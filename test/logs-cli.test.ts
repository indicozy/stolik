// `stolik logs` and `stolik trace` (src/cli/logs.ts): option parsing, filtering, the follow reader across rotation,
// and the trace lookup by trace id and by Telegram message id. Files are under the isolated state folder.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  logFilesFor, parseLogsArgs, readNewLines, runLogsCommand, runTraceCommand, selectEntries, startTail, traceTimeline,
} from '../src/cli/logs.ts'
import { SqliteStore } from '../src/adapters/store-sqlite.ts'
import { addonLogPath, emit, routerLogPath, configureLog, writeAddonLog } from '../src/router/log.ts'
import { runTraced } from '../src/brain/observe.ts'
import { ISOLATED_ROOT } from './helpers/isolate.ts'
import { tgMsg } from '../src/adapters/chat/tg-ids.ts'

function collect(): { out: string[]; err: string[]; outFn: (s: string) => void; errFn: (s: string) => void } {
  const out: string[] = []
  const err: string[] = []
  return { out, err, outFn: (s) => out.push(s), errFn: (s) => err.push(s) }
}

test('logs arguments: every flag, the = form, and the messages for bad values', () => {
  const o = parseLogsArgs(['--addon', 'ml-worker', '--level=warn', '--since', '10m', '--trace', 'a1b2c3d4', '-f'])
  assert.deepEqual(o, { addon: 'ml-worker', level: 'warn', sinceMs: 600_000, trace: 'a1b2c3d4', follow: true })
  assert.deepEqual(parseLogsArgs([]), { addon: null, level: null, sinceMs: null, trace: null, follow: false })
  assert.deepEqual(parseLogsArgs(['--follow']), { addon: null, level: null, sinceMs: null, trace: null, follow: true })
  assert.match(parseLogsArgs(['--level', 'loud']) as string, /--level is one of/)
  assert.match(parseLogsArgs(['--since', 'soon']) as string, /--since takes/)
  assert.match(parseLogsArgs(['--trace', 'xyz']) as string, /--trace takes/)
  assert.match(parseLogsArgs(['--addon', 'Bad Name']) as string, /--addon needs/)
  assert.match(parseLogsArgs(['--addon']) as string, /--addon needs/)
  assert.match(parseLogsArgs(['--what']) as string, /unknown option/)
})

test('logs: the files read are the addon log for --addon, the router and audit logs otherwise', () => {
  assert.deepEqual(logFilesFor({ addon: 'ml-worker', level: null, sinceMs: null, trace: null, follow: false }), [addonLogPath('ml-worker')].filter((f) => existsSync(f)))
  const all = logFilesFor({ addon: null, level: null, sinceMs: null, trace: null, follow: false })
  assert.ok(all.every((f) => f.startsWith(ISOLATED_ROOT)))
})

test('logs: selection filters by level and trace, and returns time order across files', () => {
  configureLog({ level: 'debug', sink: null })
  writeAddonLog('sel-addon', 'error', 'boom from the addon')
  writeAddonLog('sel-addon', 'info', 'quiet line')
  runTraced('5e1ec7ab', () => emit('warn', 'spawn', 'tagged warning'))
  emit('info', 'router', 'untagged')
  const now = Date.now()
  const all = selectEntries({ addon: null, level: null, sinceMs: null, trace: null, follow: false }, [routerLogPath()], now)
  assert.ok(all.some((e) => e.msg === 'untagged'))
  const warnOnly = selectEntries({ addon: null, level: 'warn', sinceMs: null, trace: null, follow: false }, [routerLogPath()], now)
  assert.ok(warnOnly.every((e) => e.level === 'warn' || e.level === 'error'))
  const traced = selectEntries({ addon: null, level: null, sinceMs: null, trace: '5e1ec7ab', follow: false }, [routerLogPath()], now)
  assert.deepEqual(traced.map((e) => e.msg), ['tagged warning'])
  const addon = selectEntries({ addon: 'sel-addon', level: 'warn', sinceMs: null, trace: null, follow: false }, [addonLogPath('sel-addon')], now)
  assert.deepEqual(addon.map((e) => e.msg), ['boom from the addon'])
  const recent = selectEntries({ addon: null, level: null, sinceMs: 1, trace: null, follow: false }, [routerLogPath()], now + 60_000)
  assert.equal(recent.length, 0)
  configureLog({ level: 'info' })
})

test('logs: the command prints the selected lines in the human format', async () => {
  const c = collect()
  const code = await runLogsCommand(['--addon', 'sel-addon', '--level', 'error'], c.outFn, c.errFn)
  assert.equal(code, 0)
  assert.equal(c.out.length, 1)
  assert.match(c.out[0], /ERROR addon:sel-addon boom from the addon/)
  const bad = collect()
  assert.equal(await runLogsCommand(['--level', 'loud'], bad.outFn, bad.errFn), 2)
  assert.match(bad.err[0], /--level is one of/)
})

test('follow: a tail reads only lines written after it started, keeps a partial line, and starts over after rotation', () => {
  const dir = join(ISOLATED_ROOT, 'tail')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'f.jsonl')
  writeFileSync(path, 'old line\n')
  const tail = startTail(path)
  assert.deepEqual(readNewLines(path, tail), [])
  appendFileSync(path, 'first\nsecond\npart')
  assert.deepEqual(readNewLines(path, tail), ['first', 'second'])
  appendFileSync(path, 'ial\n')
  assert.deepEqual(readNewLines(path, tail), ['partial'])
  // Rotation: the file is replaced by a shorter one; it is read from its start.
  writeFileSync(path, 'after rotation\n')
  assert.deepEqual(readNewLines(path, tail), ['after rotation'])
  rmSync(dir, { recursive: true, force: true })
})

test('trace: the timeline of one trace id, from the log files, in time order', () => {
  runTraced('7ace0001', () => {
    emit('info', 'route', 'chose shop')
    emit('warn', 'spawn', 'shop failed')
  })
  emit('info', 'other', 'unrelated')
  const lines = traceTimeline('7ace0001', [routerLogPath()])
  assert.equal(lines.length, 2)
  assert.match(lines[0], /route \[7ace0001\] chose shop/)
  assert.match(lines[1], /spawn \[7ace0001\] shop failed/)
  assert.deepEqual(traceTimeline('ffffffff', [routerLogPath()]), [])
})

test('trace: by trace id, and by a Telegram message id through the trace map', async () => {
  const dbStore = new SqliteStore({ stateDir: join(ISOLATED_ROOT, 'state', 'stolik'), inboxDir: join(ISOLATED_ROOT, 'inbox'), notesDir: join(ISOLATED_ROOT, 'notes') })
  dbStore.recordTrace({ messageId: tgMsg(8123), dir: 'in', trace: '7ace0001', at: Date.now() })
  dbStore.close()
  const byId = collect()
  assert.equal(await runTraceCommand(['7ace0001'], byId.outFn, byId.errFn), 0)
  assert.equal(byId.out[0], 'trace 7ace0001')
  assert.ok(byId.out.some((l) => /shop failed/.test(l)))
  const byMsg = collect()
  assert.equal(await runTraceCommand(['8123'], byMsg.outFn, byMsg.errFn), 0)
  assert.equal(byMsg.out[0], 'trace 7ace0001')
})

test('trace: a trace with no lines says so and exits 1; an unknown id exits 1; wrong usage exits 2', async () => {
  const missing = collect()
  assert.equal(await runTraceCommand(['abcdef12'], missing.outFn, missing.errFn), 1)
  assert.match(missing.out[1], /no log lines for this trace/)
  const unknown = collect()
  assert.equal(await runTraceCommand(['9999'], unknown.outFn, unknown.errFn), 1)
  assert.match(unknown.err[0], /no trace is kept for Telegram message 9999/)
  const word = collect()
  assert.equal(await runTraceCommand(['hello'], word.outFn, word.errFn), 1)
  assert.match(word.err[0], /neither a trace id/)
  const usage = collect()
  assert.equal(await runTraceCommand([], usage.outFn, usage.errFn), 2)
  assert.match(usage.err[0], /usage: stolik trace/)
})
