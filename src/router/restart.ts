// Restart bookkeeping: the router starts with no pending prompt, so the marker files of an earlier router are stale; on
// a clean stop, every open approval prompt is edited to say the answer is at the desk. The prompts themselves are not
// persisted here (see the report of the approvals fix).
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { clearPendingMarker, pendingDir } from '../adapters/hooks/pending-marker.ts'
import { BRIDGE_RESTART_TEXT } from '../brain/approvals.ts'
import { errMsg } from './log.ts'
import { lastMessageId } from './shared.ts'
import type { Router } from './core.ts'

// Removes every marker file in the pending folder. Returns how many were removed. A missing folder is fine.
export function clearStaleMarkers(dir: string = pendingDir()): number {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    try {
      rmSync(join(dir, name), { force: true })
      removed++
    } catch {
      // A marker that cannot be removed is left; the next start tries again.
    }
  }
  return removed
}

// Edits every open approval prompt (tool permissions and AskUserQuestion / plan asks) to the restart note, without
// buttons, and drops the markers of their sessions. Failed edits are ignored: the stop goes on.
export async function closeOpenApprovals(router: Router): Promise<void> {
  const edits: Promise<void>[] = []
  for (const p of router.pending.values()) {
    if (p.messageId !== null) edits.push(router.chat.editText(p.messageId, `${p.text}\n\n${BRIDGE_RESTART_TEXT}`, null, 'urgent'))
    if (p.session.pid !== null) {
      try {
        clearPendingMarker(p.session.pid)
      } catch (e) {
        router.logger.log(`marker not removed at stop: ${errMsg(e)}`)
      }
    }
  }
  for (const a of router.asks.values()) {
    const id = lastMessageId(a)
    if (id !== undefined) edits.push(router.chat.editRows(id, `${a.text}\n\n${BRIDGE_RESTART_TEXT}`, [], 'urgent'))
  }
  router.pending.clear()
  router.asks.clear()
  const results = await Promise.allSettled(edits)
  for (const r of results) {
    if (r.status === 'rejected') router.logger.log(`restart note not sent: ${errMsg(r.reason)}`)
  }
}
