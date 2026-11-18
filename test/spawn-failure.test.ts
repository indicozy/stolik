// A router-started session that fails to start is reported in the chat where the request came from, with the messages
// that were queued for it marked as not delivered; the last lines of its pane go to the log only.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeConn, HOME, flush, harness, textFrom } from './helpers/fakes.ts'
import { SPAWN_TIMEOUT_MS } from '../src/router/shared.ts'
import { resumeEnded } from '../src/router/spawn.ts'
import { tgMsg } from '../src/adapters/chat/tg-ids.ts'

const PROJ = `${HOME}/proj`

test('tmux refuses to start the session: the chat says so, with the reason and that the message was not delivered', async () => {
  const h = harness()
  await h.router.start()
  h.agent.trusted.add(PROJ)
  h.platform.dirs.add(PROJ)
  h.agent.startSession = async () => {
    throw new Error('tmux new-session failed: no server running')
  }
  await h.chat.inbound(textFrom('/to proj first', { messageId: tgMsg(10) }))
  await flush()
  const said = h.chat.sent.find((s) => s.text.startsWith('proj didn'))
  assert.equal(said?.text, "proj didn't start: tmux new-session failed: no server running. The message wasn't delivered.")
  assert.equal(said?.opts?.replyTo, tgMsg(10), 'the reply is to the message that asked for the session')
  assert.equal(h.router.spawns.size, 0)
})

test('two messages queued for a start that fails: both are said to be not delivered', async () => {
  const h = harness()
  await h.router.start()
  h.agent.trusted.add(PROJ)
  h.platform.dirs.add(PROJ)
  let fail: (e: Error) => void = () => {}
  h.agent.startSession = () => new Promise<string>((_, reject) => (fail = reject))
  const first = h.chat.inbound(textFrom('/to proj one', { messageId: tgMsg(10) }))
  const second = h.chat.inbound(textFrom('/to proj two', { messageId: tgMsg(11) }))
  await flush()
  fail(new Error('tmux is down'))
  await Promise.all([first, second])
  await flush()
  assert.ok(h.chat.sent.some((s) => s.text === "proj didn't start: tmux is down. 2 messages weren't delivered."))
})

test('the tmux session vanishes before the session registers: reported with the last pane lines in the log only', async () => {
  const h = harness()
  await h.router.start()
  h.agent.trusted.add(PROJ)
  h.platform.dirs.add(PROJ)
  h.agent.startupOutcome = { kind: 'gone', pane: ['claude: command not found'] }
  await h.chat.inbound(textFrom('/to proj first', { messageId: tgMsg(10) }))
  await flush()
  assert.ok(
    h.chat.sent.some((s) => s.text === "proj didn't start: the tmux session tg-proj ended before it connected. The message wasn't delivered."),
  )
  assert.ok(h.logger.lines.includes('  pane | claude: command not found'), 'the pane line is in the log')
  assert.ok(!h.chat.sent.some((s) => s.text.includes('command not found')), 'the pane is not sent to the chat')
  assert.equal(h.router.spawns.size, 0)
})

test('the registration timeout: reported after the timeout, with the pane in the log; the tmux session is stopped', async () => {
  const h = harness()
  await h.router.start()
  h.agent.trusted.add(PROJ)
  h.platform.dirs.add(PROJ)
  h.agent.paneLines = ['Loading development channels', 'Press Enter to continue']
  await h.chat.inbound(textFrom('/to proj one', { messageId: tgMsg(10) }))
  await h.chat.inbound(textFrom('/to proj two', { messageId: tgMsg(11) }))
  await flush()
  h.clock.advance(SPAWN_TIMEOUT_MS)
  await flush()
  assert.ok(
    h.chat.sent.some((s) =>
      s.text === "proj didn't start: it didn't connect within 90 s. 2 messages weren't delivered. Its tmux session was stopped.",
    ),
    h.chat.sent.map((s) => s.text).join('\n'),
  )
  assert.ok(h.logger.lines.includes('  pane | Press Enter to continue'))
  assert.equal(h.router.spawns.size, 0)
  assert.deepEqual(h.agent.killedSessions, ['tg-proj'], 'the timed-out session is stopped')
})

test('a session that registers in time: nothing is reported when the timeout would have fired', async () => {
  const h = harness()
  await h.router.start()
  h.agent.trusted.add(PROJ)
  h.platform.dirs.add(PROJ)
  await h.chat.inbound(textFrom('/to proj one', { messageId: tgMsg(10) }))
  await flush()
  // The session registers: its queue is flushed, which removes the spawn and its timer.
  const conn = new FakeConn()
  h.agent.receive(conn, { t: 'register', claudePid: 4343, cwd: PROJ, spawnToken: h.agent.spawnTokens[0] })
  h.clock.advance(SPAWN_TIMEOUT_MS + 10_000)
  await flush()
  assert.ok(!h.chat.sent.some((s) => s.text.includes("didn't start")))
})

test('a /resume whose start fails says so, naming the session', async () => {
  const h = harness()
  await h.router.start()
  h.agent.trusted.add(PROJ)
  h.platform.dirs.add(PROJ)
  h.agent.startSession = async () => {
    throw new Error('tmux is down')
  }
  const id = '11111111-2222-4333-8444-555555555555'
  h.platform.files.set('/fake/a.jsonl', { isFile: true, size: 10 })
  await resumeEnded(h.router, { id, path: '/fake/a.jsonl', cwd: PROJ, title: 'Fix the parser', lastActive: 0, state: 'ended' })
  await flush()
  assert.ok(h.chat.sent.some((s) => s.text === "Fix the parser didn't start: tmux is down."))
  assert.equal(h.router.resumingIds.size, 0)
})
