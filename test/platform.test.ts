import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLoginctlShow, logindIdleMs } from '../src/adapters/platform/linux-logind.ts'
import { parseProcStat, parseCmdline, isInteractiveClaude } from '../src/adapters/platform/linux-proc.ts'
import { parseXidle } from '../src/adapters/platform/linux-x11.ts'
import { presenceSource } from '../src/adapters/platform/index.ts'

// Output of `loginctl show-session 3 -p IdleHint -p IdleSinceHint -p LockedHint` on the dev PC (2026-11-14).
const LOGIND_IDLE = 'IdleHint=yes\nIdleSinceHint=1794608620432456\nLockedHint=no\n'
const LOGIND_ACTIVE = 'IdleHint=no\nIdleSinceHint=1794608620432456\nLockedHint=yes\n'

test('parseLoginctlShow: IdleHint, IdleSinceHint in microseconds, LockedHint', () => {
  assert.deepEqual(parseLoginctlShow(LOGIND_IDLE), { idleHint: true, idleSinceUs: 1794608620432456, locked: false })
  assert.deepEqual(parseLoginctlShow(LOGIND_ACTIVE), { idleHint: false, idleSinceUs: 1794608620432456, locked: true })
})

test('parseLoginctlShow: missing, empty or odd values give null, never a guess', () => {
  assert.deepEqual(parseLoginctlShow(''), { idleHint: null, idleSinceUs: null, locked: null })
  // systemd prints 0 for an unset timestamp; a non-number is unknown too.
  assert.deepEqual(parseLoginctlShow('IdleHint=yes\nIdleSinceHint=0\nLockedHint=maybe\n'), {
    idleHint: true,
    idleSinceUs: null,
    locked: null,
  })
  assert.deepEqual(parseLoginctlShow('IdleSinceHint=abc\r\nIdleHint=no\r\n').idleSinceUs, null)
})

test('logindIdleMs: 0 when not idle, time since the hint when idle, null when unknown', () => {
  const now = 1794609161579 // ms; IdleSinceHint is 1794608620432.456 ms
  const idle = parseLoginctlShow(LOGIND_IDLE)
  assert.equal(logindIdleMs(parseLoginctlShow(LOGIND_ACTIVE), now), 0)
  // 541146.544 ms after the hint, floored
  assert.equal(logindIdleMs(idle, now), 541146)
  assert.equal(logindIdleMs(idle, now - 10 * 60_000 * 2), 0, 'never negative')
  assert.equal(logindIdleMs({ idleHint: true, idleSinceUs: null, locked: false }, now), null)
  assert.equal(logindIdleMs({ idleHint: null, idleSinceUs: null, locked: null }, now), null)
})

test('parseProcStat: ppid is read after the last ")", so comm may hold spaces and parens', () => {
  assert.deepEqual(parseProcStat('4242 (claude) S 4000 4242 4242 0 -1 4194304'), { ppid: 4000 })
  assert.deepEqual(parseProcStat('4243 (my (odd) comm) S 77 4243 4243 0 -1'), { ppid: 77 })
  assert.equal(parseProcStat('4244 (broken) S x'), null)
  assert.equal(parseProcStat('no parens here'), null)
})

test('parseCmdline: NUL-separated argv, trailing NUL dropped, empty means null', () => {
  assert.deepEqual(parseCmdline('claude\0--resume\0abc\0'), ['claude', '--resume', 'abc'])
  assert.deepEqual(parseCmdline('python3\0-I\0bin/xidle.py'), ['python3', '-I', 'bin/xidle.py'])
  assert.equal(parseCmdline(''), null)
  assert.equal(isInteractiveClaude(parseCmdline('claude\0-p\0hi\0') ?? []), false)
  assert.equal(isInteractiveClaude(parseCmdline('claude\0--resume\0abc\0') ?? []), true)
})

test('parseXidle: milliseconds, failures and negatives give null', () => {
  assert.equal(parseXidle('1141165\n'), 1141165)
  assert.equal(parseXidle('0\n'), 0)
  assert.equal(parseXidle('-5'), null)
  assert.equal(parseXidle('xidle: cannot open X display'), null)
})

test('presenceSource: the config picks the backend by name', () => {
  assert.equal(presenceSource({ presence: 'x11' }).name, 'x11')
  assert.equal(presenceSource({ presence: 'logind' }, { XDG_SESSION_ID: '3' }).name, 'logind')
})
