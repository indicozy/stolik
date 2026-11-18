// The router's logs (design §Observability). One emit path: a human line on stderr (journald), a JSON line in
// <stateDir>/logs/router.jsonl (rotated), and for warnings and errors a sink (the Logs topic, src/router/logs-topic.ts).
// Each line takes the trace id of the flow it is written in (src/brain/observe.ts). Secrets are redacted from everything
// written. Addon stderr goes to <stateDir>/logs/addons/<name>.log. The audit log (audit.log) keeps its own format.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { STATE_DIR } from '../config.ts'
import { fileSize, redact } from '../brain/common.ts'
import { atLeast, currentTrace, parseLogLine, type Level, type LogEntry } from '../brain/observe.ts'

// Size-based rotation: a file reaches LOG_MAX_BYTES, becomes <file>.1 (older ones move up), and at most LOG_KEEP
// rotated files are kept.
export const LOG_MAX_BYTES = 10 * 1024 * 1024
export const LOG_KEEP = 5

export function logDir(): string {
  return join(STATE_DIR, 'logs')
}
export function routerLogPath(): string {
  return join(logDir(), 'router.jsonl')
}
export function addonLogPath(name: string): string {
  return join(logDir(), 'addons', `${name}.log`)
}
export function auditLogPath(): string {
  return join(STATE_DIR, 'audit.log')
}

// An append-only JSON-lines file with size-based rotation. Lines are written whole; the size is tracked, so a rotation
// costs no extra stat per line.
export class JsonlFile {
  private readonly path: string
  private readonly maxBytes: number
  private readonly keep: number
  private size: number

  constructor(path: string, maxBytes = LOG_MAX_BYTES, keep = LOG_KEEP) {
    this.path = path
    this.maxBytes = maxBytes
    this.keep = keep
    this.size = fileSize(path)
  }

  append(data: string): void {
    const bytes = Buffer.byteLength(data)
    if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate()
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    appendFileSync(this.path, data, { mode: 0o600 })
    this.size += bytes
  }

  private rotate(): void {
    for (let i = this.keep - 1; i >= 1; i--) {
      const from = `${this.path}.${i}`
      if (existsSync(from)) renameSync(from, `${this.path}.${i + 1}`)
    }
    if (existsSync(this.path)) renameSync(this.path, `${this.path}.1`)
    this.size = 0
  }
}


// The files of one rotated log that exist, oldest first: <path>.<keep> ... <path>.1, then <path>.
export function rotatedFiles(path: string, keep = LOG_KEEP): string[] {
  const out: string[] = []
  for (let i = keep; i >= 1; i--) if (existsSync(`${path}.${i}`)) out.push(`${path}.${i}`)
  if (existsSync(path)) out.push(path)
  return out
}

// What a sink receives: the record as written to the file.
export type LogRecord = { ts: string; level: Level; component: string; msg: string; trace?: string; fields: Record<string, unknown> }
export type LogSink = (r: LogRecord) => void

const RESERVED = new Set(['ts', 'level', 'component', 'trace', 'msg'])

type State = {
  threshold: Level
  // Epoch ms until which debug lines are written (`/debug on`), or 0.
  debugUntil: number
  secrets: string[]
  // Whether the file is written at all (tests turn it off when they only want the journal).
  file: boolean
  sink: LogSink | null
  router: JsonlFile | null
  addons: Map<string, JsonlFile>
}

const state: State = {
  threshold: process.env.TG_BRIDGE_DEBUG === '1' ? 'debug' : 'info',
  debugUntil: 0,
  secrets: [],
  file: true,
  sink: null,
  router: null,
  addons: new Map(),
}

// Sets the level, the redaction list, the file switch and the sink. Each field is optional; a call changes only what it
// names. The router calls it at start-up and again when a setting changes.
export function configureLog(opts: { level?: Level; secrets?: string[]; file?: boolean; sink?: LogSink | null }): void {
  if (opts.level !== undefined) state.threshold = opts.level
  if (opts.secrets !== undefined) state.secrets = opts.secrets.filter((s) => s.length > 0)
  if (opts.file !== undefined) state.file = opts.file
  if (opts.sink !== undefined) state.sink = opts.sink
  if (opts.level !== undefined || opts.secrets !== undefined) state.router = null
}

// Debug lines are written until this epoch ms (`/debug on`); 0 turns the override off.
export function setDebugUntil(ms: number): void {
  state.debugUntil = ms
}

export function debugUntil(): number {
  return state.debugUntil
}

// The level now: debug while the `/debug on` window is open, else the configured level.
export function effectiveLevel(now: number = Date.now()): Level {
  return now < state.debugUntil ? 'debug' : state.threshold
}

function routerFile(): JsonlFile {
  state.router ??= new JsonlFile(routerLogPath())
  return state.router
}

function addonFile(name: string): JsonlFile {
  let f = state.addons.get(name)
  if (!f) {
    f = new JsonlFile(addonLogPath(name))
    state.addons.set(name, f)
  }
  return f
}

// The one emit path. `trace` defaults to the trace of the flow the call runs in.
export function emit(level: Level, component: string, msg: string, fields: Record<string, unknown> = {}, trace: string | undefined = currentTrace()): void {
  const now = Date.now()
  const ts = new Date(now).toISOString()
  const text = redact(msg, state.secrets)
  const shown = atLeast(level, effectiveLevel(now))
  const tag = trace ? `[${trace}] ` : ''
  if (shown) {
    const line = level === 'info' && component === 'router' ? `${ts} ${tag}${text}` : `${ts} ${level.toUpperCase()} ${component} ${tag}${text}`
    process.stderr.write(line + '\n')
    if (state.file) {
      const safeFields: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(fields)) if (!RESERVED.has(k) && v !== undefined) safeFields[k] = v
      const rec = { ts, level, component, ...(trace ? { trace } : {}), msg: text, ...safeFields }
      try {
        routerFile().append(redact(JSON.stringify(rec), state.secrets) + '\n')
      } catch (e) {
        process.stderr.write(`${ts} ERROR logs ${tag}log file write failed: ${errMsg(e)}\n`)
      }
    }
  }
  if (state.sink && atLeast(level, 'warn') && component !== 'logs') {
    try {
      state.sink({ ts, level, component, msg: text, ...(trace ? { trace } : {}), fields })
    } catch {
      // The sink is best effort; the line is already in the journal and the file.
    }
  }
}

export function log(msg: string): void {
  emit('info', 'router', msg)
}

// Debug level: written when `/debug on` or the configured level allows it. Same rules as log().
export function debug(msg: string): void {
  emit('debug', 'router', msg)
}

export function warn(msg: string, component = 'router', fields: Record<string, unknown> = {}): void {
  emit('warn', component, msg, fields)
}

export function error(msg: string, component = 'router', fields: Record<string, unknown> = {}): void {
  emit('error', component, msg, fields)
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// One line of an addon's stderr, in its own log file. Never throws.
export function writeAddonLog(name: string, level: Level, msg: string): void {
  try {
    const rec = { ts: new Date().toISOString(), level, component: `addon:${name}`, msg: redact(msg, state.secrets) }
    addonFile(name).append(JSON.stringify(rec) + '\n')
  } catch (e) {
    process.stderr.write(`${new Date().toISOString()} ERROR logs addon ${name} log write failed: ${errMsg(e)}\n`)
  }
}

// The audit log rotates by size through JsonlFile (the same rotation as the router log): at most AUDIT_KEEP rotated files.
export const AUDIT_MAX_BYTES = 5 * 1024 * 1024
export const AUDIT_KEEP = 5
let auditSink: JsonlFile | null = null
function auditFile(): JsonlFile {
  auditSink ??= new JsonlFile(auditLogPath(), AUDIT_MAX_BYTES, AUDIT_KEEP)
  return auditSink
}

// Append-only JSON lines. Callers pass metadata only (session, lengths, kinds), never bodies or tokens. The trace id of
// the flow is added when there is one.
export function audit(event: Record<string, string | number | boolean>): void {
  const trace = currentTrace()
  try {
    auditFile().append(JSON.stringify({ ts: new Date().toISOString(), ...(trace ? { trace } : {}), ...event }) + '\n')
  } catch (e) {
    emit('error', 'audit', `audit write failed: ${errMsg(e)}`)
  }
}

// Every parsed entry of the given files, in file order. Unreadable or unparsable lines are skipped.
export function readEntries(files: readonly string[]): LogEntry[] {
  const out: LogEntry[] = []
  for (const file of files) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      const e = parseLogLine(line)
      if (e) out.push(e)
    }
  }
  return out
}

// The router log (rotated files included) and the audit log: what /trace and `tg-bridge trace` read.
export function allRouterFiles(): string[] {
  return [...rotatedFiles(routerLogPath()), ...rotatedFiles(auditLogPath(), AUDIT_KEEP)].filter((f) => existsSync(f))
}
