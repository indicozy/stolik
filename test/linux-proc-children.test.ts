import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { childPids, descendants, processName, signal, terminalWindowPid } from '../src/adapters/platform/linux-proc.ts'

// A fake /proc: one directory per pid with stat (ppid is the field after the state) and comm and cmdline files.
type Proc = { pid: number; ppid: number; comm: string; argv?: string[]; noCmdline?: boolean }

function makeProc(procs: Proc[]): string {
  const root = mkdtempSync(join(tmpdir(), 'fake-proc-'))
  mkdirSync(join(root, 'self'))
  for (const p of procs) {
    const dir = join(root, String(p.pid))
    mkdirSync(dir)
    writeFileSync(join(dir, 'stat'), `${p.pid} (${p.comm}) S ${p.ppid} 1 1 0\n`)
    writeFileSync(join(dir, 'comm'), `${p.comm}\n`)
    if (!p.noCmdline) writeFileSync(join(dir, 'cmdline'), (p.argv ?? [p.comm]).map((a) => `${a}\0`).join(''))
  }
  return root
}

test('childPids: the direct children only, ignoring non-pid entries', () => {
  const root = makeProc([
    { pid: 100, ppid: 1, comm: 'alacritty' },
    { pid: 200, ppid: 100, comm: 'zsh' },
    { pid: 201, ppid: 100, comm: 'zsh' },
    { pid: 300, ppid: 200, comm: 'claude' },
  ])
  try {
    assert.deepEqual(childPids(100, root), [200, 201])
    assert.deepEqual(childPids(300, root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('childPids: null when /proc cannot be listed', () => {
  assert.equal(childPids(100, join(tmpdir(), 'no-such-proc-root-for-tests')), null)
})

test('descendants: walks the tree with argv; a zombie has empty argv; a vanished process is skipped', () => {
  const root = makeProc([
    { pid: 300, ppid: 1, comm: 'claude' },
    { pid: 310, ppid: 300, comm: 'zsh', argv: ['/usr/bin/zsh', '-c', 'source /h/.claude/shell-snapshots/s.sh'] },
    { pid: 311, ppid: 310, comm: 'sleep', argv: ['sleep', '600'] },
    { pid: 312, ppid: 300, comm: 'defunct', argv: [] },
    { pid: 313, ppid: 300, comm: 'gone', noCmdline: true },
  ])
  // pid 313 is listed under 300 but has no cmdline, as if it exited between the reads: skipped, not an error.
  try {
    const got = descendants(300, root)
    assert.ok(got !== null)
    assert.deepEqual(
      got.map((d) => d.pid).sort((a, b) => a - b),
      [310, 311, 312],
    )
    assert.deepEqual(got.find((d) => d.pid === 311)?.argv, ['sleep', '600'])
    assert.deepEqual(got.find((d) => d.pid === 312)?.argv, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('descendants: null when /proc cannot be listed', () => {
  assert.equal(descendants(300, join(tmpdir(), 'no-such-proc-root-for-tests')), null)
})

test('processName: the trimmed comm, null when missing', () => {
  const root = makeProc([{ pid: 100, ppid: 1, comm: 'alacritty' }])
  try {
    assert.equal(processName(100, root), 'alacritty')
    assert.equal(processName(999, root), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('terminalWindowPid: terminal > shell > claude with the shell as the only child', () => {
  const root = makeProc([
    { pid: 100, ppid: 1, comm: 'alacritty' },
    { pid: 200, ppid: 100, comm: 'zsh' },
    { pid: 300, ppid: 200, comm: 'claude' },
  ])
  try {
    assert.equal(terminalWindowPid(300, root), 100)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('terminalWindowPid: terminal > claude (alacritty -e claude) with claude as the only child', () => {
  const root = makeProc([
    { pid: 100, ppid: 1, comm: 'kitty' },
    { pid: 300, ppid: 100, comm: 'claude' },
  ])
  try {
    assert.equal(terminalWindowPid(300, root), 100)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('terminalWindowPid: a terminal with other children (several windows or sessions) never matches', () => {
  const root = makeProc([
    { pid: 100, ppid: 1, comm: 'alacritty' },
    { pid: 200, ppid: 100, comm: 'zsh' },
    { pid: 201, ppid: 100, comm: 'zsh' },
    { pid: 300, ppid: 200, comm: 'claude' },
  ])
  try {
    assert.equal(terminalWindowPid(300, root), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('terminalWindowPid: a parent that is not a known terminal emulator never matches', () => {
  const root = makeProc([
    { pid: 100, ppid: 1, comm: 'gnome-terminal-' },
    { pid: 200, ppid: 100, comm: 'zsh' },
    { pid: 300, ppid: 200, comm: 'claude' },
  ])
  try {
    assert.equal(terminalWindowPid(300, root), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('terminalWindowPid: null when the tree is unreadable or claude has no parent', () => {
  assert.equal(terminalWindowPid(300, join(tmpdir(), 'no-such-proc-root-for-tests')), null)
  const root = makeProc([{ pid: 300, ppid: 1, comm: 'claude' }])
  try {
    assert.equal(terminalWindowPid(300, root), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('signal: false for a pid that does not exist', () => {
  assert.equal(signal(2_147_483_646, 'SIGTERM'), false)
})
