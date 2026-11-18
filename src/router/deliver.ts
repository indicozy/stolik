// Router inbound-to-session delivery: media download and transcription, the send to a live session, the startable folders.
import { lstatSync, readdirSync, rmSync, rmdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Inbound } from '../brain/chat-types.ts'
import { ringNum } from '../adapters/chat/telegram.ts'
import { hasDbNumber, idFileStem } from '../adapters/store-ids.ts'
import { inboxDir, voiceInboxPath } from './handlers/notes.ts'
import type { VoiceEcho } from './voice-echo.ts'
import { sendVoiceEcho, transcribeVoice } from './voice.ts'
import { errMsg } from './log.ts'
import { SESSION_BACKEND, logOutgoing, say, traceInbound } from './send.ts'
import { inboundTarget, sendTarget } from './topics.ts'
import { MAX_INBOUND_BYTES, notConnected, metaSafe, type Prepared } from './shared.ts'
import { FORWARD_PREFIX, markInbound, sanitizeFileName, pushHistory, turnBusy, type Session } from './state.ts'
import type { Router } from './core.ts'
import type { MessageId } from '../brain/chat-types.ts'

// The message id in the channel protocol meta: Telegram's own number ("tg:123" gives "123"), and the old negative number
// for an e2e id (ringNum in the Telegram adapter). An id of another platform has no number: the id string itself.
export function wireNum(id: MessageId): string {
  return hasDbNumber(id) ? String(ringNum(id)) : id
}

// The part of an inbox or attachment file name that names the message: the wire number, or the id made file-safe.
export function fileStem(id: MessageId): string {
  return hasDbNumber(id) ? String(ringNum(id)) : idFileStem(id)
}

// Startable folders: the folders the agent trusts that still exist as real directories (/to and /list use them).
export function startableDirs(router: Router): string[] {
  return router.agent.trustedFolders().filter((p) => router.platform.isDirectory(p) && router.platform.realpath(p) === p)
}

export function deliverable(router: Router): Session[] {
  return router.registry.list().filter((s) => s.hasChannel && router.agent.isConnected(s.key))
}

// Body and meta for the session. Media is downloaded here. Null means the user was already told why not.
export async function prepare(router: Router, m: Inbound, routed: string): Promise<Prepared | null> {
  const meta: Record<string, string> = { message_id: wireNum(m.messageId), user: metaSafe(m.from), chat_app: router.chatApp }
  // Identity (plan 0e decision 6): the owner's id string as the port gives it, set only when the sender is the paired
  // owner (the brain has checked it already; this is the same test, kept here so the meta never trusts a name).
  // `user` is then the chat.ownerAlias when set, else the platform name as before. A forwarded message is someone else's
  // text, and a message the router makes for an addon (origin 'addon') is not the owner's: neither gets the owner's id.
  if (m.origin !== 'addon' && !m.forwarded && m.fromId !== '' && m.fromId === router.ownerId) {
    meta.user_id = m.fromId
    if (router.ownerAlias !== null) meta.user = metaSafe(router.ownerAlias)
  }
  if (m.forwarded) meta.forwarded = 'true'
  if (m.kind === 'text') return { body: routed, meta }
  const body = await mediaBody(router, m, routed, meta)
  return body === null ? null : { body, meta }
}

// Where an incoming file is downloaded. With a chat log: a reserved file in its attachments folder (the path relative to
// the log root is kept for the log line). Without one: the Telegram inbox, as before.
function incomingFile(router: Router, m: Inbound, name: string): { dest: string; rel: string | null } {
  if (!router.chatLog) return { dest: join(inboxDir(router, m), `${fileStem(m.messageId)}_${name}`), rel: null }
  const att = router.chatLog.attachmentPath(name, router.clock.now())
  if (!att) throw new Error('attachment folder is not writable')
  return { dest: att.path, rel: att.rel }
}

// Keep the inbox (voice downloads and the Telegram copies of files) for this long; pruneInbox runs at start and then
// every INBOX_PRUNE_EVERY_MS.
export const INBOX_KEEP_MS = 7 * 24 * 60 * 60_000
export const INBOX_PRUNE_EVERY_MS = 6 * 60 * 60_000

// Deletes the files under `dir` whose mtime is older than maxAgeMs, then the directories left empty that are older
// than that too. `dir` itself stays. Returns how many files and directories were removed. Symlinks are removed as links.
export function pruneInbox(dir: string, nowMs: number, maxAgeMs: number): number {
  const cutoff = nowMs - maxAgeMs
  let removed = 0
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of entries) {
    const p = join(dir, name)
    const st = lstatSync(p)
    const old = st.mtimeMs < cutoff
    if (st.isDirectory()) {
      removed += pruneInbox(p, nowMs, maxAgeMs)
      if (old && readdirSync(p).length === 0) {
        rmdirSync(p)
        removed++
      }
    } else if (old) {
      unlinkSync(p)
      removed++
    }
  }
  return removed
}

const inboxPruneStarted = new WeakSet<Router>()

// Starts the inbox pruning for this router: once now, then every INBOX_PRUNE_EVERY_MS (unref'd). Only the first call
// per router does anything. Failures are logged, never thrown.
export function startInboxPrune(router: Router): void {
  if (inboxPruneStarted.has(router)) return
  inboxPruneStarted.add(router)
  const root = router.store.inboxPath('')
  const run = (): void => {
    try {
      pruneInbox(root, router.clock.now(), INBOX_KEEP_MS)
    } catch (e) {
      router.logger.log(`inbox prune failed: ${errMsg(e)}`)
    }
  }
  run()
  setInterval(run, INBOX_PRUNE_EVERY_MS).unref()
}

// Downloads one message file. A failed download leaves no partial or placeholder file behind.
async function download(router: Router, m: Inbound, dest: string): Promise<void> {
  try {
    await router.chat.download(m.fileRef ?? '', dest, MAX_INBOUND_BYTES)
  } catch (e) {
    rmSync(dest, { force: true })
    throw e
  }
}

// An album (several files sent as one message): every file is downloaded; the body names them all.
async function albumBody(router: Router, m: Inbound, routed: string, meta: Record<string, string>): Promise<string | null> {
  const paths: string[] = []
  for (const item of m.album ?? []) {
    if (item.fileSize !== undefined && item.fileSize > MAX_INBOUND_BYTES) {
      await say(router, 'A file of the album is over the 20 MB Bot API limit; it was not delivered.', m.messageId, inboundTarget(router, m))
      continue
    }
    const name = sanitizeFileName(item.fileName ?? (item.kind === 'photo' ? 'photo.jpg' : `${item.kind}.bin`))
    try {
      const f = incomingFile(router, { ...m, messageId: item.messageId }, name)
      await router.chat.download(item.fileRef ?? '', f.dest, MAX_INBOUND_BYTES)
      traceInbound(router, m.messageId, { attachments: f.rel ? [f.rel] : [] })
      paths.push(f.dest)
    } catch (e) {
      await say(router, `download failed: ${errMsg(e)}`, m.messageId, inboundTarget(router, m))
    }
  }
  if (paths.length === 0) return null
  if (m.album?.[0]?.kind === 'photo') meta.image_path = paths[0]
  else meta.file_path = paths[0]
  meta.album_count = String(paths.length)
  return [routed || `(album: ${paths.length} files)`, ...paths.map((p) => `file: ${p}`)].join('\n')
}

// Downloads media and returns the message body, or null if the message should not be delivered.
export async function mediaBody(router: Router, m: Inbound, routed: string, meta: Record<string, string>): Promise<string | null> {
  if (m.album && m.album.length > 0) return albumBody(router, m, routed, meta)
  if (m.fileSize !== undefined && m.fileSize > MAX_INBOUND_BYTES) {
    await say(router, 'File is over the 20 MB Bot API limit; not delivered.', m.messageId, inboundTarget(router, m))
    return null
  }
  const name = sanitizeFileName(m.fileName ?? `${m.kind}.bin`)
  startInboxPrune(router)
  try {
    if (m.kind === 'voice') {
      const dest = voiceInboxPath(router, m)
      await download(router, m, dest)
      let echo: VoiceEcho | null
      try {
        echo = await transcribeVoice(router, m, dest)
      } catch (e) {
        await say(router, `transcription failed: ${errMsg(e)}`, m.messageId, inboundTarget(router, m))
        return null
      } finally {
        // The transcript is all that goes on; the note path downloads the file again if it needs it.
        rmSync(dest, { force: true })
      }
      if (!echo) {
        await say(router, 'no speech detected; not delivered.', m.messageId, inboundTarget(router, m))
        return null
      }
      await sendVoiceEcho(router, m, echo)
      meta.voice = 'true'
      traceInbound(router, m.messageId, { text: echo.clean, raw: echo.raw })
      return routed ? `${routed}\n${echo.clean}` : echo.clean
    }
    if (m.kind === 'photo') {
      const f = incomingFile(router, m, 'photo.jpg')
      await download(router, m, f.dest)
      traceInbound(router, m.messageId, { attachments: f.rel ? [f.rel] : [] })
      meta.image_path = f.dest
      return routed || '(photo)'
    }
    const f = incomingFile(router, m, name)
    await download(router, m, f.dest)
    traceInbound(router, m.messageId, { attachments: f.rel ? [f.rel] : [] })
    meta.file_path = f.dest
    meta.file_name = name
    return routed || `(${m.kind}: ${name})`
  } catch (e) {
    await say(router, `download failed: ${errMsg(e)}`, m.messageId, inboundTarget(router, m))
    return null
  }
}

// The turn each busy-session notice was sent for. A session's turn is identified by its start time (turnStart), so the
// notice comes once per turn.
const busyNoticedAt = new WeakMap<Session, number>()

// Hands a prepared message to a session. False if the session has no connection (the user is told). A session that
// is mid-turn still gets the message at once (Claude Code queues it): the message gets a 'queued' reaction, and the first
// time in each turn a silent "queued, session is busy" reply.
export async function send(router: Router, s: Session, m: Inbound, p: Prepared, opts: { bypassGate?: boolean } = {}): Promise<boolean> {
  if (!router.agent.isConnected(s.key)) {
    await say(router, notConnected(s), m.messageId, inboundTarget(router, m))
    return false
  }
  // The gate point: an addon may hold the message instead of delivering it. A release is sent with the gate skipped.
  if (!opts.bypassGate && (await holdForGate(router, s, m, p))) return true
  const now = router.clock.now()
  const busy = turnBusy(s, now)
  const meta = { ...p.meta, ts: new Date(now).toISOString() }
  const content = (m.forwarded ? FORWARD_PREFIX : '') + p.body
  router.agent.sendToSession(s.key, content, meta)
  // The newest delivered message is the one the session's answers address (see pendingTg in brain/sessions.ts).
  s.pendingTg = { messageId: m.messageId, thread: m.chat.kind === 'home' ? m.chat.thread : null, replied: false }
  traceInbound(router, m.messageId, {
    target: { type: 'session', name: s.name },
    topic_id: sendTarget(router, 'answer', s).thread ?? null,
    backend: SESSION_BACKEND,
  })
  markInbound(s, now)
  pushHistory(s, 'user', p.body, router.secrets)
  router.audit.event({ event: 'inbound', session: s.name, kind: m.kind, length: p.body.length, forwarded: m.forwarded, busy })
  router.chat.react(m.messageId, busy ? 'queued' : 'seen').catch(() => {})
  if (busy) await noticeBusy(router, s, m)
  return true
}

// Asks the gate providers about a message (the gate point, cost-guard). Forwarded messages and an addon's own prompts (a
// spawned session's first message, sent from the addon's name) are never gated. True when an addon held the message: it
// is kept in router.holds for that addon to release or drop. A failing gate lets the message pass. A session mid-turn
// is never gated: its cache is in use, and the message is queued into the running turn.
async function holdForGate(router: Router, s: Session, m: Inbound, p: Prepared): Promise<boolean> {
  if (!router.addons?.gate || m.forwarded || isAddonSender(router, m.from)) return false
  if (turnBusy(s, router.clock.now())) return false
  let hit: { addon: string } | null
  try {
    hit = (await router.addons.gate({
      session: { name: s.name, cwd: s.cwd, backendSessionId: s.backendSessionId },
      messageId: m.messageId,
      kind: m.kind,
      length: p.body.length,
    })) ?? null
  } catch (e) {
    router.logger.log(`gate failed, message passes: ${errMsg(e)}`)
    return false
  }
  if (!hit) return false
  router.holds.put({ sessionKey: s.key, m, p, addon: hit.addon, heldAt: router.clock.now() })
  router.chat.react(m.messageId, 'held').catch(() => {})
  router.audit.event({ event: 'held', session: s.name, addon: hit.addon, kind: m.kind, length: p.body.length })
  return true
}

// Whether `from` is the name of an installed addon (its own prompts are sent under that name, see addon-bridge spawn).
function isAddonSender(router: Router, from: string): boolean {
  return router.addons?.isAddon?.(from) ?? false
}

// The silent reply that says the message waits for the running turn. Once per turn.
async function noticeBusy(router: Router, s: Session, m: Inbound): Promise<void> {
  if (busyNoticedAt.get(s) === s.turnStart) return
  busyNoticedAt.set(s, s.turnStart)
  try {
    const id = await router.chat.sendText('queued, session is busy', { replyTo: m.messageId, silent: true, ...inboundTarget(router, m) })
    logOutgoing(router, { kind: 'notice', text: 'queued, session is busy', tg_message_id: id })
  } catch (e) {
    router.logger.log(`busy notice failed: ${errMsg(e)}`)
  }
}

export async function deliver(router: Router, s: Session, m: Inbound, routed: string, prepared?: Prepared): Promise<void> {
  if (!router.agent.isConnected(s.key)) return say(router, notConnected(s), m.messageId, inboundTarget(router, m))
  const p = prepared ?? (await prepare(router, m, routed))
  if (p) await send(router, s, m, p)
}
