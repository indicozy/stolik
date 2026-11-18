// Closing a session: the idle sweep (warning, then close) and the owner's request. A session's process is stopped the
// way it was started: a tmux session by its name, anything else by signal, and its terminal window goes too when that
// window hosted nothing else.
import { readFileSync } from 'node:fs'
import { latestTranscriptMtime, transcriptPath } from '../adapters/transcripts.ts'
import type { ButtonPress } from '../brain/chat-types.ts'
import { MINUTE } from '../brain/common.ts'
import { idleVerdict, type IdleVerdict } from '../brain/idle.ts'
import { logSessionOut } from './approvals.ts'
import { errMsg } from './log.ts'
import type { Router } from './core.ts'
import { IDLE_WARN_MS, type IdleWarning } from './shared.ts'
import type { Session } from './state.ts'
import { inTopic, sendTarget } from './topics.ts'

// After SIGTERM, a claude process still alive this long later is killed with SIGKILL.
export const CLOSE_KILL_MS = 10_000

// Callback data of the warning's [Keep open] button. Telegram allows 64 bytes; a longer key gets no warning at all.
const KEEP_OPEN_PREFIX = 'ic:k:'
const KEEP_OPEN_MAX_BYTES = 64

export function parseIdleKeepCallback(data: string): string | null {
  const m = /^ic:k:(.+)$/.exec(data)
  return m ? m[1] : null
}

// Closes a session once. The key stays in router.closing until the session leaves the registry, so the sweep and a
// request cannot both close it while the process is still dying. Returns false when nothing could be closed.
export async function closeSession(router: Router, s: Session, reason: 'idle' | 'request'): Promise<boolean> {
  if (router.closing.has(s.key)) return false
  const tmux = router.tmuxBySession.get(s.key)
  if (tmux === undefined && s.pid === null) return false
  router.closing.add(s.key)
  clearWarning(router, s)
  // A closed session says so in its own notice; the "terminated before it finished answering" notice would repeat it.
  s.pendingTg = null
  const text =
    reason === 'idle'
      ? `Closed after ${router.idleCloseMinutes} min idle. Send a message here to start a new session; /resume brings this one back.`
      : 'Closed on request. Send a message here to start a new session; /resume brings this one back.'
  const logKind = reason === 'idle' ? 'idle-close' : 'close-request'
  // The notice is not awaited: it waits in the outbound queue, and the process must not wait for it.
  // The end notice is a status notice: silent. (The idle-close warning below is default level.)
  const notice = inTopic(router, s, sendTarget(router, 'idle-close', s), (t) => router.chat.sendText(text, { ...t, level: 'silent' }))
    .then(({ value, to }) => logSessionOut(router, s, to, logKind, text, value))
    .catch((e) => router.logger.log(`close notice failed: ${errMsg(e)}`))
  if (tmux !== undefined) {
    await router.stopSession(tmux).catch(() => false)
  } else if (s.pid !== null) {
    stopClaude(router, s.pid)
  }
  await notice
  return true
}

// SIGTERM now; after CLOSE_KILL_MS, SIGKILL if still alive, then the terminal window. The window's pid is read before the
// signal, while the process tree still shows it. The window is closed only when the shell that ran claude has no children
// left (a shell still running something keeps its window open). With `terminal -e claude`, the parent is the terminal.
function stopClaude(router: Router, pid: number): void {
  const term = router.platform.terminalWindowPid(pid)
  const parent = router.platform.parentPid(pid)
  router.platform.signal(pid, 'SIGTERM')
  router.clock.setTimer(() => {
    if (router.platform.pidAlive(pid)) router.platform.signal(pid, 'SIGKILL')
    if (term === null || parent === null) return
    const holder = parent === term ? term : parent
    const left = router.platform.childPids(holder)
    if (left !== null && left.length === 0) router.platform.signal(term, 'SIGTERM')
  }, CLOSE_KILL_MS)
}

// The idle sweep, from the router's periodic sweep. A session idle for idleCloseMinutes - 5 min gets the warning (once).
// It is closed once the warning is IDLE_WARN_MS old and the session is still idle at the full limit. Any busy verdict
// clears the warning, so a session that became busy is not closed on the old warning.
export function sweepIdle(router: Router, now: number): void {
  const minutes = router.idleCloseMinutes
  if (minutes === 0) return
  const live = router.registry.list()
  const liveKeys = new Set(live.map((s) => s.key))
  for (const key of router.closing) if (!liveKeys.has(key)) router.closing.delete(key)
  for (const key of router.transcriptVerdict.keys()) if (!liveKeys.has(key)) router.transcriptVerdict.delete(key)
  const idleMs = minutes * MINUTE
  for (const s of live) {
    if (s.pid === null || router.closing.has(s.key)) continue
    const warning = router.idleWarned.get(s.key)
    if (!idleCheck(router, s, s.pid, now, Math.max(0, idleMs - IDLE_WARN_MS)).idle) {
      if (warning) clearWarning(router, s)
      continue
    }
    if (!warning) {
      warnIdle(router, s, now, minutes)
      continue
    }
    // A warning still in flight (messageId null) has not reached the owner yet, so it cannot arm the close.
    if (warning.messageId === null || now - warning.at < IDLE_WARN_MS) continue
    if (idleCheck(router, s, s.pid, now, idleMs).idle) void closeSession(router, s, 'idle')
    else clearWarning(router, s)
  }
}

// The verdict for one session. The process tree and the transcript mtime are read first; the transcript text is read
// only when everything else already says idle, so a busy session never pays for reading its transcript.
// A session kept busy by a pending wake-up stays so for as long as its transcript does not change: its verdict is kept
// per mtime, so the sweep (every 30 s) does not read the same file again.
function idleCheck(router: Router, s: Session, pid: number, now: number, idleMs: number): IdleVerdict {
  const base = {
    // The raw flag, not turnBusy: a turn whose Stop hook never came is busy until its idle_prompt, not after 15 minutes.
    inTurn: s.inTurn,
    procs: descendantsOf(router, pid),
    now,
    idleMs,
    lastActive: s.lastActive,
    lastSentAt: s.lastSentAt,
    latestTranscriptMtime: transcriptMtime(router, s),
  }
  const beforeText = idleVerdict({ ...base, transcriptText: '' })
  if (!beforeText.idle) return beforeText
  const mtime = base.latestTranscriptMtime
  if (mtime === null) return beforeText
  const kept = router.transcriptVerdict.get(s.key)
  if (kept && kept.backendSessionId === s.backendSessionId && kept.mtime === mtime) return kept.verdict
  const text = readTranscript(router, s)
  const verdict = idleVerdict({ ...base, transcriptText: text })
  // Only a transcript that was read is kept: an unreadable one is asked again on the next sweep.
  if (text !== null) router.transcriptVerdict.set(s.key, { backendSessionId: s.backendSessionId, mtime, verdict })
  return verdict
}

// Each read fails closed: an error is the same as an unreadable source, which the verdict counts as busy.
function descendantsOf(router: Router, pid: number): Array<{ pid: number; argv: string[] }> | null {
  try {
    return router.platform.descendants(pid)
  } catch {
    return null
  }
}

function transcriptMtime(router: Router, s: Session): number | null {
  try {
    return latestTranscriptMtime(router.home, s.cwd, s.backendSessionId)
  } catch {
    return null
  }
}

function readTranscript(router: Router, s: Session): string | null {
  try {
    const path = transcriptPath(router.home, s.cwd, s.backendSessionId)
    return path === null ? null : readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function warnIdle(router: Router, s: Session, now: number, minutes: number): void {
  const data = `${KEEP_OPEN_PREFIX}${s.key}`
  // No button, no warning, and so no close: a session the owner cannot keep open is not closed.
  if (Buffer.byteLength(data) > KEEP_OPEN_MAX_BYTES) return
  const text = `💤 Closing this session in 5 min (idle ${minutes} min).`
  // Set before the send, so a sweep that runs while the send is in flight does not warn twice.
  const entry: IdleWarning = { messageId: null, at: now, text }
  router.idleWarned.set(s.key, entry)
  inTopic(router, s, sendTarget(router, 'idle-close', s), (t) =>
    router.chat.sendText(text, { rows: [[{ text: 'Keep open', data }]], ...t }),
  )
    .then(({ value, to }) => {
      if (router.idleWarned.get(s.key) === entry) {
        entry.messageId = value
      } else {
        // Activity came while the warning was in flight: its button comes off now.
        void router.chat.editRows(value, text, []).catch(() => {})
      }
      logSessionOut(router, s, to, 'idle-warning', text, value)
    })
    .catch((e) => {
      if (router.idleWarned.get(s.key) === entry) router.idleWarned.delete(s.key)
      router.logger.log(`idle warning failed: ${errMsg(e)}`)
    })
}

// Drops the warning and its button. The message keeps its text (with `note`, if given).
function clearWarning(router: Router, s: Session, note?: string): void {
  const warning = router.idleWarned.get(s.key)
  if (!warning) return
  router.idleWarned.delete(s.key)
  // In flight (messageId null): warnIdle takes the button off when the send lands.
  if (warning.messageId === null) return
  const text = note ? `${warning.text}\n\n${note}` : warning.text
  void router.chat.editRows(warning.messageId, text, []).catch(() => {})
}

// [Keep open]: the session's idle time starts again, and the warning goes.
export async function onIdleKeepOpen(router: Router, cb: ButtonPress, key: string): Promise<void> {
  const s = router.registry.list().find((x) => String(x.key) === key)
  if (!s) return router.chat.ackButton(cb.pressId, 'That session is no longer running.').catch(() => {})
  if (router.closing.has(s.key)) return router.chat.ackButton(cb.pressId, 'Already closing.').catch(() => {})
  s.lastActive = router.clock.now()
  clearWarning(router, s, 'Kept open.')
  return router.chat.ackButton(cb.pressId, 'Kept open').catch(() => {})
}
