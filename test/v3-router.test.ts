// Review round (v3 fix-tg): router behaviour through fake ports. Topics that Telegram lost, the bot losing its rights,
// callbacks answered before queued edits, topic deletes backing off, topics ended mid-creation, keyboards left from the
// last run, edits and unsupported kinds, the rate-limit notice, and a plan sent as one group.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
const DAY = 24 * 60 * 60 * 1000
import { FakeConn, HOME, OWNER, flush, harness, textFrom } from './helpers/fakes.ts'
import { tgChat, tgMsg, tgThread } from '../src/adapters/chat/tg-ids.ts'
import { parseCallbackData, permissionButtons } from '../src/router/state.ts'

const PROJ = `${HOME}/proj`
const GROUP = -1001234567890
const GROUP_ID = tgChat(GROUP)
const HOUR = 60 * 60 * 1000
const WEEK = 7 * DAY
const GROUP_CHAT = { kind: 'home' as const, id: GROUP_ID, thread: null }

async function groupWithSession(pid = 4242) {
  const h = harness({ groupId: tgChat(GROUP) })
  await h.router.start()
  h.platform.dirs.add(PROJ)
  const conn = new FakeConn()
  h.agent.receive(conn, { t: 'register', claudePid: pid, cwd: PROJ })
  await flush()
  return { ...h, conn }
}

test('a topic Telegram says is gone: a new topic is made for the session, and the reply goes there once', async () => {
  const { chat, agent, conn, router } = await groupWithSession()
  chat.goneThreads.add(tgThread(100))
  agent.receive(conn, { t: 'reply', reqId: 'r1', text: 'Hello again.', kind: 'response' })
  await flush()
  const creates = chat.topicOps.filter((o) => o.op === 'create')
  assert.equal(creates.length, 2, 'the original topic, then its replacement')
  const newThread = creates[1].threadId
  const sent = chat.sent.filter((s) => s.text.includes('Hello again.'))
  assert.equal(sent.length, 1, 'sent once, into the new topic')
  assert.equal(sent[0].opts?.thread, newThread)
  assert.equal(router.topics.find((r) => r.threadId === tgThread(100))?.state, 'deleted')
  assert.equal(router.topics.find((r) => r.threadId === newThread)?.state, 'open')
})

test('a chunked reply into a deleted topic recovers: the first chunk fails there, the rest go to the new topic', async () => {
  const { chat, agent, conn, router } = await groupWithSession()
  chat.goneThreads.add(tgThread(100))
  const text = Array.from({ length: 900 }, (_, i) => `line ${i} of the reply`).join('\n')
  agent.receive(conn, { t: 'reply', reqId: 'r1', text, kind: 'response' })
  await flush()
  const creates = chat.topicOps.filter((o) => o.op === 'create')
  assert.equal(creates.length, 2, 'the original topic, then its replacement')
  const newThread = creates[1].threadId
  assert.ok(chat.chunkCalls.length >= 2, 'the group was tried in the gone topic, then sent again')
  const sent = chat.sent.filter((s) => s.text.includes('of the reply'))
  assert.ok(sent.length >= 2, 'the reply is split into chunks')
  assert.ok(sent.every((s) => s.opts?.thread === newThread), 'every chunk goes to the new topic')
  assert.equal(router.topics.find((r) => r.threadId === newThread)?.state, 'open')
})

test('a gone topic that cannot be recreated: the message goes to General', async () => {
  const { chat, agent, conn } = await groupWithSession()
  chat.goneThreads.add(tgThread(100))
  chat.failTopicOps.add('create')
  agent.receive(conn, { t: 'reply', reqId: 'r1', text: 'Still here.', kind: 'response' })
  await flush()
  const sent = chat.sent.find((s) => s.text.includes('Still here.'))
  assert.ok(sent)
  assert.equal(sent.chat, 'group')
  assert.equal(sent.opts?.thread, undefined, 'General: no thread id')
})

test('the bot loses its rights: output goes to the DM with one notice; it goes back to the topics when the rights return', async () => {
  const { chat, agent, conn, router } = await groupWithSession()
  await chat.chatEvent({ type: 'access', chat: GROUP_ID, access: 'lost', reason: 'kicked' })
  await flush()
  assert.equal(router.groupAccess, false)
  const notices = chat.sent.filter((s) => s.text.includes('can no longer run the group'))
  assert.equal(notices.length, 1)
  assert.equal(notices[0].chat, 'dm')

  agent.receive(conn, { t: 'reply', reqId: 'r1', text: 'While away.', kind: 'response' })
  await flush()
  const away = chat.sent.find((s) => s.text.includes('While away.'))
  assert.equal(away?.chat, 'dm', 'routed to the DM while the group is out of reach')

  await chat.chatEvent({ type: 'access', chat: GROUP_ID, access: 'ok', reason: 'administrator' })
  await flush()
  assert.equal(router.groupAccess, true)
  agent.receive(conn, { t: 'reply', reqId: 'r2', text: 'Back.', kind: 'response' })
  await flush()
  assert.equal(chat.sent.find((s) => s.text.includes('Back.'))?.chat, 'group')
})

test('Telegram refusing a send to the group for good counts as losing access, and is said once', async () => {
  const { chat, router } = await groupWithSession()
  chat.accessError('Forbidden: bot was kicked from the supergroup chat')
  chat.accessError('Forbidden: bot was kicked from the supergroup chat')
  await flush()
  assert.equal(router.groupAccess, false)
  assert.equal(chat.sent.filter((s) => s.text.includes('can no longer run the group')).length, 1)
})

test('a permission tap is answered before its edit, even while the edit waits in the queue', async () => {
  const { chat, platform, agent, conn } = await groupWithSession()
  platform.away = true
  agent.receive(conn, { t: 'permission_request', request_id: 'abcde', tool_name: 'Bash', description: 'run', input_preview: '{"command":"ls"}' })
  await flush()
  const prompt = chat.sent.find((s) => s.opts?.perm?.requestId === 'abcde')
  assert.ok(prompt)
  const allow = permissionButtons('abcde', prompt.opts?.perm ?? { withMore: true, redacted: false })[0]
  assert.ok(parseCallbackData(allow.data))
  chat.editGate = new Promise(() => {}) // the edit never returns
  void chat.callback({ pressId: 'cb1', data: allow.data, message: prompt.id, from: OWNER, chat: { kind: 'home', id: GROUP_ID, thread: tgThread(100) } })
  await flush()
  assert.ok(chat.answers.some((a) => a.id === 'cb1'), 'the tap was answered without waiting for the edit')
})

test('a folder topic stays open long after its last session ended: no close, no delete', async () => {
  const { chat, platform, clock, router } = await groupWithSession()
  platform.dead.add(4242)
  clock.advance(60_000)
  await flush()
  clock.advance(WEEK * 2)
  await flush()
  assert.deepEqual(chat.topicOps.filter((o) => o.op !== 'create'), [])
  assert.equal(router.topics[0]?.state, 'open')
  assert.equal(router.topics[0]?.deleteAt, null)
})

test('keyboards left from the last run are removed at start, and the stored list is cleared', async () => {
  const h = harness({ groupId: tgChat(GROUP) })
  h.store.liveButtons = JSON.stringify([
    { messageId: 5, dm: false },
    { messageId: 6, dm: true },
  ])
  await h.router.start()
  await flush()
  assert.deepEqual(h.chat.clearedKeyboards.map((c) => [c.messageId, c.target?.dm]), [[tgMsg(5), false], [tgMsg(6), true]])
  assert.equal(h.store.liveButtons, '[]')
})

test('an edited message is answered once, and an unsupported kind is said; neither is routed', async () => {
  const h = harness({ groupId: tgChat(GROUP) })
  await h.router.start()
  await h.chat.inbound(textFrom('changed', { kind: 'edited', messageId: tgMsg(9), chat: GROUP_CHAT }))
  await h.chat.inbound(textFrom('changed again', { kind: 'edited', messageId: tgMsg(9), chat: GROUP_CHAT }))
  await h.chat.inbound(textFrom('', { kind: 'unsupported', label: 'a sticker', messageId: tgMsg(10), chat: GROUP_CHAT }))
  await flush()
  assert.equal(h.chat.sent.filter((s) => s.text.includes("Edits aren't forwarded")).length, 1)
  assert.ok(h.chat.sent.some((s) => s.text === "Can't forward a sticker. Send it as text or a file."))
  assert.deepEqual(h.agent.sent, [], 'nothing reached a session')
})

test('an anonymous admin post is explained once in General', async () => {
  const h = harness({ groupId: tgChat(GROUP) })
  await h.router.start()
  await h.chat.chatEvent({ type: 'unattributable-post', chat: GROUP_ID })
  await h.chat.chatEvent({ type: 'unattributable-post', chat: GROUP_ID })
  assert.equal(h.chat.sent.filter((s) => s.text.includes('anonymous admin')).length, 1)
})

test('messages dropped by the rate limit are counted and said with the next one that gets through', async () => {
  const h = harness({ groupId: tgChat(GROUP) })
  await h.router.start()
  for (let i = 0; i < 22; i++) await h.chat.inbound(textFrom(`m${i}`, { chat: GROUP_CHAT, messageId: tgMsg(100 + i) }))
  h.clock.advance(61_000)
  await h.chat.inbound(textFrom('later', { chat: GROUP_CHAT, messageId: tgMsg(200) }))
  await flush()
  assert.ok(h.chat.sent.some((s) => s.text === '2 earlier messages dropped by the rate limit.'))
})

test('a plan goes out as one group, the buttons on its last chunk only', async () => {
  const { chat, platform, agent, conn } = await groupWithSession()
  platform.away = true
  const plan = Array.from({ length: 900 }, (_, i) => `step ${i} do the thing`).join('\n')
  agent.receive(conn, { t: 'ask', claudePid: 4242, cwd: PROJ, tool_name: 'ExitPlanMode', tool_input: { plan } })
  await flush()
  assert.equal(chat.chunkCalls.length, 1, 'one group')
  assert.ok(chat.chunkCalls[0].texts.length >= 2)
  const parts = chat.sent.filter((s) => s.text.includes('step') || s.text.includes('plan ready'))
  assert.equal(parts.at(0)?.opts?.rows, undefined)
  assert.ok(parts.at(-1)?.opts?.rows, 'Approve / Reject on the last chunk')
})

test('an album is one message to the session: every file is downloaded and named in the body', async () => {
  const { chat, agent, conn } = await groupWithSession()
  const fetched: string[] = []
  chat.download = async (fileRef: string) => {
    fetched.push(fileRef)
  }
  await chat.inbound(
    textFrom('two shots', {
      kind: 'photo',
      messageId: tgMsg(11),
      chat: { kind: 'home', id: GROUP_ID, thread: tgThread(100) },
      album: [
        { messageId: tgMsg(11), kind: 'photo', fileRef: 'p1' },
        { messageId: tgMsg(12), kind: 'photo', fileRef: 'p2' },
      ],
    }),
  )
  await flush()
  assert.deepEqual(fetched, ['p1', 'p2'])
  assert.equal(agent.sent.length, 1, 'one inbound, not two')
  assert.match(agent.sent[0].content, /two shots/)
  assert.equal((agent.sent[0].content.match(/file: /g) ?? []).length, 2)
  assert.equal(agent.sent[0].meta.album_count, '2')
  void conn
})

test('/bind: an approval still waiting in the DM is closed, since its answer belongs to the group now', async () => {
  const h = harness()
  await h.router.start()
  h.platform.dirs.add(PROJ)
  const conn = new FakeConn()
  h.agent.receive(conn, { t: 'register', claudePid: 4242, cwd: PROJ })
  await flush()
  h.platform.away = true
  h.agent.receive(conn, { t: 'permission_request', request_id: 'abcde', tool_name: 'Bash', description: 'run', input_preview: '{"command":"ls"}' })
  await flush()
  const prompt = h.chat.sent.find((s) => s.opts?.perm?.requestId === 'abcde')
  assert.equal(prompt?.chat, 'dm')
  await h.chat.inbound(textFrom('/bind', { chat: GROUP_CHAT }))
  await flush()
  assert.equal(h.router.pending.size, 0)
  assert.ok(h.chat.edits.some((e) => e.messageId === prompt?.id && /expired/i.test(e.text)))
})
