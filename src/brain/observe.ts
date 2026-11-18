// Observability rules (design §Observability): log levels, trace ids and their context, reading and filtering log lines,
// the trace timeline, the Logs-topic gate (rate limit and dedupe), and the text of forensics files, /debug and doctor
// reports. Pure: no I/O. The I/O lives in src/router/log.ts, src/router/logs-topic.ts, src/cli/*.
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { parseCommandWord } from './commands.ts'

// ---------- levels ----------

export const LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type Level = (typeof LEVELS)[number]

export function isLevel(v: unknown): v is Level {
  return typeof v === 'string' && (LEVELS as readonly string[]).includes(v)
}

export function levelRank(level: Level): number {
  return LEVELS.indexOf(level)
}

// True when `level` is at least `min`.
export function atLeast(level: Level, min: Level): boolean {
  return levelRank(level) >= levelRank(min)
}

// ---------- trace ids ----------

// How long the trace map keeps a message's trace id (/trace and `tg-bridge trace` answer for that long).
export const TRACE_KEEP_MS = 7 * 24 * 3_600_000

const TRACE_RE = /^[0-9a-f]{8}$/

// A new trace id: 8 lowercase hex characters (4 random bytes).
export function newTraceId(): string {
  return randomBytes(4).toString('hex')
}

export function isTraceId(v: unknown): v is string {
  return typeof v === 'string' && TRACE_RE.test(v)
}

// The trace id an addon sent in its payload (`trace`), or undefined when absent or not a trace id.
export function traceFromPayload(v: unknown): string | undefined {
  return isTraceId(v) ? v : undefined
}

// The trace of the flow running now. Set by runTraced; timers and awaits inside a flow keep it.
const traceContext = new AsyncLocalStorage<string>()

export function currentTrace(): string | undefined {
  return traceContext.getStore()
}

// Runs fn with `trace` as the current trace id (returns what fn returns).
export function runTraced<T>(trace: string, fn: () => T): T {
  return traceContext.run(trace, fn)
}

// ---------- log entries ----------

// One line of router.jsonl, addon logs, or the audit log, as the readers see it.
export type LogEntry = {
  ts: string
  level: Level
  component: string
  msg: string
  trace?: string
  fields: Record<string, unknown>
}

// Parses one JSON line. Router and addon lines have level, component and msg. Audit lines (audit.log) have an event
// name instead; they read as info events of component "audit". Null for anything else.
export function parseLogLine(line: string): LogEntry | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (typeof o.ts !== 'string') return null
  const trace = isTraceId(o.trace) ? o.trace : undefined
  if (isLevel(o.level) && typeof o.msg === 'string') {
    const { ts, level, component, msg, trace: _t, ...fields } = o
    return {
      ts: o.ts,
      level,
      component: typeof component === 'string' ? component : 'router',
      msg,
      ...(trace ? { trace } : {}),
      fields,
    }
  }
  if (typeof o.event === 'string') {
    const { ts, event, trace: _t, ...fields } = o
    return { ts: o.ts, level: 'info', component: 'audit', msg: event, ...(trace ? { trace } : {}), fields }
  }
  return null
}

// Parses a `--since` value: a number and a unit (s, m, h, d). Null when it does not parse.
export function parseSince(text: string): number | null {
  const m = /^(\d+)\s*([smhd])$/.exec(text.trim())
  if (!m) return null
  const n = Number(m[1])
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd']
  return n * unit
}

export type LogFilter = {
  // Entries at this level or above.
  level?: Level
  // Entries at or after `nowMs - sinceMs`.
  sinceMs?: number
  // Entries of this trace id only.
  trace?: string
}

export function matchesFilter(e: LogEntry, f: LogFilter, nowMs: number): boolean {
  if (f.level !== undefined && !atLeast(e.level, f.level)) return false
  if (f.trace !== undefined && e.trace !== f.trace) return false
  if (f.sinceMs !== undefined) {
    const t = Date.parse(e.ts)
    if (Number.isNaN(t) || t < nowMs - f.sinceMs) return false
  }
  return true
}

// `HH:MM:SS.mmm` in local time (the clock the owner reads).
export function clockOf(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

// Fields as `key=value` pairs, values JSON-encoded when they are not plain strings. Empty when there are none.
export function fieldsText(fields: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue
    parts.push(`${k}=${typeof v === 'string' ? (/\s/.test(v) ? JSON.stringify(v) : v) : JSON.stringify(v)}`)
  }
  return parts.join(' ')
}

// One human line: `HH:MM:SS.mmm LEVEL component [trace] msg k=v`.
export function formatLogLine(e: LogEntry): string {
  const trace = e.trace ? ` [${e.trace}]` : ''
  const f = fieldsText(e.fields)
  return `${clockOf(e.ts)} ${e.level.toUpperCase().padEnd(5)} ${e.component}${trace} ${e.msg}${f ? ' ' + f : ''}`
}

// Relative time of `ms` after the first entry: `+123ms` below a second, `+1.234s` above.
export function relativeTime(ms: number): string {
  if (ms < 1_000) return `+${Math.round(ms)}ms`
  return `+${(ms / 1_000).toFixed(3)}s`
}

// The timeline of one trace: entries in time order (stable), each with its time since the first. `short` is the Telegram
// form (no clock time, no level). `max` keeps the first lines and says how many were left out.
export function formatTimeline(entries: readonly LogEntry[], opts: { short?: boolean; max?: number } = {}): string[] {
  const sorted = entries
    .map((e, i) => ({ e, i, t: Date.parse(e.ts) }))
    .filter((x) => !Number.isNaN(x.t))
    .sort((a, b) => a.t - b.t || a.i - b.i)
  if (sorted.length === 0) return []
  const t0 = sorted[0].t
  const max = opts.max ?? Number.POSITIVE_INFINITY
  const lines = sorted.slice(0, max).map(({ e, t }) => {
    const rel = relativeTime(t - t0)
    const f = fieldsText(e.fields)
    if (opts.short) {
      const f2 = f ? ' ' + f : ''
      return `${rel.padEnd(9)} ${e.component}: ${e.msg}${f2}`
    }
    const trace = e.trace ? ` [${e.trace}]` : ''
    return `${rel.padEnd(9)} ${clockOf(e.ts)} ${e.level.toUpperCase().padEnd(5)} ${e.component}${trace} ${e.msg}${f ? ' ' + f : ''}`
  })
  if (sorted.length > max) lines.push(`… ${sorted.length - max} more`)
  return lines
}

// ---------- the Logs-topic gate ----------

export type GateDecision =
  // Send the line. `repeats` counts the same message suppressed as a duplicate since it was last sent.
  | { action: 'send'; repeats: number }
  // The same message was sent within the dedupe window: counted, not sent.
  | { action: 'duplicate' }
  // The per-minute limit is reached: counted in takeRateDropped, not sent.
  | { action: 'rate-limited' }

// Limits what reaches the Logs topic: at most `perMinute` lines in a sliding minute, and one line per message key per
// `dedupeMs`. Duplicates and rate drops are counted, so the topic can say how many were left out.
export class AlertGate {
  private readonly perMinute: number
  private readonly dedupeMs: number
  private sent: number[] = []
  private last = new Map<string, { at: number; repeats: number }>()
  private rateDropped = 0

  constructor(perMinute: number, dedupeMs: number) {
    this.perMinute = perMinute
    this.dedupeMs = dedupeMs
  }

  offer(key: string, now: number): GateDecision {
    this.sent = this.sent.filter((t) => now - t < 60_000)
    if (this.last.size > 500) {
      for (const [k, v] of this.last) if (now - v.at >= this.dedupeMs) this.last.delete(k)
    }
    const seen = this.last.get(key)
    if (seen && now - seen.at < this.dedupeMs) {
      seen.repeats++
      return { action: 'duplicate' }
    }
    if (this.sent.length >= this.perMinute) {
      this.rateDropped++
      return { action: 'rate-limited' }
    }
    const repeats = seen?.repeats ?? 0
    this.last.set(key, { at: now, repeats: 0 })
    this.sent.push(now)
    return { action: 'send', repeats }
  }

  // The number of lines the rate limit dropped since the last call (and resets it).
  takeRateDropped(): number {
    const n = this.rateDropped
    this.rateDropped = 0
    return n
  }
}

// A warning through the logger when it can post warnings (the Logs topic), else a plain log line.
export function warnOrLog(logger: { log(msg: string): void; warn?(msg: string, component?: string): void }, msg: string, component: string): void {
  if (logger.warn) logger.warn(msg, component)
  else logger.log(msg)
}

// ---------- addon stderr ----------

// The level of one line an addon wrote to stderr: error for tracebacks and exceptions, warn for failures and "warning:" lines, else info.
export function stderrLevel(line: string): Level {
  if (/traceback|exception|\berror\b|[a-z]error\b/i.test(line)) return 'error'
  if (/\bfail(ed|ure|s)?\b|\bwarn(ing)?:/i.test(line)) return 'warn'
  return 'info'
}

// ---------- forensics ----------

export type ForensicsInput = {
  // ISO time of the failure.
  ts: string
  project: string
  // The folder the session was to start in.
  cwd: string
  // The command line (tmux and the launcher), one element per argument.
  argv: string[]
  // The tmux session name the start used, or null when none was made.
  tmuxName: string | null
  // The environment variable NAMES of the router (values are never written, except PATH).
  envNames: string[]
  // The router's PATH value.
  path: string | undefined
  // The last lines of the session's pane (empty when the session is gone).
  pane: string[]
  // `claude --version`, or null when it could not be run.
  claudeVersion: string | null
  // Why the start failed.
  reason: string
}

// The forensics file for a failed start. Plain text, one section per item, so it reads well in any editor.
export function buildForensics(i: ForensicsInput): string {
  const lines = [
    'tg-bridge spawn forensics',
    `time: ${i.ts}`,
    `project: ${i.project}`,
    `reason: ${i.reason}`,
    `cwd: ${i.cwd}`,
    `tmux session: ${i.tmuxName ?? '(none)'}`,
    `claude --version: ${i.claudeVersion ?? '(not available)'}`,
    '',
    'argv:',
    ...i.argv.map((a) => `  ${JSON.stringify(a)}`),
    '',
    `PATH: ${i.path ?? '(unset)'}`,
    `environment variable names (${i.envNames.length}):`,
    ...i.envNames.map((n) => `  ${n}`),
    '',
    'pane (last lines):',
    ...(i.pane.length > 0 ? i.pane.map((l) => `  | ${l}`) : ['  (no output)']),
    '',
  ]
  return lines.join('\n')
}

// A file name for a forensics file: `<time>-<project>.txt`, with the time made safe for a file name.
export function forensicsFileName(ts: string, project: string): string {
  const safeTs = ts.replace(/[:.]/g, '-')
  const safeProject = project.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'project'
  return `${safeTs}-${safeProject}.txt`
}

// ---------- /debug ----------

export type DebugSession = { name: string; folder: string; connected: boolean; lastActive: number; tmux: string | null }
export type DebugAddon = { name: string; status: string; running: boolean; restarts: number; lastError: string | null }
export type DebugMl =
  | { ok: true; gpu: string | null; vram: { usedMiB: number; totalMiB: number } | null; models: Array<{ name: string; loaded: boolean; device: string | null; unloadInSec: number | null }> }
  | { ok: false; reason: string }

export type DebugInput = {
  now: number
  uptimeSec: number | null
  version: string
  gitSha: string | null
  level: Level
  // Epoch ms until which debug logging is on, or null.
  debugUntil: number | null
  sessions: DebugSession[]
  addons: DebugAddon[]
  // Outbound queue depth per chat label ("group", "dm").
  queues: Record<string, number>
  ml: DebugMl
  quota: { weeklyUsedPct: number; aheadBy: number } | null
  logsTopic: string
}

function ago(now: number, t: number): string {
  if (t <= 0) return 'never'
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

// The /debug report, one block per area. Plain text; the caller splits it into Telegram-sized chunks.
export function buildDebugReport(i: DebugInput): string {
  const out: string[] = []
  const up = i.uptimeSec === null ? 'unknown' : `${Math.floor(i.uptimeSec / 3600)}h ${Math.floor((i.uptimeSec % 3600) / 60)}m`
  out.push(`tg-bridge ${i.version}${i.gitSha ? ` (${i.gitSha})` : ''}, up ${up}`)
  const dbg = i.debugUntil !== null && i.debugUntil > i.now
  out.push(`log level: ${i.level}${dbg ? ` (debug on until ${clockOf(new Date(i.debugUntil!).toISOString()).slice(0, 5)})` : ''}`)
  out.push(`logs topic: ${i.logsTopic}`)
  out.push('')
  out.push(`sessions (${i.sessions.length}):`)
  if (i.sessions.length === 0) out.push('  none')
  for (const s of i.sessions) {
    out.push(`  ${s.name}: ${s.connected ? 'connected' : 'not connected'}, last activity ${ago(i.now, s.lastActive)}`)
    out.push(`    folder ${s.folder}${s.tmux ? `, tmux ${s.tmux}` : ''}`)
  }
  out.push('')
  out.push(`addons (${i.addons.length}):`)
  if (i.addons.length === 0) out.push('  none installed')
  for (const a of i.addons) {
    const err = a.lastError ? `, last error: ${a.lastError}` : ''
    out.push(`  ${a.name}: ${a.status}, restarts ${a.restarts}${err}`)
  }
  out.push('')
  const queueText = Object.entries(i.queues).map(([k, v]) => `${k} ${v}`).join(', ')
  out.push(`outbound queue: ${queueText || 'empty'}`)
  out.push('')
  if (i.ml.ok) {
    const vram = i.ml.vram ? `${i.ml.vram.usedMiB}/${i.ml.vram.totalMiB} MiB` : 'not readable'
    out.push(`ml-worker: GPU ${i.ml.gpu ?? 'not configured'}, VRAM ${vram}`)
    for (const m of i.ml.models) {
      const state = m.loaded ? `loaded on ${m.device ?? '?'}, unloads in ${m.unloadInSec ?? '?'} s` : 'not loaded'
      out.push(`  ${m.name}: ${state}`)
    }
  } else {
    out.push(`ml-worker: ${i.ml.reason}`)
  }
  out.push('')
  out.push(i.quota ? `quota: week ${i.quota.weeklyUsedPct}% used, ${i.quota.aheadBy > 0 ? `${i.quota.aheadBy} points ahead of pace` : 'on pace or behind'}` : 'quota: unknown')
  return out.join('\n')
}

// Parses `/debug` arguments: '' (report), 'on [minutes]', 'off'. Null when it does not parse. Minutes default to 60
// and are kept between 1 and 1440.
export type DebugCommand = { action: 'report' } | { action: 'on'; minutes: number } | { action: 'off' }

export const DEBUG_DEFAULT_MINUTES = 60
export const DEBUG_MAX_MINUTES = 1440

export function parseDebugArgs(arg: string): DebugCommand | null {
  const t = arg.trim().toLowerCase()
  if (t === '') return { action: 'report' }
  if (t === 'off') return { action: 'off' }
  const m = /^on(?:\s+(\d{1,5}))?$/.exec(t)
  if (!m) return null
  const n = m[1] === undefined ? DEBUG_DEFAULT_MINUTES : Number(m[1])
  if (n < 1) return null
  return { action: 'on', minutes: Math.min(n, DEBUG_MAX_MINUTES) }
}

// ---------- /trace ----------

// `/trace` as the first word of a message (any topic). Returns its argument or null when the text is not /trace.
export function isTraceCommand(text: string, forwarded = false): boolean {
  return parseCommandWord(text, forwarded)?.word === 'trace'
}

// ---------- doctor ----------

export type CheckStatus = 'ok' | 'warn' | 'fail'
// `group: 'privacy'` marks the privacy health checks (who can see the chat); the router reports their failures once.
export type Check = { id: string; title: string; status: CheckStatus; detail: string; group?: 'privacy' }

// The overall answer: fail when any check failed; warnings alone do not fail.
export function summarizeChecks(checks: readonly Check[]): { ok: boolean; exitCode: number } {
  const failed = checks.some((c) => c.status === 'fail')
  return { ok: !failed, exitCode: failed ? 1 : 0 }
}

const MARK: Record<CheckStatus, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' }

// The human report: one line per check, then a summary line.
export function formatChecks(checks: readonly Check[]): string {
  const lines = checks.map((c) => `[${MARK[c.status]}] ${c.title}: ${c.detail}`)
  const s = summarizeChecks(checks)
  const fails = checks.filter((c) => c.status === 'fail').length
  const warns = checks.filter((c) => c.status === 'warn').length
  lines.push('', s.ok ? `doctor: all checks passed${warns ? ` (${warns} warning${warns === 1 ? '' : 's'})` : ''}` : `doctor: ${fails} check${fails === 1 ? '' : 's'} failed`)
  return lines.join('\n')
}

// The machine form (`--json`).
export function checksJson(checks: readonly Check[]): string {
  return JSON.stringify({ ok: summarizeChecks(checks).ok, checks }, null, 2)
}

// The first executable `name` on a PATH value, given an existence test. Null when none.
export function resolveOnPath(name: string, pathValue: string | undefined, isExecutable: (file: string) => boolean): string | null {
  if (!pathValue) return null
  for (const dir of pathValue.split(':')) {
    if (dir === '') continue
    const file = `${dir.replace(/\/+$/, '')}/${name}`
    if (isExecutable(file)) return file
  }
  return null
}

// The PATH value a systemd unit gives its service: the `Environment=PATH=...` line, with systemd's specifiers expanded
// (%h is the user's home folder, %% a literal percent sign). Null when there is none.
export function unitPathValue(unitText: string, home: string): string | null {
  for (const raw of unitText.split('\n')) {
    const line = raw.trim()
    const m = /^Environment=(.*)$/.exec(line)
    if (!m) continue
    let value = m[1].trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\(.)/g, '$1')
    if (value.startsWith('PATH=')) return value.slice('PATH='.length).replace(/%(%|h)/g, (_, s: string) => (s === 'h' ? home : '%'))
  }
  return null
}

// The name of a running service's executable path in its unit: ExecStart's first word, or null.
export function unitExecStart(unitText: string): string | null {
  const m = /^ExecStart=(.*)$/m.exec(unitText)
  return m ? m[1].trim() : null
}

// Whether a count of bytes is enough disk space: warn below 1 GiB, fail below 200 MiB. Null when it is plenty.
export function diskStatus(freeBytes: number): CheckStatus {
  if (freeBytes < 200 * 1024 * 1024) return 'fail'
  if (freeBytes < 1024 * 1024 * 1024) return 'warn'
  return 'ok'
}

// A Unix socket path must fit sun_path (108 bytes with the terminating NUL): at most 107 bytes.
export const SOCKET_PATH_MAX_BYTES = 107

// Telegram's answer for a bound group's rights: the rights the router needs, and the ones missing.
export const REQUIRED_GROUP_RIGHTS = ['can_manage_topics', 'can_delete_messages', 'can_pin_messages'] as const

export function missingRights(member: { status: string } & Record<string, unknown>): string[] {
  if (member.status === 'creator') return []
  if (member.status !== 'administrator') return [...REQUIRED_GROUP_RIGHTS]
  return REQUIRED_GROUP_RIGHTS.filter((r) => member[r] !== true)
}
