// Unprefixed General messages through the router with fake ports (plan 2.5, 2.7 wiring, the New flow of design §4.4):
// the 30-minute rule, the buttons, "wrong one?", the folder picker and Read-only / Full, quick/read/web through the
// modes addon, the busy-session reaction, chunk groups, and the chat-log fields.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ButtonPress, Inbound } from '../src/brain/chat-types.ts'
import type { ChatLine } from '../src/brain/chatlog.ts'
import { MINUTE } from '../src/brain/common.ts'
import type { AddonInfo, AddonsPort, ChatLogPort } from '../src/ports.ts'
import type { Rows } from '../src/router/state.ts'
import { FakeConn, HOME, OWNER, flush, harness, textFrom } from './helpers/fakes.ts'
import { tgChat, tgMsg, tgThread } from '../src/adapters/chat/tg-ids.ts'

const PROJ = `${HOME}/proj`
const OTHER = `${HOME}/other`
const MASTER = `${HOME}/Documents/projects/master`
const GROUP = -1001234567890
const GROUP_CHAT = { kind: 'home' as const, id: tgChat(GROUP), thread: null }

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

// An addons port that answers "<word>: ..." for the words it provides, and nothing else.
class FakeAddons implements AddonsPort {
  readonly asked: string[] = []
  private readonly words: string[]
  constructor(words: string[]) {
    this.words = words
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  list(): AddonInfo[] {
    return []
  }
  async setEnabled(): Promise<string | null> {
    return null
  }
  async media(): Promise<null> {
    return null
  }
  async cleanText(text: string): Promise<{ text: string; unpolished: boolean }> {
    return { text, unpolished: false }
  }
  async general(text: string): Promise<string | null> {
    const word = text.split(':')[0]
    if (!this.words.includes(word)) return null
    this.asked.push(text)
    return `answer to ${text}`
  }
}

// The button data of a rows list, flattened.
function datas(rows: Rows): string[] {
  return rows.flat().map((b) => b.data)
}

// The pending id carried by a route button (rt:<kind>:<id>...).
function pendingIdOf(rows: Rows): string {
  const m = /^rt:[a-z]:([0-9a-f]{8})/.exec(datas(rows)[0] ?? '')
  assert.ok(m, `a route button in ${datas(rows)}`)
  return m[1]
}

async function tap(h: ReturnType<typeof harness>, data: string, messageId: number, id = 'cb') {
  const c: ButtonPress = { pressId: id, data, message: tgMsg(messageId), from: OWNER }
  await h.chat.callback(c)
  await flush()
}

// Registers a channel session in `cwd` with pid `pid`. Returns its connection.
function register(h: ReturnType<typeof harness>, cwd: string, pid: number): FakeConn {
  h.platform.dirs.add(cwd)
  const conn = new FakeConn()
  h.agent.receive(conn, { t: 'register', claudePid: pid, cwd })
  return conn
}

test('ACTIVE window: exactly one session active in the last 30 minutes is forwarded with "wrong one?"; 29:59 and 30:00 forward, 30:01 shows buttons', async () => {
  for (const [minutes, seconds, forwarded] of [[29, 59, true], [30, 0, true], [30, 1, false]] as const) {
    const h = harness()
    await h.router.start()
    register(h, PROJ, 4242)
    await flush()
    h.clock.advance(minutes * MINUTE + seconds * 1000)
    await h.chat.inbound(textFrom('how is it going?'))
    if (forwarded) {
      assert.equal(h.agent.sent.length, 1, `${minutes}:${seconds} forwards`)
      assert.deepEqual(h.chat.texts(), ['→ [proj]'])
      assert.match(datas(h.chat.sent[0].opts!.rows!)[0], /^rt:w:[0-9a-f]{8}$/)
    } else {
      assert.equal(h.agent.sent.length, 0, `${minutes}:${seconds} does not forward`)
      assert.equal(h.chat.sent[0].text, 'Which one?')
    }
  }
})

test('zero sessions: nothing is sent to a session; the buttons are New, quick, read and web', async () => {
  const h = harness()
  await h.router.start()
  await h.chat.inbound(textFrom('hello?'))
  assert.equal(h.agent.sent.length, 0)
  const ask = h.chat.sent[0]
  assert.match(ask.text, /^No session can take it right now/)
  assert.deepEqual(ask.opts?.rows?.map((r) => r.map((b) => b.text)), [['New…'], ['quick', 'read', 'web']])
})

test('several active sessions: one button each, most recently active first; a tap delivers to that one', async () => {
  const h = harness()
  await h.router.start()
  register(h, PROJ, 4001)
  await flush()
  h.clock.advance(5 * MINUTE)
  register(h, OTHER, 4002)
  await flush()
  await h.chat.inbound(textFrom('which one is blocked?', { messageId: tgMsg(30) }))

  assert.equal(h.agent.sent.length, 0, 'no session got it yet')
  const ask = h.chat.sent[0]
  assert.equal(ask.text, 'Which one?')
  const rows = ask.opts!.rows!
  assert.deepEqual(rows.slice(0, 2).map((r) => r[0].text), ['other', 'proj'], 'most recently active first')
  assert.deepEqual(rows[2].map((b) => b.text), ['🆕 New'])

  await tap(h, rows[1][0].data, 31) // "proj": index 1
  assert.equal(h.agent.sent.length, 1)
  assert.equal(h.agent.sent[0].key, '4001:start-4001')
  assert.equal(h.agent.sent[0].content, 'which one is blocked?')
  assert.ok(h.chat.edits.some((e) => e.text === '→ [proj]'), 'the buttons become the confirmation')
})

test('"wrong one?" offers the other open sessions, then moves the message there', async () => {
  const h = harness()
  await h.router.start()
  // The other session was last active 40 minutes ago, so only proj is active and the first message goes to it.
  register(h, OTHER, 4002)
  h.clock.advance(40 * MINUTE)
  await flush()
  register(h, PROJ, 4001)
  await flush()
  await h.chat.inbound(textFrom('move me', { messageId: tgMsg(40) }))
  assert.equal(h.agent.sent[0].key, '4001:start-4001')

  const wrong = h.chat.sent.find((s) => s.text === '→ [proj]')!
  await tap(h, datas(wrong.opts!.rows!)[0], wrong.id, 'cb-wrong')
  const moving = h.chat.edits.find((e) => e.text === '→ [proj] — move to:')
  assert.ok(moving, 'the other sessions are offered')
  const rows = h.chat.rowEdits.find((e) => e.text === '→ [proj] — move to:')!.rows
  assert.deepEqual(rows.map((r) => r[0].text).slice(0, 1), ['other'])

  await tap(h, rows[0][0].data, wrong.id, 'cb-move')
  assert.equal(h.agent.sent.length, 2)
  assert.equal(h.agent.sent[1].key, '4002:start-4002')
  assert.equal(h.agent.sent[1].content, 'move me')
  assert.ok(h.chat.edits.some((e) => e.text === '→ [other] (moved)'), 'the confirmation names the new session')
})

test('New…: the picker lists the trusted folders, master first; ＋ starts a Full session at once with the message as its first prompt', async () => {
  const h = harness()
  await h.router.start()
  h.agent.trusted.add(PROJ)
  h.agent.trusted.add(MASTER)
  h.platform.dirs.add(PROJ)
  h.platform.dirs.add(MASTER)
  await h.chat.inbound(textFrom('start a plan for the parser', { messageId: tgMsg(50) }))
  const ask = h.chat.sent.find((s) => s.text === 'No session can take it right now. Start one with New…, or ask quick, read or web.') ?? h.chat.sent[0]
  const newButton = ask.opts!.rows!.find((r) => r[0].text === 'New…')![0]
  await tap(h, newButton.data, ask.id)

  const picker = h.chat.rowEdits.find((e) => e.text === 'Start a session in which folder?')!
  assert.deepEqual(picker.rows.map((r) => r.map((b) => b.text)), [['＋ master', '👁'], ['＋ proj', '👁']], 'master first')

  await tap(h, picker.rows[1][0].data, ask.id) // ＋ proj: Full, now
  assert.deepEqual(h.agent.startedSessions, [{ project: 'proj', dir: PROJ, extra: [] }])
  assert.ok(h.chat.rowEdits.some((e) => e.text === '→ starting proj (full)'))

  const conn = new FakeConn()
  h.agent.receive(conn, { t: 'register', claudePid: 6060, cwd: PROJ, spawnToken: h.agent.spawnTokens[0] })
  h.clock.advance(1000)
  await flush()
  assert.equal(h.agent.sent.length, 1)
  assert.equal(h.agent.sent[0].key, '6060:start-6060')
  assert.equal(h.agent.sent[0].content, 'start a plan for the parser')
})

test('the picker 👁 button starts the session read-only (plan mode) at once', async () => {
  const h = harness()
  await h.router.start()
  h.agent.trusted.add(PROJ)
  h.platform.dirs.add(PROJ)
  await h.chat.inbound(textFrom('look only', { messageId: tgMsg(51) }))
  const ask = h.chat.sent[0]
  await tap(h, ask.opts!.rows!.find((r) => r[0].text === 'New…')![0].data, ask.id)
  const picker = h.chat.rowEdits.find((e) => e.text === 'Start a session in which folder?')!
  await tap(h, picker.rows[0][1].data, ask.id) // 👁 on the first row (proj)
  assert.deepEqual(h.agent.startedSessions, [{ project: 'proj', dir: PROJ, extra: ['--permission-mode', 'plan'] }])
})

test('"new <project>: text" goes straight to Read-only / Full; Full starts without plan mode and the text is the first message', async () => {
  const h = harness()
  await h.router.start()
  h.agent.trusted.add(PROJ)
  h.platform.dirs.add(PROJ)
  await h.chat.inbound(textFrom('new proj: build the thing', { messageId: tgMsg(60) }))
  const prompt = h.chat.sent.find((s) => s.text === 'Start proj: read-only or full?')!
  assert.ok(prompt, 'the Read-only / Full question is asked')
  assert.deepEqual(prompt.opts!.rows![0].map((b) => b.text), ['Read-only', 'Full'])
  assert.deepEqual(h.agent.startedSessions, [], 'nothing starts before the answer')

  await tap(h, prompt.opts!.rows![0][1].data, prompt.id) // Full
  assert.deepEqual(h.agent.startedSessions, [{ project: 'proj', dir: PROJ, extra: [] }])

  h.agent.receive(new FakeConn(), { t: 'register', claudePid: 6161, cwd: PROJ, spawnToken: h.agent.spawnTokens[0] })
  h.clock.advance(1000)
  await flush()
  assert.equal(h.agent.sent[0].content, 'build the thing')
})

test('"new <unknown>:" says there is no such trusted folder and starts nothing', async () => {
  const h = harness()
  await h.router.start()
  await h.chat.inbound(textFrom('new nope: hi', { messageId: tgMsg(61) }))
  assert.deepEqual(h.chat.texts(), ['No trusted folder named "nope". See /list for the folders.'])
  assert.deepEqual(h.agent.startedSessions, [])
})

test('quick, read and web buttons hand the text to the modes addon; its answer is a reply to the question', async () => {
  const addons = new FakeAddons(['quick', 'read', 'web'])
  const h = harness({ addons })
  await h.router.start()
  await h.chat.inbound(textFrom('what is a fence?', { messageId: tgMsg(70) }))
  const ask = h.chat.sent[0]
  const quick = ask.opts!.rows!.find((r) => r[0].text === 'quick')![0]
  await tap(h, quick.data, ask.id)
  assert.deepEqual(addons.asked, ['quick: what is a fence?'])
  const answer = h.chat.sent.find((s) => s.text === 'answer to quick: what is a fence?')!
  assert.equal(answer.opts?.replyTo, tgMsg(70))
  assert.equal(h.agent.sent.length, 0, 'modes never reach a session')
})

test('quick with no modes addon: "not installed", and the buttons stay', async () => {
  const h = harness()
  await h.router.start()
  await h.chat.inbound(textFrom('why?', { messageId: tgMsg(71) }))
  const ask = h.chat.sent[0]
  const quick = ask.opts!.rows!.find((r) => r[0].text === 'quick')![0]
  await tap(h, quick.data, ask.id, 'cb-q')
  assert.ok(h.chat.sent.some((s) => s.text === '"quick" is not installed.'))
  assert.deepEqual(h.chat.answers.at(-1), { id: 'cb-q', text: '"quick" is not installed.' })
})

test('a message to a busy session gets ✍, and the silent "queued, session is busy" reply once per turn', async () => {
  const h = harness()
  await h.router.start()
  const conn = register(h, PROJ, 4242)
  await flush()
  h.agent.receive(conn, { t: 'hook', event: 'UserPromptSubmit', claudePid: 4242, cwd: PROJ, payload: { session_id: '11111111-2222-4333-8444-555555555555' } })
  await flush()

  await h.chat.inbound(textFrom('first while busy', { messageId: tgMsg(80) }))
  await h.chat.inbound(textFrom('second while busy', { messageId: tgMsg(81) }))
  assert.equal(h.agent.sent.length, 2, 'both are delivered at once')
  assert.deepEqual(h.chat.reactions, [
    { messageId: tgMsg(80), emoji: '✍' },
    { messageId: tgMsg(81), emoji: '✍' },
  ])
  const notices = h.chat.sent.filter((s) => s.text === 'queued, session is busy')
  assert.equal(notices.length, 1, 'once in this turn')
  assert.equal(notices[0].opts?.silent, true)
  assert.equal(notices[0].opts?.replyTo, tgMsg(80))

  // A new turn (the Stop hook ends this one), then a message: no reaction for busy, no notice.
  h.agent.receive(conn, { t: 'hook', event: 'Stop', claudePid: 4242, cwd: PROJ, payload: {} })
  await flush()
  await h.chat.inbound(textFrom('idle now', { messageId: tgMsg(82) }))
  assert.equal(h.chat.reactions.at(-1)?.emoji, '👀')
  assert.equal(h.chat.sent.filter((s) => s.text === 'queued, session is busy').length, 1)
})

test('a busy notice for the next turn comes again', async () => {
  const h = harness()
  await h.router.start()
  const conn = register(h, PROJ, 4242)
  await flush()
  const prompt = { t: 'hook', event: 'UserPromptSubmit', claudePid: 4242, cwd: PROJ, payload: {} }
  h.agent.receive(conn, prompt)
  await flush()
  await h.chat.inbound(textFrom('a', { messageId: tgMsg(90) }))
  h.clock.advance(1000)
  h.agent.receive(conn, prompt) // a new turn starts
  await flush()
  await h.chat.inbound(textFrom('b', { messageId: tgMsg(91) }))
  assert.equal(h.chat.sent.filter((s) => s.text === 'queued, session is busy').length, 2)
})

test('a long reply goes out as one chunk group (sendChunks), in order', async () => {
  const h = harness()
  await h.router.start()
  const conn = register(h, PROJ, 4242)
  await flush()
  const text = 'a'.repeat(9000)
  h.agent.receive(conn, { t: 'reply', reqId: 'r1', text, kind: 'response' })
  await flush()
  assert.equal(h.chat.chunkCalls.length, 1, 'one group')
  const chunks = h.chat.chunkCalls[0].texts
  assert.ok(chunks.length >= 3, `chunks ${chunks.length}`)
  assert.deepEqual(h.chat.sent.map((s) => s.text), chunks)
  assert.ok(chunks.every((c) => c.startsWith('[proj] ')))
})

test('a chunk group that fails part-way: the retry sends only the chunks not yet sent', async () => {
  const h = harness()
  await h.router.start()
  const conn = register(h, PROJ, 4242)
  await flush()
  const text = 'b'.repeat(9000)
  h.chat.failChunkIndex = 1
  h.agent.receive(conn, { t: 'reply', reqId: 'r1', text, kind: 'response' })
  await flush()
  assert.equal(h.chat.sent.length, 1, 'the first chunk went out before the failure')
  h.agent.receive(conn, { t: 'reply', reqId: 'r2', text, kind: 'response' })
  await flush()
  const [first, retry] = h.chat.chunkCalls
  assert.deepEqual(retry.texts, first.texts.slice(1), 'only the unsent chunks are sent again')
  assert.deepEqual(h.chat.sent.map((s) => s.text), first.texts, 'every chunk exactly once')
})

test('chat log: the session line has its topic and backend; a button pick logs its decision with scores and gap null', async () => {
  const chat = new RecordingLog()
  const h = harness({ groupId: tgChat(GROUP), chatLog: chat })
  await h.router.start()
  h.agent.trusted.add(PROJ)
  const conn = register(h, PROJ, 4242)
  await flush()
  // The session's topic is the first topic created in the group (thread 100 in the fake).
  await h.chat.inbound(textFrom('status?', { messageId: tgMsg(100), chat: GROUP_CHAT }))
  const incoming = chat.lines.find((l) => l.dir === 'in' && l.tg_message_id === tgMsg(100))!
  assert.deepEqual(incoming.target, { type: 'session', name: 'proj' })
  assert.equal(incoming.topic_id, tgThread(100))
  assert.equal(incoming.backend, 'claude-code')
  assert.equal(incoming.scores, null)
  assert.equal(incoming.gap, null)

  h.agent.receive(conn, { t: 'reply', reqId: 'r1', text: 'all green', kind: 'response' })
  await flush()
  const outgoing = chat.lines.find((l) => l.dir === 'out' && l.text === '[proj] all green')!
  assert.equal(outgoing.topic_id, tgThread(100))
  assert.equal(outgoing.backend, 'claude-code')
})

test('chat log: picking a session from the buttons writes a route line with the target, scores and gap null', async () => {
  const chat = new RecordingLog()
  const h = harness({ chatLog: chat })
  await h.router.start()
  register(h, PROJ, 4001)
  register(h, OTHER, 4002)
  h.clock.advance(40 * MINUTE) // both inactive: buttons
  await flush()
  await h.chat.inbound(textFrom('pick me', { messageId: tgMsg(110) }))
  const ask = h.chat.sent[0]
  assert.equal(ask.text, 'Which one?')
  await tap(h, ask.opts!.rows![0][0].data, ask.id) // proj: the first button (registry order, equal activity)

  assert.equal(h.agent.sent[0].key, '4001:start-4001')
  const incoming = chat.lines.find((l) => l.dir === 'in' && l.tg_message_id === tgMsg(110))!
  assert.equal(incoming.target, null, 'the message line is written before the pick')
  const route = chat.lines.find((l) => l.kind === 'route' && l.tg_message_id === tgMsg(110))!
  assert.deepEqual(route.target, { type: 'session', name: 'proj' })
  assert.equal(route.scores, null)
  assert.equal(route.gap, null)
  assert.equal(route.backend, 'claude-code')
})
