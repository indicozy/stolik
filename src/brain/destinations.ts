// Where each outbound message goes in group mode (plan 2.3, design §4.2). Pure: kind and topic in, chat and thread out.
//
import type { ThreadId } from './chat-types.ts'
// Scopes:
//   session  the session's folder topic (one per folder, shared by its sessions): answers, end-of-turn, proactive pings,
//            approvals, questions, plans, files. Without an open topic (the folder has none) it falls back to General;
//            nothing goes to both.
//   inbound  a reply to the message the owner just wrote: the same thread the message came from.
//   general  General: lists, pickers, notes, mode answers, alerts, buttons. No thread id is sent.
//   dm       the bot's private chat with the owner (fallback only, e.g. "use the group").
// In DM mode (no group bound) every kind goes to the DM with no thread, which is today's behaviour.

export type OutScope = 'session' | 'inbound' | 'general' | 'dm'

export const OUT_KINDS = {
  answer: 'session',
  proactive: 'session',
  'end-of-turn': 'session',
  approval: 'session',
  ask: 'session',
  plan: 'session',
  file: 'session',
  typing: 'session',
  reminder: 'session',
  'idle-close': 'session',
  'reply-in-place': 'inbound',
  list: 'general',
  'resume-picker': 'general',
  note: 'general',
  'mode-answer': 'general',
  alert: 'general',
  'route-buttons': 'general',
  'dm-hint': 'dm',
} as const satisfies Record<string, OutScope>

export type OutKind = keyof typeof OUT_KINDS

export type Destination = { chat: 'group' | 'dm'; threadId?: ThreadId }

export function destinationFor(kind: OutKind, ctx: { groupMode: boolean; topicThread: ThreadId | null }): Destination {
  const scope = OUT_KINDS[kind]
  if (scope === 'dm' || !ctx.groupMode) return { chat: 'dm' }
  // General: sending with message_thread_id omitted. The alternative, passing id 1, is what to try if Telegram rejects this.
  if (scope === 'general' || ctx.topicThread === null) return { chat: 'group' }
  return { chat: 'group', threadId: ctx.topicThread }
}
