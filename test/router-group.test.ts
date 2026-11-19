// Group mode through the router with fake ports (plan 2.1-2.3, ticket 22): binding, the DM hint, one topic per folder,
// output into its topic, topic messages into their session, close / reopen, the legacy rollout, join alerts and migration.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeConn, HOME, OWNER, flush, harness, textFrom } from './helpers/fakes.ts'
import { tgChat, tgMsg, tgThread, tgUser } from '../src/adapters/chat/tg-ids.ts'
import type { Inbound } from '../src/brain/chat-types.ts'
import { ChatError } from '../src/brain/chat-types.ts'
import { SWEEP_MS } from '../src/router/shared.ts'

const PROJ = `${HOME}/proj`
const GROUP = -1001234567890
const GROUP_ID = tgChat(GROUP)
const DAY = 24 * 60 * 60 * 1000
const DELETE_AFTER_MS = 7 * DAY
const GROUP_CHAT = { kind: 'home' as const, id: GROUP_ID, thread: null }
const topicChat = (threadId: number) => ({ kind: 'home' as const, id: GROUP_ID, thread: tgThread(threadId) })

// A group-mode router with one channel session in PROJ (pid 4242), its topic created.
async function groupWithSession(pid = 4242, opts: { startWhenNoSession?: boolean; quotaRefusal?: () => Promise<string | null> } = {}) {
  const h = harness({ groupId: tgChat(GROUP), ...opts })
  await h.router.start()
  h.platform.dirs.add(PROJ)
  const conn = new FakeConn()
  h.agent.receive(conn, { t: 'register', claudePid: pid, cwd: PROJ })
  await flush()
  return { ...h, conn }
}

// The thread id of the topic created by the n-th createThread call (1-based).
function createdThreads(chat: { topicOps: Array<{ op: string; threadId?: number; name?: string }> }) {
  return chat.topicOps.filter((o) => o.op === 'create').map((o) => ({ threadId: o.threadId, name: o.name }))
}

test('/bind in the supergroup by the owner stores the group id and confirms in General', async () => {
  const h = harness()
  await h.router.start()
  await h.chat.inbound(textFrom('/bind', { chat: GROUP_CHAT }))

  assert.equal(h.router.groupId, GROUP_ID)
  assert.equal(h.store.groupId, GROUP_ID)
  assert.equal(h.chat.group, GROUP_ID)
  const reply = h.chat.sent.find((s) => s.text.startsWith('Bound.'))
  assert.ok(reply, 'the bind is confirmed')
  assert.equal(reply.chat, 'group')
  assert.equal(reply.opts?.thread, undefined, 'General: no thread id')
})

test('/bind from anyone but the owner does nothing', async () => {
  const h = harness()
  await h.router.start()
  await h.chat.inbound(textFrom('/bind', { chat: GROUP_CHAT, fromId: tgUser(999), from: 'stranger' }))
  assert.equal(h.router.groupId, null)
  assert.equal(h.store.groupId, null)
  assert.deepEqual(h.chat.sent, [])
})

test('group mode: a DM message gets "use the group" with the link, and is not routed', async () => {
  const { chat, agent } = await groupWithSession()
  await chat.inbound(textFrom('hello there'))

  assert.deepEqual(agent.sent, [])
  const hint = chat.sent.find((s) => s.text.startsWith('Use the group'))
  assert.ok(hint, 'the hint is sent')
  assert.equal(hint.chat, 'dm')
  assert.match(hint.text, /https:\/\/t\.me\/c\/1234567890/)
})

test('group mode: a tap in the DM is answered "Use the group"', async () => {
  const { chat } = await groupWithSession()
  await chat.callback({ pressId: 'cb1', data: 'x', message: tgMsg(5), from: OWNER })
  assert.deepEqual(chat.answers, [{ id: 'cb1', text: 'Use the group' }])
})

test('group mode: a message from another user in the group is ignored', async () => {
  const { chat, agent } = await groupWithSession()
  await chat.inbound(textFrom('let me in', { chat: topicChat(100), fromId: tgUser(999), from: 'stranger' }))
  assert.deepEqual(agent.sent, [])
  assert.deepEqual(chat.sent, [])
})

test('a session gets a topic named after its folder when it registers', async () => {
  const { chat, store } = await groupWithSession()
  assert.deepEqual(createdThreads(chat), [{ threadId: tgThread(100), name: 'proj' }])
  const saved = JSON.parse(store.topicsJson) as Array<{ threadId: string; state: string; cwd: string; sessionKey: string | null }>
  assert.equal(saved[0]?.threadId, tgThread(100))
  assert.equal(saved[0]?.state, 'open')
  assert.equal(saved[0]?.cwd, PROJ)
  assert.equal(saved[0]?.sessionKey, null, 'a folder topic keeps no session key')
})

test('a second session in the same folder shares its topic: no second topic', async () => {
  const { chat, agent } = await groupWithSession()
  agent.receive(new FakeConn(), { t: 'register', claudePid: 4343, cwd: PROJ })
  await flush()
  assert.deepEqual(createdThreads(chat).map((t) => t.name), ['proj'])
})

test('a folder with the same basename as another gets its topic named parent/basename', async () => {
  const { chat, agent, platform } = await groupWithSession()
  const other = `${HOME}/work/proj`
  platform.dirs.add(other)
  agent.receive(new FakeConn(), { t: 'register', claudePid: 4343, cwd: other })
  await flush()
  assert.deepEqual(createdThreads(chat).map((t) => t.name), ['proj', 'work/proj'])
})

test('two sessions in one folder registering at once make one topic', async () => {
  const h = harness({ groupId: tgChat(GROUP) })
  await h.router.start()
  h.platform.dirs.add(PROJ)
  let release: () => void = () => {}
  h.chat.createGate = new Promise<void>((r) => (release = r))
  h.agent.receive(new FakeConn(), { t: 'register', claudePid: 4242, cwd: PROJ })
  h.agent.receive(new FakeConn(), { t: 'register', claudePid: 4343, cwd: PROJ })
  await flush()
  h.chat.createGate = null
  release()
  await flush()
  assert.deepEqual(createdThreads(h.chat), [{ threadId: tgThread(100), name: 'proj' }])
  assert.equal(h.router.topics.length, 1)
})

test('the folder topic stays open while another session in the folder is live; the last one closes it', async () => {
  const { chat, agent, platform, clock, router } = await groupWithSession()
  agent.receive(new FakeConn(), { t: 'register', claudePid: 4343, cwd: PROJ })
  await flush()
  platform.dead.add(4242)
  clock.advance(60_000)
  await flush()
  assert.equal(chat.topicOps.filter((o) => o.op === 'close').length, 0, 'the other session still works in it')
  assert.equal(router.topics[0]?.state, 'open')

  platform.dead.add(4343)
  clock.advance(60_000)
  await flush()
  assert.deepEqual(chat.topicOps.filter((o) => o.op === 'close'), [{ op: 'close', threadId: tgThread(100) }])
  assert.equal(router.topics[0]?.state, 'closed')
  assert.equal(router.topics[0]?.deleteAt, null)
})

test('two register messages for one session before its topic exists make one topic', async () => {
  const h = harness({ groupId: tgChat(GROUP) })
  await h.router.start()
  h.platform.dirs.add(PROJ)
  const a = new FakeConn()
  const b = new FakeConn()
  h.agent.receive(a, { t: 'register', claudePid: 4242, cwd: PROJ })
  h.agent.receive(b, { t: 'register', claudePid: 4242, cwd: PROJ })
  await flush()
  assert.deepEqual(createdThreads(h.chat).map((t) => t.name), ['proj'])
})

test('a session reply goes into its topic (with the thread id), not General', async () => {
  const { chat, agent, conn } = await groupWithSession()
  agent.receive(conn, { t: 'reply', reqId: 'r1', text: 'Tests pass.', kind: 'response' })
  await flush()
  const sent = chat.sent.find((s) => s.text.includes('Tests pass.'))
  assert.ok(sent)
  assert.equal(sent.chat, 'group')
  assert.equal(sent.opts?.thread, tgThread(100))
})

test('a file sent by a session goes into its topic', async () => {
  const { chat, agent, conn, platform } = await groupWithSession()
  platform.files.set(`${PROJ}/out.txt`, { isFile: true, size: 10 })
  platform.dirs.add(PROJ)
  agent.receive(conn, { t: 'reply', reqId: 'r2', text: '', files: [`${PROJ}/out.txt`], kind: 'response' })
  await flush()
  const file = chat.files.find((f) => f.path.endsWith('out.txt'))
  assert.ok(file, 'the file is sent')
  assert.equal(file.target?.thread, tgThread(100))
  assert.equal(file.chat, 'group')
})

test('a permission prompt goes into the session topic', async () => {
  const { chat, platform, agent, conn } = await groupWithSession()
  platform.away = true
  agent.receive(conn, { t: 'permission_request', request_id: 'abcde', tool_name: 'Bash', description: 'run', input_preview: 'ls' })
  await flush()
  const prompt = chat.sent.find((s) => s.opts?.perm?.requestId === 'abcde')
  assert.ok(prompt, 'the prompt is sent')
  assert.equal(prompt.opts?.thread, tgThread(100))
  assert.equal(prompt.chat, 'group')
})

test('a message in a session topic goes to that session as it is: no prefix, no command', async () => {
  const { chat, agent, store } = await groupWithSession()
  await chat.inbound(textFrom('note: keep this', { chat: topicChat(100) }))
  await chat.inbound(textFrom('/list', { chat: topicChat(100), messageId: tgMsg(11) }))

  assert.deepEqual(agent.sent.map((m) => m.content), ['note: keep this', '/list'])
  assert.deepEqual(store.notes, [], 'a note-looking message in a topic is not saved')
  assert.deepEqual(chat.sent.filter((s) => s.text.includes('Pick a session')), [])
})

test('a message in General (group mode) keeps today\'s routing: commands still run there', async () => {
  const { chat, agent } = await groupWithSession()
  await chat.inbound(textFrom('/list', { chat: GROUP_CHAT, messageId: tgMsg(12) }))
  assert.deepEqual(agent.sent, [])
  const list = chat.sent.find((s) => s.text.includes('proj'))
  assert.ok(list, 'the session list is sent')
  assert.equal(list.chat, 'group')
  assert.equal(list.opts?.thread, undefined)
})

test('a session ends: its topic closes; a message in it then says how to start one, in that topic', async () => {
  const { chat, platform, clock, agent } = await groupWithSession()
  platform.dead.add(4242)
  clock.advance(60_000)
  await flush()
  assert.deepEqual(chat.topicOps.filter((o) => o.op === 'close'), [{ op: 'close', threadId: tgThread(100) }])

  await chat.inbound(textFrom('still there?', { chat: topicChat(100) }))
  assert.deepEqual(agent.sent, [])
  const note = chat.sent.find((s) => s.text.startsWith('No live session in this folder'))
  assert.ok(note)
  assert.equal(note.opts?.thread, tgThread(100))
})

test('a closed folder topic is never deleted: 7 days later it is still there, and the next session reopens it', async () => {
  const { chat, platform, clock, store, agent } = await groupWithSession()
  platform.dead.add(4242)
  clock.advance(60_000)
  await flush()

  clock.advance(DELETE_AFTER_MS + DAY)
  await flush()
  assert.equal(chat.topicOps.filter((o) => o.op === 'delete').length, 0, 'never deleted')
  const saved = JSON.parse(store.topicsJson) as Array<{ state: string; deleteAt: number | null }>
  assert.equal(saved[0]?.state, 'closed')
  assert.equal(saved[0]?.deleteAt, null)

  agent.receive(new FakeConn(), { t: 'register', claudePid: 4343, cwd: PROJ })
  await flush()
  assert.deepEqual(chat.topicOps.filter((o) => o.op === 'reopen'), [{ op: 'reopen', threadId: tgThread(100) }])
  assert.equal(createdThreads(chat).length, 1, 'no second topic')
})

test('/resume of a transcript reopens its closed topic instead of making a new one', async () => {
  const { chat, platform, clock, agent, conn } = await groupWithSession()
  const sid = '11111111-2222-4333-8444-555555555555'
  const transcript = `${HOME}/t.jsonl`
  agent.receive(conn, { t: 'hook', event: 'UserPromptSubmit', claudePid: 4242, cwd: PROJ, payload: { session_id: sid } })
  await flush()
  platform.dead.add(4242)
  clock.advance(60_000)
  await flush()

  // /resume lists the ended transcript; tapping it starts `claude --resume` for it in the same folder.
  agent.transcripts = [{ id: sid, path: transcript, cwd: PROJ, title: 'Fix the parser', mtime: clock.now() - 60_000, entrypoint: 'cli' }]
  platform.files.set(transcript, { isFile: true, size: 1 })
  agent.trusted.add(PROJ)
  await chat.inbound(textFrom('/resume', { chat: GROUP_CHAT }))
  const list = chat.sent.find((s) => s.text.startsWith('Pick a session'))
  assert.ok(list, 'the resume list is sent')
  const data = String(list.opts?.rows?.[0]?.[0]?.data)
  await chat.callback({ pressId: 'cbR', data, message: list.id, from: OWNER, chat: GROUP_CHAT })
  await flush()
  assert.deepEqual(agent.startedSessions.map((x) => x.extra), [['--resume', sid]])

  // The resumed process registers: its topic is the old one, reopened.
  const newConn = new FakeConn()
  agent.receive(newConn, { t: 'register', claudePid: 5151, cwd: PROJ, spawnToken: agent.spawnTokens[0] })
  await flush()
  assert.deepEqual(chat.topicOps.filter((o) => o.op === 'reopen'), [{ op: 'reopen', threadId: tgThread(100) }])
  assert.equal(createdThreads(chat).length, 1, 'no second topic was created')
})

test('a stranger join raises one alert in General (the adapter already left the owner and bots out)', async () => {
  const { chat } = await groupWithSession()
  await chat.chatEvent({ type: 'stranger-joined', chat: GROUP_ID, label: 'stranger' })
  const alerts = chat.sent.filter((s) => s.text.startsWith('A new member joined'))
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0]?.chat, 'group')
  assert.equal(alerts[0]?.opts?.thread, undefined)
})

test('a group migration moves the stored id and the adapter\'s target', async () => {
  const { chat, store, router } = await groupWithSession()
  await chat.chatEvent({ type: 'home-moved', from: GROUP_ID, to: tgChat(-1009999999999) })
  assert.equal(router.groupId, tgChat(-1009999999999))
  assert.equal(store.groupId, tgChat(-1009999999999))
  assert.equal(chat.group, tgChat(-1009999999999))
})

test('when topic creation fails, the session still works: its output goes to General', async () => {
  const h = harness({ groupId: tgChat(GROUP) })
  await h.router.start()
  h.platform.dirs.add(PROJ)
  h.chat.failTopicOps.add('create')
  const conn = new FakeConn()
  h.agent.receive(conn, { t: 'register', claudePid: 4242, cwd: PROJ })
  await flush()
  h.agent.receive(conn, { t: 'reply', reqId: 'r1', text: 'Done.', kind: 'response' })
  await flush()
  const sent = h.chat.sent.find((s) => s.text.includes('Done.'))
  assert.ok(sent)
  assert.equal(sent.opts?.thread, undefined)
  assert.equal(h.router.topics.length, 0)
  assert.ok(h.logger.lines.some((l) => l.includes('not created')))
})

test('topics survive a restart: the group and the topic records are read back', async () => {
  const first = await groupWithSession()
  // The group was bound with /bind (stored), not set in the config.
  const second = harness()
  second.store.groupId = tgChat(GROUP)
  second.store.topicsJson = first.store.topicsJson
  await second.router.start()
  assert.equal(second.router.groupId, GROUP_ID)
  assert.equal(second.chat.group, GROUP_ID)
  assert.deepEqual(second.router.topics.map((t) => [t.threadId, t.name]), [[tgThread(100), 'proj']])
})

test('the stored group id wins over the start-up config value', async () => {
  const h = harness({ groupId: tgChat(GROUP) })
  h.store.groupId = tgChat(-1005555555555)
  await h.router.start()
  assert.equal(h.router.groupId, tgChat(-1005555555555))
})

test('a message in a topic that is not a folder topic says so, in that topic', async () => {
  const h = harness({ groupId: tgChat(GROUP) })
  await h.router.start()
  const msg: Inbound = textFrom('hi', { chat: topicChat(555) })
  await h.chat.inbound(msg)
  const note = h.chat.sent.find((s) => s.text.startsWith('This topic has no folder'))
  assert.ok(note)
  assert.equal(note.opts?.thread, tgThread(555))
})

test('DM mode is unchanged: no group, no topics, sends carry no thread', async () => {
  const h = harness()
  await h.router.start()
  h.platform.dirs.add(PROJ)
  const conn = new FakeConn()
  h.agent.receive(conn, { t: 'register', claudePid: 4242, cwd: PROJ })
  await flush()
  h.agent.receive(conn, { t: 'reply', reqId: 'r1', text: 'Hello.', kind: 'response' })
  await flush()
  assert.deepEqual(h.chat.topicOps, [])
  const sent = h.chat.sent.find((s) => s.text.includes('Hello.'))
  assert.equal(sent?.chat, 'dm')
  assert.equal(sent?.opts?.thread, undefined)
})

// Review finding 6: a session that died while the router was down leaves its topic open. After start-up and a
// reconnect grace (2 minutes), the open topics whose session is not live are closed.
test('a topic whose session did not reconnect after a restart is closed once the grace has passed', async () => {
  const first = await groupWithSession()
  const second = harness({ groupId: tgChat(GROUP) })
  second.store.topicsJson = first.store.topicsJson
  await second.router.start()
  second.clock.advance(2 * 60_000 - 1000)
  await flush()
  assert.equal(second.chat.topicOps.filter((o) => o.op === 'close').length, 0, 'still in the grace')
  second.clock.advance(1000)
  await flush()
  assert.deepEqual(second.chat.topicOps.filter((o) => o.op === 'close'), [{ op: 'close', threadId: tgThread(100) }])
  assert.equal((JSON.parse(second.store.topicsJson) as Array<{ state: string }>)[0]?.state, 'closed')
})

// ---------- ticket 22: folder routing, /new, the rollout ----------

// The live session with this pid.
function sessionOf(router: { registry: { list(): Array<{ pid: number | null }> } }, pid: number) {
  const s = router.registry.list().find((x) => x.pid === pid)
  if (!s) throw new Error(`no session ${pid}`)
  return s as typeof s & { key: number | string; name: string; cwd: string; lastActive: number }
}

// Records that session `s` wrote message `messageId` into topic 100 (what its reply would record).
function wrote(router: { msgMap: { record(id: MessageId, e: { key: unknown; name: string; cwd: string; thread?: ThreadId | null }): void } }, s: { key: unknown; name: string; cwd: string }, messageId: number): void {
  router.msgMap.record(tgMsg(messageId), { key: s.key, name: s.name, cwd: s.cwd, thread: tgThread(100) })
}

// Three sessions in PROJ (pids 4242, 4343, 4545) with their folder topic 100.
async function folderWithThree() {
  const h = await groupWithSession()
  h.agent.receive(new FakeConn(), { t: 'register', claudePid: 4343, cwd: PROJ })
  h.agent.receive(new FakeConn(), { t: 'register', claudePid: 4545, cwd: PROJ })
  await flush()
  return h
}

test('a plain message in a folder topic goes to the session that wrote last before it', async () => {
  const h = await folderWithThree()
  const a = sessionOf(h.router, 4242)
  const b = sessionOf(h.router, 4343)
  wrote(h.router, a, 50)
  wrote(h.router, b, 60)
  await h.chat.inbound(textFrom('next step?', { messageId: tgMsg(70), chat: topicChat(100) }))
  assert.deepEqual(h.agent.sent.map((x) => x.key), [b.key])
})

test('a session message posted after the user message does not take it (the race case)', async () => {
  const h = await folderWithThree()
  const a = sessionOf(h.router, 4242)
  const b = sessionOf(h.router, 4343)
  wrote(h.router, a, 50)
  wrote(h.router, b, 80) // written after the user's message (70), while it was being handled
  await h.chat.inbound(textFrom('next step?', { messageId: tgMsg(70), chat: topicChat(100) }))
  assert.deepEqual(h.agent.sent.map((x) => x.key), [a.key])
})

test('a swipe-reply in a folder topic goes to the session it replies to', async () => {
  const h = await folderWithThree()
  const a = sessionOf(h.router, 4242)
  const b = sessionOf(h.router, 4343)
  wrote(h.router, a, 50)
  wrote(h.router, b, 60)
  await h.chat.inbound(textFrom('and you?', { messageId: tgMsg(70), replyToId: tgMsg(50), chat: topicChat(100) }))
  assert.deepEqual(h.agent.sent.map((x) => x.key), [a.key])
})

test('when the last writer has ended, the message goes to the most recently active live session of the folder', async () => {
  const h = await folderWithThree()
  const a = sessionOf(h.router, 4242)
  const b = sessionOf(h.router, 4343)
  const c = sessionOf(h.router, 4545)
  wrote(h.router, b, 60)
  h.router.registry.remove(b.key)
  a.lastActive = 1000
  c.lastActive = 2000
  await h.chat.inbound(textFrom('still there?', { messageId: tgMsg(70), chat: topicChat(100) }))
  assert.deepEqual(h.agent.sent.map((x) => x.key), [c.key])
})

test('a folder topic with no live session says how to start one, in that topic', async () => {
  const h = await groupWithSession()
  for (const s of h.router.registry.list()) h.router.registry.remove(s.key)
  await h.chat.inbound(textFrom('hi', { chat: topicChat(100) }))
  const note = h.chat.sent.find((s) => s.text.startsWith('No live session in this folder'))
  assert.ok(note)
  assert.ok(note.text.includes('/new'))
  assert.equal(note.opts?.thread, tgThread(100))
  assert.deepEqual(h.agent.sent, [])
})

test('/new in a folder topic starts a session in the folder, with the text as its first message', async () => {
  const h = await groupWithSession()
  h.agent.trusted.add(PROJ)
  await h.chat.inbound(textFrom('/new hi there', { messageId: tgMsg(90), chat: topicChat(100) }))
  await flush()
  assert.equal(h.agent.startedSessions.length, 1)
  assert.equal(h.agent.startedSessions[0]?.dir, PROJ)
  assert.deepEqual(h.router.spawns.get(PROJ)?.items.map((i) => i.content), ['hi there'])
  assert.deepEqual(h.agent.sent, [], '/new is not delivered to a session')
})

test('/new alone in a folder topic starts an empty session', async () => {
  const h = await groupWithSession()
  h.agent.trusted.add(PROJ)
  await h.chat.inbound(textFrom('/new', { messageId: tgMsg(91), chat: topicChat(100) }))
  await flush()
  assert.equal(h.agent.startedSessions.length, 1)
  assert.deepEqual(h.router.spawns.get(PROJ)?.items.map((i) => i.content), [''])
})

test('after a bare /new, a plain message while the new session is still starting joins its queue, not the old session', async () => {
  const h = await groupWithSession()
  h.agent.trusted.add(PROJ)
  const old = sessionOf(h.router, 4242)
  wrote(h.router, old, 50)
  await h.chat.inbound(textFrom('/new', { messageId: tgMsg(60), chat: topicChat(100) }))
  await h.chat.inbound(textFrom('next step', { messageId: tgMsg(70), chat: topicChat(100) }))
  await flush()
  assert.deepEqual(h.agent.sent, [], 'the old session gets nothing')
  assert.deepEqual(h.router.spawns.get(PROJ)?.items.map((i) => i.content), ['', 'next step'])

  h.agent.receive(new FakeConn(), { t: 'register', claudePid: 5151, cwd: PROJ, spawnToken: h.agent.spawnTokens[0] })
  await flush()
  h.clock.advance(1000)
  await flush()
  const fresh = sessionOf(h.router, 5151)
  assert.deepEqual(h.agent.sent.map((x) => x.key), [fresh.key], 'delivered to the new session on connect')
  assert.equal(h.agent.sent[0]?.content, 'next step')
})

test('after a bare /new and its registration, the next plain message goes to the new session, then normal routing resumes', async () => {
  const h = await groupWithSession()
  h.agent.trusted.add(PROJ)
  const old = sessionOf(h.router, 4242)
  wrote(h.router, old, 50)
  await h.chat.inbound(textFrom('/new', { messageId: tgMsg(60), chat: topicChat(100) }))
  h.agent.receive(new FakeConn(), { t: 'register', claudePid: 5151, cwd: PROJ, spawnToken: h.agent.spawnTokens[0] })
  await flush()
  h.clock.advance(1000)
  await flush()
  const fresh = sessionOf(h.router, 5151)

  await h.chat.inbound(textFrom('first for new', { messageId: tgMsg(70), chat: topicChat(100) }))
  assert.deepEqual(h.agent.sent.map((x) => x.key), [fresh.key], 'the new session, not the old one')
  assert.equal(h.router.topicNext.has(tgThread(100)), false, 'the entry is used up')

  // The new session writes last; the old one writes after it. Normal routing: the last writer gets the next message.
  wrote(h.router, fresh, 75)
  wrote(h.router, old, 76)
  await h.chat.inbound(textFrom('second', { messageId: tgMsg(80), chat: topicChat(100) }))
  assert.deepEqual(h.agent.sent.map((x) => x.key), [fresh.key, old.key])
})

test('a plain message while the new start is still inside startSession (before spawnFor returns) joins the new queue', async () => {
  const h = await groupWithSession()
  h.agent.trusted.add(PROJ)
  const old = sessionOf(h.router, 4242)
  wrote(h.router, old, 50)
  // Hold the tmux start on a gate: spawnFor is then still awaiting startSession when the next message arrives.
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  const startSession = h.agent.startSession.bind(h.agent)
  h.agent.startSession = async (...args) => {
    await gate
    return startSession(...args)
  }
  const starting = h.chat.inbound(textFrom('/new', { messageId: tgMsg(60), chat: topicChat(100) }))
  await flush()
  assert.equal(h.agent.startedSessions.length, 0, 'the tmux start is still pending')
  assert.ok(h.router.spawns.get(PROJ), 'the queue exists before the start returns')

  await h.chat.inbound(textFrom('next step', { messageId: tgMsg(70), chat: topicChat(100) }))
  await flush()
  assert.deepEqual(h.agent.sent, [], 'the old session gets nothing')
  assert.deepEqual(h.router.spawns.get(PROJ)?.items.map((i) => i.content), ['', 'next step'])

  release()
  await starting
  await flush()
  h.agent.receive(new FakeConn(), { t: 'register', claudePid: 5151, cwd: PROJ, spawnToken: h.agent.spawnTokens[0] })
  await flush()
  h.clock.advance(1000)
  await flush()
  const fresh = sessionOf(h.router, 5151)
  assert.deepEqual(h.agent.sent.map((x) => x.key), [fresh.key], 'delivered to the new session on connect')
  assert.equal(h.agent.sent[0]?.content, 'next step')
})

test('a swipe-reply to an old-session message after a bare /new still goes to the old session', async () => {
  const h = await groupWithSession()
  h.agent.trusted.add(PROJ)
  const old = sessionOf(h.router, 4242)
  wrote(h.router, old, 50)
  await h.chat.inbound(textFrom('/new', { messageId: tgMsg(60), chat: topicChat(100) }))
  await h.chat.inbound(textFrom('and you?', { messageId: tgMsg(70), replyToId: tgMsg(50), chat: topicChat(100) }))
  await flush()
  assert.deepEqual(h.agent.sent.map((x) => x.key), [old.key])
  assert.deepEqual(h.router.spawns.get(PROJ)?.items.map((i) => i.content), [''], 'the swipe-reply did not join the new start')
  assert.ok(h.router.topicNext.has(tgThread(100)), 'the entry is kept for the next plain message')
})

test('/new with text leaves no entry: the next plain message routes normally', async () => {
  const h = await groupWithSession()
  h.agent.trusted.add(PROJ)
  const old = sessionOf(h.router, 4242)
  wrote(h.router, old, 50)
  await h.chat.inbound(textFrom('/new hi', { messageId: tgMsg(60), chat: topicChat(100) }))
  assert.equal(h.router.topicNext.has(tgThread(100)), false)
  await h.chat.inbound(textFrom('next', { messageId: tgMsg(70), chat: topicChat(100) }))
  await flush()
  assert.deepEqual(h.agent.sent.map((x) => x.key), [old.key], 'the session that wrote last gets it')
})

test('two sends into a gone folder topic make one new topic for the folder', async () => {
  const { chat, agent, conn } = await groupWithSession()
  chat.goneThreads.add(tgThread(100))
  agent.receive(conn, { t: 'reply', reqId: 'r1', text: 'one', kind: 'response' })
  agent.receive(conn, { t: 'reply', reqId: 'r2', text: 'two', kind: 'response' })
  await flush()
  assert.equal(chat.topicOps.filter((o) => o.op === 'create').length, 2, 'the original, then one replacement')
  assert.equal(chat.sent.filter((s) => s.text.endsWith('one') || s.text.endsWith('two')).length, 2, 'both sent, into the new topic')
})

test('at start, a folder topic keeps parent/basename while a legacy record still holds the basename: no rename', async () => {
  const h = harness({ groupId: tgChat(GROUP) })
  h.store.topicsJson = JSON.stringify([
    { threadId: 77, name: 'proga', project: 'proga', sessionKey: '1:x', backendSessionId: null, state: 'open', endedAt: null, deleteAt: null },
    { threadId: 50, name: 'projects/proga', project: 'proga', cwd: `${HOME}/projects/proga`, sessionKey: null, backendSessionId: null, state: 'open', endedAt: null, deleteAt: null },
  ])
  await h.router.start()
  await flush()
  // Legacy records are kept, so their name stays taken and the folder topic keeps its parent/basename.
  assert.deepEqual(h.chat.topicOps.filter((o) => o.op === 'edit'), [])
  assert.equal(h.router.topics.find((r) => r.threadId === tgThread(50))?.name, 'projects/proga')
})

test('no sweep deletes a topic: a legacy closed record stays, and the periodic sweep sends Telegram no topic call', async () => {
  const h = harness({ groupId: tgChat(GROUP) })
  h.store.topicsJson = JSON.stringify([
    { threadId: 60, name: 'old', project: 'old', cwd: null, sessionKey: null, backendSessionId: null, state: 'closed', endedAt: 1, deleteAt: 2 },
  ])
  await h.router.start()
  await flush()
  h.clock.advance(30 * DAY)
  h.clock.advance(SWEEP_MS)
  await flush()
  assert.equal(h.router.topics.find((r) => r.threadId === tgThread(60))?.state, 'closed')
  assert.deepEqual(h.chat.topicOps, [], 'no topic call at all')
})

test('at start, two folders with the same basename keep basename and parent/basename, with no rename', async () => {
  const h = harness({ groupId: tgChat(GROUP) })
  h.store.topicsJson = JSON.stringify([
    { threadId: 50, name: 'proj', project: 'proj', cwd: `${HOME}/proj`, sessionKey: null, backendSessionId: null, state: 'open', endedAt: null, deleteAt: null },
    { threadId: 51, name: 'work/proj', project: 'proj', cwd: `${HOME}/work/proj`, sessionKey: null, backendSessionId: null, state: 'open', endedAt: null, deleteAt: null },
  ])
  await h.router.start()
  await flush()
  assert.deepEqual(h.chat.topicOps.filter((o) => o.op === 'edit'), [])
  assert.deepEqual(h.router.topics.map((t) => t.name), ['proj', 'work/proj'])
})

// ---------- startWhenNoSession in a folder topic ----------

const NO_LIVE = 'No live session in this folder. Send /new to start one (/new <text> to start it with a message).'

test('a topic with no live session: a message starts a session in the topic folder, quota permitting, with the message as first prompt', async () => {
  const h = await groupWithSession(4242, { quotaRefusal: async () => null })
  h.agent.trusted.add(PROJ)
  for (const s of h.router.registry.list()) h.router.registry.remove(s.key)
  await h.chat.inbound(textFrom('start the parser plan', { chat: topicChat(100) }))
  await flush()
  assert.deepEqual(h.agent.startedSessions, [{ project: 'proj', dir: PROJ, extra: [] }])
  assert.deepEqual(h.router.spawns.get(PROJ)?.items.map((i) => i.content), ['start the parser plan'])
  assert.equal(h.chat.sent.filter((s) => s.text.startsWith('No live session')).length, 0, 'no note')
  assert.equal(h.audit.events.filter((e) => e.event === 'topic_start').length, 1)
})

test('a topic with no live session and the quota refused: the note says why, and nothing starts', async () => {
  const h = await groupWithSession(4242, { quotaRefusal: async () => 'weekly quota at 99%' })
  for (const s of h.router.registry.list()) h.router.registry.remove(s.key)
  await h.chat.inbound(textFrom('start the parser plan', { chat: topicChat(100) }))
  assert.deepEqual(h.agent.startedSessions, [])
  const note = h.chat.sent.find((s) => s.text === `${NO_LIVE} (not started by itself: weekly quota at 99%)`)
  assert.ok(note, 'the note with the reason')
  assert.equal(note.opts?.thread, tgThread(100))
})

// The session a topic starts with the message: its first prompt, once the new session has connected.
async function startedPrompt(h: Awaited<ReturnType<typeof groupWithSession>>): Promise<string | undefined> {
  h.agent.receive(new FakeConn(), { t: 'register', claudePid: 5151, cwd: PROJ, spawnToken: h.agent.spawnTokens[0] })
  h.clock.advance(1000)
  await flush()
  return h.agent.sent.at(-1)?.content
}

test('a topic with no live session: a reply starts a session whose first prompt quotes the replied-to text', async () => {
  const h = await groupWithSession(4242, { quotaRefusal: async () => null })
  h.agent.trusted.add(PROJ)
  for (const s of h.router.registry.list()) h.router.registry.remove(s.key)
  await h.chat.inbound(textFrom('start the parser plan', { chat: topicChat(100), replyToId: tgMsg(5), replyToText: 'Use zod here' }))
  await flush()
  assert.deepEqual(h.agent.startedSessions, [{ project: 'proj', dir: PROJ, extra: [] }])
  assert.equal(
    await startedPrompt(h),
    'The user is replying to this earlier message:\n"""\nUse zod here\n"""\n\nstart the parser plan',
  )
})

test('a topic with no live session: a plain message starts a session with no quote', async () => {
  const h = await groupWithSession(4242, { quotaRefusal: async () => null })
  h.agent.trusted.add(PROJ)
  for (const s of h.router.registry.list()) h.router.registry.remove(s.key)
  await h.chat.inbound(textFrom('start the parser plan', { chat: topicChat(100) }))
  await flush()
  assert.deepEqual(h.agent.startedSessions, [{ project: 'proj', dir: PROJ, extra: [] }])
  assert.equal(await startedPrompt(h), 'start the parser plan')
})

test('a topic with no live session: a reply to a message with no text (media) starts without a quote', async () => {
  const h = await groupWithSession(4242, { quotaRefusal: async () => null })
  h.agent.trusted.add(PROJ)
  for (const s of h.router.registry.list()) h.router.registry.remove(s.key)
  await h.chat.inbound(textFrom('start the parser plan', { chat: topicChat(100), replyToId: tgMsg(5), replyToText: null }))
  await flush()
  assert.deepEqual(h.agent.startedSessions, [{ project: 'proj', dir: PROJ, extra: [] }])
  assert.equal(await startedPrompt(h), 'start the parser plan')
})

test('a topic with no live session and startWhenNoSession off: the note only, as before', async () => {
  const h = await groupWithSession(4242, { startWhenNoSession: false, quotaRefusal: async () => null })
  for (const s of h.router.registry.list()) h.router.registry.remove(s.key)
  await h.chat.inbound(textFrom('start the parser plan', { chat: topicChat(100) }))
  assert.deepEqual(h.agent.startedSessions, [])
  assert.ok(h.chat.sent.some((s) => s.text === NO_LIVE))
})
