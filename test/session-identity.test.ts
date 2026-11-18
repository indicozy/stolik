// Session identity (pid + process start time), the spawn token that ties a register to its start, the stopped-start
// rules, and the bounded transcript reads. The spawn tests run through the harness (tmux is faked).
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FakeConn, HOME, flush, harness, textFrom } from './helpers/fakes.ts'
import { SPAWN_TIMEOUT_MS } from '../src/router/shared.ts'
import { SPAWN_FLUSH_DELAY_MS } from '../src/router/state.ts'
import { resumeEnded } from '../src/router/spawn.ts'
import { Registry, detachedSession, procKey, procRef, newSession } from '../src/brain/sessions.ts'
import { MsgMap, loadMsgMap, resolveMsgRef } from '../src/brain/msgmap.ts'
import { parseProcStart } from '../src/adapters/platform/linux-proc.ts'
import { parentPid, processComm, processStart } from '../src/adapters/platform/process.ts'
import { readTranscript, scanTranscripts } from '../src/adapters/transcripts.ts'
import { tgMsg } from '../src/adapters/chat/tg-ids.ts'

const T0 = 1_700_000_000_000
const PROJ = `${HOME}/proj`
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '.tmp-session-identity')

// ---------- keys and the registry ----------

test('a session key is pid and start time, and a folder key has no pid', () => {
  assert.equal(procKey({ pid: 42, start: '99' }), '42:99')
  assert.deepEqual(procRef(42, () => '99'), { pid: 42, start: '99' })
  assert.deepEqual(procRef(42, () => null), { pid: 42, start: '' }, 'an unreadable start is empty, not a pid-only key')
  assert.equal(procRef(null, () => '99'), null)
})

test('a reused pid is a different session: the old one is swept when its start time no longer matches', () => {
  const r = new Registry()
  const old = r.registerChannel({ pid: 700, start: 'old' }, '/x/foo', T0)
  const reused = r.registerChannel({ pid: 700, start: 'new' }, '/x/foo', T0)
  assert.notEqual(old, reused)
  assert.equal(r.list().length, 2)
  const removed = r.sweep(T0, (pid, start) => pid === 700 && start === 'new')
  assert.deepEqual(removed.map((s) => s.key), ['700:old'])
  assert.equal(r.get('700:new'), reused)
})

test('a channel without a pid is its own session: two connections in one folder do not merge', () => {
  const r = new Registry()
  const a = r.registerChannel(null, '/x/foo', T0)
  const b = r.registerChannel(null, '/x/foo', T0)
  assert.notEqual(a, b)
  assert.notEqual(a.key, b.key)
  assert.equal(r.list().length, 2)
})

test('a hook without a pid attaches only to a session without a pid, never to one with a pid in the same folder', () => {
  const r = new Registry()
  const withPid = r.registerChannel({ pid: 800, start: 's' }, '/x/foo', T0)
  const hook = r.upsertFromHook(null, '/x/foo', T0)
  assert.notEqual(hook, withPid)
  assert.equal(hook.pid, null)
})

test('a connected channel without a pid is not adopted by a process with a pid', () => {
  const r = new Registry()
  const channel = r.registerChannel(null, '/x/foo', T0)
  const proc = r.upsertFromHook({ pid: 900, start: 's' }, '/x/foo', T0)
  assert.notEqual(proc, channel)
  assert.equal(channel.pid, null)
})

test('an adopted pid-less hook session keeps its key and is found again by pid and start', () => {
  const r = new Registry()
  const hook = r.upsertFromHook(null, '/x/foo', T0)
  const adopted = r.upsertFromHook({ pid: 901, start: 's' }, '/x/foo', T0 + 1)
  assert.equal(adopted, hook)
  assert.equal(adopted.key, 'cwd:/x/foo')
  assert.equal(r.upsertFromHook({ pid: 901, start: 's' }, '/x/foo', T0 + 2), adopted)
  assert.equal(r.list().length, 1)
})

test('detachedSession keys by pid and start too', () => {
  assert.equal(detachedSession({ pid: 5, start: 'x' }, '/a/b', T0).key, '5:x')
  assert.equal(detachedSession(null, '/a/b', T0).key, 'cwd:/a/b')
})

// ---------- message map ----------

test('the message map keeps a bare-pid entry from before the identity change: it resolves by name and folder, never by key', () => {
  const json = JSON.stringify([
    [1, { key: 4242, name: 'proj', cwd: '/c' }],
    [2, { key: '4242:start', name: 'proj', cwd: '/c' }],
  ])
  const map = loadMsgMap(json)
  assert.equal(map.get(tgMsg(1))?.key, 4242)
  assert.equal(map.get(tgMsg(2))?.key, '4242:start')
  assert.equal(new MsgMap().size(), 0)
  const live = [newSession('4242:start-2', 'proj', '/c', 4242, T0, 'start-2')]
  assert.equal(resolveMsgRef(map.get(tgMsg(1)), live)?.status, 'live', 'found by name and folder')
  assert.equal(resolveMsgRef(map.get(tgMsg(1)), [newSession('9:s', 'other', '/c', 9, T0, 's')])?.status, 'dead')
})

test('resolveMsgRef: the key must come with the same folder; a key match in another folder is not the session', () => {
  const live = [newSession('5:s', 'proj', '/a', 5, T0, 's')]
  assert.equal(resolveMsgRef({ key: '5:s', name: 'proj', cwd: '/a' }, live)?.status, 'live')
  assert.deepEqual(resolveMsgRef({ key: '5:s', name: 'other', cwd: '/b' }, live), { status: 'dead', name: 'other' })
})

// ---------- process facts ----------

test('parseProcStart reads field 22 after the last ")", even when the command name has spaces and parens', () => {
  const stat = '4321 (my (weird) claude) S 1 4321 4321 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 1 0 987654 12345678 1000'
  assert.equal(parseProcStart(stat), '987654')
  assert.equal(parseProcStart('4321 (x) S 1'), null, 'a short line has no start time')
})

test('processStart, processComm and parentPid read this process on Linux', { skip: process.platform === 'darwin' }, () => {
  assert.match(processStart(process.pid) ?? '', /^\d+$/)
  assert.equal(typeof processComm(process.pid), 'string')
  assert.equal(parentPid(process.pid), process.ppid)
})

// ---------- spawn token ----------

test('a register carrying another start\'s token does not take the queue; the matching token does', async () => {
  const h = harness()
  await h.router.start()
  h.agent.trusted.add(PROJ)
  h.platform.dirs.add(PROJ)
  await h.chat.inbound(textFrom('/to proj first message'))
  const token = h.agent.spawnTokens[0]
  assert.match(token, /^[0-9a-f]{32}$/)

  h.agent.receive(new FakeConn(), { t: 'register', claudePid: 5151, cwd: PROJ, spawnToken: 'not-ours' })
  h.clock.advance(SPAWN_FLUSH_DELAY_MS)
  await flush()
  assert.equal(h.agent.sent.length, 0, 'the wrong token delivers nothing')
  assert.equal(h.router.spawns.size, 1, 'the queue is still waiting')
  assert.equal(h.router.registry.list().find((s) => s.pid === 5151)?.spawned, false)

  h.agent.receive(new FakeConn(), { t: 'register', claudePid: 5151, cwd: PROJ, spawnToken: token })
  h.clock.advance(SPAWN_FLUSH_DELAY_MS)
  await flush()
  assert.equal(h.agent.sent.length, 1)
  assert.equal(h.agent.sent[0].content, 'first message')
  assert.equal(h.router.registry.list().find((s) => s.pid === 5151)?.spawned, true)
})

test('a register without a token takes the queue only when its claude process is below the queue\'s tmux pane', async () => {
  const h = harness()
  await h.router.start()
  h.agent.trusted.add(PROJ)
  h.platform.dirs.add(PROJ)
  h.agent.panes.set('tg-proj', 9000)
  h.platform.parents.set(5151, 9100)
  h.platform.parents.set(9100, 9000)
  await h.chat.inbound(textFrom('/to proj hello'))

  h.agent.receive(new FakeConn(), { t: 'register', claudePid: 6161, cwd: PROJ })
  h.clock.advance(SPAWN_FLUSH_DELAY_MS)
  await flush()
  assert.equal(h.agent.sent.length, 0, 'an unrelated process does not take it')

  h.agent.receive(new FakeConn(), { t: 'register', claudePid: 5151, cwd: PROJ })
  h.clock.advance(SPAWN_FLUSH_DELAY_MS)
  await flush()
  assert.equal(h.agent.sent.length, 1, 'a process under the pane takes it')
})

test('a start that times out is stopped; its token retires, and a late register still counts as router-started', async () => {
  const h = harness()
  await h.router.start()
  h.agent.trusted.add(PROJ)
  h.platform.dirs.add(PROJ)
  await h.chat.inbound(textFrom('/to proj hello'))
  const token = h.agent.spawnTokens[0]
  h.clock.advance(SPAWN_TIMEOUT_MS)
  await flush()
  assert.deepEqual(h.agent.killedSessions, ['tg-proj'])
  assert.equal(h.router.spawns.size, 0)
  assert.ok(h.router.retiredSpawns.has(token))

  h.agent.receive(new FakeConn(), { t: 'register', claudePid: 4444, cwd: PROJ, spawnToken: token })
  await flush()
  const late = h.router.registry.list().find((s) => s.pid === 4444)
  assert.equal(late?.spawned, true, 'counted toward the spawn cap')
  assert.equal(h.agent.sent.length, 0, 'nothing is delivered from a stopped start')
})

test('a /resume reserves its transcript and its folder before the start; both are released when the session registers', async () => {
  const h = harness()
  await h.router.start()
  h.agent.trusted.add(PROJ)
  h.platform.dirs.add(PROJ)
  h.platform.files.set('/fake/a.jsonl', { isFile: true, size: 10 })
  const id = '11111111-2222-4333-8444-555555555555'
  const item = { id, path: '/fake/a.jsonl', cwd: PROJ, title: 'Fix the parser', lastActive: 0, state: 'ended' as const }
  let release: (name: string) => void = () => {}
  h.agent.startSession = (_p: string, _d: string, _x: readonly string[] = [], token?: string) => {
    if (token !== undefined) h.agent.spawnTokens.push(token)
    return new Promise<string>((r) => (release = r))
  }

  const first = resumeEnded(h.router, item)
  await flush()
  assert.equal(h.router.spawns.get(PROJ)?.resumeOf, id, 'the queue entry exists while the start is pending')
  await resumeEnded(h.router, item)
  assert.ok(h.chat.sent.some((s) => s.text === `${'Fix the parser'} is already being resumed.`))
  release('tg-proj')
  await first
  await flush()
  assert.ok(h.router.resumingIds.has(id), 'still reserved until the session registers')

  h.agent.receive(new FakeConn(), { t: 'register', claudePid: 7373, cwd: PROJ, spawnToken: h.agent.spawnTokens[0] })
  h.clock.advance(SPAWN_FLUSH_DELAY_MS)
  await flush()
  assert.equal(h.router.resumingIds.size, 0)
  assert.equal(h.router.spawns.size, 0)
})

test('a start that fails releases its reservation and names the session by its title', async () => {
  const h = harness()
  await h.router.start()
  h.agent.trusted.add(PROJ)
  h.platform.dirs.add(PROJ)
  h.platform.files.set('/fake/b.jsonl', { isFile: true, size: 10 })
  h.agent.startSession = async () => {
    throw new Error('tmux is down')
  }
  const id = '22222222-3333-4444-8555-666666666666'
  await resumeEnded(h.router, { id, path: '/fake/b.jsonl', cwd: PROJ, title: 'Port the cache', lastActive: 0, state: 'ended' })
  await flush()
  assert.ok(h.chat.sent.some((s) => s.text === "Port the cache didn't start: tmux is down."))
  assert.equal(h.router.resumingIds.size, 0)
})

// ---------- transcripts ----------

test('readTranscript reads a cwd from a first line longer than one chunk, and gives up past the 4 MB bound', async () => {
  rmSync(FIXTURE, { recursive: true, force: true })
  mkdirSync(FIXTURE, { recursive: true })
  try {
    const big = JSON.stringify({ type: 'user', cwd: '/home/u/big', entrypoint: 'cli', message: { content: 'x'.repeat(300_000) } })
    const titled = join(FIXTURE, 'big.jsonl')
    writeFileSync(titled, `${big}\n${JSON.stringify({ type: 'ai-title', aiTitle: 'Big one' })}\n`)
    const meta = await readTranscript(titled, 'id', 1)
    assert.equal(meta?.cwd, '/home/u/big')
    assert.equal(meta?.title, 'Big one', 'the tail is read whole too')

    const huge = join(FIXTURE, 'huge.jsonl')
    const hugeLine = JSON.stringify({ type: 'user', cwd: '/home/u/huge', entrypoint: 'cli', message: { content: 'y'.repeat(4_500_000) } })
    writeFileSync(huge, `${hugeLine}\n${JSON.stringify({ type: 'ai-title', aiTitle: 'Huge' })}\n`)
    assert.equal(await readTranscript(huge, 'id', 1), null, 'no complete first line within the bound: skipped')
  } finally {
    rmSync(FIXTURE, { recursive: true, force: true })
  }
})

test('scanTranscripts reuses its result for a few seconds', async () => {
  rmSync(FIXTURE, { recursive: true, force: true })
  const dir = join(FIXTURE, 'projects', '-home-u-a')
  mkdirSync(dir, { recursive: true })
  try {
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    writeFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify({ type: 'user', cwd: '/home/u/a', entrypoint: 'cli', message: { content: 'hi' } })}\n`)
    const projects = join(FIXTURE, 'projects')
    assert.equal((await scanTranscripts(projects)).length, 1)
    writeFileSync(join(dir, 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff.jsonl'), `${JSON.stringify({ type: 'user', cwd: '/home/u/a', entrypoint: 'cli' })}\n`)
    assert.equal((await scanTranscripts(projects)).length, 1, 'the second scan within the cache window is the first one')
  } finally {
    rmSync(FIXTURE, { recursive: true, force: true })
  }
})
