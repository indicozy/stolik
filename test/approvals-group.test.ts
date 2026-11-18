// Approvals in topics (plan 2.14), in group mode through the router with fake ports and a fake clock: tool permissions,
// AskUserQuestion and plan approvals. Each goes to the session's topic, verdicts are owner-only, the reminder comes at
// half the TTL, expiry adds the expired note and releases to the terminal, and PostToolUse clears a prompt answered at the desk.
import './helpers/isolate.ts'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ANSWERED_AT_DESK_TEXT, callKey } from '../src/brain/posttool.ts'
import { ASK_TTL_MS, PLAN_FOOTER } from '../src/router/ask.ts'
import { APPROVAL_EXPIRED_TEXT, PERMISSION_TTL_MS } from '../src/router/state.ts'
import { markerPath, pendingDir } from '../src/adapters/hooks/pending-marker.ts'
import { tgChat, tgMsg, tgThread } from '../src/adapters/chat/tg-ids.ts'
import { FakeConn, HOME, OWNER, flush, harness, textFrom } from './helpers/fakes.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJ = `${HOME}/proj`
const GROUP = -1001234567890
const GROUP_ID = tgChat(GROUP)
const topicChat = (threadId: number) => ({ kind: "home" as const, id: GROUP_ID, thread: tgThread(threadId) })
const MIN = 60_000
const PID = 4242
const THREAD = 100

// Each test that relays a prompt starts with an empty marker folder: the one beside the router socket (isolated by
// test/helpers/isolate.ts). The folder is emptied first, so a marker left by an earlier test cannot count.
let runtimeRoot: string | null = null
let savedXdg: string | undefined
function useRuntimeDir(): string {
  runtimeRoot = mkdtempSync(join(HERE, '.tmp-approvals-'))
  savedXdg = process.env.XDG_RUNTIME_DIR
  rmSync(pendingDir(), { recursive: true, force: true })
  return pendingDir()
}
// The key fields a PostToolUse hook sends for a tool input (see src/adapters/hooks/hook.ts).
const keyFields = (input: unknown) => {
  const k = callKey(input)
  return { input_hash: k.hash, input_head: k.head }
}
afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR
  else process.env.XDG_RUNTIME_DIR = savedXdg
  savedXdg = undefined
  if (runtimeRoot) rmSync(runtimeRoot, { recursive: true, force: true })
  runtimeRoot = null
})

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

const sentBy = (chat: { sent: Array<{ id: string; text: string; opts?: any; chat: string }> }, pred: (s: any) => boolean) =>
  chat.sent.filter(pred)

// ---------- tool permissions ----------

test('permission: the prompt goes to the session topic, and its marker file is written while it waits', async () => {
  const dir = useRuntimeDir()
  const { chat, platform, agent, conn } = await groupWithSession()
  platform.away = true
  agent.receive(conn, { t: 'permission_request', request_id: 'abcde', tool_name: 'Bash', description: 'run', input_preview: '{"command":"ls"}' })
  await flush()
  const prompt = chat.sent.find((s) => s.opts?.perm?.requestId === 'abcde')
  assert.ok(prompt)
  assert.equal(prompt.opts?.thread, tgThread(THREAD))
  assert.equal(prompt.chat, 'group')
  assert.equal(existsSync(markerPath(PID, dir)), true)
})

test('permission: one reminder as a reply in the topic at 15 minutes, none before, none after', async () => {
  useRuntimeDir()
  const { chat, platform, agent, conn, clock } = await groupWithSession()
  platform.away = true
  agent.receive(conn, { t: 'permission_request', request_id: 'abcde', tool_name: 'Bash', description: 'run', input_preview: '{"command":"ls"}' })
  await flush()
  const prompt = chat.sent.find((s) => s.opts?.perm?.requestId === 'abcde')
  assert.ok(prompt)
  const reminders = () => chat.sent.filter((s) => s.text.startsWith('⏰ Still waiting'))

  clock.advance(PERMISSION_TTL_MS / 2 - MIN)
  await flush()
  assert.equal(reminders().length, 0, 'not yet at 14 minutes')

  clock.advance(2 * MIN)
  await flush()
  assert.equal(reminders().length, 1, 'once at 15 minutes')
  assert.equal(reminders()[0].opts?.replyTo, prompt.id)
  assert.equal(reminders()[0].opts?.thread, tgThread(THREAD))
  assert.equal(reminders()[0].chat, 'group')

  clock.advance(10 * MIN)
  await flush()
  assert.equal(reminders().length, 1, 'never again')
})

test('permission: at expiry the prompt says so and the pending entry and its marker go; no deny is sent', async () => {
  const dir = useRuntimeDir()
  const { chat, platform, agent, conn, clock } = await groupWithSession()
  platform.away = true
  agent.receive(conn, { t: 'permission_request', request_id: 'abcde', tool_name: 'Bash', description: 'run', input_preview: '{"command":"ls"}' })
  await flush()
  const prompt = chat.sent.find((s) => s.opts?.perm?.requestId === 'abcde')
  assert.ok(prompt)

  clock.advance(PERMISSION_TTL_MS + MIN)
  await flush()
  const edit = chat.edits.find((e) => e.messageId === prompt.id)
  assert.ok(edit, 'the prompt is edited')
  assert.match(edit.text, new RegExp(APPROVAL_EXPIRED_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.equal(agent.permissions.length, 0, 'released to the terminal: no verdict sent')
  assert.equal(existsSync(markerPath(PID, dir)), false)
})

test('permission: a verdict from a button or a text reply of anyone but the owner is refused', async () => {
  useRuntimeDir()
  const { chat, platform, agent, conn } = await groupWithSession()
  platform.away = true
  agent.receive(conn, { t: 'permission_request', request_id: 'abcde', tool_name: 'Bash', description: 'run', input_preview: '{"command":"ls"}' })
  await flush()
  await chat.callback({ pressId: 'cbX', data: 'perm:allow:abcde', message: tgMsg(1), from: '999', chat: topicChat(THREAD) })
  await chat.inbound(textFrom('yes abcde', { chat: topicChat(THREAD), fromId: '999', from: 'stranger' }))
  assert.deepEqual(chat.answers, [{ id: 'cbX', text: 'Not allowed' }])
  assert.equal(agent.permissions.length, 0)
})

test('permission: the owner\'s text verdict in the topic is applied, and the marker goes', async () => {
  const dir = useRuntimeDir()
  const { chat, platform, agent, conn } = await groupWithSession()
  platform.away = true
  agent.receive(conn, { t: 'permission_request', request_id: 'abcde', tool_name: 'Bash', description: 'run', input_preview: '{"command":"ls"}' })
  await flush()
  await chat.inbound(textFrom('yes abcde', { chat: topicChat(THREAD) }))
  await flush()
  assert.deepEqual(agent.permissions, [{ key: agent.permissions[0].key, requestId: 'abcde', behavior: 'allow' }])
  assert.equal(existsSync(markerPath(PID, dir)), false)
})

test('permission: a PostToolUse for the same call (answered "Yes" at the desk) clears the buttons and says so', async () => {
  const dir = useRuntimeDir()
  const { chat, platform, agent, conn } = await groupWithSession()
  platform.away = true
  agent.receive(conn, { t: 'permission_request', request_id: 'abcde', tool_name: 'Bash', description: 'run', input_preview: '{"command":"ls"}' })
  await flush()
  const prompt = chat.sent.find((s) => s.opts?.perm?.requestId === 'abcde')
  assert.ok(prompt)

  agent.receive(new FakeConn(), { t: 'hook', event: 'PostToolUse', claudePid: PID, cwd: PROJ, payload: { session_id: 's1', tool_name: 'Bash', ...keyFields({ command: 'ls' }) } })
  await flush()
  const edit = chat.edits.find((e) => e.messageId === prompt.id)
  assert.ok(edit)
  assert.match(edit.text, new RegExp(ANSWERED_AT_DESK_TEXT))
  assert.equal(existsSync(markerPath(PID, dir)), false)

  // Once cleared, the same event again does nothing, and the sweep finds nothing to expire for it.
  const before = chat.edits.length
  agent.receive(new FakeConn(), { t: 'hook', event: 'PostToolUse', claudePid: PID, cwd: PROJ, payload: { session_id: 's1', tool_name: 'Bash', ...keyFields({ command: 'ls' }) } })
  await flush()
  assert.equal(chat.edits.length, before)
})

test('permission: a PostToolUse for another call leaves the prompt alone', async () => {
  useRuntimeDir()
  const { chat, platform, agent, conn } = await groupWithSession()
  platform.away = true
  agent.receive(conn, { t: 'permission_request', request_id: 'abcde', tool_name: 'Bash', description: 'run', input_preview: '{"command":"ls"}' })
  await flush()
  agent.receive(new FakeConn(), { t: 'hook', event: 'PostToolUse', claudePid: PID, cwd: PROJ, payload: { session_id: 's1', tool_name: 'Bash', ...keyFields({ command: 'rm -rf /tmp/x' }) } })
  await flush()
  assert.equal(chat.edits.length, 0)
})

// ---------- AskUserQuestion ----------

const QUESTION = {
  tool_name: 'AskUserQuestion',
  tool_input: {
    questions: [{ question: 'Which db?', header: 'Database', multiSelect: false, options: [{ label: 'Postgres' }, { label: 'SQLite' }] }],
  },
}

test('AskUserQuestion: the question goes to the session topic, with its buttons', async () => {
  const { chat, platform, agent, conn } = await groupWithSession()
  platform.away = true
  agent.receive(conn, { t: 'ask', claudePid: PID, cwd: PROJ, ...QUESTION })
  await flush()
  const q = chat.sent.find((s) => s.text.includes('Which db?'))
  assert.ok(q, 'the question is sent')
  assert.equal(q.opts?.thread, tgThread(THREAD))
  assert.equal(q.chat, 'group')
  assert.ok(q.opts?.rows?.length, 'with buttons')
})

test('AskUserQuestion: the reminder comes at half of its TTL, in the topic, once', async () => {
  const { chat, platform, agent, conn, clock } = await groupWithSession()
  platform.away = true
  agent.receive(conn, { t: 'ask', claudePid: PID, cwd: PROJ, ...QUESTION })
  await flush()
  const q = chat.sent.find((s) => s.text.includes('Which db?'))
  assert.ok(q)
  const reminders = () => chat.sent.filter((s) => s.text.startsWith('⏰ Still waiting'))

  clock.advance(ASK_TTL_MS / 2 - MIN)
  await flush()
  assert.equal(reminders().length, 0)
  clock.advance(2 * MIN)
  await flush()
  assert.equal(reminders().length, 1)
  assert.equal(reminders()[0].opts?.replyTo, q.id)
  assert.equal(reminders()[0].opts?.thread, tgThread(THREAD))
  clock.advance(10 * MIN)
  await flush()
  assert.equal(reminders().length, 1)
})

test('AskUserQuestion: at expiry the question gets the expired note and the terminal takes over (no answer sent)', async () => {
  const { chat, platform, agent, conn, clock } = await groupWithSession()
  platform.away = true
  agent.receive(conn, { t: 'ask', claudePid: PID, cwd: PROJ, ...QUESTION })
  await flush()
  const q = chat.sent.find((s) => s.text.includes('Which db?'))
  assert.ok(q)

  clock.advance(ASK_TTL_MS + MIN)
  await flush()
  const edit = chat.edits.find((e) => e.messageId === q.id)
  assert.ok(edit)
  assert.ok(edit.text.endsWith(APPROVAL_EXPIRED_TEXT))
  assert.equal(conn.ended, true, 'the hook connection is ended, so the terminal dialog shows')
  assert.equal(agent.permissions.length, 0)
})

test('AskUserQuestion: a button from anyone but the owner is refused, and the question stays open', async () => {
  const { chat, platform, agent, conn } = await groupWithSession()
  platform.away = true
  agent.receive(conn, { t: 'ask', claudePid: PID, cwd: PROJ, ...QUESTION })
  await flush()
  const q = chat.sent.find((s) => s.text.includes('Which db?'))
  assert.ok(q)
  const data = String(q.opts?.rows?.[0]?.[0]?.data)
  await chat.callback({ pressId: 'cbQ', data, message: q.id, from: '999', chat: topicChat(THREAD) })
  assert.deepEqual(chat.answers, [{ id: 'cbQ', text: 'Not allowed' }])
  assert.equal(conn.ended, false)
})

// ---------- plan approvals ----------

test('plan approval (ExitPlanMode): the plan goes to the session topic, the last part with Approve / Reject', async () => {
  const { chat, platform, agent, conn } = await groupWithSession()
  platform.away = true
  agent.receive(conn, { t: 'ask', claudePid: PID, cwd: PROJ, tool_name: 'ExitPlanMode', tool_input: { plan: '# Plan\n- step one' } })
  await flush()
  const plan = chat.sent.find((s) => s.text.includes('step one'))
  assert.ok(plan, 'the plan is sent')
  assert.equal(plan.opts?.thread, tgThread(THREAD))
  assert.equal(plan.chat, 'group')
  assert.ok(plan.text.includes(PLAN_FOOTER))
  assert.ok(plan.opts?.rows?.length, 'the last part has the buttons')
})

test('plan approval: the reminder at half of the TTL, and the expired note at expiry, in the topic', async () => {
  const { chat, platform, agent, conn, clock } = await groupWithSession()
  platform.away = true
  agent.receive(conn, { t: 'ask', claudePid: PID, cwd: PROJ, tool_name: 'ExitPlanMode', tool_input: { plan: '# Plan\n- step one' } })
  await flush()
  const plan = chat.sent.find((s) => s.text.includes('step one'))
  assert.ok(plan)

  clock.advance(ASK_TTL_MS / 2 + MIN)
  await flush()
  const reminder = chat.sent.find((s) => s.text.startsWith('⏰ Still waiting'))
  assert.ok(reminder, 'reminder sent')
  assert.equal(reminder.opts?.thread, tgThread(THREAD))
  assert.equal(reminder.opts?.replyTo, plan.id)

  clock.advance(ASK_TTL_MS)
  await flush()
  const edit = chat.edits.find((e) => e.messageId === plan.id)
  assert.ok(edit && edit.text.endsWith(APPROVAL_EXPIRED_TEXT))
  assert.equal(conn.ended, true)
})

test('plan approval: a button from anyone but the owner is refused', async () => {
  const { chat, platform, agent, conn } = await groupWithSession()
  platform.away = true
  agent.receive(conn, { t: 'ask', claudePid: PID, cwd: PROJ, tool_name: 'ExitPlanMode', tool_input: { plan: '# Plan\n- step one' } })
  await flush()
  const plan = chat.sent.find((s) => s.text.includes('step one'))
  assert.ok(plan)
  const data = String(plan.opts?.rows?.[0]?.[0]?.data)
  await chat.callback({ pressId: 'cbP', data, message: plan.id, from: '999', chat: topicChat(THREAD) })
  assert.deepEqual(chat.answers, [{ id: 'cbP', text: 'Not allowed' }])
  assert.equal(conn.ended, false)
})

// ---------- away-only relay ----------

test('at the desk, no prompt is relayed: the terminal shows it', async () => {
  const { chat, platform, agent, conn } = await groupWithSession()
  platform.away = false
  agent.receive(conn, { t: 'permission_request', request_id: 'abcde', tool_name: 'Bash', description: 'run', input_preview: 'ls' })
  agent.receive(new FakeConn(), { t: 'ask', claudePid: PID, cwd: PROJ, ...QUESTION })
  await flush()
  assert.equal(chat.sent.filter((s) => s.opts?.perm || s.text.includes('Which db?')).length, 0)
})
