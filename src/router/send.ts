// Router outbound: sends to Telegram through each session's outbound ledger, file rules, the message map and its save.
import { isAbsolute } from 'node:path'
import type { Kind } from '../adapters/channel/protocol.ts'
import { errMsg } from './log.ts'
import { outboundKeys, type OutboundSource, type Part } from './outbound.ts'
import type { Rows } from './state.ts'
import { AUTO_IMAGE_MAX_BYTES, fileAllowed, findImagePaths, formatForSession, isImagePath, textLimit, markSent, pushHistory, type Session, type SessionFormat, type SessionKey, type MsgEntry } from './state.ts'
import { newChatLine, type ChatLineInput, type ChatTrace } from '../brain/chatlog.ts'
import { redact } from '../brain/common.ts'
import type { Router } from './core.ts'
import type { MessageId, SendTarget, ThreadId } from '../brain/chat-types.ts'
import type { Inbound } from '../brain/chat-types.ts'
import { ChunkSendError } from '../brain/outbound-queue.ts'
import { DEFAULT_LEVEL, type NotifyLevel } from '../brain/notify-level.ts'
import { inTopic, outKindFor, sendTarget } from './topics.ts'

// Resolves paths to realpaths and applies the outbound file rules. The realpath is what gets sent.
export function resolveOutboundFiles(router: Router, files: string[]): { paths: string[] } | { error: string } {
  const paths: string[] = []
  for (const f of files) {
    if (!isAbsolute(f)) return { error: `refused: not an absolute path` }
    const real = router.platform.realpath(f)
    if (!real) return { error: 'refused: file not found' }
    const st = router.platform.fileInfo(real)
    if (!st) return { error: 'refused: file not found' }
    if (!st.isFile) return { error: 'refused: not a regular file' }
    const cap = router.chat.capabilities.files.maxUploadBytes
    if (st.size > cap) {
      // Telegram's wording is unchanged; another app's notice names its own limit.
      const mb = Math.round(cap / (1024 * 1024))
      const app = router.chat.capabilities.displayName
      return { error: `refused: larger than ${mb} MB${app === 'Telegram' ? '' : ` (the ${app} upload limit)`}` }
    }
    const verdict = fileAllowed(real, router.home)
    if (!verdict.ok) {
      router.audit.event({ event: 'refused_file', reason: verdict.reason })
      return { error: verdict.reason }
    }
    paths.push(real)
  }
  return { paths }
}

// The backend every session-bound chat line names (design §4.11).
export const SESSION_BACKEND = 'claude-code'

// Sends a message to the user: text chunks, then files, then images named in the text. Goes through the session's
// outbound ledger, so a retry of the same message joins or reuses the first send, and a failed send resends only the
// parts that failed. The text chunks go out as one group (sendChunks), so an urgent send cannot land between them.
// Throws when a required part fails.
// The session's ledger is kept in the store (StorePort), so a retry after a router restart is still deduplicated.
// Attaching is idempotent (once per ledger). The router attaches when a session is claimed (core.ts), so the restored
// rows are read back before the first Stop-forward or requested-dedupe check; this call also covers the first send.
// The prune timer is started by the router at start (core.ts), not here.
export function attachLedger(router: Router, s: Session): void {
  s.outbound.attach(router.store, s.key, (msg) => router.logger.log(msg))
}

// Returns whether the message was a duplicate of one just sent (nothing was sent then; see DUPLICATE_WINDOW_MS).
// `level` decides whether it pings (src/brain/notify-level.ts). Its topic is never muted yet, so muted is false.
export async function sendForSession(
  router: Router,
  s: Session,
  text: string,
  kind: Kind,
  paths: string[],
  source: OutboundSource,
  format: SessionFormat = 'markdown',
  level: NotifyLevel = DEFAULT_LEVEL,
): Promise<{ deduped: boolean }> {
  attachLedger(router, s)
  const texts = text.trim() ? formatForSession(s.name, text, router.secrets, format, textLimit(router.chat)) : []
  const parts: Part[] = [
    ...(texts.length > 0 ? [{ kind: 'text', value: texts[0], chunks: texts } as Part] : []),
    ...paths.map((value): Part => ({ kind: 'file', value, photo: isImagePath(value) })),
    // Problems with these never fail the message.
    ...mentionedImages(router, text, paths).map((value): Part => ({ kind: 'file', value, photo: true, optional: true })),
  ]
  // The session's topic (or General). `to` moves to a new topic when the old one is gone (see inTopic).
  let to: SendTarget = { ...sendTarget(router, outKindFor(kind, source), s), session: String(s.key) }
  const res = await s.outbound.send({
    keys: outboundKeys(kind, text, paths),
    source,
    parts,
    now: router.clock.now(),
    deliver: async (part) => {
      try {
        if (part.kind === 'text') {
          const r = await inTopic(router, s, to, (t) => sendChunkPart(router, s, kind, source, text, part, t, format, level))
          to = r.to
          return r.value
        }
        const r = await inTopic(router, s, to, async (t) => ({ id: await router.chat.sendFile(part.value, part.photo === true, { ...t, level }), t }))
        to = r.to
        const id = r.value.id
        recordMsg(router, s, id, to.thread ?? null)
        logOutgoing(router, {
          kind,
          text: '',
          attachments: [part.value],
          target: { type: 'session', name: s.name },
          tg_message_id: id,
          topic_id: to.thread ?? null,
          backend: SESSION_BACKEND,
        })
        router.audit.event({ event: 'outbound', kind, session: s.name, length: 0, files: 1, message_id: id })
        return id
      } catch (e) {
        if (part.optional) router.logger.debug(`image attach failed for ${part.value}: ${errMsg(e)}`)
        throw e
      }
    },
  })
  if (!res.ok) throw new Error(res.error ?? 'send failed')
  if (res.messageIds.length > 0) markSent(s, kind, router.clock.now())
  return { deduped: res.deduped && res.messageIds.length > 0 }
}

// The message an answer quotes: the session's pending Telegram message, when this text is the session's answer to it
// (a response or the end-of-turn text), it is in the same topic, and no answer has quoted it yet. Undefined otherwise.
function quotedMessage(s: Session, kind: Kind, source: OutboundSource, to: SendTarget): MessageId | undefined {
  const pending = s.pendingTg
  if (!pending || pending.replied || kind !== 'response') return undefined
  if (source !== 'reply' && source !== 'hook') return undefined
  if ((to.thread ?? null) !== pending.thread) return undefined
  return pending.messageId
}

// The text chunks of one message as one group. A partly sent group keeps only its unsent chunks in the part (the
// ledger stores that object, so a retry sends the rest). Returns the first message id. The first chunk quotes the
// pending message when quotedMessage says so; once it has gone out, that message counts as answered.
async function sendChunkPart(router: Router, s: Session, kind: Kind, source: OutboundSource, text: string, part: Part, to: SendTarget, format: SessionFormat, level: NotifyLevel): Promise<MessageId> {
  const chunks = part.chunks ?? [part.value]
  const quote = quotedMessage(s, kind, source, to)
  const sendTo: SendTarget & { replyTo?: MessageId; format?: 'markdown'; level?: NotifyLevel } = { ...to, ...(quote === undefined ? {} : { replyTo: quote }), ...(format === 'markdown' ? { format: 'markdown' as const } : {}), level }
  let ids: MessageId[]
  try {
    ids = await router.chat.sendChunks(chunks, sendTo)
  } catch (e) {
    if (e instanceof ChunkSendError) {
      if (quote !== undefined && e.sentIds.length > 0 && s.pendingTg) s.pendingTg.replied = true
      recordChunks(router, s, kind, chunks.slice(0, e.sentIds.length), e.sentIds, to)
      part.chunks = chunks.slice(e.sentIds.length)
    }
    throw e
  }
  if (quote !== undefined && s.pendingTg) s.pendingTg.replied = true
  recordChunks(router, s, kind, chunks, ids, to)
  pushHistory(s, 'agent', text, router.secrets)
  return ids[0]
}

// Records, logs and audits each chunk that went out.
function recordChunks(router: Router, s: Session, kind: Kind, chunks: readonly string[], ids: readonly MessageId[], to: SendTarget): void {
  chunks.forEach((chunk, i) => {
    const id = ids[i]
    recordMsg(router, s, id, to.thread ?? null)
    logOutgoing(router, {
      kind,
      text: chunk,
      attachments: [],
      target: { type: 'session', name: s.name },
      tg_message_id: id,
      topic_id: to.thread ?? null,
      backend: SESSION_BACKEND,
    })
    router.audit.event({ event: 'outbound', kind, session: s.name, length: chunk.length, files: 0, message_id: id })
  })
}

// Real paths of image files named in `text` that pass the same checks as explicit files, minus those already in `explicit`.
export function mentionedImages(router: Router, text: string, explicit: readonly string[]): string[] {
  const home = router.home
  const have = new Set(explicit)
  const out: string[] = []
  for (const p of findImagePaths(text, home)) {
    try {
      const real = router.platform.realpath(p)
      if (!real) continue
      if (have.has(real)) continue
      const st = router.platform.fileInfo(real)
      if (!st?.isFile) { router.logger.debug(`image skipped (not a regular file): ${real}`); continue }
      if (st.size > AUTO_IMAGE_MAX_BYTES) { router.logger.debug(`image skipped (over 10 MB): ${real}`); continue }
      const verdict = fileAllowed(real, home)
      if (!verdict.ok) { router.logger.debug(`image skipped (${verdict.reason}): ${real}`); continue }
      have.add(real)
      out.push(real)
    } catch (e) {
      router.logger.debug(`image skipped (${errMsg(e)}): ${p}`)
    }
  }
  return out
}

// Records a message a session sent, with the topic it went into (null: General). A topic reply finds its session by the
// last message written in that topic (see topicSessionFor).
export function recordMsg(router: Router, s: Session, messageId: MessageId, thread: ThreadId | null): void {
  const entry: MsgEntry = { key: s.key as SessionKey, name: s.name, cwd: s.cwd, ...(thread !== null ? { thread } : {}) }
  router.msgMap.record(messageId, entry)
  scheduleSave(router)
}

// A plain message. General (or the owner's DM) unless `to` names a topic: replies to a message pass its thread.
// `level` is the message's notification level (default: it pings).
export async function say(router: Router, text: string, replyTo?: MessageId, to: SendTarget = {}, rows?: Rows, level: NotifyLevel = DEFAULT_LEVEL): Promise<void> {
  try {
    const id = await router.chat.sendText(text, { replyTo, ...to, ...(rows ? { rows } : {}), level })
    logOutgoing(router, { kind: 'notice', text, tg_message_id: id })
  } catch (e) {
    router.logger.log(`send failed: ${errMsg(e)}`)
  }
}

// A bot status notice (starting, still starting, resuming): silent, so it does not ping. Refusals and errors use say.
export function sayStatus(router: Router, text: string, replyTo?: MessageId, to: SendTarget = {}): Promise<void> {
  return say(router, text, replyTo, to, undefined, 'silent')
}

// Chat log (design §4.11): one line for one message the bot sent. Secrets are redacted. Never throws.
export function logOutgoing(router: Router, input: Omit<ChatLineInput, 'ts' | 'dir' | 'text'> & { text: string }): void {
  router.chatLog?.append(newChatLine({ ...input, ts: router.clock.now(), dir: 'out', text: redact(input.text, router.secrets) }))
}

// A routing decision made by a button tap (the message's own line was written before the tap). One General line that
// names the session the message went to. Without a model there are no scores, so scores and gap are null.
export function logRouteDecision(router: Router, m: Inbound, s: Session): void {
  router.chatLog?.append(
    newChatLine({
      ts: router.clock.now(),
      dir: 'in',
      kind: 'route',
      text: '',
      target: { type: 'session', name: s.name },
      topic_id: sendTarget(router, 'answer', s).thread ?? null,
      backend: SESSION_BACKEND,
      scores: null,
      gap: null,
      tg_message_id: m.messageId,
    }),
  )
}

// Adds what the handler learned about an incoming message (its target, its saved files, the text it became).
export function traceInbound(router: Router, messageId: MessageId, patch: ChatTrace): void {
  const t = router.chatTrace.get(messageId)
  if (!t) return
  if (patch.text !== undefined) t.text = patch.text
  if (patch.raw !== undefined) t.raw = patch.raw
  if (patch.target !== undefined) t.target = patch.target
  if (patch.attachments) t.attachments = [...(t.attachments ?? []), ...patch.attachments]
  if (patch.topic_id !== undefined) t.topic_id = patch.topic_id
  if (patch.backend !== undefined) t.backend = patch.backend
}

export function scheduleSave(router: Router): void {
  if (router.saveTimer) return
  router.saveTimer = router.clock.setTimer(() => {
    router.saveTimer = null
    saveNow(router)
  }, 2000)
}

export function saveNow(router: Router): void {
  try {
    router.store.writeMsgMap(router.msgMap.serialize())
  } catch (e) {
    router.logger.log(`msgmap save failed: ${errMsg(e)}`)
  }
}
