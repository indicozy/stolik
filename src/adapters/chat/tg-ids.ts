// Telegram's opaque ids (plan 23 §2.1, §4.1). Every chat, thread, message and user id the Telegram adapter hands out is
// "tg:" + Telegram's own number. Only this module and the Telegram adapter read the prefix.
import type { ChatId, MessageId, ThreadId, UserId } from '../../brain/chat-types.ts'

export const TG_PREFIX = 'tg:'
const TG_NUMBER = /^-?\d+$/

export function tgMsg(n: number): MessageId {
  return `${TG_PREFIX}${n}` as MessageId
}

export function tgThread(n: number): ThreadId {
  return `${TG_PREFIX}${n}` as ThreadId
}

export function tgChat(n: number): ChatId {
  return `${TG_PREFIX}${n}` as ChatId
}

export function tgUser(n: number): UserId {
  return `${TG_PREFIX}${n}` as UserId
}

// The owner's user id from a config or pairing value (digits, as Telegram gives them). Kept as text: never Number().
export function tgUserOf(text: string): UserId {
  if (!TG_NUMBER.test(text)) throw new Error(`not a Telegram user id: ${JSON.stringify(text)}`)
  return `${TG_PREFIX}${text}` as UserId
}

// True for a well-formed Telegram id: "tg:" followed by an integer.
export function isTgId(id: string): boolean {
  return id.startsWith(TG_PREFIX) && TG_NUMBER.test(id.slice(TG_PREFIX.length))
}

// The number inside a Telegram id. Throws on anything that is not a "tg:<integer>" id.
export function tgNum(id: string): number {
  if (!id.startsWith(TG_PREFIX) || !TG_NUMBER.test(id.slice(TG_PREFIX.length))) {
    throw new Error(`not a Telegram id: ${JSON.stringify(id)}`)
  }
  return Number(id.slice(TG_PREFIX.length))
}

// The t.me link that opens a private supergroup for its members (t.me/c/<id>). Null for a chat that is not a
// supergroup (its number does not start with -100).
export function tgGroupLink(chat: ChatId): string | null {
  if (!chat.startsWith(TG_PREFIX)) return null
  const s = chat.slice(TG_PREFIX.length)
  return /^-100\d+$/.test(s) ? `https://t.me/c/${s.slice(4)}` : null
}
