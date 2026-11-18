// Router behaviour through fake ports, in group mode:
// - a plain General message is not taken as the answer to a pending AskUserQuestion; a reply or a message in the ask's
//   topic is (inbound.ts + ask.ts);
// - a stale inTurn (an interrupted turn) no longer marks the next message as queued (deliver.ts);
// - at start the stale pending markers are removed; at a clean stop every open approval prompt is edited (restart.ts).
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { BRIDGE_RESTART_TEXT } from '../src/brain/approvals.ts'
import { IN_TURN_IDLE_MS } from '../src/router/state.ts'
import { markerPath, pendingDir, setPendingMarker } from '../src/adapters/hooks/pending-marker.ts'
import { FakeConn, HOME, flush, harness, textFrom } from './helpers/fakes.ts'
import { tgChat, tgMsg, tgThread } from '../src/adapters/chat/tg-ids.ts'

const PROJ = `${HOME}/proj`
const GROUP = -1001234567890
const GROUP_ID = tgChat(GROUP)
const GROUP_CHAT = { kind: 'home' as const, id: GROUP_ID, thread: null }
const topicChat = (threadId: number) => ({ kind: 'home' as const, id: GROUP_ID, thread: tgThread(threadId) })
const PID = 4242
const THREAD = 100

// The marker folder is the module's own (next to the router socket, inside the isolated test runtime folder). Each test
// that uses it starts from an empty folder.
function markerDir(): string {
  rmSync(pendingDir(), { recursive: true, force: true })
  return pendingDir()
}

// A group-mode router with one channel session in PROJ (pid 4242), its topic created (thread 100).
async function groupWithSession(groupId: string | null = GROUP_ID) {
  const h = harness({ groupId })
  await h.router.start()
  h.platform.dirs.add(PROJ)
  const conn = new FakeConn()
  h.agent.receive(conn, { t: 'register', claudePid: PID, cwd: PROJ })
  await flush()
  return { ...h, conn }
}

const QUESTION = {
  tool_name: 'AskUserQuestion',
  tool_input: {
    questions: [{ question: 'Which db?', header: 'Database', multiSelect: false, options: [{ label: 'Postgres' }, { label: 'SQLite' }] }],
  },
}

// FakeAgent.respondToAsk only ends the hook connection, so an answer shows as an ended connection.
const answered = (conn: FakeConn) => conn.ended

test('group mode: a plain General message does not answer the pending question; it routes as any General message', async () => {
  const { chat, platform, agent, conn, router } = await groupWithSession()
  platform.away = true
  agent.receive(conn, { t: 'ask', claudePid: PID, cwd: PROJ, ...QUESTION })
  await flush()
  assert.equal(router.asks.size, 1)
  const before = chat.sent.length

  await chat.inbound(textFrom('Postgres', { chat: GROUP_CHAT, messageId: tgMsg(50) }))
  await flush()

  assert.equal(router.asks.size, 1, 'the question is still pending')
  assert.equal(answered(conn), false, 'no answer went to the session')
  assert.ok(chat.sent.length > before, 'the message got a reply (the General routing buttons)')
})

test('group mode: a reply to the question answers it, from General', async () => {
  const { chat, platform, agent, conn, router } = await groupWithSession()
  platform.away = true
  agent.receive(conn, { t: 'ask', claudePid: PID, cwd: PROJ, ...QUESTION })
  await flush()
  const q = chat.sent.find((s) => s.text.includes('Which db?'))
  assert.ok(q)

  await chat.inbound(textFrom('SQLite', { chat: GROUP_CHAT, messageId: tgMsg(51), replyToId: q.id }))
  await flush()

  assert.equal(router.asks.size, 0)
  assert.equal(answered(conn), true)
})

test('group mode: a message in the question\'s session topic answers it', async () => {
  const { chat, platform, agent, conn, router } = await groupWithSession()
  platform.away = true
  agent.receive(conn, { t: 'ask', claudePid: PID, cwd: PROJ, ...QUESTION })
  await flush()

  await chat.inbound(textFrom('Postgres', { chat: topicChat(THREAD), messageId: tgMsg(52) }))
  await flush()

  assert.equal(router.asks.size, 0)
  assert.equal(answered(conn), true)
})

test('group mode: a message in another topic does not answer the question', async () => {
  const { chat, platform, agent, conn, router } = await groupWithSession()
  platform.away = true
  agent.receive(conn, { t: 'ask', claudePid: PID, cwd: PROJ, ...QUESTION })
  await flush()

  await chat.inbound(textFrom('Postgres', { chat: topicChat(999), messageId: tgMsg(53) }))
  await flush()

  assert.equal(router.asks.size, 1)
  assert.equal(answered(conn), false)
})

test('inTurn: after an interrupted turn (idle_prompt, or 15 quiet minutes), a message is not marked as queued', async () => {
  const h = await groupWithSession()
  const { chat, agent, conn, clock } = h
  // Interrupted turn: the prompt starts a turn and no Stop follows; idle_prompt ends it.
  agent.receive(conn, { t: 'hook', event: 'UserPromptSubmit', claudePid: PID, cwd: PROJ, payload: {} })
  await flush()
  agent.receive(conn, { t: 'hook', event: 'Notification', claudePid: PID, cwd: PROJ, payload: { notification_type: 'idle_prompt', message: 'Waiting' } })
  await flush()
  await chat.inbound(textFrom('next', { chat: topicChat(THREAD), messageId: tgMsg(60) }))
  await flush()
  assert.deepEqual(chat.reactions.find((r) => r.messageId === tgMsg(60)), { messageId: tgMsg(60), emoji: '👀' })

  // A second turn with no Stop and no activity: after 15 minutes it is no longer busy.
  agent.receive(conn, { t: 'hook', event: 'UserPromptSubmit', claudePid: PID, cwd: PROJ, payload: {} })
  await flush()
  await chat.inbound(textFrom('still busy?', { chat: topicChat(THREAD), messageId: tgMsg(61) }))
  await flush()
  assert.deepEqual(chat.reactions.find((r) => r.messageId === tgMsg(61)), { messageId: tgMsg(61), emoji: '✍' }) // the 'queued' kind (✍): ⏳ is not a Telegram reaction
  clock.advance(IN_TURN_IDLE_MS)
  await chat.inbound(textFrom('later', { chat: topicChat(THREAD), messageId: tgMsg(62) }))
  await flush()
  assert.deepEqual(chat.reactions.find((r) => r.messageId === tgMsg(62)), { messageId: tgMsg(62), emoji: '👀' })
})

test('restart: markers left by an earlier router are removed when this one starts', async () => {
  const dir = markerDir()
  setPendingMarker(111, dir)
  setPendingMarker(222, dir)
  assert.equal(readdirSync(dir).length, 2)
  const h = harness({ groupId: tgChat(GROUP) })
  await h.router.start()
  assert.deepEqual(readdirSync(dir), [])
  assert.equal(existsSync(markerPath(111, dir)), false)
})

test('restart: a clean stop edits every open permission prompt and ask to the restart note, without buttons', async () => {
  const dir = markerDir()
  const { chat, platform, agent, conn, router } = await groupWithSession()
  platform.away = true
  agent.receive(conn, { t: 'permission_request', request_id: 'abcde', tool_name: 'Bash', description: 'run', input_preview: '{"command":"ls"}' })
  agent.receive(conn, { t: 'ask', claudePid: PID, cwd: PROJ, ...QUESTION })
  await flush()
  assert.equal(existsSync(markerPath(PID, dir)), true)
  const permPrompt = chat.sent.find((s) => s.opts?.perm?.requestId === 'abcde')
  const askPrompt = chat.sent.find((s) => s.text.includes('Which db?'))
  assert.ok(permPrompt && askPrompt)

  await router.stop()

  const permEdit = chat.edits.find((e) => e.messageId === permPrompt.id)
  assert.ok(permEdit, 'the permission prompt is edited')
  assert.ok(permEdit.text.endsWith(BRIDGE_RESTART_TEXT))
  assert.equal(chat.edits.some((e) => e.messageId === askPrompt.id && e.text.endsWith(BRIDGE_RESTART_TEXT)), true, 'the question is edited')
  const askRowEdit = chat.rowEdits.find((e) => e.messageId === askPrompt.id && e.text.endsWith(BRIDGE_RESTART_TEXT))
  assert.deepEqual(askRowEdit?.rows, [], 'the question loses its buttons')
  assert.equal(existsSync(markerPath(PID, dir)), false, 'its marker is removed')
  assert.equal(router.pending.size, 0)
  assert.equal(router.asks.size, 0)
})

test('restart: a stop with no open prompt edits nothing', async () => {
  markerDir()
  const { chat, router } = await groupWithSession()
  const before = chat.edits.length
  await router.stop()
  assert.equal(chat.edits.length, before)
})
