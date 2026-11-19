// The PostToolUse path of plan 1.2 outside the router: the marker files (dir 700, one per Claude pid) and the shell guard
// bin/tg-posttool-hook, run for real with and without a marker. Temp folders are under test/ (ignored by git).
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clearPendingMarker, markerPath, pendingDir, setPendingMarker } from '../src/adapters/hooks/pending-marker.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const GUARD = join(HERE, '..', 'bin', 'tg-posttool-hook')

function tempDir(): string {
  return mkdtempSync(join(HERE, '.tmp-posttool-'))
}

test('pendingDir: the pending/ folder beside the router socket', () => {
  assert.equal(pendingDir('/run/user/1000/stolik.sock'), '/run/user/1000/pending')
  assert.equal(pendingDir('/home/u/.config/stolik/sock'), '/home/u/.config/stolik/pending')
})

test('marker lifecycle: set creates the folder (0700) and the marker; clear removes it; clearing twice is fine', () => {
  const root = tempDir()
  try {
    const dir = join(root, 'stolik', 'pending')
    setPendingMarker(4242, dir)
    assert.equal(existsSync(markerPath(4242, dir)), true)
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    setPendingMarker(4242, dir) // idempotent
    clearPendingMarker(4242, dir)
    assert.equal(existsSync(markerPath(4242, dir)), false)
    clearPendingMarker(4242, dir) // missing is fine
    assert.equal(existsSync(markerPath(4242, dir)), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('marker lifecycle: each Claude pid has its own marker', () => {
  const root = tempDir()
  try {
    const dir = join(root, 'pending')
    setPendingMarker(1, dir)
    setPendingMarker(2, dir)
    clearPendingMarker(1, dir)
    assert.equal(existsSync(markerPath(1, dir)), false)
    assert.equal(existsSync(markerPath(2, dir)), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// A stand-in for `node`: records its arguments in a file and exits with the code it is given through STUB_EXIT.
function fakeNode(root: string): string {
  const path = join(root, 'fake-node.sh')
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(root, 'called')}"\nexit \${STUB_EXIT:-0}\n`)
  chmodSync(path, 0o755)
  return path
}

// The guard finds the folder from the socket: STOLIK_SOCKET, here a socket inside `root`, so the folder is `root/pending`.
function runGuard(root: string, env: Record<string, string>, node: string) {
  return spawnSync('sh', [GUARD, node, join(root, 'hook.js')], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, STOLIK_SOCKET: join(root, 'stolik.sock'), ...env },
    encoding: 'utf8',
  })
}

test('shell guard: no pending folder at all, exits 0 and does not run node', () => {
  const root = tempDir()
  try {
    const node = fakeNode(root)
    const r = runGuard(root, {}, node)
    assert.equal(r.status, 0)
    assert.equal(existsSync(join(root, 'called')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('shell guard: folder present but no marker for this process tree, exits 0 without running node', () => {
  const root = tempDir()
  try {
    mkdirSync(join(root, 'pending'), { recursive: true })
    setPendingMarker(999999, join(root, 'pending')) // a pid that is not ours
    const node = fakeNode(root)
    const r = runGuard(root, {}, node)
    assert.equal(r.status, 0)
    assert.equal(existsSync(join(root, 'called')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('shell guard: a marker for an ancestor of the hook (the test process is the parent here) forwards PostToolUse', () => {
  const root = tempDir()
  try {
    setPendingMarker(process.pid, join(root, 'pending'))
    const node = fakeNode(root)
    const r = runGuard(root, {}, node)
    assert.equal(r.status, 0)
    assert.equal(readFileSync(join(root, 'called'), 'utf8'), `${join(root, 'hook.js')}\nPostToolUse\n`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('shell guard: always exits 0, even when the forwarded run fails', () => {
  const root = tempDir()
  try {
    setPendingMarker(process.pid, join(root, 'pending'))
    const node = fakeNode(root)
    const r = runGuard(root, { STUB_EXIT: '3' }, node)
    assert.equal(r.status, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('shell guard: missing arguments exit 0 quietly', () => {
  const r = spawnSync('sh', [GUARD], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, encoding: 'utf8' })
  assert.equal(r.status, 0)
})
