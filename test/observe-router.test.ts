// The router side of observability: traces on the flows, /trace (a reply), /debug, spawn forensics, the Logs topic at start,
// and the doctor's start-up checks. The router is built from the fakes with the observability deps.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Router, type RouterDeps } from '../src/router/core.ts'
import { spawnFor } from '../src/router/spawn.ts'
import { debugCommand } from '../src/router/handlers/debug.ts'
import { LogsTopic } from '../src/router/logs-topic.ts'
import { TracedChat } from '../src/router/traced-chat.ts'
import { configureLog, debugUntil, effectiveLevel, emit, readEntries, routerLogPath, setDebugUntil, warn } from '../src/router/log.ts'
import { runTraced } from '../src/brain/observe.ts'
import type { Check } from '../src/brain/observe.ts'
import type { TraceRecord } from '../src/ports.ts'
import { tgChat, tgMsg, tgThread } from '../src/adapters/chat/tg-ids.ts'
import { FakeAgent, FakeAudit, FakeClock, FakeLogger, FakePlatform, FakeStore, FakeChat, HOME, OWNER, flush, textFrom } from './helpers/fakes.ts'
import type { Inbound } from '../src/brain/chat-types.ts'

const GROUP = -100777
const GROUP_CHAT = { kind: 'home' as const, id: String(GROUP), thread: null }

class Traces {
  records: TraceRecord[] = []
  pruned: number[] = []
  recordTrace(r: TraceRecord): void {
    this.records.push(r)
  }
  tracesForMessage(id: string): TraceRecord[] {
    return this.records.filter((r) => r.messageId === id)
  }
  pruneTraces(before: number): void {
    this.pruned.push(before)
  }
}

type Wired = {
  router: Router
  chat: FakeChat
  store: FakeStore
  agent: FakeAgent
  clock: FakeClock
  logger: FakeLogger
  traces: Traces
  forensics: Array<Parameters<NonNullable<RouterDeps['forensics']>>[0]>
}

// A router over the fakes, with the observability deps. `group` makes the group bound at start.
function wired(extra: Partial<RouterDeps> = {}, group: number | null = null): Wired {
  const chat = new FakeChat()
  const store = new FakeStore()
  const agent = new FakeAgent()
  const clock = new FakeClock()
  const logger = new FakeLogger()
  const traces = new Traces()
  const forensics: Wired['forensics'] = []
  const router = new Router({
    ownerId: OWNER,
    groupId: group === null ? null : tgChat(group),
    secrets: ['SECRET-TOKEN'],
    home: HOME,
    socketPath: '/fake/router.sock',
    chat: new TracedChat(chat, traces),
    store,
    platform: new FakePlatform(),
    agent,
    ml: { transcribe: async () => '', close: () => {} },
    clock,
    audit: new FakeAudit(),
    logger,
    traces,
    forensics: async (req) => {
      forensics.push(req)
      return '/state/forensics/f.txt'
    },
    ...extra,
  })
  return { router, chat, store, agent, clock, logger, traces, forensics }
}

const inboundAt = (text: string, over: Partial<Inbound> = {}): Inbound => textFrom(text, over)

// Drives one message through the router's own entry point (it starts its own trace, as the Telegram adapter's does).
async function send(w: Wired, m: Inbound): Promise<void> {
  await w.chat.inbound(m)
  await flush()
}

test('a message in starts a trace: the trace map records the Telegram id, and the journal line carries the trace', async () => {
  const w = wired()
  await w.router.start()
  await send(w, inboundAt('hello there', { messageId: tgMsg(4001) }))
  const rec = w.traces.records.find((r) => r.messageId === tgMsg(4001) && r.dir === 'in')
  assert.ok(rec, 'the inbound id is mapped')
  assert.match(rec.trace, /^[0-9a-f]{8}$/)
  const journal = readEntries([routerLogPath()]).filter((e) => e.trace === rec.trace)
  assert.ok(journal.some((e) => /inbound text in DM/.test(e.msg)), 'the ingress line has the trace')
})

test('/trace as a reply: answers with the timeline of the message replied to, from the log files', async () => {
  const w = wired()
  await w.router.start()
  const trace = 'cafe0001'
  // The flow of message 5001 (its log lines name the trace; /trace reads them back).
  runTraced(trace, () => {
    emit('info', 'route', 'chose the session', { session: 'shop' })
    emit('info', 'deliver', 'delivered to shop')
  })
  w.traces.recordTrace({ messageId: tgMsg(5001), dir: 'in', trace, at: 1 })
  await send(w, inboundAt('/trace', { messageId: tgMsg(5002), replyToId: tgMsg(5001) }))
  const answer = w.chat.sent.at(-1)
  assert.ok(answer)
  assert.match(answer.text, /^trace cafe0001/)
  assert.match(answer.text, /route: chose the session session=shop/)
  assert.match(answer.text, /deliver: delivered to shop/)
})

test('/trace: no reply gives the usage line; a message with no trace kept says so', async () => {
  const w = wired()
  await w.router.start()
  await send(w, inboundAt('/trace', { messageId: tgMsg(5100) }))
  assert.match(w.chat.sent.at(-1)?.text ?? '', /Reply to a message with \/trace/)
  await send(w, inboundAt('/trace', { messageId: tgMsg(5101), replyToId: tgMsg(9999) }))
  assert.match(w.chat.sent.at(-1)?.text ?? '', /No trace is kept for that message/)
})

test('/trace works in a session topic too (topics do not parse commands; /trace is the exception)', async () => {
  const w = wired({}, GROUP)
  await w.router.start()
  w.traces.recordTrace({ messageId: tgMsg(5200), dir: 'in', trace: 'beef0002', at: 1 })
  const topicMsg = inboundAt('/trace', { messageId: tgMsg(5201), replyToId: tgMsg(5200), chat: { kind: 'home', id: tgChat(GROUP), thread: tgThread(77) } })
  await send(w, topicMsg)
  assert.match(w.chat.sent.at(-1)?.text ?? '', /^trace beef0002/)
})

test('/debug: the report names the level, sessions, addons, queues, ML worker and quota; on, off and bad arguments', async () => {
  const w = wired({
    debugExtras: async () => ({
      version: '0.1.0', gitSha: 'abc1234', queues: { group: 2 }, quota: { weeklyUsedPct: 41, aheadBy: 0 },
      ml: { ok: false, reason: 'not installed' },
    }),
  })
  await w.router.start()
  await send(w, inboundAt('/debug', { messageId: tgMsg(6001) }))
  const report = w.chat.sent.map((s) => s.text).join('\n')
  assert.match(report, /stolik 0\.1\.0 \(abc1234\)/)
  assert.match(report, /log level: info/)
  assert.match(report, /sessions \(0\)/)
  assert.match(report, /addons \(0\)/)
  assert.match(report, /outbound queue: group 2/)
  assert.match(report, /ml-worker: not installed/)
  assert.match(report, /quota: week 41% used/)
  assert.match(report, /logs topic: off/)

  await send(w, inboundAt('/debug on 15', { messageId: tgMsg(6002) }))
  assert.match(w.chat.sent.at(-1)?.text ?? '', /Debug logging on until \d\d:\d\d \(15 min\)/)
  assert.ok(debugUntil() > Date.now())
  assert.equal(effectiveLevel(), 'debug')
  await send(w, inboundAt('/debug off', { messageId: tgMsg(6003) }))
  assert.equal(w.chat.sent.at(-1)?.text, 'Debug logging off.')
  assert.equal(effectiveLevel(), 'info')
  await send(w, inboundAt('/debug banana', { messageId: tgMsg(6004) }))
  assert.match(w.chat.sent.at(-1)?.text ?? '', /Usage: \/debug/)
  setDebugUntil(0)
})

test('/debug without the composition root still answers, with what the router knows', async () => {
  const w = wired()
  await w.router.start()
  const m = inboundAt('/debug', { messageId: tgMsg(6100) })
  await debugCommand(w.router, '', m)
  const text = w.chat.sent.at(-1)?.text ?? ''
  assert.match(text, /stolik unknown/)
  assert.match(text, /ml-worker: not available/)
})

test('a failed start writes forensics: the failure message names the file, and the log names it too', async () => {
  const w = wired()
  await w.router.start()
  w.agent.trusted.add('/home/u/shop')
  w.agent.startSession = async () => {
    throw new Error('tmux new-session failed: no server running')
  }
  await runTraced('feed0003', () => spawnFor(w.router, 'shop', '/home/u/shop', inboundAt('hi', { messageId: tgMsg(7001) }), 'hi'))
  await flush()
  assert.equal(w.forensics.length, 1)
  assert.equal(w.forensics[0].project, 'shop')
  assert.equal(w.forensics[0].cwd, '/home/u/shop')
  assert.match(w.chat.sent.at(-1)?.text ?? '', /shop didn't start: tmux new-session failed: no server running\. The message wasn't delivered\. Forensics: \/state\/forensics\/f\.txt/)
  assert.ok(w.logger.lines.some((l) => /didn't start.*Forensics: \/state\/forensics\/f\.txt/.test(l)))
})

test('a failed start with no forensics writer still reports the failure', async () => {
  const w = wired({ forensics: undefined })
  await w.router.start()
  w.agent.trusted.add('/home/u/shop')
  w.agent.startSession = async () => {
    throw new Error('boom')
  }
  await spawnFor(w.router, 'shop', '/home/u/shop', inboundAt('hi', { messageId: tgMsg(7101) }), 'hi')
  assert.match(w.chat.sent.at(-1)?.text ?? '', /shop didn't start: boom\./)
})

test('start: the Logs topic is made in the bound group, and the start-up checks run; failures are logged', async () => {
  const checks: Check[] = [
    { id: 'ok', title: 'fine', status: 'ok', detail: 'ok' },
    { id: 'sock', title: 'socket path', status: 'fail', detail: 'folder missing' },
    { id: 'disk', title: 'disk: state folder', status: 'warn', detail: '500 MiB free' },
  ]
  const store = new FakeStore()
  const logsStore = { value: null as string | null, get() { return this.value }, set(id: string) { this.value = id } }
  const chat = new FakeChat()
  const logsTopic = new LogsTopic({ chat, store: logsStore, enabled: true, groupId: () => tgChat(GROUP), clock: { setTimer: () => 0, clearTimer: () => {} } })
  const w = wired({ startupChecks: async () => checks, logsTopic }, GROUP)
  // The Logs topic talks through the same fake Telegram the router uses.
  void store
  await w.router.start()
  await flush()
  await flush()
  assert.equal(logsStore.value, tgThread(100), 'the topic id is stored')
  assert.ok(w.logger.lines.some((l) => l.includes('doctor: socket path: folder missing')))
  assert.ok(w.logger.lines.some((l) => l.includes('doctor: disk: state folder: 500 MiB free')))
  assert.ok(w.logger.lines.some((l) => /doctor: 2 start-up checks need attention/.test(l)))
})

test('start: a start-up check that throws is reported, and the router still starts', async () => {
  const w = wired({ startupChecks: async () => { throw new Error('probe broke') } })
  await w.router.start()
  assert.ok(w.logger.lines.some((l) => l.includes('start-up checks did not run: probe broke')))
})

test('the trace map is pruned by the sweep at most once an hour', async () => {
  const w = wired()
  await w.router.start()
  const { sweep } = await import('../src/router/handlers/timers.ts')
  sweep(w.router)
  sweep(w.router)
  assert.equal(w.traces.pruned.length, 1)
  w.clock.t += 3_600_000
  sweep(w.router)
  assert.equal(w.traces.pruned.length, 2)
})

test('warnings from the router reach the sink with their component; configureLog can be reset', () => {
  const seen: string[] = []
  configureLog({ level: 'info', sink: (r) => seen.push(`${r.level}:${r.component}`) })
  warn('x', 'quota')
  configureLog({ sink: null })
  warn('y', 'quota')
  assert.deepEqual(seen, ['warn:quota'])
})

// Cleanup of the folders some tests make under the isolated state folder.
test('cleanup', () => {
  rmSync(join(process.env.XDG_STATE_HOME as string, 'forensics'), { recursive: true, force: true })
  mkdirSync(process.env.XDG_STATE_HOME as string, { recursive: true })
})

const PRIVACY_WARN: Check = {
  id: 'members',
  title: 'group members',
  status: 'warn',
  detail: '4 members; expected 2 (you and the bot). fix: remove the others, or use a group only you are in',
  group: 'privacy',
}

// Privacy findings (decision 12): posted to the owner once per change in the set, not on every start.
test('privacy: a finding is posted to the owner once, and an unchanged state is not re-posted', async () => {
  let current: Check[] = [PRIVACY_WARN]
  const w = wired({ startupChecks: async () => current }, GROUP)
  await w.router.runStartupChecks()
  await w.router.runStartupChecks()
  const posts = w.chat.sent.filter((s) => s.text.startsWith('Privacy check'))
  assert.equal(posts.length, 1)
  assert.match(posts[0]!.text, /remove the others/)
  assert.notEqual(w.store.privacyJson, '')
  assert.ok(w.logger.lines.some((l) => l.includes('doctor: group members:')), 'the finding is logged')
})

test('privacy: a cleared state forgets the finding, so its recurrence is posted again', async () => {
  let current: Check[] = [PRIVACY_WARN]
  const w = wired({ startupChecks: async () => current }, GROUP)
  await w.router.runStartupChecks()
  current = [{ id: 'members', title: 'group members', status: 'ok', detail: '2 (the owner and the bot)', group: 'privacy' }]
  await w.router.runStartupChecks()
  assert.equal(w.store.privacyJson, '')
  current = [PRIVACY_WARN]
  await w.router.runStartupChecks()
  assert.equal(w.chat.sent.filter((s) => s.text.startsWith('Privacy check')).length, 2)
})

test('privacy: "not checked" results are logged but never posted', async () => {
  const w = wired({ startupChecks: async () => [{ ...PRIVACY_WARN, detail: 'not checked: 503 Service Unavailable' }] }, GROUP)
  await w.router.runStartupChecks()
  assert.equal(w.chat.sent.filter((s) => s.text.startsWith('Privacy check')).length, 0)
  assert.equal(w.store.privacyJson, '')
})

test('privacy: nothing is posted before the owner pairs, and it is posted after', async () => {
  let current: Check[] = [PRIVACY_WARN]
  const w = wired({ startupChecks: async () => current, ownerId: '' as never }, GROUP)
  await w.router.runStartupChecks()
  assert.equal(w.chat.sent.filter((s) => s.text.startsWith('Privacy check')).length, 0)
  assert.equal(w.store.privacyJson, '')
  assert.ok(w.logger.lines.some((l) => l.includes('not paired yet')))
})
