// The sinks of the log: the Logs topic (src/router/logs-topic.ts), the traced Telegram decorator (src/router/traced-chat.ts)
// and spawn forensics (src/router/forensics.ts).
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FakeChat } from './helpers/fakes.ts'
import { LOGS_TOPIC_NAME, LogsTopic, topicLine, type LogsThreadStore } from '../src/router/logs-topic.ts'
import { ChatError, type ThreadId } from '../src/brain/chat-types.ts'
import { tgThread } from '../src/adapters/chat/tg-ids.ts'
import { TracedChat, httpStatusOf } from '../src/router/traced-chat.ts'
import { writeForensics } from '../src/router/forensics.ts'
import { configureLog, type LogRecord } from '../src/router/log.ts'
import { runTraced } from '../src/brain/observe.ts'
import type { TraceRecord } from '../src/ports.ts'

class Clock {
  timers: Array<{ fn: () => void; ms: number; id: number }> = []
  private n = 0
  setTimer(fn: () => void, ms: number): unknown {
    const id = ++this.n
    this.timers.push({ fn, ms, id })
    return id
  }
  clearTimer(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle)
  }
  fire(): void {
    const due = this.timers
    this.timers = []
    for (const t of due) t.fn()
  }
}

function memStore(initial: number | null = null): LogsThreadStore & { value: ThreadId | null } {
  const s = {
    value: initial === null ? null : tgThread(initial),
    get(): ThreadId | null {
      return s.value
    },
    set(id: ThreadId): void {
      s.value = id
    },
  }
  return s
}

const rec = (over: Partial<LogRecord> = {}): LogRecord => ({
  ts: '2026-11-14T10:00:00.000Z', level: 'warn', component: 'spawn', msg: "p didn't start", fields: {}, ...over,
})

// Lets the topic's queued sends run.
const settle = () => new Promise((r) => setImmediate(r))

// A Telegram where a chosen thread is gone (deleted by hand), and where a report from inside a send is possible.
class ThreadGoneTelegram extends FakeChat {
  goneThread: ThreadId | null = null
  onSend: (() => void) | null = null
  override async sendText(text: string, opts?: Parameters<FakeChat['sendText']>[1]): Promise<number> {
    this.onSend?.()
    if (opts?.thread !== undefined && opts.thread === this.goneThread) throw new ChatError('thread-closed', 'Bad Request: message thread not found')
    return super.sendText(text, opts)
  }
}

test('Logs topic: the first line makes the topic, stores its id, and ends with the trace id', async () => {
  const tg = new FakeChat()
  tg.group = -100123
  const store = memStore()
  const clock = new Clock()
  const topic = new LogsTopic({ chat: tg, store, enabled: true, groupId: () => -100123, clock })
  topic.report(rec({ trace: 'a1b2c3d4' }))
  await settle()
  assert.equal(store.value, tgThread(100))
  assert.deepEqual(tg.topicOps.map((o) => [o.op, o.name]), [['create', LOGS_TOPIC_NAME]])
  assert.equal(tg.sent.length, 1)
  assert.equal(tg.sent[0].opts?.thread, tgThread(100))
  assert.equal(tg.sent[0].opts?.quiet, true)
  assert.equal(tg.sent[0].chat, 'group')
  assert.equal(tg.sent[0].text, "⚠️ spawn: p didn't start · trace a1b2c3d4")
})

test('Logs topic: an existing topic is reused; no trace means no trace suffix; errors get the error icon', async () => {
  const tg = new FakeChat()
  tg.group = -100123
  const store = memStore(7)
  const topic = new LogsTopic({ chat: tg, store, enabled: true, groupId: () => -100123, clock: new Clock() })
  topic.report(rec({ level: 'error', component: 'addons', msg: 'disabled' }))
  await settle()
  assert.deepEqual(tg.topicOps, [])
  assert.equal(tg.sent[0].opts?.thread, tgThread(7))
  assert.equal(tg.sent[0].text, '❌ addons: disabled')
})

test('Logs topic: the same message within 5 minutes is counted, and the count is reported on its next send', async () => {
  const tg = new FakeChat()
  tg.group = -100123
  let now = 1_000_000
  const topic = new LogsTopic({ chat: tg, store: memStore(5), enabled: true, groupId: () => -100123, clock: new Clock(), now: () => now })
  topic.report(rec())
  topic.report(rec())
  topic.report(rec())
  await settle()
  assert.equal(tg.sent.length, 1)
  now += 6 * 60_000
  topic.report(rec())
  await settle()
  assert.equal(tg.sent.length, 2)
  assert.match(tg.sent[1].text, /\(\+2 similar in the last 5 min\)/)
})

test('Logs topic: more than 10 lines a minute are dropped, and one roll-up line says how many', async () => {
  const tg = new FakeChat()
  tg.group = -100123
  const clock = new Clock()
  const topic = new LogsTopic({ chat: tg, store: memStore(5), enabled: true, groupId: () => -100123, clock })
  for (let i = 0; i < 12; i++) topic.report(rec({ msg: `distinct ${i}` }))
  await settle()
  assert.equal(tg.sent.length, 10)
  assert.equal(clock.timers.length, 1, 'a roll-up is scheduled')
  clock.fire()
  await settle()
  assert.equal(tg.sent.length, 11)
  assert.match(tg.sent[10].text, /… 2 more warnings and errors suppressed in the last minute/)
})

test('Logs topic: a deleted topic is made again and the line goes to the new one', async () => {
  const tg = new ThreadGoneTelegram()
  tg.group = -100123
  tg.goneThread = tgThread(5)
  const store = memStore(5)
  const topic = new LogsTopic({ chat: tg, store, enabled: true, groupId: () => -100123, clock: new Clock() })
  topic.report(rec({ msg: 'after the deletion' }))
  await settle()
  assert.equal(store.value, tgThread(100), 'the new topic is stored')
  assert.deepEqual(tg.topicOps.map((o) => o.op), ['create'])
  assert.equal(tg.sent.at(-1)?.opts?.thread, tgThread(100))
  assert.match(tg.sent.at(-1)?.text ?? '', /after the deletion/)
})

test('Logs topic: a line that fails for another reason is not retried in a loop', async () => {
  const tg = new ThreadGoneTelegram()
  tg.group = -100123
  tg.sendText = async () => {
    throw new Error('network down')
  }
  const topic = new LogsTopic({ chat: tg, store: memStore(5), enabled: true, groupId: () => -100123, clock: new Clock() })
  topic.report(rec())
  await settle()
  assert.equal(tg.topicOps.length, 0, 'no topic is made for a network error')
})

test('Logs topic: when the topic cannot be made again, the line is dropped once: no retry loop', async () => {
  const tg = new ThreadGoneTelegram()
  tg.group = -100123
  tg.goneThread = tgThread(5)
  let creates = 0
  tg.createThread = async () => {
    creates++
    throw new Error('Forbidden: not enough rights')
  }
  const topic = new LogsTopic({ chat: tg, store: memStore(5), enabled: true, groupId: () => -100123, clock: new Clock() })
  topic.report(rec({ msg: 'one' }))
  topic.report(rec({ msg: 'two' }))
  await settle()
  await settle()
  assert.equal(creates, 2, 'one attempt to make a topic per queued line, no more')
  assert.equal(tg.sent.length, 0)
})

test('Logs topic: DM mode posts Telegram send errors only, to the owner, with the stricter limit', async () => {
  const tg = new FakeChat()
  const clock = new Clock()
  const topic = new LogsTopic({ chat: tg, store: memStore(), enabled: true, groupId: () => null, clock })
  topic.report(rec({ component: 'spawn' }))
  topic.report(rec({ component: 'telegram', msg: 'send failed: HTTP 429' }))
  for (let i = 0; i < 5; i++) topic.report(rec({ component: 'telegram', msg: `e${i}` }))
  await settle()
  assert.equal(tg.topicOps.length, 0)
  assert.equal(tg.sent.every((s) => s.chat === 'dm' && s.opts?.dm === true && s.opts?.quiet === true), true)
  assert.equal(tg.sent.length, 3, 'the DM limit is 3 a minute; other components are not posted')
  assert.equal(clock.timers.length, 1, 'the roll-up for the dropped ones is scheduled')
})

test('Logs topic: disabled posts nothing; ensure makes the topic only when the group is bound and none is stored', async () => {
  const off = new FakeChat()
  off.group = -100123
  const disabled = new LogsTopic({ chat: off, store: memStore(), enabled: false, groupId: () => -100123, clock: new Clock() })
  disabled.report(rec())
  await settle()
  assert.equal(off.sent.length, 0)
  await disabled.ensure()
  assert.equal(off.topicOps.length, 0)

  const tg = new FakeChat()
  const store = memStore()
  let group: number | null = null
  const topic = new LogsTopic({ chat: tg, store, enabled: true, groupId: () => group, clock: new Clock() })
  await topic.ensure()
  assert.equal(tg.topicOps.length, 0, 'DM mode makes no topic')
  group = -100555
  await topic.ensure()
  assert.equal(tg.topicOps.length, 1)
  assert.equal(store.value, tgThread(100))
  await topic.ensure()
  assert.equal(tg.topicOps.length, 1, 'an existing topic is kept')
})

test('Logs topic: a failure to make the topic is logged, not thrown', async () => {
  const tg = new FakeChat()
  tg.group = -100123
  tg.createThread = async () => {
    throw new Error('Forbidden: not enough rights')
  }
  const topic = new LogsTopic({ chat: tg, store: memStore(), enabled: true, groupId: () => -100123, clock: new Clock() })
  await topic.ensure()
  await assert.doesNotReject(async () => topic.report(rec()))
})

test('topicLine', () => {
  assert.equal(topicLine({ level: 'warn', component: 'c', msg: 'm' }, 0), '⚠️ c: m')
  assert.equal(topicLine({ level: 'error', component: 'c', msg: 'm', trace: 'a1b2c3d4' }, 3), '❌ c: m (+3 similar in the last 5 min) · trace a1b2c3d4')
  assert.match(topicLine({ level: 'warn', component: 'c', msg: 'x'.repeat(2000) }, 0), /…/)
})

// ---------- traced Telegram ----------

class Recorder {
  readonly records: TraceRecord[] = []
  recordTrace(r: TraceRecord): void {
    this.records.push(r)
  }
  tracesForMessage(id: number): TraceRecord[] {
    return this.records.filter((r) => r.messageId === id)
  }
  pruneTraces(): void {}
}

test('traced Telegram: a sent message is mapped to the trace of the flow that sent it', async () => {
  const tg = new FakeChat()
  const sink = new Recorder()
  const traced = new TracedChat(tg, sink, () => 42)
  const id = await runTraced('abcdef01', () => traced.sendText('hello'))
  assert.deepEqual(sink.records, [{ messageId: id, dir: 'out', trace: 'abcdef01', at: 42 }])
  // Outside a flow there is nothing to map.
  await traced.sendText('no flow')
  assert.equal(sink.records.length, 1)
})

test('traced Telegram: chunks and files are mapped too, each to the trace of the call', async () => {
  const tg = new FakeChat()
  const sink = new Recorder()
  const traced = new TracedChat(tg, sink, () => 1)
  const ids = await runTraced('11111111', () => traced.sendChunks(['a', 'b']))
  assert.equal(sink.records.filter((r) => r.trace === '11111111').length, ids.length)
  const fid = await runTraced('22222222', () => traced.sendFile('/x/y.png', true))
  assert.equal(sink.records.find((r) => r.messageId === fid)?.trace, '22222222')
})

test('traced Telegram: an HTTP error on a send is a warning with the status; a quiet send is not reported', async () => {
  const records: LogRecord[] = []
  configureLog({ level: 'info', sink: (r) => records.push(r) })
  const tg = new FakeChat()
  tg.sendText = async () => {
    throw new ChatError('access-lost', 'Bad Request: chat not found', { status: 400, description: 'Bad Request: chat not found' })
  }
  const traced = new TracedChat(tg, null)
  await assert.rejects(runTraced('33333333', () => traced.sendText('x')))
  await assert.rejects(traced.sendText('y', { quiet: true }))
  const warns = records.filter((r) => r.component === 'telegram')
  assert.equal(warns.length, 1)
  assert.equal(warns[0].level, 'warn')
  assert.match(warns[0].msg, /send failed: HTTP 400: Bad Request: chat not found/)
  assert.equal(warns[0].trace, '33333333')
  configureLog({ sink: null })
})

test('traced Telegram: a text group that stops on an HTTP error is a warning too (the cause is read from the chunk error)', async () => {
  const records: LogRecord[] = []
  configureLog({ level: 'info', sink: (r) => records.push(r) })
  const tg = new FakeChat()
  const { ChunkSendError } = await import('../src/brain/outbound-queue.ts')
  tg.sendChunks = async () => {
    throw new ChunkSendError(new ChatError('rate-limited', 'Too Many Requests', { status: 429, description: 'Too Many Requests: retry later', retryAfterMs: 1000 }), [1])
  }
  await assert.rejects(runTraced('44444444', () => new TracedChat(tg, null).sendChunks(['a', 'b'])))
  const warn = records.find((r) => r.component === 'telegram')
  assert.match(warn?.msg ?? '', /send failed: HTTP 429: Too Many Requests: retry later/)
  assert.equal(warn?.trace, '44444444')
  configureLog({ sink: null })
})

test('traced Telegram: a network error (no HTTP status) is not a warning here; the status helper reads error_code', async () => {
  const records: LogRecord[] = []
  configureLog({ level: 'info', sink: (r) => records.push(r) })
  const tg = new FakeChat()
  tg.sendText = async () => {
    throw new Error('socket hang up')
  }
  await assert.rejects(new TracedChat(tg, null).sendText('x'))
  assert.equal(records.filter((r) => r.component === 'telegram').length, 0)
  assert.equal(httpStatusOf(new ChatError('rate-limited', 'x', { status: 429, retryAfterMs: 1000 })), 429)
  assert.equal(httpStatusOf(new Error('x')), undefined)
  configureLog({ sink: null })
})

test('traced Telegram: a failed edit reports its HTTP status; the rest passes straight through', async () => {
  const records: LogRecord[] = []
  configureLog({ level: 'info', sink: (r) => records.push(r) })
  const tg = new FakeChat()
  tg.editText = async () => {
    throw new ChatError('other', 'x', { status: 500, description: 'Internal', transient: true })
  }
  const traced = new TracedChat(tg, null)
  await assert.rejects(traced.editText(1, 'a', null))
  assert.match(records.find((r) => r.component === 'telegram')?.msg ?? '', /edit failed: HTTP 500/)
  traced.setHome(-100)
  assert.equal(tg.group, -100)
  configureLog({ sink: null })
})

// ---------- forensics ----------

function forensicsDir(): string {
  return mkdtempSync(join(tmpdir(), 'forensics-test-'))
}

test('forensics: the file is written owner-only with the start, the names of the environment and PATH, and no secret values', async () => {
  const dir = forensicsDir()
  try {
    const path = await writeForensics(
      {
        dir: join(dir, 'forensics'),
        now: () => new Date('2026-11-14T10:00:00.000Z'),
        secrets: ['SUPERSECRETVALUE123'],
        env: { PATH: '/usr/bin', HOME: '/home/u', STOLIK_TOKEN: 'SUPERSECRETVALUE123' },
        claudeVersion: async () => '2.1.0 (Claude Code)',
      },
      {
        project: 'shop', cwd: '/home/u/shop', argv: ['tmux', 'new-session', '-d', '-s', 'tg-shop'], tmuxName: 'tg-shop',
        pane: ['Trust this folder? SUPERSECRETVALUE123'], reason: "it didn't connect within 90 s",
      },
    )
    assert.ok(path)
    assert.ok(existsSync(path as string))
    assert.equal(statSync(path as string).mode & 0o777, 0o600)
    const text = readFileSync(path as string, 'utf8')
    assert.match(text, /claude --version: 2\.1\.0 \(Claude Code\)/)
    assert.match(text, /PATH: \/usr\/bin/)
    assert.match(text, /^ {2}STOLIK_TOKEN$/m, 'the variable name is listed')
    assert.doesNotMatch(text, /SUPERSECRETVALUE123/, 'no secret value is written')
    assert.match(text, /\[REDACTED\]/)
    assert.match(readdirSync(join(dir, 'forensics'))[0], /^2026-11-14T10-00-00-000Z-shop\.txt$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('forensics: a missing claude version is written as not available; a failed write returns null', async () => {
  const dir = forensicsDir()
  try {
    const path = await writeForensics(
      { dir: join(dir, 'f'), now: () => new Date(), secrets: [], env: {}, claudeVersion: async () => null },
      { project: 'p', cwd: '/c', argv: [], tmuxName: null, pane: [], reason: 'r' },
    )
    assert.match(readFileSync(path as string, 'utf8'), /claude --version: \(not available\)/)
    // A folder that cannot be made (a file is in the way) gives null, not a throw.
    const blocker = join(dir, 'blocked')
    writeFileSync(blocker, 'x')
    const none = await writeForensics(
      { dir: join(blocker, 'sub'), now: () => new Date(), secrets: [], env: {}, claudeVersion: async () => null },
      { project: 'p', cwd: '/c', argv: [], tmuxName: null, pane: [], reason: 'r' },
    )
    assert.equal(none, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
