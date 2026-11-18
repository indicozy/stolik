// Discord's opaque ids (plan 23 §2.1; research/d1-brief.md, decision 2). Only the Discord adapter reads the "dc:" prefix.
// Discord snowflakes are unsigned 64-bit integers: they travel as decimal strings, never through Number(). BigInt is used
// only to compare them.
import type { ChatId, MessageId, ThreadId, UserId } from '../../brain/chat-types.ts'

export const DC_PREFIX = 'dc:'

const SNOWFLAKE_RE = /^[1-9]\d{0,19}$/
const MAX_SNOWFLAKE = (1n << 64n) - 1n
const MSG_RE = /^dc:([1-9]\d{0,19}):([1-9]\d{0,19})$/
const THREAD_RE = /^dc:([1-9]\d{0,19})$/
const HOME_RE = /^dc:g([1-9]\d{0,19}):l([1-9]\d{0,19})$/
const DM_RE = /^dc:d([1-9]\d{0,19})$/

// True for a decimal string that fits an unsigned 64-bit integer (a Discord snowflake).
export function isSnowflake(s: string): boolean {
  return SNOWFLAKE_RE.test(s) && BigInt(s) <= MAX_SNOWFLAKE
}

function snowflake(s: string, what: string): string {
  if (!isSnowflake(s)) throw new Error(`not a Discord ${what}: ${JSON.stringify(s)}`)
  return s
}

// A message: "dc:<channelId>:<messageId>". The channel comes first because Discord addresses a message by its channel.
export function dcMsg(channelId: string, messageId: string): MessageId {
  return `${DC_PREFIX}${snowflake(channelId, 'channel id')}:${snowflake(messageId, 'message id')}` as MessageId
}

// A folder channel (a text channel under a stolik category), or a thread: "dc:<channelId>".
export function dcThread(channelId: string): ThreadId {
  return `${DC_PREFIX}${snowflake(channelId, 'channel id')}` as ThreadId
}

// A guild channel as a chat: "dc:g<guildId>:l<channelId>". The bound home is the lobby channel's chat id.
export function dcChat(guildId: string, channelId: string): ChatId {
  return `${DC_PREFIX}g${snowflake(guildId, 'guild id')}:l${snowflake(channelId, 'channel id')}` as ChatId
}

// The owner's private chat with the bot: "dc:d<dmChannelId>".
export function dcDm(channelId: string): ChatId {
  return `${DC_PREFIX}d${snowflake(channelId, 'channel id')}` as ChatId
}

// A user: "dc:<userId>". The same shape as a thread id; the brain never mixes the two.
export function dcUser(userId: string): UserId {
  return `${DC_PREFIX}${snowflake(userId, 'user id')}` as UserId
}

export function isDcId(id: string): boolean {
  return MSG_RE.test(id) || HOME_RE.test(id) || DM_RE.test(id) || THREAD_RE.test(id)
}

export function parseDcMessage(id: string): { channelId: string; messageId: string } {
  const m = MSG_RE.exec(id)
  if (!m || !isSnowflake(m[1]!) || !isSnowflake(m[2]!)) throw new Error(`not a Discord message id: ${JSON.stringify(id)}`)
  return { channelId: m[1]!, messageId: m[2]! }
}

export function parseDcThread(id: string): string {
  const m = THREAD_RE.exec(id)
  if (!m || !isSnowflake(m[1]!)) throw new Error(`not a Discord thread id: ${JSON.stringify(id)}`)
  return m[1]!
}

export function parseDcChat(id: string): { guildId: string; channelId: string } {
  const m = HOME_RE.exec(id)
  if (!m || !isSnowflake(m[1]!) || !isSnowflake(m[2]!)) throw new Error(`not a Discord guild chat id: ${JSON.stringify(id)}`)
  return { guildId: m[1]!, channelId: m[2]! }
}

export function parseDcDm(id: string): string {
  const m = DM_RE.exec(id)
  if (!m || !isSnowflake(m[1]!)) throw new Error(`not a Discord DM id: ${JSON.stringify(id)}`)
  return m[1]!
}

// Orders two message ids of one chat by their snowflakes (snowflakes grow with time): negative when a is older, 0 when
// equal, positive when a is newer. Compares BigInts, never Numbers.
export function compareMessages(a: MessageId, b: MessageId): number {
  const x = BigInt(parseDcMessage(a).messageId)
  const y = BigInt(parseDcMessage(b).messageId)
  return x < y ? -1 : x > y ? 1 : 0
}
