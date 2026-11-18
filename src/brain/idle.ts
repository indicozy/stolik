// Idle-close detection: when a Claude session counts as idle. Pure logic, no I/O; the caller reads the process tree,
// the transcript and the clock, and passes them in. Every check that cannot run counts as busy, so a wrong guess keeps
// a session open rather than killing one.

// True when the argv is a Claude Code Bash tool shell. Its command line sources a shell snapshot under
// ~/.claude/shell-snapshots, and background (run_in_background) jobs use the same form.
export function isBashToolArgv(argv: string[]): boolean {
  return argv.some((a) => a.includes('/.claude/shell-snapshots/'))
}

// True when the transcript shows a wake-up or cron job the session has scheduled and not yet finished. Only assistant
// entries count. A line that fails to parse is skipped, not an error.
export function pendingSchedule(transcriptJsonl: string): boolean {
  let sawWakeup = false
  let lastWakeupStop = false
  let creates = 0
  let deletes = 0
  for (const line of transcriptJsonl.split('\n')) {
    if (line.trim() === '') continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as { type?: unknown; message?: { content?: unknown } }
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue
    for (const item of e.message.content as Array<{ type?: unknown; name?: unknown; input?: { stop?: unknown } }>) {
      if (item?.type !== 'tool_use') continue
      if (item.name === 'ScheduleWakeup') {
        sawWakeup = true
        lastWakeupStop = item.input?.stop === true
      } else if (item.name === 'CronCreate') {
        creates++
      } else if (item.name === 'CronDelete') {
        deletes++
      }
    }
  }
  return (sawWakeup && !lastWakeupStop) || creates > deletes
}

export type IdleVerdict = { idle: true } | { idle: false; reason: string }

export interface IdleInput {
  // The session is inside a turn (the router has not seen the turn end).
  inTurn: boolean
  // The descendants of the claude process with their argv, or null when the process tree cannot be read.
  procs: Array<{ pid: number; argv: string[] }> | null
  now: number
  // The idle threshold in milliseconds.
  idleMs: number
  // Epoch milliseconds of the last activity the router saw, of the last message sent to the session, and of the
  // newest transcript write (null when unknown).
  lastActive: number
  lastSentAt: number
  latestTranscriptMtime: number | null
  // The transcript's text, or null when it cannot be read.
  transcriptText: string | null
}

// The most recent activity time. The transcript mtime counts too: a session can write without the router seeing it.
export function lastActivityAt(input: {
  lastActive: number
  lastSentAt: number
  latestTranscriptMtime: number | null
}): number {
  return Math.max(input.lastActive, input.lastSentAt, input.latestTranscriptMtime ?? 0)
}

// Idle only when every check says so. The first busy reason wins, in this order.
export function idleVerdict(input: IdleInput): IdleVerdict {
  if (input.inTurn) return { idle: false, reason: 'in turn' }
  if (input.procs === null) return { idle: false, reason: 'process tree unreadable' }
  if (input.procs.some((p) => isBashToolArgv(p.argv))) return { idle: false, reason: 'running a command' }
  if (input.latestTranscriptMtime === null) return { idle: false, reason: 'transcript unknown' }
  if (input.now - lastActivityAt(input) < input.idleMs) return { idle: false, reason: 'recent activity' }
  if (input.transcriptText === null) return { idle: false, reason: 'transcript unreadable' }
  if (pendingSchedule(input.transcriptText)) return { idle: false, reason: 'scheduled wake-up' }
  return { idle: true }
}
