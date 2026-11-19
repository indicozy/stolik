// Peer identity of router socket connections (finding 14): the ss listing parser, ancestry, the message gate, and on
// Linux a real connection from a child process, whose pid must come back as the peer.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { ancestry, claimHolds, gateMessage, parseSsRows, peerPidFromSs, peerPidOf, validPid } from '../src/adapters/channel/peer.ts'
import { startSocketServer, closeSocketServer } from '../src/adapters/channel/server.ts'
import { SOCKET_PATH } from '../src/config.ts'
import type { LineConn } from '../src/adapters/channel/ipc.ts'
import type { Server } from 'node:net'

// `ss -xpeH` lines as Linux prints them: a server-side socket with its path, and the client's unnamed end.
const SS = [
  'u_str ESTAB 0 0 /run/user/1000/stolik.sock 6749074 * 6749073 users:(("node",pid=5000,fd=23))                      <-> ino:364587 dev:0/51',
  'u_str ESTAB 0 0 * 6749073 * 6749074 users:(("node",pid=5100,fd=12))                                                  <-> ino:364588 dev:0/51',
  'u_str LISTEN 0 511 /run/user/1000/stolik.sock 6700000 * 0 users:(("node",pid=5000,fd=20))',
].join('\n')

test('parseSsRows: local and peer inodes and the owner pid of each unix socket row', () => {
  const rows = parseSsRows(SS)
  assert.deepEqual(rows[0], { localIno: '6749074', peerIno: '6749073', owner: 5000 })
  assert.deepEqual(rows[1], { localIno: '6749073', peerIno: '6749074', owner: 5100 })
  assert.deepEqual(rows[2], { localIno: '6700000', peerIno: '0', owner: 5000 })
})

test('peerPidFromSs: the owner of the peer end, looked up from the accepted socket inode', () => {
  assert.equal(peerPidFromSs(SS, '6749074'), 5100, 'the accepted socket on the server side: its peer is the client')
  assert.equal(peerPidFromSs(SS, '6749073'), 5000, 'and the other way round')
  assert.equal(peerPidFromSs(SS, '9999999'), null, 'an unknown inode gives nothing')
})

test('peerPidFromSs: a peer that has already gone gives null', () => {
  const gone = 'u_str ESTAB 0 0 /run/user/1000/stolik.sock 6749074 * 6749073 users:(("node",pid=5000,fd=23))'
  assert.equal(peerPidFromSs(gone, '6749074'), null)
})

test('ancestry: the pid itself, then its parents, nearest first', () => {
  const chain = ancestry(process.pid)
  assert.equal(chain[0], process.pid)
  if (process.ppid > 1) assert.equal(chain[1], process.ppid)
})

test('claimHolds: the parent of this process holds, an unrelated pid does not', () => {
  if (process.ppid > 1) assert.equal(claimHolds(process.ppid, process.pid), true)
  assert.equal(claimHolds(1, process.pid), false, 'init is never a claim')
  assert.equal(claimHolds(999_999_999, process.pid), false)
})

test('validPid: positive safe integers only', () => {
  assert.equal(validPid(4242), 4242)
  for (const bad of [0, -1, 1.5, NaN, Infinity, '4242', null, undefined, 2 ** 60]) assert.equal(validPid(bad), null, String(bad))
})

const never = () => false
const always = () => true

test('gateMessage: a claim that is not a positive integer is refused', () => {
  for (const bad of [0, -5, 2.5, 'x']) {
    const g = gateMessage({ t: 'hook', claudePid: bad }, 100, { claimHolds: always, isClaudeSession: never })
    assert.equal(g.ok, false, String(bad))
  }
})

test('gateMessage: a claim that is not the peer or its parent is refused; the right claim passes', () => {
  const claimed = gateMessage({ t: 'register', claudePid: 777 }, 100, { claimHolds: (c, p) => c === 777 && p === 100, isClaudeSession: never })
  assert.equal(claimed.ok, true)
  const wrong = gateMessage({ t: 'register', claudePid: 888 }, 100, { claimHolds: (c, p) => c === 777 && p === 100, isClaudeSession: never })
  assert.equal(wrong.ok, false)
})

test('gateMessage: an unknown peer (macOS, failed lookup) skips the claim check', () => {
  const g = gateMessage({ t: 'hook', claudePid: 888 }, null, { claimHolds: never, isClaudeSession: never })
  assert.equal(g.ok, true)
})

test('gateMessage: no claim at all (reply, ctl status) is not checked against the peer', () => {
  assert.equal(gateMessage({ t: 'reply', text: 'hi' }, 100, { claimHolds: never, isClaudeSession: never }).ok, true)
  assert.equal(gateMessage({ t: 'ctl', cmd: 'status' }, 100, { claimHolds: never, isClaudeSession: never }).ok, true)
})

test('gateMessage: ctl unlock from inside a Claude session is refused with a reply; lock is still allowed', () => {
  const unlock = gateMessage({ t: 'ctl', cmd: 'unlock' }, 100, { claimHolds: always, isClaudeSession: always })
  assert.equal(unlock.ok, false)
  assert.equal(unlock.ok === false && unlock.reply && (unlock.reply as any).ok, false)
  assert.equal(gateMessage({ t: 'ctl', cmd: 'lock' }, 100, { claimHolds: always, isClaudeSession: always }).ok, true)
  assert.equal(gateMessage({ t: 'ctl', cmd: 'unlock' }, 100, { claimHolds: always, isClaudeSession: never }).ok, true, 'a shell outside Claude may unlock')
  assert.equal(gateMessage({ t: 'ctl', cmd: 'unlock' }, null, { claimHolds: always, isClaudeSession: always }).ok, true, 'unknown peer: as before')
})

// ---- a real connection (Linux) ---------------------------------------------

const onLinux = process.platform === 'linux'

test('peerPidOf: a connection from a child process reports the child pid (Linux)', { skip: !onLinux }, async () => {
  const drops: string[] = []
  const got: Array<{ conn: LineConn; msg: any }> = []
  const server: Server = await startSocketServer(
    (conn, msg) => got.push({ conn, msg }),
    () => {},
    SOCKET_PATH,
    { onDrop: (r) => drops.push(r) },
  )
  try {
    const child = spawn(process.execPath, ['-e', CLIENT, SOCKET_PATH, String(process.pid)], { stdio: 'ignore' })
    const deadline = Date.now() + 8000
    while (got.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
    assert.equal(got.length, 1, `one message dispatched (drops: ${drops.join('; ')})`)
    const pid = await peerPidOf(got[0].conn.socket as any)
    assert.equal(pid, child.pid)
    child.kill()
  } finally {
    await closeSocketServer(server)
  }
})

// The client claims its own pid, which is its own peer: the claim holds, and the message is dispatched.
const CLIENT = `
const net = require('net')
const s = net.createConnection(process.argv[1])
s.on('connect', () => s.write(JSON.stringify({ t: 'ctl', cmd: 'status', claudePid: process.pid }) + '\\n'))
setTimeout(() => process.exit(0), 4000)
`
