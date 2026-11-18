// Message id -> session map (replies and swipe-replies find their session through it). No I/O.
import type { Session, SessionKey } from './sessions.ts'
import type { MessageId, ThreadId } from './chat-types.ts'
import { legacyMsgId, storedId } from '../adapters/legacy-ids.ts'

export const MSG_MAP_CAP = 5000

// `thread` is the forum topic the message was sent into (null: General or a DM). Entries from before topics were
// per folder have none.
export type MsgEntry = { key: SessionKey; name: string; cwd: string; thread?: ThreadId | null }
export type ReplyRef = { status: 'live'; session: Session } | { status: 'dead'; name: string }

// ---------- message -> session map ----------

export class MsgMap {
  private readonly entries = new Map<MessageId, MsgEntry>()
  private readonly cap: number

  constructor(cap: number = MSG_MAP_CAP) {
    this.cap = cap
  }

  record(messageId: MessageId, entry: MsgEntry): void {
    this.entries.delete(messageId)
    this.entries.set(messageId, entry)
    while (this.entries.size > this.cap) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  get(messageId: MessageId): MsgEntry | undefined {
    return this.entries.get(messageId)
  }

  size(): number {
    return this.entries.size
  }

  // The entry of the last session message sent into `thread` before the message `before` (the highest message id below
  // it). `compare` orders the ids of the chat (the port's compareMessages): a message the session posts after the user's
  // message does not count.
  lastInThread(thread: ThreadId | null, before: MessageId, compare: (a: MessageId, b: MessageId) => number): MsgEntry | undefined {
    let bestId: MessageId | null = null
    let best: MsgEntry | undefined
    for (const [id, e] of this.entries) {
      if (e.thread !== thread || compare(id, before) >= 0) continue
      if (bestId === null || compare(id, bestId) > 0) {
        bestId = id
        best = e
      }
    }
    return best
  }

  serialize(): string {
    return JSON.stringify([...this.entries])
  }
}

// Parses a persisted map. Invalid input yields an empty map. An entry keyed by a bare pid (the pre-v3 identity) is kept:
// its key never matches a session again, but resolveMsgRef still finds the session by name and folder.
export function loadMsgMap(json: string, cap: number = MSG_MAP_CAP): MsgMap {
  const map = new MsgMap(cap)
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return map
    for (const item of parsed) {
      if (!Array.isArray(item) || item.length !== 2) continue
      const [rawId, e] = item
      const id = storedId(rawId, legacyMsgId)
      if (id === null || !e || typeof e !== 'object') continue
      const entry = e as Record<string, unknown>
      if (
        (typeof entry.key !== 'number' && typeof entry.key !== 'string') ||
        typeof entry.name !== 'string' ||
        typeof entry.cwd !== 'string'
      ) continue
      const base = { key: entry.key as SessionKey, name: entry.name, cwd: entry.cwd }
      const thread = storedId(entry.thread, legacyMsgId)
      map.record(id as MessageId, thread === null ? base : { ...base, thread: thread as ThreadId })
    }
  } catch {
    return new MsgMap(cap)
  }
  return map
}

// Resolves a stored message mapping to a live session. The key must match and the folder must be the same (a key is
// per process, but the folder check guards against a key reused by another session). Failing that, name+cwd: keys can
// change across restarts. Otherwise dead.
export function resolveMsgRef(entry: MsgEntry | undefined, live: Session[]): ReplyRef | null {
  if (!entry) return null
  const exact = live.find((s) => s.key === entry.key && s.cwd === entry.cwd)
  if (exact) return { status: 'live', session: exact }
  const same = live.find((s) => s.name === entry.name && s.cwd === entry.cwd)
  if (same) return { status: 'live', session: same }
  return { status: 'dead', name: entry.name }
}
