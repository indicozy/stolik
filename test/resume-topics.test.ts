// /resume in topics (plan 2.15, ticket 22), group mode through the router with fake ports: the picker in General, a resume
// that reopens the folder's topic, the folder topic kept after 7 days, a live channel session pointed to its topic, and a
// live session without a channel given the Remote Control hint.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
const DAY = 24 * 60 * 60 * 1000
const DELETE_AFTER_MS = 7 * DAY
import { FakeConn, HOME, OWNER, flush, harness, textFrom } from './helpers/fakes.ts'
import { tgChat, tgThread } from '../src/adapters/chat/tg-ids.ts'
import type { ChatLogPort } from '../src/ports.ts'
import type { ChatLine } from '../src/brain/chatlog.ts'

const PROJ = `${HOME}/proj`
const GROUP = -1001234567890
const GROUP_ID = tgChat(GROUP)
const GROUP_CHAT = { kind: 'home' as const, id: GROUP_ID, thread: null }
const SID = '11111111-2222-4333-8444-555555555555'
const TRANSCRIPT = `${HOME}/t.jsonl`

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

// A group-mode router with one channel session in PROJ (pid 4242), its topic created (thread 100). It has announced its
// backend session id through a hook, so /resume can recognise the transcript as live.
async function groupWithSession(chatLog?: ChatLogPort) {
  const h = harness({ groupId: tgChat(GROUP), chatLog })
  await h.router.start()
  h.platform.dirs.add(PROJ)
  h.platform.files.set(TRANSCRIPT, { isFile: true, size: 1 })
  h.agent.trusted.add(PROJ)
  const conn = new FakeConn()
  h.agent.receive(conn, { t: 'register', claudePid: 4242, cwd: PROJ })
  await flush()
  h.agent.receive(conn, { t: 'hook', event: 'UserPromptSubmit', claudePid: 4242, cwd: PROJ, payload: { session_id: SID } })
  await flush()
  return { ...h, conn }
}

function transcript(mtime: number) {
  return [{ id: SID, path: TRANSCRIPT, cwd: PROJ, title: 'Fix the parser', mtime, entrypoint: 'cli' }]
}

// Sends /resume in General, then taps the first item of the list.
async function resumeFirst(h: Awaited<ReturnType<typeof groupWithSession>>) {
  await h.chat.inbound(textFrom('/resume', { chat: GROUP_CHAT }))
  const list = h.chat.sent.find((s) => s.text.startsWith('Pick a session'))
  assert.ok(list, 'the picker is sent')
  const data = String(list.opts?.rows?.[0]?.[0]?.data)
  await h.chat.callback({ pressId: 'cbR', data, message: list.id, from: OWNER, chat: GROUP_CHAT })
  await flush()
  return list
}

test('the picker is a General message: no thread, and it is written to the chat log', async () => {
  const log = new RecordingLog()
  const h = await groupWithSession(log)
  h.agent.transcripts = transcript(h.clock.now() - 60_000)
  await h.chat.inbound(textFrom('/resume', { chat: GROUP_CHAT }))
  const list = h.chat.sent.find((s) => s.text.startsWith('Pick a session'))
  assert.ok(list)
  assert.equal(list.chat, 'group')
  assert.equal(list.opts?.thread, undefined)
  const line = log.lines.find((l) => l.kind === 'resume')
  assert.ok(line, 'the picker is logged')
  assert.equal(line.dir, 'out')
  assert.equal(line.topic_id, null)
  assert.equal(line.tg_message_id, list.id)
})

test('an ended session resumes in tmux, and its closed topic is reopened when it registers', async () => {
  const h = await groupWithSession()
  h.agent.transcripts = transcript(h.clock.now() - 60_000)
  h.platform.dead.add(4242)
  h.clock.advance(60_000)
  await flush()
  assert.deepEqual(h.chat.topicOps.filter((o) => o.op === 'close'), [{ op: 'close', threadId: tgThread(100) }])

  await resumeFirst(h)
  assert.deepEqual(h.agent.startedSessions.map((x) => x.extra), [['--resume', SID]])
  h.agent.receive(new FakeConn(), { t: 'register', claudePid: 5151, cwd: PROJ, spawnToken: h.agent.spawnTokens[0] })
  await flush()
  assert.deepEqual(h.chat.topicOps.filter((o) => o.op === 'reopen'), [{ op: 'reopen', threadId: tgThread(100) }])
  assert.equal(h.chat.topicOps.filter((o) => o.op === 'create').length, 1, 'no new topic')
})

test('the folder topic is never deleted: after 7 days, /resume still reopens it, with no new topic', async () => {
  const h = await groupWithSession()
  h.agent.transcripts = transcript(h.clock.now() - 60_000)
  h.platform.dead.add(4242)
  h.clock.advance(60_000)
  await flush()
  h.clock.advance(DELETE_AFTER_MS + DAY)
  await flush()
  assert.equal(h.chat.topicOps.filter((o) => o.op === 'delete').length, 0, 'not deleted')

  await resumeFirst(h)
  h.agent.receive(new FakeConn(), { t: 'register', claudePid: 5151, cwd: PROJ, spawnToken: h.agent.spawnTokens[0] })
  await flush()
  assert.deepEqual(h.chat.topicOps.filter((o) => o.op === 'reopen'), [{ op: 'reopen', threadId: tgThread(100) }])
  assert.equal(h.chat.topicOps.filter((o) => o.op === 'create').length, 1, 'no second topic')
})

test('a session that is live in its channel is pointed to its topic, not resumed', async () => {
  const h = await groupWithSession()
  h.agent.transcripts = transcript(h.clock.now() - 60_000)
  h.agent.live.set(SID, 4242)
  await resumeFirst(h)
  assert.deepEqual(h.agent.startedSessions, [], 'nothing is started')
  const note = h.chat.sent.find((s) => s.text.includes('already live'))
  assert.ok(note, 'the pointer is sent')
  assert.match(note.text, /in its topic "proj"/)
  assert.equal(note.chat, 'group')
})

test('a session that is live without a channel gets the Remote Control hint, and is never forked', async () => {
  const h = harness({ groupId: tgChat(GROUP) })
  await h.router.start()
  h.platform.dirs.add(PROJ)
  h.platform.files.set(TRANSCRIPT, { isFile: true, size: 1 })
  h.agent.trusted.add(PROJ)
  h.agent.transcripts = transcript(h.clock.now() - 60_000)
  h.agent.live.set(SID, 7777)
  await resumeFirst(h)
  assert.deepEqual(h.agent.startedSessions, [])
  const hint = h.chat.sent.find((s) => s.text.includes('Remote Control'))
  assert.ok(hint, 'the Remote Control hint is sent')
})

test('the picker tap of a transcript that is gone says so, and starts nothing', async () => {
  const h = await groupWithSession()
  h.agent.transcripts = transcript(h.clock.now() - 60_000)
  h.platform.files.delete(TRANSCRIPT)
  h.platform.dead.add(4242)
  h.clock.advance(60_000)
  await flush()
  await resumeFirst(h)
  assert.deepEqual(h.agent.startedSessions, [])
  assert.ok(h.chat.sent.some((s) => s.text.includes('transcript is gone')))
})

test('a plain /resume with nothing to resume says so in General', async () => {
  const h = await groupWithSession()
  h.agent.transcripts = []
  await h.chat.inbound(textFrom('/resume', { chat: GROUP_CHAT }))
  const reply = h.chat.sent.find((s) => s.text === 'No agent sessions to resume.')
  assert.ok(reply)
  assert.equal(reply.opts?.thread, undefined)
})

test('a session whose channel has gone is not live: /resume starts it again, with no "already live" pointer', async () => {
  const h = await groupWithSession()
  h.agent.transcripts = transcript(h.clock.now() - 60_000)
  h.agent.disconnect(h.conn)
  await flush()
  h.agent.live.delete(SID)
  await resumeFirst(h)
  assert.equal(h.chat.sent.find((s) => s.text.includes('already live')), undefined, 'no pointer')
  assert.equal(h.agent.startedSessions.length, 1, 'the ended session is resumed')
})
