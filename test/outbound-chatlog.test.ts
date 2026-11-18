// Chat log for the outbound paths of the approval, /resume and timer handlers (plan 2.13, task 5): each path appends at
// least one line, with the session as target and the topic it went to. Fake ports; the log is recorded in memory.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatLine } from '../src/brain/chatlog.ts'
import type { ChatLogPort } from '../src/ports.ts'
import { APPROVAL_EXPIRED_TEXT, PERMISSION_TTL_MS } from '../src/router/state.ts'
import { ASK_TTL_MS } from '../src/router/ask.ts'
import { sendBootAnnouncement } from '../src/router/handlers/timers.ts'
import { FakeConn, HOME, OWNER, flush, harness, textFrom } from './helpers/fakes.ts'
import { tgChat, tgThread } from '../src/adapters/chat/tg-ids.ts'

class RecordingLog implements ChatLogPort {
  readonly lines: ChatLine[] = []
  append(line: ChatLine): void {
    this.lines.push(line)
  }
  attachmentPath(): null {
    return null
  }
  recentExchanges(): ChatLine[] {
    return []
  }
}

const PROJ = `${HOME}/proj`
const GROUP = -1001234567890
const GROUP_CHAT = { kind: 'home' as const, id: tgChat(GROUP), thread: null }
const THREAD = tgThread(100)
const MIN = 60_000

async function groupWithSession() {
  const log = new RecordingLog()
  const h = harness({ groupId: tgChat(GROUP), chatLog: log })
  await h.router.start()
  h.platform.dirs.add(PROJ)
  const conn = new FakeConn()
  h.agent.receive(conn, { t: 'register', claudePid: 4242, cwd: PROJ })
  await flush()
  return { ...h, conn, log }
}

const outLines = (log: RecordingLog, kind: string) => log.lines.filter((l) => l.dir === 'out' && l.kind === kind)

test('a permission prompt is logged with its session and topic', async () => {
  const { log, platform, agent, conn } = await groupWithSession()
  platform.away = true
  agent.receive(conn, { t: 'permission_request', request_id: 'abcde', tool_name: 'Bash', description: 'run', input_preview: 'ls' })
  await flush()
  const [line] = outLines(log, 'approval')
  assert.ok(line, 'one approval line')
  assert.equal(line.topic_id, THREAD)
  assert.deepEqual(line.target, { type: 'session', name: 'proj' })
  assert.match(line.text, /Bash/)
})

test('a permission reminder and the permission expiry are logged', async () => {
  const { log, platform, agent, conn, clock } = await groupWithSession()
  platform.away = true
  agent.receive(conn, { t: 'permission_request', request_id: 'abcde', tool_name: 'Bash', description: 'run', input_preview: 'ls' })
  await flush()
  clock.advance(PERMISSION_TTL_MS / 2 + MIN)
  await flush()
  const [reminder] = outLines(log, 'reminder')
  assert.ok(reminder, 'the reminder is logged')
  assert.equal(reminder.topic_id, THREAD)
  assert.match(reminder.text, /Still waiting/)

  clock.advance(PERMISSION_TTL_MS)
  await flush()
  const [expired] = outLines(log, 'expired')
  assert.ok(expired, 'the expiry is logged')
  assert.equal(expired.text, APPROVAL_EXPIRED_TEXT)
  assert.equal(expired.topic_id, THREAD)
})

test('an AskUserQuestion, its expiry, and a plan approval are logged', async () => {
  const { log, platform, agent, conn, clock } = await groupWithSession()
  platform.away = true
  agent.receive(conn, {
    t: 'ask', claudePid: 4242, cwd: PROJ, tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'Which db?', header: '', multiSelect: false, options: [{ label: 'SQLite' }] }] },
  })
  await flush()
  assert.equal(outLines(log, 'ask').length, 1)
  assert.equal(outLines(log, 'ask')[0].topic_id, THREAD)

  clock.advance(ASK_TTL_MS + MIN)
  await flush()
  assert.equal(outLines(log, 'expired').length, 1, 'the ask expiry is logged')

  agent.receive(new FakeConn(), { t: 'ask', claudePid: 4242, cwd: PROJ, tool_name: 'ExitPlanMode', tool_input: { plan: '# Plan\n- one' } })
  await flush()
  const plan = outLines(log, 'plan')
  assert.equal(plan.length, 1)
  assert.equal(plan[0].topic_id, THREAD)
  assert.match(plan[0].text, /one/)
})

test('a reply from a session goes to its topic and is logged there', async () => {
  const { log, agent, conn } = await groupWithSession()
  agent.receive(conn, { t: 'reply', reqId: 'r1', text: 'done', kind: 'response' })
  await flush()
  const [line] = outLines(log, 'response')
  assert.ok(line, 'the reply is logged')
  assert.equal(line.topic_id, THREAD)
  assert.deepEqual(line.target, { type: 'session', name: 'proj' })
})

test('the /resume picker and its results are logged, the picker with no topic', async () => {
  const { log, chat, agent, platform, clock } = await groupWithSession()
  const SID = '11111111-2222-4333-8444-555555555555'
  const transcript = `${HOME}/t.jsonl`
  platform.files.set(transcript, { isFile: true, size: 1 })
  agent.trusted.add(PROJ)
  agent.transcripts = [{ id: SID, path: transcript, cwd: PROJ, title: 'Fix', mtime: clock.now() - MIN, entrypoint: 'cli' }]
  await chat.inbound(textFrom('/resume', { chat: GROUP_CHAT }))
  const [picker] = outLines(log, 'resume')
  assert.ok(picker, 'the picker is logged')
  assert.equal(picker.topic_id, null)

  const list = chat.sent.find((s) => s.text.startsWith('Pick a session'))
  assert.ok(list)
  await chat.callback({ pressId: 'cbR', data: String(list.opts?.rows?.[0]?.[0]?.data), message: list.id, from: OWNER, chat: GROUP_CHAT })
  await flush()
  assert.ok(log.lines.some((l) => l.dir === 'out' && l.text.startsWith('🔁 Resuming Fix')), 'the resume result is logged')
})

test('the boot announcement is logged (General)', async () => {
  const { log, router } = await groupWithSession()
  await sendBootAnnouncement(router, 0)
  const line = log.lines.find((l) => l.dir === 'out' && l.kind === 'notice' && l.text.length > 0 && l.topic_id === null)
  assert.ok(line, 'the boot line is logged')
})

test('a note saved by the core fallback is logged as the confirmation', async () => {
  const log = new RecordingLog()
  const h = harness({ chatLog: log })
  await h.router.start()
  await h.chat.inbound(textFrom('note: buy milk'))
  const line = log.lines.find((l) => l.dir === 'out' && l.text === '📝 saved')
  assert.ok(line, 'the confirmation is logged')
  assert.equal(line.topic_id, null)
})
