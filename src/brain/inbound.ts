// Inbound decisions (plan 2.1, design §4.1): which chat and which sender an update may use. Pure, no I/O.
// The owner check is on `from.id`: an admin bot sees every group message, so the chat id alone is not enough.
// The router applies the decision; the chat adapter already drops messages and taps from other users.

import type { ChatEvent, ChatId, ChatRef } from './chat-types.ts'
import { parseCommandWord } from './commands.ts'

export type InboundInput = {
  // A message (text or media) or a button tap.
  update: 'message' | 'callback'
  chatKind: ChatRef['kind']
  // The chat id as a string ('' when unknown).
  chatId: string
  // The sender's user id as a string ('' when unknown).
  fromId: string
  ownerUserId: string
  // The bound home, or null in DM mode.
  groupId: ChatId | null
  // Message text ('' for media). Only `/bind` matters here.
  text?: string
  // A forwarded message: its `!bind` is data (see parseCommandWord).
  forwarded?: boolean
}

export type InboundDecision =
  | { action: 'route' }
  | { action: 'use-group' }
  | { action: 'bind' }
  | { action: 'ignore' }

export function isBindCommand(text: string | undefined, forwarded = false): boolean {
  return parseCommandWord(text ?? '', forwarded)?.word === 'bind'
}

// Decision table (owner = the sender is the owner; the rest is the chat):
//   owner, home, /bind message              -> bind (any home chat, bound or not)
//   owner, home = bound home                 -> route
//   owner, home other / unbound              -> ignore
//   owner, dm, DM mode (no home)             -> route (today's behaviour)
//   owner, dm, home mode                     -> use-group (message and tap)
//   owner, other chat (basic group, channel) -> ignore
//   not the owner, any chat                  -> ignore
export function decideInbound(input: InboundInput): InboundDecision {
  if (input.fromId === '' || input.fromId !== input.ownerUserId) return { action: 'ignore' }
  if (input.chatKind === 'home') {
    if (input.update === 'message' && isBindCommand(input.text, input.forwarded)) return { action: 'bind' }
    if (input.groupId !== null && input.chatId === input.groupId) return { action: 'route' }
    return { action: 'ignore' }
  }
  if (input.chatKind === 'dm') {
    if (input.groupId === null) return { action: 'route' }
    return { action: 'use-group' }
  }
  return { action: 'ignore' }
}

export type ChatEventDecision =
  | { action: 'set-group'; groupId: ChatId }
  | { action: 'join-alert' }
  | { action: 'access'; access: 'ok' | 'lost'; reason: string }
  | { action: 'anonymous-notice' }
  | { action: 'ignore' }

// Decides what a neutral chat event means for the bound home. The adapter has already filtered member joins (the owner
// and bots never reach here) and classified the bot's rights. Events for other chats are ignored.
export function decideChatEvent(e: ChatEvent, ctx: { groupId: ChatId | null }): ChatEventDecision {
  if (e.type === 'home-moved') {
    return ctx.groupId !== null && e.from === ctx.groupId ? { action: 'set-group', groupId: e.to } : { action: 'ignore' }
  }
  if (ctx.groupId === null || e.chat !== ctx.groupId) return { action: 'ignore' }
  if (e.type === 'unattributable-post') return { action: 'anonymous-notice' }
  if (e.type === 'access') return { action: 'access', access: e.access, reason: e.reason }
  return { action: 'join-alert' }
}
