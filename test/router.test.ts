// End-to-end router decisions with fake ports (plan S11): no Telegram, no socket, no files, no real timers.
// These are the safety net for the Phase 2 changes: they drive Router through its ports and assert what it sends.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeConn, HOME, OWNER, flush, harness, textFrom } from './helpers/fakes.ts'
import { tgMsg, tgUser } from '../src/adapters/chat/tg-ids.ts'

const PROJ = `${HOME}/proj`
const UUID_A = '11111111-2222-4333-8444-555555555555'
const UUID_B = '66666666-7777-4888-8999-aaaaaaaaaaaa'

// Starts a router and registers one channel session for `cwd` (a folder the platform reports as real).
async function startWithSession(cwd = PROJ, pid = 4242) {
  const h = harness()
  await h.router.start()
  h.platform.dirs.add(cwd)
  const conn = new FakeConn()
  h.agent.receive(conn, { t: 'register', claudePid: pid, cwd })
  return { ...h, conn }
}

test('a text message from the owner goes to the one live session', async () => {
  const { chat, agent, conn } = await startWithSession()
  assert.deepEqual(conn.sent[0], { t: 'registered', name: 'proj' })

  await chat.inbound(textFrom('hello there'))

  assert.equal(agent.sent.length, 1)
  assert.equal(agent.sent[0].key, '4242:start-4242')
  assert.equal(agent.sent[0].content, 'hello there')
  assert.equal(agent.sent[0].meta.message_id, '10')
  assert.deepEqual(chat.reactions, [{ messageId: tgMsg(10), emoji: '👀' }])
  // The one active session gets the confirmation with its "wrong one?" button.
  assert.deepEqual(chat.texts(), ['→ [proj]'])
})

test('a message the agent refuses is answered in the topic as not connected: no seen reaction, no pending reply', async () => {
  const { chat, agent, router } = await startWithSession()
  agent.sendToSession = () => false

  await chat.inbound(textFrom('are you there'))

  assert.ok(chat.texts().includes('proj is not connected right now. Try again in a moment.'), JSON.stringify(chat.texts()))
  assert.deepEqual(chat.reactions, [])
  assert.equal(router.registry.get('4242:start-4242')?.pendingTg ?? null, null)
})

test('a message from a non-owner id is ignored', async () => {
  const { chat, agent } = await startWithSession()

  await chat.inbound(textFrom('let me in', { fromId: tgUser(999), from: 'stranger' }))

  assert.deepEqual(agent.sent, [])
  assert.deepEqual(chat.sent, [])
  assert.deepEqual(chat.reactions, [])
})

test('/resume lists the transcripts as buttons, newest first', async () => {
  const { chat, agent, clock } = await startWithSession()
  agent.transcripts = [
    { id: UUID_B, path: '/fake/b.jsonl', cwd: PROJ, title: 'Older one', mtime: clock.now() - 90_000_000, entrypoint: 'cli' },
    { id: UUID_A, path: '/fake/a.jsonl', cwd: PROJ, title: 'Fix the parser', mtime: clock.now() - 60_000, entrypoint: 'cli' },
  ]

  await chat.inbound(textFrom('/resume'))

  const list = chat.sent.find((s) => s.text.startsWith('Pick a session'))
  assert.ok(list, 'the resume list is sent')
  const labels = (list.opts?.rows ?? []).map((row) => row[0]!.text)
  assert.equal(labels.length, 2)
  assert.match(labels[0]!, /Fix the parser/)
  assert.match(labels[1]!, /Older one/)
})

test('the same reply twice in one turn is sent once, and the second is reported as not sent', async () => {
  const { chat, agent, conn } = await startWithSession()
  const text = 'Done: all tests pass.'

  agent.receive(conn, { t: 'reply', reqId: 'r1', text, kind: 'response' })
  await flush()
  agent.receive(conn, { t: 'reply', reqId: 'r2', text, kind: 'response' })
  await flush()

  assert.equal(chat.sent.filter((s) => s.text.includes(text)).length, 1)
  const results = conn.sent.filter((m) => m.t === 'reply_result')
  assert.deepEqual(
    results.map((m) => [m.reqId, m.ok, m.delivered]),
    [
      ['r1', true, true],
      ['r2', false, false],
    ],
  )
})

test('a message queued for a new session is delivered 1 s after it registers', async () => {
  const h = harness()
  await h.router.start()
  h.agent.trusted.add(PROJ)
  h.platform.dirs.add(PROJ)

  await h.chat.inbound(textFrom('/to proj first message'))
  assert.deepEqual(h.agent.startedSessions.map((s) => [s.project, s.dir]), [['proj', PROJ]])
  assert.equal(h.agent.sent.length, 0, 'nothing is delivered before the session connects')

  const conn = new FakeConn()
  h.agent.receive(conn, { t: 'register', claudePid: 5151, cwd: PROJ, spawnToken: h.agent.spawnTokens[0] })
  h.clock.advance(999)
  await flush()
  assert.equal(h.agent.sent.length, 0, 'still queued 999 ms after registration')

  h.clock.advance(1)
  await flush()
  assert.equal(h.agent.sent.length, 1)
  assert.equal(h.agent.sent[0].content, 'first message')
  assert.equal(h.agent.sent[0].key, '5151:start-5151')
})

// Review finding 5: the spawn guard is checked before the await and set after it. Two messages at once for one folder
// used to start two sessions. A placeholder queue entry is now set before the start, and it counts toward the cap.
test('two messages for one folder at once start one session; the second joins its queue', async () => {
  const h = harness()
  await h.router.start()
  h.agent.trusted.add(PROJ)
  h.platform.dirs.add(PROJ)
  await Promise.all([
    h.chat.inbound(textFrom('/to proj first', { messageId: tgMsg(10) })),
    h.chat.inbound(textFrom('/to proj second', { messageId: tgMsg(11) })),
  ])
  await flush()
  assert.equal(h.agent.startedSessions.length, 1, 'one session started')
  assert.equal(h.router.spawns.get(PROJ)?.items.length, 2, 'both messages wait in one queue')
})

test('a session that fails to start is reported, and its placeholder queue is removed', async () => {
  const h = harness()
  await h.router.start()
  h.agent.trusted.add(PROJ)
  h.platform.dirs.add(PROJ)
  h.agent.startSession = async () => {
    throw new Error('tmux is down')
  }
  await h.chat.inbound(textFrom('/to proj first', { messageId: tgMsg(10) }))
  await flush()
  assert.equal(h.router.spawns.size, 0, 'no placeholder left behind')
  assert.ok(h.chat.sent.some((s) => s.text === "proj didn't start: tmux is down. The message wasn't delivered."))
})

test('a session that is still starting counts toward the spawn cap', async () => {
  const h = harness()
  await h.router.start()
  const dirs = ['a', 'b', 'c', 'd'].map((n) => `${HOME}/${n}`)
  for (const d of dirs) {
    h.agent.trusted.add(d)
    h.platform.dirs.add(d)
  }
  const release: Array<() => void> = []
  h.agent.startSession = (project: string) =>
    new Promise<string>((resolve) => {
      release.push(() => resolve(`tmux-${project}`))
    })
  const sends = dirs.map((d, i) => h.chat.inbound(textFrom(`/to ${d.split('/').pop()} hi`, { messageId: tgMsg(20 + i) })))
  await flush()
  assert.equal(release.length, 3, 'three sessions started, all still starting')
  await sends[3]
  await flush()
  assert.equal(release.length, 3, 'the fourth is not started while three are still starting')
  assert.ok(h.chat.sent.some((s) => s.text.startsWith('Not starting d: 3 router-started sessions')))
  for (const r of release) r()
  await flush()
})
