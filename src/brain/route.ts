// Routing of plain General messages (design §4.4) and the store of routes waiting on a button tap. Pure: no I/O.
// The caller checks expiry on a tap and in its sweep.
import { MINUTE } from './common.ts'

// A plain message goes to the only session that was active within this window (last inbound or outbound activity).
export const ACTIVE_WINDOW_MS = 30 * MINUTE
export const ROUTE_PENDING_TTL_MS = 30 * MINUTE
export const ROUTE_PENDING_CAP = 200
// Folder buttons per page of the folder picker.
export const FOLDER_PAGE_SIZE = 8
// What a plain message may do by itself (config routerAutoStart): "confirm" (default) only offers buttons, "auto" may
// start a folder's session at once when its name leads the message, "off" never asks the route addon and never matches
// names (the 30-minute rule and the buttons remain).
export type RouterAutoStart = 'confirm' | 'auto' | 'off'
// At most one auto-start in this window; a later one is offered as buttons.
export const AUTO_START_GAP_MS = 5 * MINUTE

// True when an auto-start may happen at `now`, given the time of the last one (-Infinity when none was made).
export function autoStartAllowed(lastAt: number, now: number): boolean {
  return now - lastAt >= AUTO_START_GAP_MS
}

export type Activity = { lastActive: number; lastSentAt: number }

// The later of a session's last inbound or turn activity and its last outbound send.
export function lastActivity(s: Activity): number {
  return Math.max(s.lastActive, s.lastSentAt)
}

// The sessions active within ACTIVE_WINDOW_MS at `now`. Exactly 30 minutes ago still counts; 30 min + 1 ms does not.
export function activeSessions<T extends Activity>(list: readonly T[], now: number): T[] {
  return list.filter((s) => now - lastActivity(s) <= ACTIVE_WINDOW_MS)
}

// The session a plain message is forwarded to: the one active session, when there is exactly one. Otherwise null
// (zero or several active sessions, or one that is not active): the user picks from buttons.
export function plainTarget<T extends Activity>(list: readonly T[], now: number): T | null {
  const active = activeSessions(list, now)
  return active.length === 1 ? active[0] : null
}

// Every trusted folder for the picker: master first, then the folders with the newest Claude activity (`recency`: folder
// to the newest transcript mtime in ms, most recent first), then the rest by path. Pure.
export function orderFolders(dirs: readonly string[], master: string, recency: ReadonlyMap<string, number>): string[] {
  const uniq = [...new Set(dirs)]
  const rank = (d: string): number => (d === master ? 0 : (recency.get(d) ?? 0) > 0 ? 1 : 2)
  return uniq.sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    if (ra === 1) return (recency.get(b) ?? 0) - (recency.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0)
    return a < b ? -1 : a > b ? 1 : 0
  })
}

// The page of a list shown `size` at a time. The page asked for is clamped to the pages that exist.
export function folderPage(total: number, page: number, size: number = FOLDER_PAGE_SIZE): { page: number; pages: number; start: number; end: number } {
  const pages = Math.max(1, Math.ceil(total / size))
  const p = Math.min(Math.max(0, Math.trunc(page)), pages - 1)
  return { page: p, pages, start: p * size, end: Math.min(total, p * size + size) }
}

// Entries keyed by id, capped (the oldest is dropped first) and expiring after the TTL.
export class RoutePendingStore<T extends { createdAt: number }> {
  private readonly items = new Map<string, T>()
  private readonly cap: number
  private readonly ttlMs: number

  constructor(cap: number = ROUTE_PENDING_CAP, ttlMs: number = ROUTE_PENDING_TTL_MS) {
    this.cap = cap
    this.ttlMs = ttlMs
  }

  put(id: string, p: T): void {
    if (this.items.size >= this.cap) {
      const oldest = this.items.keys().next().value
      if (oldest !== undefined) this.items.delete(oldest)
    }
    this.items.set(id, p)
  }

  get(id: string): T | undefined {
    return this.items.get(id)
  }

  delete(id: string): void {
    this.items.delete(id)
  }

  size(): number {
    return this.items.size
  }

  // Past the TTL at `now`. Strictly older than the TTL: an entry exactly at the TTL is still live.
  isExpired(p: T, now: number): boolean {
    return now - p.createdAt > this.ttlMs
  }

  // Entries past the TTL at `now`, oldest first. They stay in the store until the caller deletes them.
  expired(now: number): Array<[string, T]> {
    const out: Array<[string, T]> = []
    for (const [id, p] of this.items) if (this.isExpired(p, now)) out.push([id, p])
    return out
  }
}
