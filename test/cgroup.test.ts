// The router's cgroup (stolik doctor, and the router's start-up checks): the parsers for /proc and cgroup v2 files, the
// process tree test (a process is the router's when its parent chain reaches the router), the reader over an injected
// file source, and the doctor check. Nothing here reads the machine: every file is a fake.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foreignProcs, parseCgroupPath, parseCgroupProcs, parsePpid, readRouterCgroup, type CgroupIo } from '../src/adapters/cgroup.ts'
import { checkRouterCgroup, type RouterCgroupFacts } from '../src/cli/doctor.ts'

const UNIT = '/user.slice/user-1000.slice/user@1000.service/app.slice/stolik.service'

test('parseCgroupPath: the cgroup v2 line of /proc/<pid>/cgroup; null for a v1-only file', () => {
  assert.equal(parseCgroupPath(`0::${UNIT}\n`), UNIT)
  assert.equal(parseCgroupPath(`12:cpu,cpuacct:/a\n1:name=systemd:/b\n0::/c/d\n`), '/c/d')
  assert.equal(parseCgroupPath('0::/\n'), '/')
  assert.equal(parseCgroupPath('12:cpu:/a\n'), null)
  assert.equal(parseCgroupPath(''), null)
})

test('parseCgroupProcs: one positive pid per line; anything else is skipped', () => {
  assert.deepEqual(parseCgroupProcs('123\n456\n\n'), [123, 456])
  assert.deepEqual(parseCgroupProcs('x\n-1\n0\n7\n1.5\n'), [7])
  assert.deepEqual(parseCgroupProcs(''), [])
})

test('parsePpid: the parent pid after the command name, which may hold spaces and brackets', () => {
  assert.equal(parsePpid('4242 (node) S 1000 4242 4242 0 -1 4194560 1 0'), 1000)
  assert.equal(parsePpid('4243 (my (odd) name) S 4242 4243 4243 0 -1'), 4242)
  assert.equal(parsePpid('garbage'), null)
  assert.equal(parsePpid(''), null)
})

test('foreignProcs: a process is the router’s when its parent chain reaches the router; the rest are foreign', () => {
  // 100 is the router. 101 is its child, 102 the child's child. 200 is a tmux server reparented to systemd (pid 1), 201 a
  // session shell under it, 202 a hook that session started. 300 is gone (no parent entry): never reported.
  const ppid: Record<number, number | null> = { 101: 100, 102: 101, 200: 1, 201: 200, 202: 201, 300: null }
  const got = foreignProcs([100, 101, 102, 200, 201, 202, 300], 100, (pid) => ppid[pid] ?? null)
  assert.deepEqual(got, [200, 201, 202])
})

test('foreignProcs: the router alone, or only its children, gives nothing foreign', () => {
  assert.deepEqual(foreignProcs([100, 101], 100, (pid) => ({ 101: 100 })[pid] ?? null), [])
  assert.deepEqual(foreignProcs([], 100, () => null), [])
})

test('readRouterCgroup: reads the router’s cgroup, its procs, their parents and command names through the injected source', () => {
  const files: Record<string, string> = {
    '/proc/100/cgroup': `0::${UNIT}\n`,
    [`/sys/fs/cgroup${UNIT}/cgroup.procs`]: '100\n101\n200\n201\n',
    '/proc/100/stat': '100 (node) S 1 100 100 0 -1',
    '/proc/101/stat': '101 (node) S 100 101 101 0 -1',
    '/proc/200/stat': '200 (tmux) S 1 200 200 0 -1',
    '/proc/201/stat': '201 (bash) S 200 201 201 0 -1',
    '/proc/200/comm': 'tmux: server\n',
    '/proc/201/comm': 'bash\n',
  }
  const io: CgroupIo = { readText: (p) => (p in files ? files[p] : null) }
  const got = readRouterCgroup(100, io)
  assert.deepEqual(got, {
    path: UNIT,
    routerPid: 100,
    total: 4,
    foreign: [
      { pid: 200, comm: 'tmux: server' },
      { pid: 201, comm: 'bash' },
    ],
  })
})

test('readRouterCgroup: null when the process is gone, has no v2 cgroup, or its procs cannot be read', () => {
  assert.equal(readRouterCgroup(100, { readText: () => null }), null)
  assert.equal(readRouterCgroup(100, { readText: (p) => (p === '/proc/100/cgroup' ? '12:cpu:/x\n' : null) }), null)
  assert.equal(readRouterCgroup(100, { readText: (p) => (p === '/proc/100/cgroup' ? `0::${UNIT}\n` : null) }), null)
})

test('checkRouterCgroup: no router running is ok and says nothing to compare', () => {
  const [c] = checkRouterCgroup({ routerCgroup: () => null })
  assert.equal(c.status, 'ok')
  assert.match(c.detail, /no router/)
})

test('checkRouterCgroup: only the router and its children is ok', () => {
  const facts: RouterCgroupFacts = { path: UNIT, routerPid: 100, total: 2, foreign: [] }
  const [c] = checkRouterCgroup({ routerCgroup: () => facts })
  assert.equal(c.status, 'ok')
})

test('checkRouterCgroup: foreign processes in the router’s cgroup warn, naming each command and pid', () => {
  const facts: RouterCgroupFacts = {
    path: UNIT,
    routerPid: 100,
    total: 4,
    foreign: [
      { pid: 200, comm: 'tmux: server' },
      { pid: 201, comm: 'bash' },
    ],
  }
  const checks = checkRouterCgroup({ routerCgroup: () => facts })
  assert.equal(checks.length, 1)
  assert.equal(checks[0].id, 'router-cgroup')
  assert.equal(checks[0].status, 'warn')
  assert.match(checks[0].detail, /2 processes outside the router/)
  assert.match(checks[0].detail, /tmux: server \(pid 200\)/)
  assert.match(checks[0].detail, /bash \(pid 201\)/)
  assert.match(checks[0].detail, /stolik\.service/)
})

test('checkRouterCgroup: absent from the deps, no check line', () => {
  assert.deepEqual(checkRouterCgroup({}), [])
})
