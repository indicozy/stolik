// Forum topic lifecycle (ticket 22): one topic per folder in group mode. A folder topic belongs to the exact cwd; every
// session in that folder writes into it. Pure: no Telegram, no I/O. The router makes the Telegram calls and stores the record.
//
//   (none) --first session connects in the folder--> open, and it stays open
//
// The bot never closes or deletes a folder topic: a session ending changes nothing. A topic that Telegram says is gone
// becomes 'deleted', and the folder's next session gets a new topic. Records from before one topic per folder have no cwd
// (legacy) and are kept as they are. 'closed' is never written: an older build's closed record is reopened once at start
// (reopenClosedTopics in router/topics.ts).
import { basename, dirname } from 'node:path'
import { assignName, type SessionKey } from './sessions.ts'
import { chatErrorOf, type ThreadId } from './chat-types.ts'
import { legacyMsgId, storedId } from '../adapters/legacy-ids.ts'
import { parseCommandWord } from './commands.ts'

// 'closed' is read only from records an older build wrote (see the header). Nothing writes it now.
export type TopicState = 'open' | 'closed' | 'deleted'

export type TopicRec = {
  threadId: ThreadId
  name: string
  project: string
  // The folder (exact cwd) the topic belongs to. Null: a legacy record, one topic per session (see the header).
  cwd: string | null
  // Legacy only: the session of a per-session topic. Folder topics keep null and never match a session.
  sessionKey: SessionKey | null
  // Legacy only: the backend session id of a per-session topic. Folder topics keep null.
  backendSessionId: string | null
  state: TopicState
  // Not set by new records (null). Kept in the store schema; an old value is read as it is.
  endedAt: number | null
  // Always null: no topic has a deadline. Kept in the store schema.
  deleteAt: number | null
}

// The name of a folder's topic: its basename. If a topic that still exists has that name, parent/basename; then #N.
export function folderTopicName(cwd: string, recs: readonly TopicRec[]): string {
  const taken = new Set(recs.filter((r) => r.state !== 'deleted').map((r) => r.name))
  const base = basename(cwd) || cwd
  if (!taken.has(base)) return base
  return assignName(`${basename(dirname(cwd))}/${base}`, taken)
}

export function newTopic(threadId: ThreadId, name: string, project: string, cwd: string): TopicRec {
  return { threadId, name, project, cwd, sessionKey: null, backendSessionId: null, state: 'open', endedAt: null, deleteAt: null }
}

// What a folder's session connecting needs: nothing (the folder already has a topic that is not deleted), or a new topic
// with its name. A closed record counts as a topic: it is reopened at start, never replaced.
export type ConnectPlan = { effect: 'none' } | { effect: 'create'; name: string }

export function connectPlan(recs: readonly TopicRec[], input: { cwd: string }): ConnectPlan {
  if (recs.some((r) => r.state !== 'deleted' && r.cwd === input.cwd)) return { effect: 'none' }
  return { effect: 'create', name: folderTopicName(input.cwd, recs) }
}

// The open topic of a folder, or undefined.
export function openTopicOfDir(recs: readonly TopicRec[], cwd: string): TopicRec | undefined {
  return recs.find((r) => r.state === 'open' && r.cwd === cwd)
}

// A message in a folder topic that starts a new session: `/new` or `/new <text>` (also `/new@<botname>`). Returns the text
// after it (trimmed, '' when there is none), or null for any other message.
export function parseNewCommand(text: string): { body: string } | null {
  const c = parseCommandWord(text)
  if (!c || c.word.toLowerCase() !== 'new') return null
  return { body: c.arg }
}

// Stored as JSON text in the store. Anything that does not parse as a topic record is dropped. Records without a cwd
// are legacy records (cwd null).
export function parseTopics(json: string): TopicRec[] {
  if (!json.trim()) return []
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  return raw.filter(isTopicRec).flatMap((r) => {
    const threadId = storedId(r.threadId, legacyMsgId)
    return threadId === null ? [] : [{ ...r, threadId: threadId as ThreadId, cwd: r.cwd ?? null, deleteAt: null }]
  })
}

export function serializeTopics(recs: readonly TopicRec[]): string {
  return JSON.stringify(recs, null, 2) + '\n'
}

// The record as it is on disk: the thread id is a string ("tg:<n>"), or a bare number from before MIGRATION_V6.
function isTopicRec(v: unknown): v is Omit<TopicRec, 'threadId'> & { threadId: string | number } {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    (typeof r.threadId === 'number' || typeof r.threadId === 'string') &&
    typeof r.name === 'string' &&
    typeof r.project === 'string' &&
    (typeof r.cwd === 'string' || r.cwd === null || r.cwd === undefined) &&
    (typeof r.sessionKey === 'number' || typeof r.sessionKey === 'string' || r.sessionKey === null) &&
    (typeof r.backendSessionId === 'string' || r.backendSessionId === null) &&
    (r.state === 'open' || r.state === 'closed' || r.state === 'deleted') &&
    (typeof r.endedAt === 'number' || r.endedAt === null) &&
    (typeof r.deleteAt === 'number' || r.deleteAt === null)
  )
}

// The text of an error, for logs and tests.
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message
  return typeof e === 'string' ? e : String(e)
}

// Telegram's answer when a topic is gone (deleted by hand, or never there): the adapter's ChatError 'thread-closed'.
// A send to it must not be retried there.
export function isThreadGone(e: unknown): boolean {
  return chatErrorOf(e)?.kind === 'thread-closed'
}

// Telegram's answer when a topic is already in the state asked for (reopen an open topic, close a closed one): the
// adapter's ChatError 'not-modified'. That is success, not a failure: the state the caller wanted holds.
export function isTopicNotModified(e: unknown): boolean {
  return chatErrorOf(e)?.kind === 'not-modified'
}
