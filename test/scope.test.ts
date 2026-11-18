// Transient scopes for headless runs (src/adapters/scope.ts): the unit names, the argv that wraps a command, and the probe.
// The probe is faked; nothing here starts systemd-run.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scopeAvailable, unitName, wrapInScope } from '../src/adapters/scope.ts'

test('unitName: tg-<kind>-<8 hex>, and a new name every call', () => {
  const names = new Set<string>()
  for (let i = 0; i < 50; i++) {
    const n = unitName('modes')
    assert.match(n, /^tg-modes-[0-9a-f]{8}$/)
    names.add(n)
  }
  assert.equal(names.size, 50)
})

test('wrapInScope: systemd-run makes the scope and runs the command as given, arguments untouched', () => {
  const got = wrapInScope('nice', ['-n', '19', 'claude', '-p', '--', '--dash prompt'], 'tg-modes-0a1b2c3d')
  assert.deepEqual(got, {
    file: 'systemd-run',
    args: ['--user', '--scope', '--quiet', '--unit=tg-modes-0a1b2c3d', '--', 'nice', '-n', '19', 'claude', '-p', '--', '--dash prompt'],
  })
})

test('scopeAvailable: needs systemd-run and an answering --user manager; the manager is not asked without systemd-run', async () => {
  let asked = 0
  const up = async () => {
    asked++
    return true
  }
  assert.equal(await scopeAvailable({ hasSystemdRun: () => true, userManagerUp: up }), true)
  assert.equal(await scopeAvailable({ hasSystemdRun: () => true, userManagerUp: async () => false }), false)
  assert.equal(await scopeAvailable({ hasSystemdRun: () => false, userManagerUp: up }), false)
  assert.equal(asked, 1)
})
