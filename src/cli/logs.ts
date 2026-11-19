// `stolik logs` and `stolik trace` (design §Observability): read the router's JSON-lines logs, the addon logs and the
// audit log. Pure parsing and filtering are here; the file reads are small wrappers so the rules are tested on temp files.
import { existsSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { DB_FILE, ReadOnlyStore } from '../adapters/store-sqlite.ts'
import { STATE_DIR } from '../config.ts'
import { fileSize } from '../brain/common.ts'
import { fromDbMsg } from '../adapters/store-ids.ts'
import { isWellFormedId } from '../adapters/legacy-ids.ts'
import type { MessageId } from '../brain/chat-types.ts'
import {
  formatLogLine, formatTimeline, isLevel, isTraceId, matchesFilter, parseLogLine, parseSince, type Level, type LogEntry,
} from '../brain/observe.ts'
import { addonLogPath, allRouterFiles, readEntries, rotatedFiles } from '../router/log.ts'

export type LogsOptions = {
  // Only this addon's log (<stateDir>/logs/addons/<name>.log).
  addon: string | null
  // Entries at this level or above.
  level: Level | null
  // Entries of the last N ms.
  sinceMs: number | null
  // Entries of this trace id.
  trace: string | null
  // Keep printing new lines (until interrupted).
  follow: boolean
}

const ADDON_NAME_RE = /^[a-z][a-z0-9-]{1,39}$/

// The flags of `stolik logs`. Returns the options, or a message saying what is wrong.
export function parseLogsArgs(args: string[]): LogsOptions | string {
  const o: LogsOptions = { addon: null, level: null, sinceMs: null, trace: null, follow: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const eq = a.indexOf('=')
    const flag = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a
    const inline = a.startsWith('--') && eq > 0 ? a.slice(eq + 1) : undefined
    const value = (): string | undefined => inline ?? args[++i]
    switch (flag) {
      case '--addon': {
        const v = value()
        if (v === undefined || !ADDON_NAME_RE.test(v)) return '--addon needs an addon name, such as ml-worker'
        o.addon = v
        break
      }
      case '--level': {
        const v = value()
        if (!isLevel(v)) return '--level is one of debug, info, warn, error'
        o.level = v
        break
      }
      case '--since': {
        const ms = parseSince(value() ?? '')
        if (ms === null) return '--since takes a number and a unit: s, m, h or d (for example 10m)'
        o.sinceMs = ms
        break
      }
      case '--trace': {
        const v = value()
        if (!isTraceId(v)) return '--trace takes an 8-character trace id (hex)'
        o.trace = v
        break
      }
      case '-f':
      case '--follow':
        o.follow = true
        break
      default:
        return `unknown option ${a}`
    }
  }
  return o
}

// The files a `logs` call reads: the addon's log, or the router log with the audit log.
export function logFilesFor(o: LogsOptions): string[] {
  if (o.addon !== null) return rotatedFiles(addonLogPath(o.addon))
  return allRouterFiles()
}

// The entries that match the options, in time order (files are read in order, then sorted by time; stable).
export function selectEntries(o: LogsOptions, files: readonly string[], nowMs: number): LogEntry[] {
  const filter = { level: o.level ?? undefined, sinceMs: o.sinceMs ?? undefined, trace: o.trace ?? undefined }
  return readEntries(files)
    .filter((e) => matchesFilter(e, filter, nowMs))
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
}

// Follow state of one file: the byte offset read so far, and an unfinished last line.
export type Tail = { offset: number; partial: string }

// Starts following a file at its current end (lines written from now on are new).
export function startTail(path: string): Tail {
  return { offset: fileSize(path), partial: '' }
}


// The complete lines written since the last call. A file that got smaller was rotated: it is read from its start.
export function readNewLines(path: string, tail: Tail): string[] {
  const size = fileSize(path)
  if (size < tail.offset) {
    tail.offset = 0
    tail.partial = ''
  }
  if (size === tail.offset) return []
  const len = size - tail.offset
  const buf = Buffer.alloc(len)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buf, 0, len, tail.offset)
  } finally {
    closeSync(fd)
  }
  tail.offset = size
  const text = tail.partial + buf.toString('utf8')
  const parts = text.split('\n')
  tail.partial = parts.pop() ?? ''
  return parts.filter((l) => l.trim() !== '')
}

// The timeline of one trace, as `stolik trace` prints it. Empty when no line of the files has the id.
export function traceTimeline(trace: string, files: readonly string[]): string[] {
  const mine = readEntries(files).filter((e) => e.trace === trace)
  return formatTimeline(mine)
}

// `stolik logs [--addon N] [--level L] [--since 10m] [--trace ID] [-f]`. Returns the exit code.
export async function runLogsCommand(args: string[], out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const parsed = parseLogsArgs(args)
  if (typeof parsed === 'string') {
    err(parsed)
    return 2
  }
  const files = logFilesFor(parsed)
  const now = Date.now()
  for (const e of selectEntries(parsed, files, now)) out(formatLogLine(e))
  if (!parsed.follow) return 0
  // Follow: new lines of the same files, until the process is interrupted.
  const tails = new Map<string, Tail>(files.map((f) => [f, startTail(f)]))
  const watch = files.length > 0 ? files : [join(STATE_DIR, 'logs', 'router.jsonl')]
  for (const f of watch) if (!tails.has(f)) tails.set(f, startTail(f))
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      for (const [file, tail] of tails) {
        for (const line of readNewLines(file, tail)) {
          const e = parseLogLine(line)
          if (e && matchesFilter(e, { level: parsed.level ?? undefined, trace: parsed.trace ?? undefined }, Date.now())) out(formatLogLine(e))
        }
      }
    }, 500)
    const stop = () => {
      clearInterval(timer)
      resolve()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  return 0
}

// `stolik trace <traceId|telegramMessageId>`: the timeline of one trace. A number is first looked up as a Telegram
// message id (the trace map); otherwise a trace id. Returns the exit code.
export async function runTraceCommand(args: string[], out: (s: string) => void, err: (s: string) => void): Promise<number> {
  if (args.length !== 1) {
    err('usage: stolik trace <traceId | telegramMessageId>')
    return 2
  }
  const arg = args[0]
  let traces: string[] = []
  // A typed number is a Telegram message id, stored as itself (store-ids).
  if (/^\d+$/.test(arg)) traces = lookupMessageTraces(fromDbMsg(Number(arg)))
  // An id of another platform (no number on disk) is looked up as the string it is.
  else if (isWellFormedId(arg)) traces = lookupMessageTraces(arg as MessageId)
  if (traces.length === 0 && isTraceId(arg)) traces = [arg]
  if (traces.length === 0) {
    err(/^\d+$/.test(arg) ? `no trace is kept for Telegram message ${arg} (kept 7 days)` : `${arg} is neither a trace id (8 hex characters) nor a kept Telegram message id`)
    return 1
  }
  const files = allRouterFiles()
  let found = false
  for (const t of traces) {
    const lines = traceTimeline(t, files)
    out(`trace ${t}`)
    if (lines.length === 0) out('  no log lines for this trace (they rotated out, or it was not logged)')
    else {
      found = true
      for (const l of lines) out('  ' + l)
    }
  }
  return found ? 0 : 1
}

// The trace ids a Telegram message id maps to, from the store (read-only). Empty when there is no database.
export function lookupMessageTraces(messageId: MessageId): string[] {
  const path = join(STATE_DIR, DB_FILE)
  if (!existsSync(path)) return []
  return [...new Set(new ReadOnlyStore(path).tracesForMessage(messageId).map((t) => t.trace))]
}
