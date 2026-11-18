// Approval bookkeeping shared by the socket, ask, timer and verdict handlers: the pending-prompt marker files (plan 1.2)
// and the chat-log lines of approval messages. Kept apart from the handlers so they can import it without a cycle.
import { clearPendingMarker, setPendingMarker } from '../adapters/hooks/pending-marker.ts'
import type { MessageId, SendTarget } from '../brain/chat-types.ts'
import { errMsg } from './log.ts'
import { logOutgoing } from './send.ts'
import type { RecentPerm } from './shared.ts'
import type { Session } from './state.ts'
import type { Router } from './core.ts'

// The marker of a Claude pid exists while it has a pending permission prompt, and not otherwise (plan 1.2).
export function syncPendingMarker(router: Router, pid: number | null): void {
  if (pid === null) return
  const waiting = [...router.pending.values()].some((x) => x.session.pid === pid)
  try {
    if (waiting) setPendingMarker(pid)
    else clearPendingMarker(pid)
  } catch (e) {
    router.logger.log(`pending marker not updated: ${errMsg(e)}`)
  }
}

// Chat log line for a message sent into a session's destination (its topic, or General when it has none).
export function logSessionOut(router: Router, s: Session, to: SendTarget, kind: string, text: string, messageId: MessageId): void {
  logOutgoing(router, { kind, text, target: { type: 'session', name: s.name }, topic_id: to.thread ?? null, tg_message_id: messageId })
}

// How long a Permission message that ended without a seen verdict still takes the terminal's verdict (RecentPerm).
export const RECENT_PERM_TTL_MS = 10 * 60_000
const RECENT_PERM_MAX = 50

// Drops the entries past their TTL (by the clock at the call).
export function pruneRecentPerms(router: Router): void {
  const now = router.clock.now()
  for (let i = router.recentPerms.length - 1; i >= 0; i--) {
    if (now - router.recentPerms[i].at > RECENT_PERM_TTL_MS) router.recentPerms.splice(i, 1)
  }
}

// Remembers a Permission message whose prompt ended without a seen verdict. The oldest go first past the cap.
export function rememberRecentPerm(router: Router, entry: Omit<RecentPerm, 'at'>): void {
  pruneRecentPerms(router)
  router.recentPerms.push({ ...entry, at: router.clock.now() })
  if (router.recentPerms.length > RECENT_PERM_MAX) router.recentPerms.splice(0, router.recentPerms.length - RECENT_PERM_MAX)
}
