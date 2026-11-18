// Router side of the tri-state away answer: unknown idle time releases asks to the terminal, still relays permission
// prompts with a note, and the one-shot idle alert goes out once. Every permission prompt of any tool is forwarded
// through the PermissionRequest hook while away (Allow / Deny). Fake ports only.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkIdleSource, sweep } from '../src/router/handlers/timers.ts'
import { FakeConn, HOME, OWNER, flush, harness, textFrom } from './helpers/fakes.ts'
import { UNKNOWN_AWAY_NOTE } from '../src/brain/away.ts'
import { PERM_DENY_MESSAGE, denyFeedbackMessage } from '../src/router/ask.ts'
import { ASK_TTL_MS } from '../src/router/ask.ts'
import { RECENT_PERM_TTL_MS } from '../src/router/approvals.ts'
import { callKey } from '../src/brain/posttool.ts'

const PROJ = `${HOME}/proj`
const ASK = {
  t: 'ask', claudePid: 4242, cwd: PROJ, tool_name: 'AskUserQuestion',
  tool_input: { questions: [{ question: 'Which db?', header: '', multiSelect: false, options: [{ label: 'SQLite' }] }] },
}

async function started() {
  const h = harness()
  await h.router.start()
  h.platform.dirs.add(PROJ)
  const conn = new FakeConn()
  h.agent.receive(conn, { t: 'register', claudePid: 4242, cwd: PROJ })
  await flush()
  return { ...h, conn }
}

test('an AskUserQuestion is not captured while the idle state is unknown (released to the terminal)', async () => {
  const { router, chat, platform, agent, conn } = await started()
  platform.stateOverride = 'unknown'
  agent.receive(conn, ASK)
  await flush()
  assert.equal(router.asks.size, 0)
  assert.equal(chat.sent.length, 0)
})

test('an AskUserQuestion is captured when the state is idle (away)', async () => {
  const { router, platform, agent, conn } = await started()
  platform.stateOverride = 'idle'
  agent.receive(conn, ASK)
  await flush()
  assert.equal(router.asks.size, 1)
})

test('a permission prompt is still relayed while unknown, marked as unknown-away', async () => {
  const { chat, platform, agent, conn } = await started()
  platform.stateOverride = 'unknown'
  agent.receive(conn, { t: 'permission_request', request_id: 'abcde', tool_name: 'Bash', description: 'run', input_preview: 'ls' })
  await flush()
  const prompt = chat.sent.find((s) => s.opts?.perm?.requestId === 'abcde')
  assert.ok(prompt, 'the prompt is sent')
  assert.ok(prompt.text.includes(UNKNOWN_AWAY_NOTE), 'the prompt says the away status is unknown')
})

test('a permission prompt at the desk (active) is not relayed and has no note', async () => {
  const { chat, platform, agent, conn } = await started()
  platform.stateOverride = 'active'
  agent.receive(conn, { t: 'permission_request', request_id: 'abcde', tool_name: 'Bash', description: 'run', input_preview: 'ls' })
  await flush()
  assert.equal(chat.sent.filter((s) => s.opts?.perm).length, 0)
})

test('the idle alert is posted in General once: the down alert, then the up alert on recovery', async () => {
  const { router, chat, platform } = await started()
  platform.idleAlerts.push('down')
  await checkIdleSource(router)
  const downs = chat.sent.filter((s) => /unreadable for 5 minutes/.test(s.text))
  assert.equal(downs.length, 1)
  assert.equal(downs[0]?.chat, 'dm', 'harness without a group sends to the owner chat, which is General in DM mode')

  await checkIdleSource(router)
  assert.equal(chat.sent.filter((s) => /unreadable for 5 minutes/.test(s.text)).length, 1, 'not repeated')

  platform.idleAlerts.push('up')
  await checkIdleSource(router)
  assert.equal(chat.sent.filter((s) => /readable again/.test(s.text)).length, 1, 'recovery is announced')
})

// ---------- permission prompts of any tool (PermissionRequest hook) ----------

// A session without the channel (pid 5151 never registered): only the hook path can reach Telegram for it.
const BASH = {
  t: 'ask', claudePid: 5151, cwd: PROJ, tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run tests' },
}

async function awayWithBash() {
  const h = await started()
  h.platform.stateOverride = 'idle'
  const conn = new FakeConn()
  h.agent.receive(conn, BASH)
  await flush()
  const prompt = h.chat.sent.find((s) => s.text.includes('wants to run Bash'))
  assert.ok(prompt, 'the prompt is sent')
  return { ...h, conn, prompt }
}

test('a Bash prompt of a session with the channel attached is left to the channel relay (no second message)', async () => {
  const { router, chat, platform, agent, conn } = await started()
  platform.stateOverride = 'idle'
  const hookConn = new FakeConn()
  agent.receive(hookConn, { ...BASH, claudePid: 4242 })
  await flush()
  assert.equal(router.asks.size, 0)
  assert.equal(chat.sent.filter((s) => s.text.includes('wants to run Bash')).length, 0)
  assert.deepEqual(agent.askDecisions, [{ conn: hookConn, decision: null }])
  void conn
})

test('a Bash permission prompt is forwarded while away: the detail, Allow / Deny, and an audit event with the tool name', async () => {
  const { router, audit, prompt } = await awayWithBash()
  assert.equal(prompt.text, '🔐 [proj#2] wants to run Bash\n\nRun tests\nnpm test')
  const askId = String(prompt.opts?.rows?.[0]?.[0]?.data).split(':')[1]
  assert.deepEqual(prompt.opts?.rows, [[
    { text: '✅ Allow', data: `apm:${askId}:y` },
    { text: '❌ Deny', data: `apm:${askId}:n` },
  ]])
  assert.equal(router.asks.size, 1)
  assert.ok(audit.events.some((e) => e.event === 'ask' && e.tool === 'Bash'))
})

test('Allow sends an allow decision with the input unchanged; the prompt says so', async () => {
  const { router, chat, agent, conn, prompt } = await awayWithBash()
  await chat.callback({ pressId: 'cbA', data: String(prompt.opts?.rows?.[0]?.[0]?.data), message: prompt.id, from: OWNER })
  assert.deepEqual(agent.askDecisions, [{ conn, decision: { behavior: 'allow', updatedInput: { command: 'npm test', description: 'Run tests' } } }])
  assert.equal(router.asks.size, 0)
  assert.ok(chat.edits.find((e) => e.messageId === prompt.id)?.text.endsWith('✅ Allowed'))
})

test('Deny sends a deny decision with the fixed message', async () => {
  const { router, chat, agent, conn, prompt } = await awayWithBash()
  await chat.callback({ pressId: 'cbD', data: String(prompt.opts?.rows?.[0]?.[1]?.data), message: prompt.id, from: OWNER })
  assert.deepEqual(agent.askDecisions, [{ conn, decision: { behavior: 'deny', message: PERM_DENY_MESSAGE } }])
  assert.equal(router.asks.size, 0)
})

test('a text reply to the permission prompt denies it, with the reply as feedback', async () => {
  const { router, chat, agent, conn, prompt } = await awayWithBash()
  await chat.inbound(textFrom('use rg instead', { replyToId: prompt.id }))
  await flush()
  assert.deepEqual(agent.askDecisions, [{ conn, decision: { behavior: 'deny', message: denyFeedbackMessage('use rg instead') } }])
  assert.equal(router.asks.size, 0)
})

test('a plan button on a permission prompt is refused (the tap is answered as expired, nothing is decided)', async () => {
  const { router, chat, agent, prompt } = await awayWithBash()
  const id = String(prompt.opts?.rows?.[0]?.[0]?.data).split(':')[1]
  await chat.callback({ pressId: 'cbX', data: `ap:${id}:y`, message: prompt.id, from: OWNER })
  assert.deepEqual(chat.answers, [{ id: 'cbX', text: 'Expired or already answered.' }])
  assert.equal(agent.askDecisions.length, 0)
  assert.equal(router.asks.size, 1)
})

test('a permission prompt is not forwarded while the idle state is unknown (released to the terminal)', async () => {
  const { router, chat, platform, agent, conn } = await started()
  platform.stateOverride = 'unknown'
  agent.receive(conn, BASH)
  await flush()
  assert.equal(router.asks.size, 0)
  assert.equal(chat.sent.filter((s) => s.text.includes('wants to run')).length, 0)
  assert.equal(agent.askDecisions.length, 1)
  assert.equal(agent.askDecisions[0].decision, null)
})

// ---------- raced plugin dialogs (the mod spawns the hook with --race) ----------

// A dialog the mod raced against the terminal: the router sends it on the askDelay timer (desk 60 s, away at once),
// whatever the idle state says.
test('a raced dialog at the desk is not sent before 60 s, and is sent after', async () => {
  const { router, chat, platform, agent, clock } = await started()
  platform.mode = 'desk'
  platform.stateOverride = 'active'
  const hookConn = new FakeConn()
  agent.receive(hookConn, { ...ASK, race: true })
  await flush()
  clock.advance(59_000)
  await flush()
  assert.equal(router.asks.size, 0)
  assert.equal(chat.sent.filter((s) => s.text.includes('Which db?')).length, 0)
  clock.advance(1_000)
  await flush()
  assert.equal(router.asks.size, 1)
  assert.equal(chat.sent.filter((s) => s.text.includes('Which db?')).length, 1)
})

test('a raced dialog while away is sent at once, even when the idle state is active', async () => {
  const { router, chat, platform, agent } = await started()
  platform.mode = 'away'
  platform.stateOverride = 'active'
  agent.receive(new FakeConn(), { ...ASK, race: true })
  await flush()
  assert.equal(router.asks.size, 1)
  assert.equal(chat.sent.filter((s) => s.text.includes('Which db?')).length, 1)
})

test('a raced dialog whose connection closes during the delay is never sent (the terminal answered)', async () => {
  const { router, chat, platform, agent, clock, logger } = await started()
  platform.mode = 'desk'
  const hookConn = new FakeConn()
  agent.receive(hookConn, { ...ASK, race: true })
  await flush()
  hookConn.end()
  clock.advance(60_000)
  await flush()
  assert.equal(router.asks.size, 0)
  assert.equal(chat.sent.filter((s) => s.text.includes('Which db?')).length, 0)
  assert.ok(logger.lines.some((l) => l.includes('the terminal answered first') && l.includes('AskUserQuestion')))
})

// The terminal answered a raced dialog: the Telegram message loses its buttons and shows the verdict.
test('ask_resolved for a sent raced dialog edits its message to the verdict with no buttons, and ends the ask', async () => {
  const { router, chat, platform, agent } = await started()
  platform.mode = 'away'
  platform.stateOverride = 'active'
  agent.receive(new FakeConn(), { ...ASK, race: true, raceId: 'race-1' })
  await flush()
  assert.equal(router.asks.size, 1)
  agent.receive(new FakeConn(), { t: 'ask_resolved', raceId: 'race-1', verdict: 'Send anyway ($1.20)' })
  await flush()
  assert.equal(router.asks.size, 0)
  const last = chat.rowEdits[chat.rowEdits.length - 1]
  assert.ok(last.text.includes('✅ Answered in terminal: Send anyway ($1.20)'))
  assert.deepEqual(last.rows, [])
  assert.equal(agent.askDecisions[agent.askDecisions.length - 1].decision, null)
})

test('ask_resolved with dismissed or a long verdict: the dismissed note, and the verdict cut to 200 characters', async () => {
  const { router, chat, platform, agent } = await started()
  platform.mode = 'away'
  platform.stateOverride = 'active'
  agent.receive(new FakeConn(), { ...ASK, race: true, raceId: 'race-2' })
  await flush()
  agent.receive(new FakeConn(), { t: 'ask_resolved', raceId: 'race-2', verdict: 'dismissed' })
  await flush()
  assert.equal(router.asks.size, 0)
  assert.ok(chat.rowEdits[chat.rowEdits.length - 1].text.endsWith('✖ Dismissed in terminal'))
  agent.receive(new FakeConn(), { ...ASK, race: true, raceId: 'race-3' })
  await flush()
  agent.receive(new FakeConn(), { t: 'ask_resolved', raceId: 'race-3', verdict: 'x'.repeat(300) })
  await flush()
  const text = chat.rowEdits[chat.rowEdits.length - 1].text
  assert.ok(text.endsWith(`✅ Answered in terminal: ${'x'.repeat(200)}`))
  assert.ok(!text.includes('x'.repeat(201)))
})

test('ask_resolved during the askDelay wait: the raced dialog is never sent', async () => {
  const { router, chat, platform, agent, clock } = await started()
  platform.mode = 'desk'
  platform.stateOverride = 'active'
  const hookConn = new FakeConn()
  agent.receive(hookConn, { ...ASK, race: true, raceId: 'race-4' })
  await flush()
  agent.receive(new FakeConn(), { t: 'ask_resolved', raceId: 'race-4', verdict: 'Send anyway' })
  await flush()
  hookConn.end()
  clock.advance(60_000)
  await flush()
  assert.equal(router.asks.size, 0)
  assert.equal(chat.sent.filter((s) => s.text.includes('Which db?')).length, 0)
})

test('ask_resolved with an unknown raceId changes nothing', async () => {
  const { router, chat, platform, agent } = await started()
  platform.mode = 'away'
  platform.stateOverride = 'active'
  agent.receive(new FakeConn(), { ...ASK, race: true, raceId: 'race-5' })
  await flush()
  const edits = chat.rowEdits.length
  agent.receive(new FakeConn(), { t: 'ask_resolved', raceId: 'nope', verdict: 'Send anyway' })
  await flush()
  assert.equal(router.asks.size, 1)
  assert.equal(chat.rowEdits.length, edits)
})

test('a non-raced dialog at active is still released to the terminal, with a logged reason', async () => {
  const { router, chat, platform, agent, logger } = await started()
  platform.stateOverride = 'active'
  const hookConn = new FakeConn()
  agent.receive(hookConn, ASK)
  await flush()
  assert.equal(router.asks.size, 0)
  assert.equal(chat.sent.length, 0)
  assert.deepEqual(agent.askDecisions, [{ conn: hookConn, decision: null }])
  assert.ok(logger.lines.some((l) => l.includes('not away (active)') && l.includes('AskUserQuestion')))
})

// PermResolved (the mod's tool.call verdict): a permission prompt the terminal answered loses its buttons and says how.
const keyFields = (input: unknown) => {
  const k = callKey(input)
  return { input_hash: k.hash, input_head: k.head }
}
const permResolved = (claudePid: number, tool_name: string, input: unknown, verdict: 'allowed' | 'denied') => ({
  t: 'hook', event: 'PermResolved', claudePid, cwd: PROJ, payload: { tool_name, ...keyFields(input), verdict },
})

test('a channel prompt answered "No" in the terminal: PermResolved denied clears its buttons and says so', async () => {
  const { router, chat, platform, agent, conn } = await started()
  platform.stateOverride = 'idle'
  agent.receive(conn, { t: 'permission_request', request_id: 'abcde', tool_name: 'Bash', description: 'run', input_preview: '{"command":"ls"}' })
  await flush()
  const prompt = chat.sent.find((s) => s.opts?.perm?.requestId === 'abcde')
  assert.ok(prompt)
  agent.receive(new FakeConn(), permResolved(4242, 'Bash', { command: 'ls' }, 'denied'))
  await flush()
  assert.equal(router.pending.size, 0)
  const edit = chat.edits.find((e) => e.messageId === prompt.id)
  assert.ok(edit)
  assert.ok(edit.text.endsWith('❌ Denied in terminal'))
})

test('a channel prompt allowed by PostToolUse, then PermResolved for the same call: no second edit', async () => {
  const { chat, platform, agent, conn } = await started()
  platform.stateOverride = 'idle'
  agent.receive(conn, { t: 'permission_request', request_id: 'abcde', tool_name: 'Bash', description: 'run', input_preview: '{"command":"ls"}' })
  await flush()
  const prompt = chat.sent.find((s) => s.opts?.perm?.requestId === 'abcde')
  assert.ok(prompt)
  agent.receive(new FakeConn(), { t: 'hook', event: 'PostToolUse', claudePid: 4242, cwd: PROJ, payload: { session_id: 's1', tool_name: 'Bash', ...keyFields({ command: 'ls' }) } })
  await flush()
  const before = chat.edits.length
  agent.receive(new FakeConn(), permResolved(4242, 'Bash', { command: 'ls' }, 'allowed'))
  await flush()
  assert.equal(chat.edits.length, before)
  assert.ok(chat.edits.find((e) => e.messageId === prompt.id)?.text.endsWith('✅ Answered at the desk'))
})

test('a hook-path Permission ask still open when PermResolved arrives: ended with no decision and the verdict note', async () => {
  const { router, chat, agent } = await awayWithBash()
  agent.receive(new FakeConn(), permResolved(5151, 'Bash', { command: 'npm test', description: 'Run tests' }, 'allowed'))
  await flush()
  assert.equal(router.asks.size, 0)
  assert.equal(agent.askDecisions[agent.askDecisions.length - 1].decision, null)
  assert.ok(chat.rowEdits[chat.rowEdits.length - 1].text.endsWith('✅ Allowed in terminal'))
  assert.deepEqual(chat.rowEdits[chat.rowEdits.length - 1].rows, [])
})

test('a released Permission ask: PermResolved within 10 minutes edits its message; after 10 minutes nothing happens', async () => {
  const { router, chat, agent, clock } = await awayWithBash()
  clock.advance(ASK_TTL_MS + 1_000)
  sweep(router)
  await flush()
  assert.equal(router.asks.size, 0)
  assert.equal(router.recentPerms.length, 1)
  clock.advance(RECENT_PERM_TTL_MS - 60_000)
  await flush()
  agent.receive(new FakeConn(), permResolved(5151, 'Bash', { command: 'npm test', description: 'Run tests' }, 'denied'))
  await flush()
  assert.ok(chat.edits[chat.edits.length - 1].text.endsWith('❌ Denied in terminal'))
  assert.equal(router.recentPerms.length, 0)

  const { router: lateRouter, chat: lateTg, agent: lateAgent, clock: lateClock } = await awayWithBash()
  lateClock.advance(ASK_TTL_MS + 1_000)
  sweep(lateRouter)
  await flush()
  lateClock.advance(RECENT_PERM_TTL_MS + 1_000)
  sweep(lateRouter)
  await flush()
  const before = lateTg.edits.length
  lateAgent.receive(new FakeConn(), permResolved(5151, 'Bash', { command: 'npm test', description: 'Run tests' }, 'denied'))
  await flush()
  assert.equal(lateTg.edits.length, before)
})
