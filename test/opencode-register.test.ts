// An opencode session registers through the router socket with agent 'opencode' (see channel.ts opencode mode).
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeAgent, FakeConn, HOME, flush, harness, textFrom } from './helpers/fakes.ts'
import { channelCapabilities } from '../src/adapters/channel/capabilities.ts'
import { SPAWN_FLUSH_DELAY_MS } from '../src/router/state.ts'

const PROJ = `${HOME}/proj`
const TOKEN = 'opencode-token-1'
const OPENCODE_PID = 6161

// A harness with a second backend registered as 'opencode'. The router is started and PROJ is a real folder.
async function started() {
  const opencode = new FakeAgent()
  const h = harness({ opencodeAgent: opencode })
  await h.router.start()
  h.platform.dirs.add(PROJ)
  return { ...h, opencode }
}

// A queued opencode start for PROJ, as a spawn of that kind would leave it (the start itself is the backend's).
function queueOpencodeStart(h: { router: { spawns: Map<string, unknown> } }, token = TOKEN): void {
  h.router.spawns.set(PROJ, {
    project: 'proj',
    real: PROJ,
    agent: 'opencode',
    tmuxName: '',
    items: [{ m: textFrom('first message'), content: 'first message' }],
    timer: null,
    token,
    panePid: null,
    extraArgs: [],
  })
}

test('opencode register creates an opencode session and flushes the queued message to it', async () => {
  const h = await started()
  queueOpencodeStart(h)

  const conn = new FakeConn()
  h.opencode.receive(conn, { t: 'register', claudePid: null, agent: 'opencode', agentPid: OPENCODE_PID, cwd: PROJ, spawnToken: TOKEN })
  h.clock.advance(SPAWN_FLUSH_DELAY_MS)
  await flush()

  const [s] = h.router.registry.list()
  assert.equal(s.agent, 'opencode')
  assert.deepEqual(conn.sent[0], { t: 'registered', name: s.name })
  assert.equal(h.opencode.isConnected(s.key), true)
  assert.equal(h.agent.isConnected(s.key), false)
  assert.equal(h.opencode.sent.length, 1)
  assert.equal(h.opencode.sent[0].content, 'first message')
  assert.equal(h.agent.sent.length, 0)
  assert.equal(h.router.spawns.has(PROJ), false)
})

test('opencode register calls bindToken with its spawn token', async () => {
  const h = await started()
  queueOpencodeStart(h)

  h.opencode.receive(new FakeConn(), { t: 'register', claudePid: null, agent: 'opencode', agentPid: OPENCODE_PID, cwd: PROJ, spawnToken: TOKEN })
  await flush()

  const [s] = h.router.registry.list()
  assert.deepEqual(h.opencode.bound, [[s.key, TOKEN]])
  assert.deepEqual(h.agent.bound, [])
})

test('opencode register skips the claude interactive check', async () => {
  const h = await started()
  // The pid would be refused as print-mode claude; an opencode register never asks the claude backend about it.
  h.agent.nonInteractive.add(OPENCODE_PID)

  h.opencode.receive(new FakeConn(), { t: 'register', claudePid: null, agent: 'opencode', agentPid: OPENCODE_PID, cwd: PROJ })
  await flush()

  const [s] = h.router.registry.list()
  assert.equal(s.agent, 'opencode')
  assert.equal(h.opencode.isConnected(s.key), true)
})

test('a claude register does not take an opencode queue', async () => {
  const h = await started()
  queueOpencodeStart(h)

  h.agent.receive(new FakeConn(), { t: 'register', claudePid: 5151, cwd: PROJ, spawnToken: TOKEN })
  h.clock.advance(SPAWN_FLUSH_DELAY_MS)
  await flush()

  assert.equal(h.router.spawns.has(PROJ), true, 'the opencode queue stays')
  assert.equal(h.opencode.sent.length, 0)
  assert.equal(h.agent.sent.length, 0)
})

test('an opencode register is refused when the router has no opencode backend', async () => {
  const h = harness()
  await h.router.start()
  h.platform.dirs.add(PROJ)

  const conn = new FakeConn()
  h.agent.receive(conn, { t: 'register', claudePid: null, agent: 'opencode', agentPid: OPENCODE_PID, cwd: PROJ, spawnToken: TOKEN })
  await flush()

  assert.deepEqual(conn.sent, [{ t: 'registered', name: '' }])
  assert.deepEqual(h.router.registry.list(), [])
})

// A pid-less, unconnected claude session in PROJ (what a hook without a pid leaves behind).
function pidlessClaude(h: { router: { registry: { upsertFromHook(p: null, cwd: string, now: number): { agent: string } } }; clock: { now(): number } }) {
  return h.router.registry.upsertFromHook(null, PROJ, h.clock.now())
}

test('an opencode register does not adopt a pid-less claude session in the same folder', async () => {
  const h = await started()
  const claude = pidlessClaude(h)
  assert.equal(claude.agent, 'claude')

  h.opencode.receive(new FakeConn(), { t: 'register', claudePid: null, agent: 'opencode', agentPid: OPENCODE_PID, cwd: PROJ })
  await flush()

  const sessions = h.router.registry.list()
  assert.equal(sessions.length, 2)
  const [s] = sessions.filter((x) => x.agent === 'opencode')
  assert.ok(s, 'a new opencode session exists')
  assert.equal(s.pid, OPENCODE_PID)
  assert.equal(h.opencode.isConnected(s.key), true)
  // The claude session is untouched: still pid-less, still claude, not connected.
  const after = h.router.registry.list().find((x) => x.key === claude.key)
  assert.ok(after)
  assert.equal(after.agent, 'claude')
  assert.equal(after.pid, null)
  assert.equal(after.connected, false)
})

test('a claude register does not adopt a pid-less opencode session in the same folder', async () => {
  const h = await started()
  const op = h.router.registry.registerChannel(null, PROJ, h.clock.now(), 'opencode')
  op.connected = false

  const conn = new FakeConn()
  h.agent.receive(conn, { t: 'register', claudePid: 5151, cwd: PROJ })
  await flush()

  const [claudeSession] = h.router.registry.list().filter((x) => x.pid === 5151)
  assert.ok(claudeSession, 'a new claude session exists')
  assert.equal(claudeSession.agent, 'claude')
  assert.equal(h.agent.isConnected(claudeSession.key), true)
  const after = h.router.registry.list().find((x) => x.key === op.key)
  assert.ok(after)
  assert.equal(after.agent, 'opencode')
  assert.equal(after.pid, null)
  assert.equal(after.connected, false)
})

test('a claude register still adopts a pid-less claude session in the same folder', async () => {
  const h = await started()
  const claude = pidlessClaude(h)

  h.agent.receive(new FakeConn(), { t: 'register', claudePid: 5151, cwd: PROJ })
  await flush()

  assert.equal(h.router.registry.list().length, 1)
  assert.equal(claude.pid, 5151)
  assert.equal(claude.agent, 'claude')
})

test('channelCapabilities: opencode advertises tools only, claude keeps the channel keys', () => {
  assert.deepEqual(channelCapabilities('opencode'), { tools: {} })
  for (const agent of [undefined, 'claude']) {
    assert.deepEqual(channelCapabilities(agent), {
      tools: {},
      experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
    })
  }
})
