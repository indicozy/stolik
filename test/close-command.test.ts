// /close through the router: in a folder topic (the topic's session, or /close <name>), and in General or a DM (a
// swipe-reply, /close <name>, or a bare /close that closes nothing). The process is stopped by signal, as idle-close does.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeConn, HOME, flush, harness, textFrom, type FakeChat } from './helpers/fakes.ts'
import { tgChat, tgThread } from '../src/adapters/chat/tg-ids.ts'

const PROJ = `${HOME}/proj`
const GROUP = -1001234567890
const GROUP_ID = tgChat(GROUP)
const PID = 4242
const GENERAL_CHAT = { kind: 'home' as const, id: GROUP_ID, thread: null }
const topicChat = (threadId: number) => ({ kind: 'home' as const, id: GROUP_ID, thread: tgThread(threadId) })

// A group-mode router with one channel session in PROJ (pid 4242), its topic (thread 100) created.
async function groupWithSession() {
  const h = harness({ groupId: tgChat(GROUP) })
  await h.router.start()
  h.platform.dirs.add(PROJ)
  const conn = new FakeConn()
  h.agent.receive(conn, { t: 'register', claudePid: PID, cwd: PROJ })
  await flush()
  return { ...h, conn, name: h.router.registry.list()[0].name }
}

const sentWith = (chat: FakeChat, text: string) => {
  const hit = chat.sent.find((s) => s.text.includes(text))
  assert.ok(hit, `sent: ${text}`)
  return hit
}
const signalsTo = (h: { platform: { signals: Array<{ pid: number; sig: string }> } }, pid: number) =>
  h.platform.signals.filter((x) => x.pid === pid)

test('/close in a folder topic closes the topic session, and says so in the topic', async () => {
  const h = await groupWithSession()
  await h.chat.inbound(textFrom('/close', { chat: topicChat(100) }))
  assert.deepEqual(signalsTo(h, PID).map((x) => x.sig), ['SIGTERM'])
  const notice = sentWith(h.chat, 'Closed on request.')
  assert.equal(notice.opts?.thread, tgThread(100))
  assert.equal(h.chat.sent.filter((s) => s.text.startsWith("Couldn't close")).length, 0, 'no failure notice')
})

test('/close in a topic with no live session says so and closes nothing', async () => {
  const h = await groupWithSession()
  await h.chat.inbound(textFrom('/close', { chat: topicChat(999) }))
  sentWith(h.chat, 'No live session in this topic to close.')
  assert.equal(signalsTo(h, PID).length, 0)
})

test('/close <name> in a folder topic with an unknown name says so and closes nothing', async () => {
  const h = await groupWithSession()
  await h.chat.inbound(textFrom('/close nosuch', { chat: topicChat(100) }))
  sentWith(h.chat, 'No live session named "nosuch" in this topic.')
  assert.equal(signalsTo(h, PID).length, 0)
})

test('a swipe-reply /close in General closes the session that wrote the replied-to message', async () => {
  const h = await groupWithSession()
  h.agent.receive(h.conn, { t: 'reply', reqId: 'r-1', text: 'Answer from the session.', kind: 'response' })
  await flush()
  const answer = sentWith(h.chat, 'Answer from the session.')
  await h.chat.inbound(textFrom('/close', { chat: GENERAL_CHAT, replyToId: answer.id }))
  assert.deepEqual(signalsTo(h, PID).map((x) => x.sig), ['SIGTERM'])
})

test('/close <name> in General closes the named session', async () => {
  const h = await groupWithSession()
  await h.chat.inbound(textFrom(`/close ${h.name}`, { chat: GENERAL_CHAT }))
  assert.deepEqual(signalsTo(h, PID).map((x) => x.sig), ['SIGTERM'])
})

test('a bare /close in General closes nothing and lists the live sessions', async () => {
  const h = await groupWithSession()
  await h.chat.inbound(textFrom('/close', { chat: GENERAL_CHAT }))
  assert.equal(signalsTo(h, PID).length, 0, 'nothing is closed')
  const reply = sentWith(h.chat, 'Which session?')
  assert.ok(reply.text.includes(`Live: ${h.name}.`), 'the live sessions are listed')
})

test('/close with an unknown name in General errors and closes nothing', async () => {
  const h = await groupWithSession()
  await h.chat.inbound(textFrom('/close nosuch', { chat: GENERAL_CHAT }))
  const reply = sentWith(h.chat, 'No session named "nosuch".')
  assert.ok(reply.text.includes(`Live: ${h.name}.`))
  assert.equal(signalsTo(h, PID).length, 0)
})
