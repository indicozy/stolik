// Pure observability rules (src/brain/observe.ts): levels, trace context, log lines, the timeline, the Logs-topic gate,
// forensics and /debug text, /trace and doctor helpers.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AlertGate, atLeast, buildDebugReport, buildForensics, checksJson, clockOf, currentTrace, diskStatus, fieldsText, forensicsFileName,
  formatChecks, formatLogLine, formatTimeline, isLevel, isTraceCommand, isTraceId, levelRank, matchesFilter, missingRights, newTraceId,
  parseDebugArgs, parseLogLine, parseSince, relativeTime, resolveOnPath, runTraced, stderrLevel, summarizeChecks, traceFromPayload,
  unitExecStart, unitPathValue, warnOrLog, type LogEntry,
} from '../src/brain/observe.ts'

test('levels: order, atLeast, and the level guard', () => {
  assert.ok(levelRank('debug') < levelRank('info') && levelRank('info') < levelRank('warn') && levelRank('warn') < levelRank('error'))
  assert.equal(atLeast('warn', 'info'), true)
  assert.equal(atLeast('info', 'warn'), false)
  assert.equal(atLeast('error', 'error'), true)
  assert.equal(isLevel('warn'), true)
  assert.equal(isLevel('trace'), false)
  assert.equal(isLevel(3), false)
})

test('trace ids: 8 lowercase hex characters, from the payload only when valid', () => {
  for (let i = 0; i < 50; i++) assert.match(newTraceId(), /^[0-9a-f]{8}$/)
  assert.equal(isTraceId('a1b2c3d4'), true)
  assert.equal(isTraceId('A1B2C3D4'), false)
  assert.equal(isTraceId('a1b2c3d'), false)
  assert.equal(isTraceId('a1b2c3d4e'), false)
  assert.equal(traceFromPayload('0badcafe'), '0badcafe')
  assert.equal(traceFromPayload('nothex!!'), undefined)
  assert.equal(traceFromPayload(42), undefined)
})

test('trace context: runTraced sets the trace for the flow, including awaits and timers', async () => {
  assert.equal(currentTrace(), undefined)
  const seen: Array<string | undefined> = []
  await runTraced('11223344', async () => {
    seen.push(currentTrace())
    await new Promise((r) => setImmediate(r))
    seen.push(currentTrace())
    await new Promise<void>((resolve) => setTimeout(() => {
      seen.push(currentTrace())
      resolve()
    }, 1))
  })
  assert.deepEqual(seen, ['11223344', '11223344', '11223344'])
  assert.equal(currentTrace(), undefined)
})

test('trace context: nested runTraced takes the inner id and restores the outer one', () => {
  runTraced('aaaaaaaa', () => {
    runTraced('bbbbbbbb', () => assert.equal(currentTrace(), 'bbbbbbbb'))
    assert.equal(currentTrace(), 'aaaaaaaa')
  })
})

test('parseLogLine: router lines, audit lines, and junk', () => {
  const r = parseLogLine('{"ts":"2026-11-14T10:00:00.000Z","level":"warn","component":"spawn","trace":"a1b2c3d4","msg":"x didn\'t start","project":"x"}')
  assert.deepEqual(r, { ts: '2026-11-14T10:00:00.000Z', level: 'warn', component: 'spawn', msg: "x didn't start", trace: 'a1b2c3d4', fields: { project: 'x' } })
  const a = parseLogLine('{"ts":"2026-11-14T10:00:01.000Z","trace":"a1b2c3d4","event":"outbound","kind":"reply","length":12}')
  assert.equal(a?.component, 'audit')
  assert.equal(a?.msg, 'outbound')
  assert.equal(a?.level, 'info')
  assert.equal(a?.trace, 'a1b2c3d4')
  assert.deepEqual(a?.fields, { kind: 'reply', length: 12 })
  // A bad trace value is dropped, not kept.
  assert.equal(parseLogLine('{"ts":"2026-11-14T10:00:01.000Z","level":"info","component":"x","msg":"m","trace":"zz"}')?.trace, undefined)
  assert.equal(parseLogLine('not json'), null)
  assert.equal(parseLogLine('[1,2]'), null)
  assert.equal(parseLogLine('{"level":"info","msg":"no ts"}'), null)
})

test('parseSince: numbers with s, m, h or d; anything else is null', () => {
  assert.equal(parseSince('10m'), 600_000)
  assert.equal(parseSince('30s'), 30_000)
  assert.equal(parseSince('2h'), 7_200_000)
  assert.equal(parseSince('1d'), 86_400_000)
  assert.equal(parseSince('10'), null)
  assert.equal(parseSince('10x'), null)
  assert.equal(parseSince(''), null)
})

const entry = (over: Partial<LogEntry>): LogEntry => ({ ts: '2026-11-14T10:00:00.000Z', level: 'info', component: 'router', msg: 'm', fields: {}, ...over })

test('matchesFilter: level, trace and time window', () => {
  const now = Date.parse('2026-11-14T10:10:00.000Z')
  const e = entry({ level: 'warn', trace: 'a1b2c3d4', ts: '2026-11-14T10:05:00.000Z' })
  assert.equal(matchesFilter(e, { level: 'warn' }, now), true)
  assert.equal(matchesFilter(e, { level: 'error' }, now), false)
  assert.equal(matchesFilter(e, { trace: 'a1b2c3d4' }, now), true)
  assert.equal(matchesFilter(e, { trace: 'ffffffff' }, now), false)
  assert.equal(matchesFilter(e, { sinceMs: 600_000 }, now), true)
  assert.equal(matchesFilter(e, { sinceMs: 60_000 }, now), false)
  assert.equal(matchesFilter(entry({ ts: 'garbage' }), { sinceMs: 1 }, now), false)
})

test('fields and lines: strings bare unless they hold spaces; objects as JSON; nulls and undefined dropped', () => {
  assert.equal(fieldsText({ a: 'x', b: 'two words', c: 3, d: { k: 1 }, e: null, f: undefined }), 'a=x b="two words" c=3 d={"k":1}')
  const line = formatLogLine(entry({ level: 'warn', component: 'spawn', trace: 'a1b2c3d4', msg: 'boom', fields: { project: 'p' } }))
  assert.match(line, /^\d\d:\d\d:\d\d\.\d{3} WARN  spawn \[a1b2c3d4\] boom project=p$/)
  assert.match(clockOf('2026-11-14T10:00:00.123Z'), /^\d\d:\d\d:\d\d\.123$/)
  assert.equal(clockOf('not a date'), 'not a date')
})

test('relativeTime: milliseconds below a second, seconds above', () => {
  assert.equal(relativeTime(0), '+0ms')
  assert.equal(relativeTime(412.6), '+413ms')
  assert.equal(relativeTime(1_234), '+1.234s')
})

test('formatTimeline: time order, relative to the first line, short form, and a cut-off with the count', () => {
  const lines = [
    entry({ ts: '2026-11-14T10:00:02.000Z', component: 'spawn', msg: 'second', fields: { project: 'p' } }),
    entry({ ts: '2026-11-14T10:00:00.000Z', component: 'router', msg: 'first' }),
    entry({ ts: '2026-11-14T10:00:00.500Z', component: 'route', msg: 'middle' }),
  ]
  const long = formatTimeline(lines)
  assert.equal(long.length, 3)
  assert.match(long[0], /^\+0ms {6}\d\d:\d\d:\d\d\.000 INFO  router first$/)
  assert.match(long[1], /^\+500ms /)
  assert.match(long[2], /^\+2\.000s /)
  const short = formatTimeline(lines, { short: true })
  assert.equal(short[0], '+0ms      router: first')
  assert.equal(short[2], '+2.000s   spawn: second project=p')
  const cut = formatTimeline(lines, { short: true, max: 2 })
  assert.equal(cut.length, 3)
  assert.equal(cut[2], '… 1 more')
  assert.deepEqual(formatTimeline([]), [])
})

test('AlertGate: duplicates within the window are counted, the limit drops and counts, the count is taken once', () => {
  const g = new AlertGate(2, 5 * 60_000)
  const t = 1_000_000
  assert.deepEqual(g.offer('a', t), { action: 'send', repeats: 0 })
  assert.deepEqual(g.offer('a', t + 1), { action: 'duplicate' })
  assert.deepEqual(g.offer('a', t + 2), { action: 'duplicate' })
  assert.deepEqual(g.offer('b', t + 3), { action: 'send', repeats: 0 })
  // Two sends in the minute: the third distinct message is rate-limited.
  assert.deepEqual(g.offer('c', t + 4), { action: 'rate-limited' })
  assert.deepEqual(g.offer('d', t + 5), { action: 'rate-limited' })
  assert.equal(g.takeRateDropped(), 2)
  assert.equal(g.takeRateDropped(), 0)
  // After the minute the window has room again; the old duplicates are reported on the next send of that key.
  assert.deepEqual(g.offer('c', t + 61_000), { action: 'send', repeats: 0 })
  assert.deepEqual(g.offer('a', t + 6 * 60_000), { action: 'send', repeats: 2 })
})

test('AlertGate: the same key sends again after the dedupe window', () => {
  const g = new AlertGate(100, 1_000)
  assert.equal(g.offer('k', 0).action, 'send')
  assert.equal(g.offer('k', 500).action, 'duplicate')
  assert.equal(g.offer('k', 1_500).action, 'send')
})

test('stderrLevel: tracebacks and exceptions are errors, failures warnings, the rest info', () => {
  assert.equal(stderrLevel('Traceback (most recent call last):'), 'error')
  assert.equal(stderrLevel('ValueError: unknown op'), 'error')
  assert.equal(stderrLevel('[ml] whisper: cuda load failed, using cpu'), 'warn')
  assert.equal(stderrLevel('[ml] whisper: loaded on cuda in 0.0 s'), 'info')
  assert.equal(stderrLevel('modes: warning: read-mode guard refused Read in ~/.ssh'), 'warn')
  assert.equal(stderrLevel('modes: hook self-test passed: read and web are on'), 'info')
})

test('forensics: the file has the argv, environment names and PATH, and no secret values', () => {
  const text = buildForensics({
    ts: '2026-11-14T10:00:00.000Z', project: 'shop', cwd: '/home/u/shop', argv: ['tmux', 'new-session', '-d'],
    tmuxName: 'tg-shop', envNames: ['HOME', 'PATH'], path: '/usr/bin:/bin', pane: ['trust dialog'], claudeVersion: '2.1.0', reason: 'did not connect',
  })
  assert.match(text, /reason: did not connect/)
  assert.match(text, /"tmux"/)
  assert.match(text, /PATH: \/usr\/bin:\/bin/)
  assert.match(text, /^ {2}HOME$/m)
  assert.match(text, /\| trust dialog/)
  assert.match(text, /claude --version: 2\.1\.0/)
  const empty = buildForensics({ ts: 't', project: 'p', cwd: '/c', argv: [], tmuxName: null, envNames: [], path: undefined, pane: [], claudeVersion: null, reason: 'r' })
  assert.match(empty, /tmux session: \(none\)/)
  assert.match(empty, /\(no output\)/)
  assert.match(empty, /PATH: \(unset\)/)
})

test('forensics file name: safe time and project', () => {
  assert.equal(forensicsFileName('2026-11-14T10:00:00.123Z', 'my/shop'), '2026-11-14T10-00-00-123Z-my_shop.txt')
  assert.equal(forensicsFileName('2026-11-14T10:00:00.123Z', ''), '2026-11-14T10-00-00-123Z-project.txt')
})

test('debug arguments: report, on with minutes (default 60, capped at 1440), off, and junk', () => {
  assert.deepEqual(parseDebugArgs(''), { action: 'report' })
  assert.deepEqual(parseDebugArgs('  '), { action: 'report' })
  assert.deepEqual(parseDebugArgs('on'), { action: 'on', minutes: 60 })
  assert.deepEqual(parseDebugArgs('on 15'), { action: 'on', minutes: 15 })
  assert.deepEqual(parseDebugArgs('ON 99999'), { action: 'on', minutes: 1440 })
  assert.deepEqual(parseDebugArgs('off'), { action: 'off' })
  assert.equal(parseDebugArgs('on 0'), null)
  assert.equal(parseDebugArgs('verbose'), null)
})

test('debug report: every area, the level and the queue depths', () => {
  const now = Date.parse('2026-11-14T10:00:00.000Z')
  const text = buildDebugReport({
    now, uptimeSec: 3_900, version: '0.1.0', gitSha: 'abc1234', level: 'debug', debugUntil: now + 60_000,
    sessions: [{ name: 'shop', folder: '~/shop', connected: true, lastActive: now - 120_000, tmux: 'tg-shop' }],
    addons: [{ name: 'ml-worker', status: 'running', running: true, restarts: 2, lastError: 'exited (code 1)' }],
    queues: { group: 3, dm: 0 },
    ml: { ok: true, gpu: '1', vram: { usedMiB: 2048, totalMiB: 8188 }, models: [{ name: 'whisper', loaded: true, device: 'cuda', unloadInSec: 480 }, { name: 'qwen', loaded: false, device: null, unloadInSec: null }] },
    quota: { weeklyUsedPct: 40, aheadBy: 0 },
    logsTopic: 'on',
  })
  assert.match(text, /^tg-bridge 0\.1\.0 \(abc1234\), up 1h 5m/)
  assert.match(text, /log level: debug \(debug on until \d\d:\d\d\)/)
  assert.match(text, /shop: connected, last activity 2m ago/)
  assert.match(text, /tmux tg-shop/)
  assert.match(text, /ml-worker: running, restarts 2, last error: exited \(code 1\)/)
  assert.match(text, /outbound queue: group 3, dm 0/)
  assert.match(text, /VRAM 2048\/8188 MiB/)
  assert.match(text, /whisper: loaded on cuda, unloads in 480 s/)
  assert.match(text, /quota: week 40% used, on pace or behind/)
})

test('debug report: nothing running says so, and a missing ML worker gives its reason', () => {
  const text = buildDebugReport({
    now: 0, uptimeSec: null, version: 'unknown', gitSha: null, level: 'info', debugUntil: null, sessions: [], addons: [],
    queues: {}, ml: { ok: false, reason: 'not installed' }, quota: null, logsTopic: 'off',
  })
  assert.match(text, /up unknown/)
  assert.match(text, /sessions \(0\):\n {2}none/)
  assert.match(text, /addons \(0\):\n {2}none installed/)
  assert.match(text, /outbound queue: empty/)
  assert.match(text, /ml-worker: not installed/)
  assert.match(text, /quota: unknown/)
  assert.doesNotMatch(text, /debug on until/)
})

test('/trace is recognised as the first word only', () => {
  assert.equal(isTraceCommand('/trace'), true)
  assert.equal(isTraceCommand('  /trace '), true)
  assert.equal(isTraceCommand('/trace@mybot'), true)
  assert.equal(isTraceCommand('/traces'), false)
  assert.equal(isTraceCommand('hello /trace'), false)
})

test('doctor: a failing check fails the run, warnings do not, and the output names both', () => {
  const ok = { id: 'a', title: 'A', status: 'ok' as const, detail: 'fine' }
  const warn = { id: 'b', title: 'B', status: 'warn' as const, detail: 'meh' }
  const fail = { id: 'c', title: 'C', status: 'fail' as const, detail: 'broken' }
  assert.deepEqual(summarizeChecks([ok, warn]), { ok: true, exitCode: 0 })
  assert.deepEqual(summarizeChecks([ok, fail]), { ok: false, exitCode: 1 })
  assert.match(formatChecks([ok, warn]), /doctor: all checks passed \(1 warning\)/)
  assert.match(formatChecks([ok, fail]), /\[FAIL\] C: broken/)
  assert.match(formatChecks([ok, fail]), /doctor: 1 check failed/)
  const j = JSON.parse(checksJson([ok, fail]))
  assert.equal(j.ok, false)
  assert.equal(j.checks.length, 2)
})

test('doctor: PATH lookup, unit PATH and ExecStart parsing', () => {
  const exists = new Set(['/usr/local/bin/claude', '/home/u/.local/bin/tmux'])
  const isExec = (f: string) => exists.has(f)
  assert.equal(resolveOnPath('claude', '/usr/bin:/usr/local/bin', isExec), '/usr/local/bin/claude')
  assert.equal(resolveOnPath('tmux', '/usr/bin::/home/u/.local/bin/', isExec), '/home/u/.local/bin/tmux')
  assert.equal(resolveOnPath('tmux', '/usr/bin', isExec), null)
  assert.equal(resolveOnPath('tmux', undefined, isExec), null)
  const unit = '[Service]\nExecStart=/usr/bin/node /x/dist/router/main.js\nEnvironment="PATH=/opt/n/bin:/usr/bin"\n'
  assert.equal(unitPathValue(unit, '/home/u'), '/opt/n/bin:/usr/bin')
  assert.equal(unitPathValue('[Service]\nExecStart=/bin/true\n', '/home/u'), null)
  // systemd expands %h (the user's home) and %% (a literal percent sign) in unit values.
  const spec = '[Service]\nEnvironment="PATH=/a/bin:%h/.local/bin:/usr/bin"\n'
  assert.equal(unitPathValue(spec, '/home/u'), '/a/bin:/home/u/.local/bin:/usr/bin')
  assert.equal(unitPathValue('[Service]\nEnvironment=PATH=/x/%%/bin\n', '/home/u'), '/x/%/bin')
  assert.equal(unitExecStart(unit), '/usr/bin/node /x/dist/router/main.js')
  assert.equal(unitExecStart('[Service]\n'), null)
})

test('doctor: disk thresholds (warn below 1 GiB, fail below 200 MiB)', () => {
  assert.equal(diskStatus(10 * 1024 ** 3), 'ok')
  assert.equal(diskStatus(500 * 1024 ** 2), 'warn')
  assert.equal(diskStatus(100 * 1024 ** 2), 'fail')
})

test('doctor: missing group rights are named; a creator has all of them', () => {
  assert.deepEqual(missingRights({ status: 'creator' }), [])
  assert.deepEqual(missingRights({ status: 'member' }), ['can_manage_topics', 'can_delete_messages', 'can_pin_messages'])
  assert.deepEqual(missingRights({ status: 'administrator', can_manage_topics: true, can_delete_messages: true, can_pin_messages: false }), ['can_pin_messages'])
  assert.deepEqual(missingRights({ status: 'administrator', can_manage_topics: true, can_delete_messages: true, can_pin_messages: true }), [])
})

test('warnOrLog: warns through a logger that can, logs otherwise', () => {
  const calls: string[] = []
  warnOrLog({ log: (m) => calls.push('log ' + m), warn: (m, c) => calls.push(`warn ${c} ${m}`) }, 'x', 'comp')
  warnOrLog({ log: (m) => calls.push('log ' + m) }, 'y', 'comp')
  assert.deepEqual(calls, ['warn comp x', 'log y'])
})
