// Router side of the E2E driver (docs/e2e.md). The socket message is {t:'e2e', op, reqId?, ...}; the reply is
// {t:'e2e_result', reqId?, ok, ...}. Injected messages and taps go through the same handlers as Telegram's, so the rules
// (lock, rate limit, prefixes, routing, topics, approvals) apply to them unchanged. Refused unless the router was
// started with TG_BRIDGE_E2E=1 (router.e2e is null otherwise).
import { basename, isAbsolute } from 'node:path'
import type { ButtonPress, ChatRef, Inbound } from '../../brain/chat-types.ts'
import type { ChatId, MessageId, ThreadId, UserId } from '../../brain/chat-types.ts'
import { tgChat, tgMsg, tgNum, tgThread } from '../../adapters/chat/tg-ids.ts'
import { e2eMsg, SYNTHETIC_ID_BASE } from '../e2e.ts'
import type { SocketConn } from '../../ports.ts'
import type { Btn } from '../state.ts'
import { errMsg } from '../log.ts'
import type { Router } from '../core.ts'
import { onInbound } from './inbound.ts'
import { onCallback } from './callbacks.ts'

export const E2E_DISABLED_TEXT = 'e2e disabled: the router must run with TG_BRIDGE_E2E=1'
// The extensions a voice file may have (the transcriber reads these).
const VOICE_EXT = /\.(ogg|oga|opus|wav|mp3|m4a)$/i

type E2eMsg = Record<string, unknown> & { op?: unknown; reqId?: unknown }

// The driver speaks numbers (router/e2e.ts counts them: synthetic message ids are negative). The brain gets the opaque
// ids: a negative number is an e2e message "e2e:<seq>", a positive one a Telegram message "tg:<n>".
function msgIdOf(n: number): MessageId {
  return n < 0 ? e2eMsg(-n - SYNTHETIC_ID_BASE) : tgMsg(n)
}

export function onE2e(router: Router, conn: SocketConn, msg: E2eMsg): void {
  const reply = (r: Record<string, unknown>) => conn.send({ t: 'e2e_result', reqId: msg.reqId, ...r })
  if (!router.e2e) return reply({ ok: false, error: E2E_DISABLED_TEXT })
  try {
    switch (msg.op) {
      case 'inbound':
        return reply(injectInbound(router, msg))
      case 'callback':
        return reply(injectCallback(router, msg))
      case 'sent':
        return reply({ ok: true, sent: router.e2e.ring.last(typeof msg.n === 'number' ? msg.n : 20) })
      default:
        return reply({ ok: false, error: `unknown op ${String(msg.op)}` })
    }
  } catch (e) {
    return reply({ ok: false, error: errMsg(e) })
  }
}

// One owner message, as the Telegram adapter would build it. Synthetic ids are negative (src/router/e2e.ts).
// The sender name the injected message carries. Sessions read it: a driver run that acts as the owner passes the owner's
// username (--from), and a bad or missing name falls back to 'e2e' so nothing is impersonated by accident.
export function senderLabel(raw: unknown): string {
  return typeof raw === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(raw) ? raw : 'e2e'
}

function injectInbound(router: Router, msg: E2eMsg): Record<string, unknown> {
  const e2e = router.e2e
  if (!e2e) throw new Error(E2E_DISABLED_TEXT)
  const media = mediaOf(router, msg)
  const text = typeof msg.text === 'string' ? msg.text : ''
  if (!media && text.trim() === '') throw new Error('nothing to send: give text, or a voice, photo or document path')
  const chat = chatFor(router, msg.topic)
  const n = e2e.nextMessageId()
  const messageId = msgIdOf(n)
  // The e2e driver simulates the owner, so its messages carry the owner's id (and get user_id) on purpose. Addon-made
  // messages use origin 'addon' instead (addon-bridge spawn).
  const m: Inbound = {
    kind: media?.kind ?? 'text',
    messageId,
    text,
    replyToId: replyIdOf(msg.reply),
    replyToText: null,
    forwarded: msg.forwarded === true,
    from: senderLabel(msg.from),
    fromId: router.ownerId as UserId,
    chat,
  }
  if (media) {
    m.fileRef = e2e.nextFileId(media.path)
    m.fileName = basename(media.path)
  }
  void onInbound(router, m).catch((e) => router.logger.log(`e2e inbound failed: ${errMsg(e)}`))
  return { ok: true, messageId: n, chat }
}

// A tap on a button of a sent message: by callback data, or by the button's text or index (0-based, as `sent` lists them).
function injectCallback(router: Router, msg: E2eMsg): Record<string, unknown> {
  const e2e = router.e2e
  if (!e2e) throw new Error(E2E_DISABLED_TEXT)
  const messageId = msg.messageId
  if (typeof messageId !== 'number' || !Number.isInteger(messageId)) throw new Error('callback needs a numeric messageId')
  const entry = e2e.ring.find(messageId)
  let data: string
  if (typeof msg.data === 'string') {
    data = msg.data
  } else {
    if (!entry) throw new Error(`message ${messageId} is not in the sent buffer`)
    data = pickButton(entry.buttons, msg.button)
  }
  const cb: ButtonPress = {
    pressId: e2e.nextCallbackId(),
    data,
    message: msgIdOf(messageId),
    from: router.ownerId as UserId,
    chat: entry?.chat ?? defaultChat(router),
  }
  void onCallback(router, cb).catch((e) => router.logger.log(`e2e callback failed: ${errMsg(e)}`))
  return { ok: true, data }
}

// The one media file of an injected message, checked like a file the owner would send (a regular file, a voice type).
function mediaOf(router: Router, msg: E2eMsg): { kind: 'voice' | 'photo' | 'document'; path: string } | null {
  const given = (['voice', 'photo', 'document'] as const).flatMap((kind) =>
    typeof msg[kind] === 'string' ? [{ kind, path: msg[kind] as string }] : [],
  )
  if (given.length === 0) return null
  if (given.length > 1 || (msg.voice !== undefined && typeof msg.voice !== 'string') || (msg.photo !== undefined && typeof msg.photo !== 'string')) {
    throw new Error('give one file: voice, photo or document')
  }
  const { kind, path } = given[0]
  if (!isAbsolute(path)) throw new Error('the file path must be absolute')
  const info = router.platform.fileInfo(path)
  if (!info || !info.isFile) throw new Error(`no such file: ${path}`)
  if (kind === 'voice' && !VOICE_EXT.test(path)) throw new Error('a voice file must be .ogg, .oga, .opus, .wav, .mp3 or .m4a')
  return { kind, path }
}

// The chat an injected message is in: the bound group (General, or a topic named by its session or thread id), or the
// owner's private chat when no group is bound.
function chatFor(router: Router, topic: unknown): ChatRef {
  if (router.groupId === null) {
    if (topic !== undefined && topic !== null && topic !== '') throw new Error('topics need the supergroup; this router runs in DM mode')
    return { kind: 'dm', id: tgChat(tgNum(router.ownerId)), thread: null }
  }
  return { kind: 'home', id: router.groupId, thread: threadOf(router, topic) }
}

function defaultChat(router: Router): ChatRef {
  return router.groupId === null
    ? { kind: 'dm', id: tgChat(tgNum(router.ownerId)), thread: null }
    : { kind: 'home', id: router.groupId, thread: null }
}

// A topic named by its session (name or project, open topics only) or by its thread id. Absent means General.
function threadOf(router: Router, topic: unknown): ThreadId | null {
  if (topic === undefined || topic === null || topic === '') return null
  if (typeof topic === 'number' || /^\d+$/.test(String(topic))) return tgThread(Number(topic))
  const name = String(topic)
  const rec = router.topics.find((r) => r.state === 'open' && (r.name === name || r.project === name))
  if (!rec) throw new Error(`no open topic for ${name}`)
  return rec.threadId
}

function replyIdOf(v: unknown): MessageId | null {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  if (!Number.isInteger(n)) throw new Error('reply must be a message id')
  return msgIdOf(n)
}

// The callback data of a button: by text (exact, else one case-insensitive match), else by index over all buttons.
function pickButton(rows: Btn[][], which: unknown): string {
  const flat = rows.flat()
  if (flat.length === 0) throw new Error('that message has no buttons')
  const key = String(which ?? '')
  const exact = flat.filter((b) => b.text === key)
  if (exact.length === 1) return exact[0].data
  if (/^\d+$/.test(key) && Number(key) < flat.length) return flat[Number(key)].data
  const loose = flat.filter((b) => b.text.toLowerCase().includes(key.toLowerCase()))
  if (key !== '' && loose.length === 1) return loose[0].data
  throw new Error(loose.length > 1 ? `"${key}" matches ${loose.length} buttons` : `no button "${key}" (buttons: ${flat.map((b, i) => `${i} ${b.text}`).join(', ')})`)
}
