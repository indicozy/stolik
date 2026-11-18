// /silent through the router (spec 24 §4): the mute of a folder topic silences its default-level sends; critical sends and
// approvals still ping; the mute ends after its duration; /silent off; restarts and topic close/reopen keep it; other
// topics and General are unaffected.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeConn, FakeChat, HOME, flush, harness, textFrom } from './helpers/fakes.ts'
import { tgChat, tgThread } from '../src/adapters/chat/tg-ids.ts'
import { withTopicMute } from '../src/router/mute.ts'

const PROJ = `${HOME}/proj`
const PROJ2 = `${HOME}/other`
const GROUP = -1001234567890
const GROUP_ID = tgChat(GROUP)
const MINUTE = 60 * 1000
const GENERAL_CHAT = { kind: 'home' as const, id: GROUP_ID, thread: null }
const topicChat = (threadId: number) => ({ kind: 'home' as const, id: GROUP_ID, thread: tgThread(threadId) })

// A group-mode router with one channel session in PROJ (pid 4242), its topic (thread 100) created.
async function groupWithSession(pid = 4242) {
  const h = harness({ groupId: tgChat(GROUP) })
  await h.router.start()
  h.platform.dirs.add(PROJ)
  const conn = new FakeConn()
  h.agent.receive(conn, { t: 'register', claudePid: pid, cwd: PROJ })
  await flush()
  return { ...h, conn }
}

function sentWith(chat: FakeChat, text: string) {
  const hit = chat.sent.find((s) => s.text.includes(text))
  assert.ok(hit, `sent: ${text}`)
  return hit
}

// A session's reply (default level unless given), then the sent message it made.
type Harnessed = ReturnType<typeof harness>
async function reply(h: Pick<Harnessed, 'agent' | 'telegram'>, conn: FakeConn, text: string, level?: 'silent' | 'default' | 'critical') {
  h.agent.receive(conn, { t: 'reply', reqId: `r-${text}`, text, kind: 'response', ...(level ? { level } : {}) } as Parameters<Harnessed['agent']['receive']>[1])
  await flush()
  return sentWith(h.chat, text)
}

const createdThreads = (chat: FakeChat) =>
  chat.topicOps.filter((o) => o.op === 'create').map((o) => ({ threadId: o.threadId, name: o.name }))

test('/silent in a folder topic: the ack is silent, a default reply there is silent, a critical one still pings', async () => {
  const h = await groupWithSession()
  await h.chat.inbound(textFrom('/silent', { chat: topicChat(100) }))
  const ack = sentWith(h.chat, 'Muted until /silent off.')
  assert.equal(ack.opts?.silent, true, 'the ack itself is silent')
  assert.equal(ack.opts?.thread, tgThread(100), 'the ack is in the topic')

  const answer = await reply(h, h.conn, 'Default answer.')
  assert.equal(answer.opts?.silent, true, 'a default reply in the muted topic is silent')
  assert.equal(answer.opts?.thread, tgThread(100))

  const blocker = await reply(h, h.conn, 'Blocker: disk full.', 'critical')
  assert.notEqual(blocker.opts?.silent, true, 'a critical reply still pings')

  h.platform.away = true
  h.agent.receive(h.conn, { t: 'permission_request', request_id: 'abcde', tool_name: 'Bash', description: 'run', input_preview: 'ls' })
  await flush()
  const prompt = h.chat.sent.find((s) => s.opts?.perm?.requestId === 'abcde')
  assert.ok(prompt, 'the approval is sent')
  assert.notEqual(prompt.opts?.silent, true, 'an approval still pings')
  assert.equal(prompt.opts?.thread, tgThread(100))
})

test('the mute ends after its duration: inside it the reply is silent, after it the reply pings and the mute is dropped', async () => {
  const h = await groupWithSession()
  await h.chat.inbound(textFrom('/silent 30m', { chat: topicChat(100) }))
  assert.match(sentWith(h.chat, 'Muted until').text, /^🔕 Muted until \w{3} \d\d:\d\d\. /)

  h.clock.advance(29 * MINUTE)
  assert.equal((await reply(h, h.conn, 'Inside the window.')).opts?.silent, true)

  h.clock.advance(2 * MINUTE)
  assert.notEqual((await reply(h, h.conn, 'After the window.')).opts?.silent, true, 'expired: pings again')
  assert.deepEqual(JSON.parse(h.store.mutesJson || '{}'), {}, 'the expired mute is cleaned from the store')
})

test('/silent off restores the ping; its ack is silent', async () => {
  const h = await groupWithSession()
  await h.chat.inbound(textFrom('/silent', { chat: topicChat(100) }))
  await h.chat.inbound(textFrom('/silent off', { chat: topicChat(100) }))
  const ack = sentWith(h.chat, 'Unmuted.')
  assert.equal(ack.opts?.silent, true)
  assert.notEqual((await reply(h, h.conn, 'Back to pinging.')).opts?.silent, true)
})

test('/silent status says whether the folder is muted, and until when', async () => {
  const h = await groupWithSession()
  await h.chat.inbound(textFrom('/silent status', { chat: topicChat(100) }))
  assert.ok(h.chat.sent.some((s) => s.text === "🔔 Not muted. /silent mutes this folder's topic."))

  await h.chat.inbound(textFrom('/silent', { chat: topicChat(100) }))
  await h.chat.inbound(textFrom('/silent status', { chat: topicChat(100) }))
  assert.ok(h.chat.sent.some((s) => s.text === '🔕 Muted until /silent off.'))

  await h.chat.inbound(textFrom('/silent 2h', { chat: topicChat(100) }))
  await h.chat.inbound(textFrom('/silent status', { chat: topicChat(100) }))
  const timed = h.chat.sent.filter((s) => s.text.startsWith('🔕 Muted until ') && !s.text.includes('/silent off')).pop()
  assert.match(timed?.text ?? '', /^🔕 Muted until \w{3} \d\d:\d\d\.$/)
})

test('a refused duration (over a week, garbage) says why; nothing is muted and the reply pings', async () => {
  const h = await groupWithSession()
  await h.chat.inbound(textFrom('/silent 8d', { chat: topicChat(100) }))
  const refusal = sentWith(h.chat, 'The longest /silent is 1w')
  assert.notEqual(refusal.opts?.silent, true, 'a refusal is an ordinary reply')
  await h.chat.inbound(textFrom('/silent banana', { chat: topicChat(100) }))
  sentWith(h.chat, 'Use /silent for until /silent off')
  assert.deepEqual(JSON.parse(h.store.mutesJson || '{}'), {})
  assert.notEqual((await reply(h, h.conn, 'Still pinging.')).opts?.silent, true)
})

test('a mute survives a router restart: the folder stays muted after the bot is started again', async () => {
  const first = await groupWithSession()
  await first.chat.inbound(textFrom('/silent', { chat: topicChat(100) }))

  const second = harness({ groupId: tgChat(GROUP) })
  second.store.groupId = tgChat(GROUP)
  second.store.topicsJson = first.store.topicsJson
  second.store.mutesJson = first.store.mutesJson
  await second.router.start()
  second.platform.dirs.add(PROJ)
  const conn = new FakeConn()
  second.agent.receive(conn, { t: 'register', claudePid: 4242, cwd: PROJ })
  await flush()
  const answer = await reply(second, conn, 'After the restart.')
  assert.equal(answer.opts?.thread, tgThread(100), 'the same topic')
  assert.equal(answer.opts?.silent, true, 'still muted')
})

test('a mute survives a topic close and reopen of the same folder', async () => {
  const h = await groupWithSession()
  await h.chat.inbound(textFrom('/silent', { chat: topicChat(100) }))
  h.platform.dead.add(4242)
  h.clock.advance(60 * MINUTE)
  await flush()
  assert.deepEqual(h.chat.topicOps.filter((o) => o.op === 'close'), [{ op: 'close', threadId: tgThread(100) }])

  const conn2 = new FakeConn()
  h.agent.receive(conn2, { t: 'register', claudePid: 4343, cwd: PROJ })
  await flush()
  assert.deepEqual(h.chat.topicOps.filter((o) => o.op === 'reopen'), [{ op: 'reopen', threadId: tgThread(100) }])
  const answer = await reply(h, conn2, 'Reopened and muted.')
  assert.equal(answer.opts?.thread, tgThread(100))
  assert.equal(answer.opts?.silent, true)
  assert.equal(JSON.parse(h.store.mutesJson)[PROJ], null, 'the mute is kept by folder')
})

test('another folder topic is unaffected by the mute', async () => {
  const h = await groupWithSession()
  await h.chat.inbound(textFrom('/silent', { chat: topicChat(100) }))

  h.platform.dirs.add(PROJ2)
  const conn2 = new FakeConn()
  h.agent.receive(conn2, { t: 'register', claudePid: 4343, cwd: PROJ2 })
  await flush()
  const otherThread = createdThreads(h.chat).find((c) => c.name === 'other')?.threadId
  assert.ok(otherThread !== undefined && otherThread !== 100, 'the other folder has its own topic')

  const other = await reply(h, conn2, 'Other folder answer.')
  assert.equal(other.opts?.thread, otherThread)
  assert.notEqual(other.opts?.silent, true, 'not muted')
  assert.equal((await reply(h, h.conn, 'Muted folder answer.')).opts?.silent, true)
})

test('/silent in General answers that it works inside a folder topic; General sends are never muted', async () => {
  const h = await groupWithSession()
  await h.chat.inbound(textFrom('/silent', { chat: GENERAL_CHAT }))
  const hint = sentWith(h.chat, '/silent works inside a folder topic')
  assert.equal(hint.opts?.thread, undefined, 'answered in General')
  assert.equal(JSON.parse(h.store.mutesJson || '{}')[PROJ], undefined, 'nothing muted')
})

test('the send wrapper: a send with no thread is never muted; a level-less send to a muted thread is silent; level is not passed on', async () => {
  const inner = new FakeChat()
  const port = withTopicMute(inner, (threadId) => threadId === tgThread(7))
  await port.sendText('general', { level: 'default' })
  await port.sendText('muted default', { thread: tgThread(7) })
  await port.sendText('muted critical', { thread: tgThread(7), level: 'critical' })
  await port.sendText('muted silent', { thread: tgThread(7), level: 'silent' })
  await port.sendText('other thread', { thread: tgThread(8), level: 'default' })
  await port.sendText('plain', {})
  const [general, mutedDefault, mutedCritical, mutedSilent, other, plain] = inner.sent
  assert.equal(general.opts?.silent, undefined, 'General is not muted')
  assert.equal(mutedDefault.opts?.silent, true)
  assert.equal(mutedCritical.opts?.silent, undefined, 'critical pings in a muted topic')
  assert.equal(mutedSilent.opts?.silent, true)
  assert.equal(other.opts?.silent, undefined)
  assert.equal(plain.opts?.silent, undefined)
  for (const s of inner.sent) assert.equal('level' in (s.opts ?? {}), false, `level is stripped from ${s.text}`)
})
