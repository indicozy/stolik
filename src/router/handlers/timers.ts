// Router housekeeping: boot announcement, the periodic sweep, approval reminders and expiry.
import { RESUME_PENDING_TTL_MS } from '../../brain/resume.ts'
import { TRACE_KEEP_MS } from '../../brain/observe.ts'
import { ASK_TTL_MS } from '../ask.ts'
import { releaseAsk } from './ask.ts'
import { legacyMsgId, storedId } from '../../adapters/legacy-ids.ts'
import type { MessageId } from '../../brain/chat-types.ts'
import { announceTerminated, closeOrphanTopics, inTopic, onSessionEnded, sendTarget } from '../topics.ts'
import type { Session } from '../state.ts'
import { expireRoute } from './route.ts'
import { errMsg } from '../log.ts'
import { ASK_BACK_TEXT, lastMessageId, type PendingPerm, type PendingAsk } from '../shared.ts'
import { PERMISSION_TTL_MS, permissionExpired, bootAnnouncementText, BOOT_ANNOUNCE_RETRY_MS, shouldAnnounceBoot, APPROVAL_EXPIRED_TEXT, approvalReminderDue, approvalReminderText } from '../state.ts'
import { logOutgoing } from '../send.ts'
import { logSessionOut, rememberRecentPerm, syncPendingMarker } from '../approvals.ts'
import { idleAlertText } from '../../brain/away.ts'
import { sweepIdle } from '../close.ts'
import type { Router } from '../core.ts'

// Once per process, when polling starts. The send is outbound-only: not gated by presence or /lock,
// not recorded in msgMap, and silent.
export function announceBoot(router: Router): void {
  if (router.bootStarted) return
  router.bootStarted = true
  // Unpaired: there is no owner chat to say it in (the start log line says so).
  if (!router.paired) return
  void sendBootAnnouncement(router, 0)
}

// Sends the message only when the boot id differs from the saved one, and saves the id after a successful send.
export async function sendBootAnnouncement(router: Router, attempt: number): Promise<void> {
  const bootId = router.platform.bootId()
  const lastBootId = router.store.readLastBootId()
  const uptimeSec = router.platform.uptimeSeconds()
  if (uptimeSec === null || !shouldAnnounceBoot(bootId, lastBootId)) return
  const text = bootAnnouncementText({ nowMs: router.clock.now(), uptimeSec, sessions: router.registry.list().length })
  try {
    const id = await router.chat.sendText(text, { silent: true })
    logOutgoing(router, { kind: 'notice', text, tg_message_id: id })
  } catch (e) {
    const delay = BOOT_ANNOUNCE_RETRY_MS[attempt]
    if (delay === undefined) {
      router.logger.log(`boot announcement given up after ${attempt + 1} attempts: ${errMsg(e)}`)
      return
    }
    router.logger.log(`boot announcement failed, retrying in ${delay / 1000}s: ${errMsg(e)}`)
    router.bootTimer = router.clock.setTimer(() => {
      router.bootTimer = null
      void sendBootAnnouncement(router, attempt + 1)
    }, delay)
    return
  }
  try {
    router.store.writeBootId(bootId)
  } catch (e) {
    router.logger.log(`boot id not saved: ${errMsg(e)}`)
  }
}

const TRACE_PRUNE_MS = 3_600_000
// Messages that carried a keyboard when the last run stopped: their buttons no longer lead anywhere, so the keyboards
// are removed (the text stays). Queued like any other edit, so the removals are rate-limited.
export function stripStaleKeyboards(router: Router): void {
  let raw = ''
  try {
    raw = router.store.readLiveButtons?.() ?? ''
  } catch (e) {
    router.logger.log(`stale keyboards not read: ${errMsg(e)}`)
    return
  }
  if (!raw.trim()) return
  let list: unknown
  try {
    list = JSON.parse(raw)
  } catch {
    list = []
  }
  // An item's message id is a string, or a bare number from before MIGRATION_V6.
  const items = (Array.isArray(list) ? list : [])
    .flatMap((x: { messageId?: unknown; dm?: unknown } | null) => {
      const id = storedId(x?.messageId, legacyMsgId)
      return id !== null && typeof x?.dm === 'boolean' ? [{ messageId: id as MessageId, dm: x.dm }] : []
    })
    .slice(0, KEYBOARD_STRIP_MAX)
  try {
    router.store.writeLiveButtons?.('[]')
  } catch (e) {
    router.logger.log(`keyboards not cleared in store: ${errMsg(e)}`)
  }
  if (items.length === 0) return
  router.logger.log(`removing ${items.length} keyboards left from the last run`)
  for (const it of items) {
    router.chat.clearButtons?.(it.messageId, { dm: it.dm }).catch(() => {})
  }
}

// At most this many stale keyboards are cleared at start (the queue spaces them out).
const KEYBOARD_STRIP_MAX = 100

export function sweep(router: Router): void {
  const now = router.clock.now()
  router.agent.sweep()
  if (router.traces && now - router.lastTracePrune >= TRACE_PRUNE_MS) {
    router.lastTracePrune = now
    try {
      router.traces.pruneTraces(now - TRACE_KEEP_MS)
    } catch (e) {
      router.logger.log(`trace map prune failed: ${errMsg(e)}`)
    }
  }
  // Sessions of non-interactive claude runs are dropped (they exit on their own anyway).
  for (const s of router.registry.list()) {
    if (s.pid === null || router.agent.isInteractive(s.pid)) continue
    router.registry.remove(s.key)
    router.agent.dropSession(s.key)
    for (const [conn, owner] of router.connSession) if (owner === s) router.connSession.delete(conn)
    void onSessionEnded(router, s)
  }
  // A session lives while its pid runs with the same start time (a reused pid is a different process).
  const alive = (pid: number, start: string) => {
    if (!router.platform.pidAlive(pid)) return false
    const now = router.platform.processStart(pid)
    return start === '' || now === null || now === start
  }
  for (const s of router.registry.sweep(now, alive)) {
    // Before onSessionEnded, so the notice still has its topic to go to.
    announceTerminated(router, s)
    void onSessionEnded(router, s)
  }
  // After the registry sweep, so a session that just died is not warned or closed.
  sweepIdle(router, now)
  void checkIdleSource(router)
  // Orphan topics (a router restart left them open) are checked on the sweep too, once the reconnect grace is over.
  if (router.orphanChecksOn) void closeOrphanTopics(router)
  const live = router.registry.list()
  for (const [id, p] of router.pending) {
    if (permissionExpired(p, now) || !live.includes(p.session)) {
      router.pending.delete(id)
      syncPendingMarker(router, p.session.pid)
      // The terminal may still answer this prompt: a PermResolved within RECENT_PERM_TTL_MS edits the message with the verdict.
      // A prompt still in flight has no message yet: nothing to remember, edit or log.
      if (p.messageId !== null) {
        rememberRecentPerm(router, { pid: p.session.pid, tool_name: p.details.tool_name, key: null, preview: p.details.input_preview, messageId: p.messageId, text: p.text })
        router.chat.editText(p.messageId, `${p.text}\n\n${APPROVAL_EXPIRED_TEXT}`, null).catch(() => {})
        logSessionOut(router, p.session, sendTarget(router, 'approval', p.session), 'expired', APPROVAL_EXPIRED_TEXT, p.messageId)
      }
    }
  }
  for (const p of router.pending.values()) {
    if (approvalReminderDue(p, now)) remindPerm(router, p, now)
  }
  for (const [id, p] of router.routePending.expired(now)) expireRoute(router, id, p)
  for (const [id, p] of router.resumes) if (now - p.createdAt > RESUME_PENDING_TTL_MS) router.resumes.delete(id)
  if (router.asks.size > 0) void sweepAsks(router, now)
}

// Expired asks are released. Pending asks are released once the user is back at the desk; while still away,
// they get their reminder.
export async function sweepAsks(router: Router, now: number): Promise<void> {
  for (const a of [...router.asks.values()]) {
    if (now - a.createdAt > ASK_TTL_MS) releaseAsk(router, a, APPROVAL_EXPIRED_TEXT, 'expired')
  }
  if (router.asks.size === 0) return
  // Only a known away keeps the asks here; unknown idle time releases them to the terminal.
  if ((await router.platform.awayState()) === 'idle') {
    for (const a of [...router.asks.values()]) if (approvalReminderDue(a, now, ASK_TTL_MS)) remindAsk(router, a, now)
    return
  }
  for (const a of [...router.asks.values()]) releaseAsk(router, a, ASK_BACK_TEXT, 'released')
}

// Reads the idle source once per sweep, so its hold and alert state stay current, and posts the one-shot alert
// (source down for 5 minutes, or readable again) in General.
export async function checkIdleSource(router: Router): Promise<void> {
  await router.platform.awayState()
  const alert = router.platform.takeIdleAlert()
  if (alert === null) return
  const text = idleAlertText(alert)
  try {
    const id = await router.chat.sendText(text)
    logOutgoing(router, { kind: 'notice', text, tg_message_id: id })
  } catch (e) {
    router.logger.log(`idle alert failed: ${errMsg(e)}`)
  }
}

// Reminder replies, sent once per approval. They are not edits: the prompt keeps its buttons.
export function remindPerm(router: Router, p: PendingPerm, now: number): void {
  p.reminded = true
  if (p.messageId === null) return
  sendReminder(router, p.messageId, PERMISSION_TTL_MS - (now - p.createdAt), p.session)
}

export function remindAsk(router: Router, a: PendingAsk, now: number): void {
  const id = lastMessageId(a)
  if (id === undefined) return
  a.reminded = true
  sendReminder(router, id, ASK_TTL_MS - (now - a.createdAt), a.session)
}

export function sendReminder(router: Router, replyTo: MessageId, remainingMs: number, s: Session): void {
  const text = approvalReminderText(remainingMs)
  const to = { ...sendTarget(router, 'reminder', s), session: String(s.key) }
  inTopic(router, s, to, (t) => router.chat.sendText(text, { replyTo, ...t }))
    .then((sent) => logSessionOut(router, s, sent.to, 'reminder', text, sent.value))
    .catch((e) => router.logger.log(`reminder failed: ${errMsg(e)}`))
}
