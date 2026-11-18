// The router's log writer (src/router/log.ts): rotation, the emit path (journal, file, sink), redaction, addon logs and the
// audit trace. Runs in its own process: the state folder is the isolated one (test/helpers/isolate.ts).
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  JsonlFile, LOG_KEEP, LOG_MAX_BYTES, addonLogPath, allRouterFiles, audit, auditLogPath, configureLog, debug, emit, effectiveLevel, error,
  errMsg, log, logDir, readEntries, rotatedFiles, routerLogPath, setDebugUntil, debugUntil, warn, writeAddonLog, type LogRecord,
} from '../src/router/log.ts'
import { runTraced } from '../src/brain/observe.ts'

// Captures what the journal (stderr) gets while fn runs.
function captureStderr(fn: () => void): string {
  const original = process.stderr.write.bind(process.stderr)
  let out = ''
  ;(process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    out += s
    return true
  }
  try {
    fn()
  } finally {
    ;(process.stderr as unknown as { write: typeof original }).write = original
  }
  return out
}

function tmp(label: string): string {
  const dir = join(process.env.XDG_STATE_HOME as string, `logtest-${label}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

test('JsonlFile: appends whole lines and rotates past the size limit, keeping the newest files', () => {
  const dir = tmp('rotate')
  const path = join(dir, 'x.jsonl')
  const f = new JsonlFile(path, 100, 3)
  for (let i = 0; i < 40; i++) f.append(`{"n":${i},"pad":"${'x'.repeat(30)}"}\n`)
  // Each rotated file stays within the limit, and at most `keep` rotated files exist.
  const files = rotatedFiles(path, 3)
  assert.ok(files.length <= 4, `at most keep + 1 files, got ${files.length}`)
  assert.equal(existsSync(`${path}.4`), false)
  for (const p of files) assert.ok(statSync(p).size <= 100 + 50, `${p} is about the limit`)
  // The newest line is in the live file; the oldest kept line is in the first file listed.
  assert.match(readFileSync(path, 'utf8'), /"n":39/)
  assert.match(readFileSync(files[0], 'utf8'), /"n":\d+/)
  // Created with owner-only permissions.
  assert.equal(statSync(path).mode & 0o777, 0o600)
})

test('JsonlFile: a second instance on an existing file continues its size', () => {
  const dir = tmp('reopen')
  const path = join(dir, 'y.jsonl')
  writeFileSync(path, 'x'.repeat(80))
  const f = new JsonlFile(path, 100, 2)
  f.append('0123456789\n') // 91 bytes, still within the limit
  f.append('abcdefghij\n') // would reach 102 bytes: rotates first
  assert.equal(existsSync(`${path}.1`), true)
  assert.equal(readFileSync(`${path}.1`, 'utf8').endsWith('0123456789\n'), true)
  assert.equal(readFileSync(path, 'utf8'), 'abcdefghij\n')
})

test('rotatedFiles: oldest first, existing ones only', () => {
  const dir = tmp('listing')
  const path = join(dir, 'z.jsonl')
  writeFileSync(`${path}.2`, '2')
  writeFileSync(`${path}.1`, '1')
  writeFileSync(path, '0')
  assert.deepEqual(rotatedFiles(path, 5), [`${path}.2`, `${path}.1`, path])
  assert.deepEqual(rotatedFiles(join(dir, 'missing.jsonl')), [])
  assert.equal(LOG_MAX_BYTES, 10 * 1024 * 1024)
  assert.equal(LOG_KEEP, 5)
})

test('paths: the router and addon logs live under the state folder', () => {
  assert.equal(routerLogPath(), join(logDir(), 'router.jsonl'))
  assert.equal(addonLogPath('ml-worker'), join(logDir(), 'addons', 'ml-worker.log'))
  assert.equal(auditLogPath().endsWith('audit.log'), true)
})

test('emit: the journal line is human-readable; the file line is JSON with the trace; the sink gets warnings and errors', () => {
  const records: LogRecord[] = []
  configureLog({ level: 'info', secrets: ['SECRET-TOKEN-VALUE'], sink: (r) => records.push(r), file: true })
  const out = captureStderr(() => {
    log('plain info')
    runTraced('a1b2c3d4', () => warn('spawn failed for SECRET-TOKEN-VALUE', 'spawn', { project: 'p' }))
    error('bad thing', 'addons')
  })
  assert.match(out, /plain info\n/)
  assert.match(out, /WARN spawn \[a1b2c3d4\] spawn failed for \[REDACTED\]/)
  assert.doesNotMatch(out, /SECRET-TOKEN-VALUE/)
  assert.match(out, /ERROR addons bad thing/)
  // The sink: warn and error only, redacted, with the trace.
  assert.deepEqual(records.map((r) => [r.level, r.component]), [['warn', 'spawn'], ['error', 'addons']])
  assert.equal(records[0].trace, 'a1b2c3d4')
  assert.equal(records[0].msg, 'spawn failed for [REDACTED]')
  // The file: JSON lines, with the trace, redacted.
  const entries = readEntries([routerLogPath()])
  const spawnLine = entries.find((e) => e.component === 'spawn')
  assert.ok(spawnLine)
  assert.equal(spawnLine?.trace, 'a1b2c3d4')
  assert.equal(spawnLine?.fields.project, 'p')
  assert.ok(entries.some((e) => e.msg === 'plain info' && e.level === 'info'))
  assert.equal(readFileSync(routerLogPath(), 'utf8').includes('SECRET-TOKEN-VALUE'), false)
})

test('emit: the level filters the journal and the file; debug shows while /debug on is open', () => {
  configureLog({ level: 'warn', secrets: [], sink: null })
  setDebugUntil(0)
  const before = readFileSync(routerLogPath(), 'utf8')
  const out = captureStderr(() => {
    log('quiet info')
    debug('quiet debug')
  })
  assert.equal(out, '')
  assert.equal(readFileSync(routerLogPath(), 'utf8'), before)
  // /debug on: debug lines are written for the window.
  setDebugUntil(Date.now() + 60_000)
  assert.equal(effectiveLevel(), 'debug')
  assert.equal(debugUntil() > Date.now(), true)
  const out2 = captureStderr(() => debug('now visible'))
  assert.match(out2, /DEBUG router now visible/)
  setDebugUntil(0)
  assert.equal(effectiveLevel(), 'warn')
  configureLog({ level: 'info' })
})

test('emit: a sink that throws does not break the caller; the component "logs" never reaches the sink', () => {
  const seen: string[] = []
  configureLog({ level: 'info', sink: (r) => {
    seen.push(r.component)
    throw new Error('sink broke')
  } })
  captureStderr(() => {
    warn('w', 'logs')
    warn('w2', 'spawn')
  })
  assert.deepEqual(seen, ['spawn'])
  configureLog({ sink: null })
})

test('emit: reserved field names cannot overwrite the record', () => {
  configureLog({ level: 'info', sink: null })
  captureStderr(() => emit('info', 'router', 'real msg', { msg: 'fake', level: 'error', ts: 'x', component: 'y' }))
  const e = readEntries([routerLogPath()]).find((x) => x.msg === 'real msg')
  assert.ok(e)
  assert.equal(e.level, 'info')
  assert.equal(e.component, 'router')
})

test('writeAddonLog: an addon line goes to its own file as JSON, redacted', () => {
  configureLog({ secrets: ['SECRET-TOKEN-VALUE'] })
  writeAddonLog('ml-worker', 'warn', 'cuda load failed with SECRET-TOKEN-VALUE')
  writeAddonLog('ml-worker', 'info', 'loaded')
  const lines = readFileSync(addonLogPath('ml-worker'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 2)
  assert.deepEqual(lines[0].component, 'addon:ml-worker')
  assert.equal(lines[0].level, 'warn')
  assert.equal(lines[0].msg, 'cuda load failed with [REDACTED]')
  assert.equal(lines[1].level, 'info')
  assert.equal(readFileSync(addonLogPath('ml-worker'), 'utf8').includes('SECRET-TOKEN-VALUE'), false)
})

test('audit: an event carries the trace of its flow; outside a flow it has none', () => {
  audit({ event: 'outbound', kind: 'reply' })
  runTraced('0badcafe', () => audit({ event: 'deliver', session: 's' }))
  const entries = readEntries([auditLogPath()])
  const outside = entries.find((e) => e.msg === 'outbound')
  const inside = entries.find((e) => e.msg === 'deliver')
  assert.equal(outside?.trace, undefined)
  assert.equal(inside?.trace, '0badcafe')
  assert.equal(inside?.component, 'audit')
  assert.equal(inside?.fields.session, 's')
})

test('readEntries: skips blank and bad lines; allRouterFiles lists what exists', () => {
  const dir = tmp('read')
  const path = join(dir, 'mixed.jsonl')
  writeFileSync(path, '\n{"ts":"2026-11-14T10:00:00.000Z","level":"info","component":"c","msg":"ok"}\nnot json\n\n')
  const entries = readEntries([path, join(dir, 'missing.jsonl')])
  assert.equal(entries.length, 1)
  assert.equal(entries[0].msg, 'ok')
  assert.ok(allRouterFiles().every((f) => existsSync(f)))
})

test('errMsg and the old debug name keep working', () => {
  assert.equal(errMsg(new Error('boom')), 'boom')
  assert.equal(errMsg('plain'), 'plain')
  const rotate = readdirSync(logDir()).length
  assert.ok(rotate >= 1)
})
