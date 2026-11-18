// Notification levels through the router (spec 24, parts 1): Logs topic posts, status notices, session replies with a
// level, the desk rule for critical proactive replies, approvals and questions, and tg-notify's level reaching the router.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeConn, HOME, flush, harness, textFrom, FakeChat } from './helpers/fakes.ts'
import { LogsTopic } from '../src/router/logs-topic.ts'
import type { LogRecord } from '../src/router/log.ts'

const PROJ = `${HOME}/proj`

async function withSession(pid = 4242) {
  const h = harness()
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

function replyResult(conn: FakeConn, reqId: string) {
  return conn.sent.find((m) => m.t === 'reply_result' && m.reqId === reqId)
}

test('a reply with level silent sends silent; default pings; critical pings', async () => {
  const { chat, agent, conn } = await withSession()
  agent.receive(conn, { t: 'reply', reqId: 'r1', text: 'Progress: half done.', kind: 'response', level: 'silent' })
  agent.receive(conn, { t: 'reply', reqId: 'r2', text: 'Answer: it is 4.', kind: 'response', level: 'default' })
  agent.receive(conn, { t: 'reply', reqId: 'r3', text: 'Blocker: the disk is full.', kind: 'response', level: 'critical' })
  agent.receive(conn, { t: 'reply', reqId: 'r4', text: 'No level given.', kind: 'response' })
  await flush()
  assert.equal(sentWith(chat, 'Progress: half done.').opts?.silent, true)
  assert.notEqual(sentWith(chat, 'Answer: it is 4.').opts?.silent, true, 'default pings')
  assert.notEqual(sentWith(chat, 'Blocker: the disk is full.').opts?.silent, true, 'critical pings')
  assert.notEqual(sentWith(chat, 'No level given.').opts?.silent, true, 'no level is the default: pings')
  assert.equal(replyResult(conn, 'r1')?.delivered, true)
})

test('a reply with an invalid level is refused with a clear error, and nothing is sent', async () => {
  const { chat, agent, conn } = await withSession()
  agent.receive(conn, { t: 'reply', reqId: 'bad', text: 'Loud message.', kind: 'response', level: 'loud' })
  await flush()
  const res = replyResult(conn, 'bad')
  assert.equal(res?.ok, false)
  assert.equal(res?.error, 'level must be one of silent, default, critical')
  assert.equal(chat.sent.some((s) => s.text.includes('Loud message.')), false)
})

test('a critical proactive reply is delivered at the desk; a default one is dropped there', async () => {
  const { chat, platform, agent, conn } = await withSession()
  assert.equal(platform.away, false, 'the owner is at the desk')
  agent.receive(conn, { t: 'reply', reqId: 'p1', text: 'Plain proactive.', kind: 'proactive' })
  agent.receive(conn, { t: 'reply', reqId: 'p2', text: 'Serious proactive.', kind: 'proactive', level: 'critical' })
  await flush()
  assert.equal(replyResult(conn, 'p1')?.delivered, false, 'default proactive dropped at the desk')
  assert.equal(chat.sent.some((s) => s.text.includes('Plain proactive.')), false)
  assert.equal(replyResult(conn, 'p2')?.delivered, true, 'critical proactive delivered at the desk')
  assert.notEqual(sentWith(chat, 'Serious proactive.').opts?.silent, true)
})

test('a permission prompt pings (critical), while the owner is away', async () => {
  const { chat, platform, agent, conn } = await withSession()
  platform.stateOverride = 'idle'
  agent.receive(conn, { t: 'permission_request', request_id: 'abcde', tool_name: 'Bash', description: 'run', input_preview: 'ls' })
  await flush()
  const prompt = chat.sent.find((s) => s.opts?.perm?.requestId === 'abcde')
  assert.ok(prompt, 'the prompt is sent')
  assert.notEqual(prompt.opts?.silent, true, 'an approval pings')
})

test('a status notice is silent: the starting notice of a router-started session', async () => {
  const h = harness()
  await h.router.start()
  h.agent.trusted.add(PROJ)
  h.platform.dirs.add(PROJ)
  await h.chat.inbound(textFrom('/to proj hello', { messageId: 10 }))
  await flush()
  const notice = sentWith(h.chat, 'Starting new instance')
  assert.equal(notice.opts?.silent, true)
})

test('every Logs topic post is silent', async () => {
  const chat = new FakeChat()
  const store = { value: null as number | null, get() { return this.value }, set(id: number) { this.value = id } }
  const logs = new LogsTopic({ chat, store, enabled: true, groupId: () => -1001234567890, clock: { setTimer: () => 0, clearTimer: () => {} } })
  await logs.ensure()
  const rec: LogRecord = { ts: '2026-11-18T10:00:00Z', level: 'error', component: 'telegram', msg: 'something broke', fields: {} }
  logs.report(rec)
  await flush()
  await flush()
  const post = chat.sent.find((s) => s.text.includes('something broke'))
  assert.ok(post, 'the line is posted to the Logs topic')
  assert.equal(post.opts?.silent, true)
})

test('tg-notify --silent reaches the router as a silent message; the default pings', async () => {
  const { chat, agent, conn } = await withSession()
  const quiet = new FakeConn()
  agent.receive(quiet, { t: 'notify', claudePid: 4242, cwd: PROJ, text: 'Quiet note.', kind: 'requested', level: 'silent' })
  agent.receive(conn, { t: 'notify', claudePid: 4242, cwd: PROJ, text: 'Loud note.', kind: 'requested' })
  await flush()
  assert.equal(sentWith(chat, 'Quiet note.').opts?.silent, true)
  assert.notEqual(sentWith(chat, 'Loud note.').opts?.silent, true)
  const bad = new FakeConn()
  agent.receive(bad, { t: 'notify', claudePid: 4242, cwd: PROJ, text: 'Bad level.', kind: 'requested', level: 'shout' })
  await flush()
  assert.equal(bad.sent[0]?.delivered, false)
  assert.equal(bad.sent[0]?.error, 'level must be one of silent, default, critical')
  assert.equal(chat.sent.some((s) => s.text.includes('Bad level.')), false)
})
