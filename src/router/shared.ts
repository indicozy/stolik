// Shared router types, constants and small helpers (moved out of core.ts; behaviour unchanged).
import { randomBytes } from 'node:crypto'
import type { Inbound } from '../brain/chat-types.ts'
import type { ResumeItem } from '../brain/resume.ts'
import type { SocketConn } from '../ports.ts'
import type { CallKey } from '../brain/posttool.ts'
import type { AskInput } from './ask.ts'
import type { PermissionDetails, Session } from './state.ts'
import { MINUTE } from '../brain/common.ts'
import type { MessageId } from '../brain/chat-types.ts'

export const SPAWN_TIMEOUT_MS = 90_000
export const SWEEP_MS = 30_000
export const MAX_INBOUND_BYTES = 20 * 1024 * 1024
export const PENDING_CAP = 200
export const TYPING_REFRESH_MS = 4_000
export const LOCK_TEXT = '🔒 locked — unlock at the desk with `stolik-ctl unlock`'
export const ASK_BACK_TEXT = '🖥 back at the desk — answer in the terminal'
export const ASK_CANCELLED_TEXT = '✖ cancelled'
// The idle close warning comes this long before the close (idle close: the session is closed at idleCloseMinutes).
export const IDLE_WARN_MS = 5 * MINUTE

// The idle warning posted in a session's topic, kept until it is closed or the session shows activity. messageId null while
// the send is still in flight.
export type IdleWarning = { messageId: MessageId | null; at: number; text: string }

export type PendingPerm = {
  session: Session
  // null while the prompt's send is still in flight (the entry is in router.pending before the send).
  messageId: MessageId | null
  text: string
  details: PermissionDetails
  // Fixed when the request arrives: a redacted request can never be allowed from Telegram.
  redacted: boolean
  createdAt: number
  // One reminder reply is sent at half the TTL (approvalReminderDue).
  reminded: boolean
}

// A delivery ready to send: the body the session gets, and the meta keys. Media is downloaded (and
// transcribed) before the route is known, so a routed message is not fetched twice.
export type Prepared = { body: string; meta: Record<string, string> }

// A PermissionRequest hook waiting for the user's answer in Telegram. `conn` is the hook's connection; the
// decision goes back on it. `messageIds` are the Telegram messages that belong to the ask (swipe-replies to any
// of them answer it); `text` is the last message's text, without its buttons.
export type PendingAsk = {
  id: string
  // The mod's id for a raced dialog (see AskMsg.raceId): ask_resolved finds the ask by it.
  raceId?: string
  input: AskInput
  toolInput: unknown
  session: Session
  conn: SocketConn
  createdAt: number
  messageIds: MessageId[]
  text: string
  // AskUserQuestion only: the question being asked, the picks so far (multi-select), the answers so far.
  qIdx: number
  selected: Set<number>
  answers: Record<string, string>
  reminded: boolean
}

// A permission message whose prompt ended without a verdict from the terminal the router saw: a released or dropped Permission
// ask, or a channel prompt the sweep expired. A PermResolved within RECENT_PERM_TTL_MS edits it with the verdict. Either
// `key` (a hook ask's exact input) or `preview` (a channel prompt's input preview) matches the call.
export type RecentPerm = {
  pid: number | null
  tool_name: string
  key: CallKey | null
  preview: string | null
  messageId: MessageId
  text: string
  at: number
}

// The /resume buttons of one list: the items, by button index. Expires after RESUME_PENDING_TTL_MS.
export type PendingResume = { items: ResumeItem[]; createdAt: number }

export type SpawnQueue = {
  project: string
  // The folder the session starts in (a realpath): the key of the queue in Router.spawns.
  real: string
  tmuxName: string
  items: Array<{ m: Inbound; content: string; prepared?: Prepared }>
  timer: unknown
  // Set by /resume: the transcript id being resumed (its closed topic is reopened on registration).
  resumeOf?: string
  // The arguments the session was started with after the launcher (New with Read-only, /resume): for forensics.
  extraArgs?: readonly string[]
  // Given to the session in its tmux environment; only the register that echoes it takes this queue (spawn.ts).
  token: string
  // The pane's process, once known: the fallback match for a register that carries no token (spawn.ts).
  panePid: number | null
}

// A plain message or a New request waiting on the user (design §4.4). Modes:
//   delivered  forwarded to the one active session (or a name matched it); its "wrong one?" button is live.
//   moving     "wrong one?" was tapped: the other sessions are offered (candidates).
//   ask        the buttons: sessions (candidates), New, quick, read, web.
//   folder     New (or Other…) was tapped: the folder picker (folders).
//   launch     a folder is chosen (folder): [Read-only] [Full].
//   confirm    a name or the model preselected a target: pick (a session, [Yes] [Other…]) or folder ([Full] [Read-only]
//              [Other…]); candidates are the live sessions for Other….
//   started    a folder's session was started by the router (tmuxName); "wrong one?" offers Stop it and the picker.
export type RoutePending = {
  m: Inbound
  prepared: Prepared
  mode: 'ask' | 'delivered' | 'moving' | 'folder' | 'launch' | 'started' | 'confirm'
  messageId: MessageId
  text: string
  // ask / moving / confirm: session buttons index into this list (confirm: the live sessions for Other…). Other modes: unused.
  candidates: Session[]
  // delivered / moving: the session the message went to first.
  from?: Session
  // confirm: the session a name or the model preselected (a session confirm).
  pick?: Session
  // confirm: how the target was chosen (audit only: the source is "match" or "model").
  via?: { source: 'match' | 'model'; reason: string; confidence?: number }
  // folder: the folders the picker offers, by button index.
  folders: string[]
  // folder: the page of the picker on the message (0-based).
  page?: number
  // launch / confirm / started: the folder the session starts in.
  folder: string | null
  // started: the tmux session the router started (for Stop it).
  tmuxName?: string
  createdAt: number
}

export type Answer = (t?: string) => Promise<void>

export function newRouteId(): string {
  return randomBytes(4).toString('hex')
}

export function lastMessageId(a: PendingAsk): MessageId | undefined {
  return a.messageIds[a.messageIds.length - 1]
}

export function notConnected(s: Session): string {
  return `${s.name} is not connected right now. Try again in a moment.`
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

export function metaSafe(v: string): string {
  return v.replace(/[^A-Za-z0-9 _.@-]/g, '_').slice(0, 64)
}
