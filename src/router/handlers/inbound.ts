// Router Telegram messages: lock, rate limit, permission text verdicts, notes, commands and routing to a session.
import { basename } from 'node:path'
import type { Inbound } from '../../brain/chat-types.ts'
import type { MessageId, ThreadId } from '../../brain/chat-types.ts'
import { findTextTarget } from '../ask.ts'
import type { PendingAsk } from '../shared.ts'
import { startableDirs, deliver, prepare } from '../deliver.ts'
import { decideInbound } from '../../brain/inbound.ts'
import { bindGroup } from './group.ts'
import { inboundTarget, topicForThread, topicSessionFor } from '../topics.ts'
import { words } from '../../brain/words.ts'
import { parseNewCommand } from '../../brain/topics.ts'
import { muteAckText, muteStatusText, parseSilentCommand, UNMUTED_TEXT, type SilentCommand } from '../../brain/mute.ts'
import { answerAskText } from './ask.ts'
import { resolvePermission } from './callbacks.ts'
import { runPrefix } from './prefix.ts'
import { sendResumeList } from './resume.ts'
import { sendAddonMenu } from './addons.ts'
import { sendUsage } from './usage.ts'
import { quotaBlock, routeByContent } from './route.ts'
import { debugCommand, traceCommand } from './debug.ts'
import { setLocked } from './socket.ts'
import { parseGeneral, type Prefix } from '../../brain/prefixes.ts'
import { newChatLine } from '../../brain/chatlog.ts'
import { say, sayStatus } from '../send.ts'
import { muteOf, setMute } from '../mute.ts'
import { voiceRawTranscript } from '../voice.ts'
import { LOCK_TEXT, type Prepared, type SpawnQueue } from '../shared.ts'
import { effectiveModel, spawnFor, type SpawnOptions } from '../spawn.ts'
import { MODEL_RE } from '../../config.ts'
import { helpText, INBOUND_RATE_LIMIT, formatList, permissionRefusal, permissionVerdict, resolveMsgRef, resolveProject, chunkText, textLimit, routeInbound, isCommandText, isOwnerUser, type ReplyRef } from '../state.ts'
import { currentTrace, isTraceCommand } from '../../brain/observe.ts'
import { log } from '../log.ts'
import type { Router } from '../core.ts'

export async function onInbound(router: Router, m: Inbound): Promise<void> {
  // The Telegram adapter only hands over the owner's messages; the brain checks again (ports.ts).
  if (!isOwnerUser(m.fromId, router.ownerId)) return
  // The message's trace id (the flow started for it) is kept against its Telegram id, for /trace and `tg-bridge trace`.
  const trace = currentTrace()
  if (trace) router.traces?.recordTrace({ messageId: m.messageId, dir: 'in', trace, at: router.clock.now() })
  const where = m.chat.kind === 'home' ? (m.chat.thread !== null ? `topic ${m.chat.thread}` : 'group') : 'DM'
  log(`inbound ${m.kind} in ${where}`)
  // Every message the owner sends gets one chat-log line, written when it is done: by then its target and files are known.
  router.chatTrace.set(m.messageId, {})
  try {
    return await handleInbound(router, m)
  } finally {
    logIncoming(router, m)
  }
}

// Chat log (design §4.11): the incoming line. Never throws.
function logIncoming(router: Router, m: Inbound): void {
  const t = router.chatTrace.get(m.messageId) ?? {}
  router.chatTrace.delete(m.messageId)
  router.chatLog?.append(
    newChatLine({
      ts: router.clock.now(),
      dir: 'in',
      kind: m.kind,
      text: t.text ?? m.text,
      raw: t.raw ?? null,
      target: t.target ?? null,
      topic_id: t.topic_id ?? null,
      backend: t.backend ?? null,
      scores: null,
      gap: null,
      attachments: t.attachments ?? [],
      tg_message_id: m.messageId,
    }),
  )
}

async function handleInbound(router: Router, m: Inbound): Promise<void> {
  if (router.locked) {
    if (!router.lockNotified) {
      router.lockNotified = true
      await say(router, LOCK_TEXT, m.messageId)
    }
    return
  }
  const rl = router.limiter.check(router.clock.now())
  if (rl !== 'ok') {
    router.audit.event({ event: 'rate_limited', kind: m.kind })
    if (rl === 'drop-notify') {
      await say(router, `Rate limit: more than ${INBOUND_RATE_LIMIT} messages a minute. Dropping extras.`, m.messageId, inboundTarget(router, m))
    }
    return
  }
  // Messages dropped while the limit held are said so, once, with the next message that gets through.
  const dropped = router.limiter.takeDropped()
  if (dropped > 0) await say(router, `${dropped} earlier message${dropped === 1 ? '' : 's'} dropped by the rate limit.`, undefined, inboundTarget(router, m))
  // Which chat the message is in decides what it means (src/brain/inbound.ts). Plain DM mode routes as before.
  const chat = m.chat
  const decision = decideInbound({
    update: 'message',
    chatKind: chat.kind,
    chatId: chat.id,
    fromId: m.fromId,
    ownerUserId: router.ownerId,
    groupId: router.groupId,
    text: m.text,
    forwarded: m.forwarded,
  })
  if (decision.action === 'ignore') return
  if (decision.action === 'bind') return bindGroup(router, m)
  if (decision.action === 'use-group') {
    const link = router.chat.homeLink?.()
    const at = link ? `: ${link}` : ''
    return say(router, `Use the group${at}. Messages here are not routed.`, m.messageId, { dm: true })
  }
  // /trace as a reply works in any topic, so it comes before the topic rules.
  if (m.kind === 'text' && isTraceCommand(m.text, m.forwarded)) return traceCommand(router, m)
  // Edits and kinds the bot cannot forward are not routed; the owner is told why, and that is all.
  if (m.kind === 'edited') {
    if (router.noticedEdits.has(m.messageId)) return
    router.noticedEdits.add(m.messageId)
    if (router.noticedEdits.size > 1000) router.noticedEdits.delete(router.noticedEdits.values().next().value as MessageId)
    return say(router, "Edits aren't forwarded. Send it again as a new message.", m.messageId, inboundTarget(router, m))
  }
  if (m.kind === 'unsupported') {
    return say(router, `Can't forward ${m.label ?? 'this kind of message'}. Send it as text or a file.`, m.messageId, inboundTarget(router, m))
  }
  // A message in a folder topic goes to a session of that folder as it is (no prefixes, no routing). Only the approval
  // verdict, `/new` and the answer to a pending question still apply in a topic.
  // The forum topic the message is in (null: General or a DM). inTopic narrows it.
  const topicThread: ThreadId | null = chat.kind === 'home' ? chat.thread : null
  const inTopic = topicThread !== null
  if (m.kind === 'text' && !m.forwarded) {
    const v = permissionVerdict(m.text)
    const pending = v ? router.pending.get(v.requestId) : undefined
    if (v && pending) {
      if (!isOwnerUser(m.fromId, router.ownerId)) return
      const refusal = permissionRefusal(v.behavior, pending.redacted)
      if (refusal) return say(router, refusal, m.messageId, inboundTarget(router, m))
      return resolvePermission(router, v.requestId, v.behavior)
    }
  }
  // Own messages only. A voice message is transcribed here (not after routing) so its transcript can be checked
  // for "note"; the prepared body is then reused for delivery, so nothing is downloaded or transcribed twice.
  let prepared: Prepared | undefined
  if (!m.forwarded) {
    if (m.kind === 'voice' && m.text === '') {
      const p = await prepare(router, m, '')
      if (!p) return
      prepared = p
    }
    // General prefixes (design §4.3). In a folder topic only `/new` is parsed (ticket 22).
    if (!inTopic) {
      const found = generalPrefix(router, m, prepared)
      if (found !== null) return runPrefix(router, found.prefix, m, found.prepared)
    } else if (m.kind === 'text') {
      const start = parseNewCommand(m.text)
      if (start !== null) return startInTopic(router, m, topicThread, start.body)
      const silentCmd = parseSilentCommand(m.text)
      if (silentCmd !== null) return silentInTopic(router, m, topicThread, silentCmd)
    }
    if (m.kind === 'text' && m.text.trim() !== '' && !isCommandText(m.text)) {
      // Group mode: a plain General message is not an answer to a pending ask; only a reply to the ask or a message in
      // the ask's folder topic is (ask.ts findTextTarget): a folder topic answers the one pending ask of its folder.
      const topic = inTopic ? topicForThread(router, topicThread) : undefined
      const group = chat.kind === 'home'
        ? { inTopic: (a: PendingAsk) => topic !== undefined && topic.cwd !== null && topic.cwd === a.session.cwd }
        : null
      const ask = findTextTarget([...router.asks.values()], m.replyToId, group)
      if (ask) return answerAskText(router, ask, m.text.trim())
    }
  }
  if (inTopic) return routeToTopic(router, m, topicThread, prepared)
  // Addon prefixes and commands in General are asked before the message is routed (plan 2.9). Replies to a session
  // message are never captured by an addon.
  if (m.kind === 'text' && !m.forwarded && m.replyToId === null && router.addons) {
    const reply = await router.addons.general(m.text, m.messageId)
    if (reply !== null) return reply === '' ? undefined : say(router, reply, m.messageId)
  }
  const now = router.clock.now()
  const replyTo: ReplyRef | null =
    m.replyToId !== null ? resolveMsgRef(router.msgMap.get(m.replyToId), router.registry.list()) : null
  // A swipe-reply to an addon's own message (modes threads) goes to that addon, not to a session (plan 2.11).
  if (replyTo === null && m.kind === 'text' && !m.forwarded && m.replyToId !== null && router.addons?.reply) {
    if (await router.addons.reply(m.text, m.replyToId, m.messageId)) return
  }
  const route = routeInbound(m.text, now, {
    live: router.registry.list(),
    replyTo,
    attachment: m.kind !== 'text',
    forwarded: m.forwarded,
    resolveProject: (ref) => resolveProject(ref, startableDirs(router)),
  })
  switch (route.type) {
    case 'error':
      return say(router, route.text, m.messageId)
    case 'command':
      return runCommand(router, route.cmd, m, now, route.arg)
    case 'session':
      return deliver(router, route.session, m, route.content, prepared)
    case 'spawn':
      await spawnFor(router, route.project, route.dir, m, route.content, prepared)
      return
    case 'general':
      return routeByContent(router, route.candidates, m, route.content, prepared)
  }
}

// The prefix of a General message, with the body to use. A voice message's prefix is read from its RAW transcript: the
// cleaned text (voice cleanup) only supplies the body after it, so a cleaner can neither add nor remove a prefix. When the
// cleaned text starts with the same prefix kind, its remainder is the body; otherwise the cleaned text is the body. With no
// raw transcript (not echoed), a voice message has no prefix. Null when there is no prefix.
export function generalPrefix(router: Router, m: Inbound, prepared: Prepared | undefined): { prefix: Prefix; prepared?: Prepared } | null {
  if (!prepared || m.kind !== 'voice') {
    const prefix = parseGeneral(prepared ? prepared.body : m.text)
    return prefix === null ? null : { prefix, prepared }
  }
  const raw = voiceRawTranscript(router, m.messageId)
  if (raw === null) return null
  const header = parseGeneral(raw)
  if (header === null) return null
  const clean = prepared.body
  const cleaned = parseGeneral(clean)
  const body = cleaned !== null && cleaned.kind === header.kind ? cleaned.body : clean
  return { prefix: { ...header, body }, prepared: { body, meta: prepared.meta } }
}

// The first prompt of a session started by a reply carries the replied-to text, so the new session knows what the user
// means: the quote goes in front of the text, in the same form for every kind of message.
export function withReplyText(m: Inbound, text: string): string {
  if (m.replyToText === null) return text
  return `The user is replying to this earlier message:\n"""\n${m.replyToText}\n"""\n\n${text}`
}

export const NO_FOLDER_TOPIC_TEXT = 'This topic has no folder. Start a session in General with "new <project>:".'
export const NO_LIVE_IN_FOLDER_TEXT = 'No live session in this folder. Send /new to start one (/new <text> to start it with a message).'

// A plain message in a folder topic goes to one session of the folder (topicSessionFor): the one it replies to, else the
// one that wrote last in the topic. With no live session in the folder the user is told how to start one, in the topic.
// With no live session in the folder and config startWhenNoSession on, the message (a reply too) starts a session in the
// topic's folder, quota permitting (an explicit folder: no 5-minute cap). A reply's session gets the replied-to text
// first (withReplyText). A refusal says why, in the topic.
async function routeToTopic(router: Router, m: Inbound, threadId: ThreadId, prepared?: Prepared): Promise<void> {
  const rec = topicForThread(router, threadId)
  if (!rec || rec.cwd === null) return say(router, NO_FOLDER_TOPIC_TEXT, m.messageId, inboundTarget(router, m))
  // After a bare `/new` (startInTopic), the topic's next plain message goes to the instance it started. A swipe-reply still
  // picks its session. While that start is pending (its queue is still in router.spawns) the message joins the queue and is
  // delivered on register; the entry is used up only by a message that reaches the live instance (or when it is gone).
  const next = m.replyToId === null ? router.topicNext.get(threadId) : undefined
  if (next !== undefined) {
    if (router.spawns.get(next.real) === next.q) {
      await spawnFor(router, basename(next.real), next.real, m, m.text, prepared)
      return
    }
    router.topicNext.delete(threadId)
    const s = router.registry.list().find((x) => router.tmuxBySession.get(x.key) === next.q.tmuxName)
    if (s) return deliver(router, s, m, m.text, prepared)
  }
  const live = router.registry.list().filter((x) => x.cwd === rec.cwd)
  const s = topicSessionFor(router, rec, m, live)
  if (!s) {
    if (router.startWhenNoSession) {
      const block = await quotaBlock(router)
      if (block === null) {
        router.audit.event({ event: 'topic_start', reason: 'no live session' })
        // Only the text part gets the quote: a prepared body (media, voice) keeps everything else it carries.
        const first = prepared ? { ...prepared, body: withReplyText(m, prepared.body) } : undefined
        await spawnInTopic(router, rec.cwd, m, withReplyText(m, m.text), first)
        return
      }
      router.audit.event({ event: 'topic_without_session', reason: block })
      return say(router, `${NO_LIVE_IN_FOLDER_TEXT} (not started by itself: ${block})`, m.messageId, inboundTarget(router, m))
    }
    router.audit.event({ event: 'topic_without_session' })
    return say(router, NO_LIVE_IN_FOLDER_TEXT, m.messageId, inboundTarget(router, m))
  }
  return deliver(router, s, m, m.text, prepared)
}

// `/new [text]` in a folder topic: a new Claude session in that folder. The text after it is the session's first message;
// with no text the session starts empty (spawnFor skips an empty first message), and the topic's next plain message goes
// to it (topicNext). Every /new drops an earlier entry of the topic; a bare one sets the entry when its queue is made, and
// drops it again if the start then fails.
async function startInTopic(router: Router, m: Inbound, threadId: ThreadId, body: string): Promise<void> {
  const rec = topicForThread(router, threadId)
  if (!rec || rec.cwd === null) return say(router, NO_FOLDER_TOPIC_TEXT, m.messageId, inboundTarget(router, m))
  router.topicNext.delete(threadId)
  const queued: { q?: SpawnQueue } = {}
  const onQueued = body === '' ? (q: SpawnQueue) => { queued.q = q; router.topicNext.set(threadId, { real: q.real, q }) } : undefined
  const tmuxName = await spawnInTopic(router, rec.cwd, m, body, undefined, { onQueued })
  if (tmuxName === null && queued.q !== undefined && router.topicNext.get(threadId)?.q === queued.q) router.topicNext.delete(threadId)
}

// A new session in a topic's folder, its first message `body` (with the prepared content of a routed message, if any).
// Returns the tmux session name of the start, or null when none was started.
async function spawnInTopic(router: Router, cwd: string, m: Inbound, body: string, prepared?: Prepared, options: SpawnOptions = {}): Promise<string | null> {
  const real = router.platform.realpath(cwd)
  if (real === null || !router.platform.isDirectory(real)) {
    await say(router, `Can't start a session here: the folder ${cwd} no longer exists.`, m.messageId, inboundTarget(router, m))
    return null
  }
  return spawnFor(router, basename(real), real, m, body, prepared, [], options)
}

export async function runCommand(router: Router, cmd: string, m: Inbound, now: number, arg = ''): Promise<void> {
  switch (cmd) {
    case 'debug':
      return debugCommand(router, arg, m)
    case 'list':
      // Telegram caps one message at 4096 chars and sendText does not split, so send in chunks.
      for (const chunk of chunkText(formatList(router.registry.list(), now, startableDirs(router), router.home), textLimit(router.chat))) {
        await say(router, chunk, m.messageId)
      }
      return
    case 'help':
    case 'start':
      return say(router, helpText(words(router.chat.capabilities)), m.messageId)
    case 'away':
      router.platform.setAway()
      router.audit.event({ event: 'away', source: 'telegram' })
      return say(router, 'Away mode on: all messages come here.', m.messageId)
    case 'here':
      router.platform.setHere(now)
      router.audit.event({ event: 'here', source: 'telegram' })
      return say(router, 'Muted until you touch the desktop.', m.messageId)
    case 'lock':
      setLocked(router, true, 'telegram')
      router.lockNotified = true
      return say(router, LOCK_TEXT, m.messageId)
    case 'resume':
      return sendResumeList(router, m.messageId)
    case 'addons':
      return sendAddonMenu(router, m.messageId)
    case 'usage':
      return sendUsage(router, m.messageId)
    case 'model':
      return modelCommand(router, arg, m)
    case 'silent':
      return say(router, SILENT_IN_GENERAL_TEXT, m.messageId)
  }
}

const SILENT_IN_GENERAL_TEXT = '/silent works inside a folder topic: it mutes that folder\'s topic. Send it in the topic.'

// `/silent` in a folder topic (spec 24 §4): mutes the folder's default-level sends; critical ones still ping. The ack is
// itself silent; a refusal (bad or too long duration) is an ordinary reply.
function silentInTopic(router: Router, m: Inbound, threadId: ThreadId, cmd: SilentCommand): Promise<void> {
  const to = inboundTarget(router, m)
  const topic = topicForThread(router, threadId)
  if (!topic || topic.cwd === null) return say(router, 'This topic has no folder, so /silent has nothing to mute.', m.messageId, to)
  const cwd = topic.cwd
  switch (cmd.kind) {
    case 'refuse':
      return say(router, cmd.reason, m.messageId, to)
    case 'status':
      return sayStatus(router, muteStatusText(muteOf(router, cwd)), m.messageId, to)
    case 'off':
      setMute(router, cwd, undefined)
      return sayStatus(router, UNMUTED_TEXT, m.messageId, to)
    case 'on':
      setMute(router, cwd, null)
      return sayStatus(router, muteAckText(null), m.messageId, to)
    case 'for': {
      const until = router.clock.now() + cmd.ms
      setMute(router, cwd, until)
      return sayStatus(router, muteAckText(until), m.messageId, to)
    }
  }
}

// `/model`: shows the model new bot-started sessions get and where it comes from. `/model <name>` saves it for new
// starts (running sessions keep theirs); `/model default` clears the bot's setting, so the config value or Claude
// Code's default applies again.
function modelCommand(router: Router, arg: string, m: Inbound): Promise<void> {
  const reply = (text: string) => say(router, text, m.messageId, inboundTarget(router, m))
  if (arg === '') {
    const { model, source } = effectiveModel(router)
    if (source === 'bot') return reply(`New sessions start with --model ${model} (set with /model).`)
    if (source === 'config') return reply(`New sessions start with --model ${model} (from config claudeModel).`)
    return reply("New sessions use Claude Code's default model (no --model). Set one with /model <name>.")
  }
  if (arg.toLowerCase() === 'default') {
    router.store.setDefaultModel(null)
    const { model } = effectiveModel(router)
    if (model === null) return reply("Cleared the /model setting. New sessions use Claude Code's default model (no --model).")
    return reply(`Cleared the /model setting. New sessions start with --model ${model} (from config claudeModel).`)
  }
  if (!MODEL_RE.test(arg)) {
    return reply(`Not a model name: ${arg}. Use letters, digits, dots, colons, brackets or dashes, not starting with a dash (for example sonnet).`)
  }
  router.store.setDefaultModel(arg)
  return reply(`New sessions will start with --model ${arg}. Running sessions keep their model.`)
}
