// Answers that quote the message they answer, and the notice for a session that died mid-turn. Group mode through the
// router with fake ports and a fake clock: the session's topic is thread 100, and each delivered message is tracked as
// the session's pending message until its turn ends (Stop hook, idle prompt) or the session is stopped.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stopStarted } from '../src/router/handlers/route.ts'
import { TERMINATED_CHECK_MS } from '../src/router/handlers/socket.ts'
import { SWEEP_MS, type RoutePending } from '../src/router/shared.ts'
import { tgChat, tgMsg, tgThread } from '../src/adapters/chat/tg-ids.ts'
import { FakeConn, HOME, OWNER, flush, harness, textFrom } from './helpers/fakes.ts'

const PROJ = `${HOME}/proj`
const GROUP = -1001234567890
const GROUP_ID = tgChat(GROUP)
const topicChat = (threadId: number) => ({ kind: 'home' as const, id: GROUP_ID, thread: tgThread(threadId) })
const THREAD = 100
const PID = 4242
const NOTICE = '⚠️ [proj] was terminated before it finished answering this message.'

// A group-mode router with one channel session in PROJ (pid 4242), its topic created (thread 100).
async function groupWithSession() {
  const h = harness({ groupId: GROUP_ID })
  await h.router.start()
  h.platform.dirs.add(PROJ)
  const conn = new FakeConn()
  h.agent.receive(conn, { t: 'register', claudePid: PID, cwd: PROJ })
  await flush()
  return { ...h, conn }
}

// The one session of the router.
const onlySession = (router: { registry: { list(): Array<{ pendingTg: unknown }> } }) => router.registry.list()[0]

// The text a reply sent (the first sent message containing `fragment`).
const sentWith = (chat: { sent: Array<{ text: string; opts?: any }> }, fragment: string) => chat.sent.find((s) => s.text.includes(fragment))

// An answer from the session over its channel connection, then the router's work on it.
async function answer(agent: { receive(conn: unknown, msg: unknown): void }, conn: unknown, reqId: string, text: string, kind = 'response') {
  agent.receive(conn, { t: 'reply', reqId, text, kind })
  await flush()
}

test('the first answer to a delivered message quotes it, and a later answer does not', async () => {
  const { chat, agent, conn } = await groupWithSession()
  await chat.inbound(textFrom('first question', { chat: topicChat(THREAD), messageId: tgMsg(11) }))
  agent.receive(conn, { t: 'reply', reqId: 'r1', text: 'First answer.', kind: 'response' })
  await flush()
  agent.receive(conn, { t: 'reply', reqId: 'r2', text: 'Second answer.', kind: 'response' })
  await flush()
  assert.equal(sentWith(chat, 'First answer.')?.opts?.replyTo, tgMsg(11))
  assert.equal(sentWith(chat, 'Second answer.')?.opts?.replyTo, undefined)
})

test('a newly delivered message re-arms the quote for the next answer', async () => {
  const { chat, agent, conn } = await groupWithSession()
  await chat.inbound(textFrom('first question', { chat: topicChat(THREAD), messageId: tgMsg(11) }))
  await answer(agent, conn, 'r1', 'First answer.')
  await chat.inbound(textFrom('second question', { chat: topicChat(THREAD), messageId: tgMsg(12) }))
  await answer(agent, conn, 'r2', 'Third answer.')
  assert.equal(sentWith(chat, 'Third answer.')?.opts?.replyTo, tgMsg(12), 'the newest delivered message is quoted')
})

test('a proactive message never quotes, and does not use up the quote of the pending message', async () => {
  const { chat, agent, conn, platform } = await groupWithSession()
  platform.setAway()
  await chat.inbound(textFrom('question', { chat: topicChat(THREAD), messageId: tgMsg(11) }))
  await answer(agent, conn, 'r1', 'Ping from the session.', 'proactive')
  assert.equal(sentWith(chat, 'Ping from the session.')?.opts?.replyTo, undefined)
  await answer(agent, conn, 'r2', 'The actual answer.')
  assert.equal(sentWith(chat, 'The actual answer.')?.opts?.replyTo, tgMsg(11))
})

test('an answer in another topic than the pending message is not quoted, and keeps the quote for later', async () => {
  const { router, chat, agent, conn } = await groupWithSession()
  // The pending message came from topic 999; the session answers in its own topic (100).
  onlySession(router).pendingTg = { messageId: tgMsg(11), thread: tgThread(999), replied: false }
  await answer(agent, conn, 'r1', 'Topic answer.')
  assert.equal(sentWith(chat, 'Topic answer.')?.opts?.replyTo, undefined)
  assert.deepEqual(onlySession(router).pendingTg, { messageId: tgMsg(11), thread: tgThread(999), replied: false })
})

test('the end-of-turn text quotes the pending message, and the Stop hook clears it', async () => {
  const { router, chat, platform, agent } = await groupWithSession()
  platform.setAway()
  await chat.inbound(textFrom('question', { chat: topicChat(THREAD), messageId: tgMsg(11) }))
  // A question at the end of the text is forwarded whatever the turn length.
  agent.receive(new FakeConn(), { t: 'hook', event: 'Stop', claudePid: PID, cwd: PROJ, payload: { last_assistant_message: 'All done, want more?' } })
  await flush()
  assert.equal(sentWith(chat, 'All done, want more?')?.opts?.replyTo, tgMsg(11))
  assert.equal(onlySession(router).pendingTg, null)
})

test('a session that dies while its turn is open gets one terminated notice, as a reply to the message', async () => {
  const h = await groupWithSession()
  await h.chat.inbound(textFrom('long task', { chat: topicChat(THREAD), messageId: tgMsg(11) }))
  h.platform.dead.add(PID)
  h.clock.advance(SWEEP_MS)
  h.clock.advance(SWEEP_MS)
  const notes = h.chat.sent.filter((s) => s.text === NOTICE)
  assert.equal(notes.length, 1, 'said once, not again on later sweeps')
  assert.equal(notes[0].opts?.replyTo, tgMsg(11))
  assert.equal(notes[0].opts?.thread, tgThread(THREAD))
})

test('a session whose turn had ended when it died gets no terminated notice', async () => {
  const h = await groupWithSession()
  h.platform.setAway()
  await h.chat.inbound(textFrom('question', { chat: topicChat(THREAD), messageId: tgMsg(11) }))
  h.agent.receive(new FakeConn(), { t: 'hook', event: 'Stop', claudePid: PID, cwd: PROJ, payload: { last_assistant_message: 'Done?' } })
  await flush()
  h.platform.dead.add(PID)
  h.clock.advance(SWEEP_MS)
  assert.equal(h.chat.sent.filter((s) => s.text.includes('was terminated')).length, 0)
})

test('a channel that drops and reconnects while its process lives gets no terminated notice', async () => {
  const h = await groupWithSession()
  await h.chat.inbound(textFrom('question', { chat: topicChat(THREAD), messageId: tgMsg(11) }))
  h.agent.disconnect(h.conn)
  // The same session registers again on a new connection (the channel reconnected).
  h.agent.receive(new FakeConn(), { t: 'register', claudePid: PID, cwd: PROJ })
  await flush()
  h.clock.advance(TERMINATED_CHECK_MS)
  h.clock.advance(SWEEP_MS)
  assert.equal(h.chat.sent.filter((s) => s.text.includes('was terminated')).length, 0)
  assert.notEqual(onlySession(h.router).pendingTg, null, 'the turn is still open')
})

test('a channel that drops while its process is gone gets one notice, not another from the sweep', async () => {
  const h = await groupWithSession()
  await h.chat.inbound(textFrom('question', { chat: topicChat(THREAD), messageId: tgMsg(11) }))
  h.platform.dead.add(PID)
  h.agent.disconnect(h.conn)
  h.clock.advance(TERMINATED_CHECK_MS)
  assert.equal(h.chat.sent.filter((s) => s.text === NOTICE).length, 1, 'said by the check on the disconnect')
  h.clock.advance(SWEEP_MS * 2)
  const notes = h.chat.sent.filter((s) => s.text === NOTICE)
  assert.equal(notes.length, 1, 'the sweep does not say it again')
  assert.equal(notes[0].opts?.replyTo, tgMsg(11))
})

test('stopping a started session from the router gives no terminated notice', async () => {
  const h = await groupWithSession()
  await h.chat.inbound(textFrom('work', { chat: topicChat(THREAD), messageId: tgMsg(11) }))
  const s = h.router.registry.list()[0]
  h.router.tmuxBySession.set(s.key, 'tg-proj')
  assert.notEqual(s.pendingTg, null, 'the message is pending before the stop')
  h.router.stopSession = async () => {
    h.platform.dead.add(PID)
    return true
  }
  const p = {
    mode: 'folder', tmuxName: 'tg-proj', folder: PROJ, folders: [], page: 0, messageId: tgMsg(5), text: 'Starting', candidates: [], createdAt: 0,
  } as unknown as RoutePending
  await stopStarted(h.router, 'rid-stop', p, async () => {})
  h.clock.advance(SWEEP_MS)
  assert.equal(h.chat.sent.filter((x) => x.text.includes('was terminated')).length, 0)
})
