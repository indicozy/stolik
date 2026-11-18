// The route point through the router (design §4.4): the 30-minute rule first, then a name in the text (a live session
// forwards; a folder gets one-tap Full / Read-only buttons), then the router addon's model pick, which only preselects
// ("Send to" or "Start", with buttons), else the buttons. The model's confidence decides nothing. Also the paged folder
// picker's ＋ and 👁 starting sessions.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ButtonPress } from '../src/brain/chat-types.ts'
import { MINUTE } from '../src/brain/common.ts'
import type { AddonInfo, AddonsPort, RouteAnswer, RoutePayload } from '../src/ports.ts'
import { FakeConn, HOME, OWNER, flush, harness, textFrom } from './helpers/fakes.ts'
import { tgMsg } from '../src/adapters/chat/tg-ids.ts'

const PROJ = `${HOME}/proj`
const OTHER = `${HOME}/other`
const MASTER = `${HOME}/Documents/projects/master`

class RouteAddons implements AddonsPort {
  readonly calls: RoutePayload[] = []
  answer: (RouteAnswer & { addon: string }) | null = null
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  list(): AddonInfo[] {
    return []
  }
  async setEnabled(): Promise<string | null> {
    return null
  }
  async general(): Promise<string | null> {
    return null
  }
  async route(p: RoutePayload): Promise<(RouteAnswer & { addon: string }) | null> {
    this.calls.push(p)
    return this.answer
  }
}

function register(h: ReturnType<typeof harness>, cwd: string, pid: number): FakeConn {
  h.platform.dirs.add(cwd)
  const conn = new FakeConn()
  h.agent.receive(conn, { t: 'register', claudePid: pid, cwd })
  return conn
}

async function tap(h: ReturnType<typeof harness>, data: string, messageId: number, id = 'cb') {
  await h.chat.callback({ pressId: id, data, message: tgMsg(messageId), from: OWNER } as ButtonPress)
  await flush()
}

const addonAnswer = (a: Partial<RouteAnswer> & { addon?: string }): RouteAnswer & { addon: string } => ({
  target: null,
  confidence: 1,
  reason: 'test',
  addon: 'router',
  ...a,
})

test('the 30-minute rule comes first: a single active session is forwarded and the route addon is not asked', async () => {
  const addons = new RouteAddons()
  addons.answer = addonAnswer({ target: { kind: 'new', folder: MASTER } })
  const h = harness({ addons })
  await h.router.start()
  h.agent.trusted.add(PROJ)
  register(h, PROJ, 4001)
  await flush()
  await h.chat.inbound(textFrom('just this one', { messageId: tgMsg(10) }))
  assert.deepEqual(addons.calls, [])
  assert.equal(h.agent.sent.length, 1)
  assert.equal(h.audit.events.filter((e) => e.event === 'route').at(-1)?.source, 'rule')
})

test('a name in the text is matched before the route addon is asked: a live session it names is forwarded with "wrong one?"', async () => {
  const addons = new RouteAddons()
  const h = harness({ addons })
  await h.router.start()
  h.agent.trusted.add(PROJ)
  h.agent.trusted.add(OTHER)
  register(h, PROJ, 4001)
  register(h, OTHER, 4002)
  h.clock.advance(40 * MINUTE) // neither is active now: the rule does not forward
  await flush()
  await h.chat.inbound(textFrom('discuss other and its backlog', { messageId: tgMsg(11) }))
  assert.deepEqual(addons.calls, [], 'the addon is not asked')
  assert.equal(h.agent.sent.at(-1)?.key, '4002:start-4002')
  assert.ok(h.chat.sent.some((s) => s.text === '→ [other]'), 'the confirmation with wrong one?')
  const ev = h.audit.events.filter((e) => e.event === 'route').at(-1)
  assert.equal(ev?.source, 'match')
  assert.equal(ev?.decision, 'forward')
})

test('the route addon names a live session: "Send to" waits for Yes, whatever its confidence; Yes forwards and offers "wrong one?"', async () => {
  const addons = new RouteAddons()
  const h = harness({ addons })
  await h.router.start()
  h.agent.trusted.add(PROJ)
  h.agent.trusted.add(OTHER)
  register(h, PROJ, 4001)
  register(h, OTHER, 4002)
  h.clock.advance(40 * MINUTE)
  await flush()
  addons.answer = addonAnswer({ target: { kind: 'session', name: 'other' }, confidence: 1 })
  await h.chat.inbound(textFrom('the backlog one', { messageId: tgMsg(11) }))
  assert.equal(addons.calls.length, 1)
  assert.equal(addons.calls[0].text, 'the backlog one')
  assert.deepEqual(addons.calls[0].sessions.map((s) => s.name).sort(), ['other', 'proj'])
  assert.deepEqual(h.agent.sent, [], 'nothing is sent before the tap')
  const ask = h.chat.sent.find((s) => s.text === 'Send to other?')!
  assert.deepEqual(ask.opts?.rows?.[0].map((b) => b.text), ['Yes', 'Other…'])

  await tap(h, ask.opts!.rows![0][0].data, ask.id)
  assert.equal(h.agent.sent.length, 1)
  assert.equal(h.agent.sent[0].key, '4002:start-4002')
  assert.equal(h.agent.sent[0].content, 'the backlog one')
  assert.ok(h.chat.rowEdits.some((e) => e.text === '→ [other]' && e.rows[0][0].text === '↩ wrong one?'), 'the confirmation keeps wrong one?')
  const ev = h.audit.events.filter((e) => e.event === 'route')
  assert.deepEqual(ev.slice(-2).map((e) => [e.decision, e.source]), [['confirm', 'model'], ['forward', 'model']])
  assert.equal(ev.at(-2)?.session, 'other')
  assert.equal(ev.at(-2)?.confidence, 1)
})

test('the route addon names a new folder: "Start" waits for a tap; Full starts it with the message as its first prompt', async () => {
  const addons = new RouteAddons()
  const h = harness({ addons, startWhenNoSession: false })
  await h.router.start()
  h.agent.trusted.add(PROJ)
  h.agent.trusted.add(MASTER)
  h.platform.dirs.add(PROJ)
  h.platform.dirs.add(MASTER)
  addons.answer = addonAnswer({ target: { kind: 'new', folder: PROJ }, confidence: 0.99 })
  await h.chat.inbound(textFrom('start the parser plan', { messageId: tgMsg(12) }))
  assert.deepEqual(h.agent.startedSessions, [], 'nothing starts by itself')
  const ask = h.chat.sent.find((s) => s.text === 'Start proj?')!
  assert.deepEqual(ask.opts?.rows?.[0].map((b) => b.text), ['Full', '👁 Read-only', 'Other…'])

  await tap(h, ask.opts!.rows![0][0].data, ask.id) // Full
  assert.deepEqual(h.agent.startedSessions, [{ project: 'proj', dir: PROJ, extra: [] }])
  const conn = new FakeConn()
  h.agent.receive(conn, { t: 'register', claudePid: 7070, cwd: PROJ, spawnToken: h.agent.spawnTokens[0] })
  h.clock.advance(1000)
  await flush()
  assert.equal(h.agent.sent.at(-1)?.key, '7070:start-7070')
  assert.equal(h.agent.sent.at(-1)?.content, 'start the parser plan')
  assert.equal(h.audit.events.filter((e) => e.event === 'route').at(-1)?.decision, 'start')
})

test('Other… on a "Send to" confirm opens the session buttons; Other… on a "Start" confirm opens the folder picker', async () => {
  const addons = new RouteAddons()
  const h = harness({ addons })
  await h.router.start()
  h.agent.trusted.add(PROJ)
  h.agent.trusted.add(MASTER)
  h.platform.dirs.add(PROJ)
  h.platform.dirs.add(MASTER)
  register(h, OTHER, 4002)
  h.platform.dirs.add(OTHER)
  h.clock.advance(40 * MINUTE)
  await flush()
  addons.answer = addonAnswer({ target: { kind: 'session', name: 'other' } })
  await h.chat.inbound(textFrom('a vague one', { messageId: tgMsg(13) }))
  const send = h.chat.sent.find((s) => s.text === 'Send to other?')!
  await tap(h, send.opts!.rows![0][1].data, send.id) // Other…
  const buttons = h.chat.rowEdits.find((e) => e.text === 'Which one?')!
  assert.deepEqual(buttons.rows[0].map((b) => b.text), ['other'])

  addons.answer = addonAnswer({ target: { kind: 'new', folder: PROJ } })
  await h.chat.inbound(textFrom('something for proj', { messageId: tgMsg(14) }))
  const start = h.chat.sent.find((s) => s.text === 'Start proj?')!
  await tap(h, start.opts!.rows![0][2].data, start.id) // Other…
  const picker = h.chat.rowEdits.find((e) => e.text === 'Start a session in which folder?')
  assert.ok(picker, 'the folder picker opens')
  assert.deepEqual(h.agent.startedSessions, [], 'still nothing started')
})

test('the route addon gives no target, no usable answer, or a target that is not live or trusted: the buttons', async () => {
  for (const answer of [addonAnswer({ target: null, confidence: 0.99 }), null] as const) {
    const addons = new RouteAddons()
    addons.answer = answer
    const h = harness({ addons })
    await h.router.start()
    register(h, PROJ, 4001)
    register(h, OTHER, 4002)
    await flush()
    h.clock.advance(40 * MINUTE)
    await flush()
    await h.chat.inbound(textFrom('hmm', { messageId: tgMsg(13) }))
    assert.equal(h.agent.sent.length, 0)
    assert.equal(h.chat.sent.at(-1)?.text, 'Which one?')
  }
  const h = harness()
  await h.router.start()
  await h.chat.inbound(textFrom('no addon at all', { messageId: tgMsg(14) }))
  assert.equal(h.chat.sent.at(-1)?.text, 'No session can take it right now. Start one with New…, or ask quick, read or web.')
  assert.equal(h.audit.events.filter((e) => e.event === 'route').at(-1)?.decision, 'buttons')
})

test('the route addon: a target that is no longer a live session or a trusted folder falls back to the buttons', async () => {
  const addons = new RouteAddons()
  addons.answer = addonAnswer({ target: { kind: 'new', folder: '/not/trusted' }, confidence: 0.99 })
  const h = harness({ addons })
  await h.router.start()
  await h.chat.inbound(textFrom('go there', { messageId: tgMsg(15) }))
  assert.deepEqual(h.agent.startedSessions, [])
  assert.equal(h.chat.sent.at(-1)?.text, 'No session can take it right now. Start one with New…, or ask quick, read or web.')
})

test('the picker: ＋ of a row starts Full at once, 👁 starts read-only, and ◀ ▶ turn the page in place', async () => {
  const h = harness()
  await h.router.start()
  const dirs = [MASTER, ...Array.from({ length: 9 }, (_, i) => `${HOME}/w${i}`)]
  for (const d of dirs) {
    h.agent.trusted.add(d)
    h.platform.dirs.add(d)
  }
  await h.chat.inbound(textFrom('pick one', { messageId: tgMsg(16) }))
  const ask = h.chat.sent[0]
  await tap(h, ask.opts!.rows!.find((r) => r[0].text === 'New…')![0].data, ask.id)
  const first = h.chat.rowEdits.find((e) => e.text === 'Start a session in which folder? (page 1 of 2)')!
  assert.deepEqual(first.rows[0].map((b) => b.text), ['＋ master', '👁'], 'master first')
  const next = first.rows.at(-1)![0]
  assert.equal(next.text, '▶')
  await tap(h, next.data, ask.id)
  const second = h.chat.rowEdits.at(-1)!
  assert.equal(second.text, 'Start a session in which folder? (page 2 of 2)')
  assert.equal(second.rows[0][0].text, '＋ w7', 'page 2 starts after master and w0 to w6')
  await tap(h, second.rows[0][1].data, ask.id) // 👁 on w7, read-only
  assert.deepEqual(h.agent.startedSessions, [{ project: 'w7', dir: `${HOME}/w7`, extra: ['--permission-mode', 'plan'] }])
})

test('the picker orders the folders by recent activity after master', async () => {
  const h = harness()
  await h.router.start()
  h.agent.trusted.add(OTHER)
  h.agent.trusted.add(PROJ)
  h.agent.trusted.add(MASTER)
  for (const d of [OTHER, PROJ, MASTER]) h.platform.dirs.add(d)
  h.agent.transcripts = [
    { id: '11111111-1111-4111-8111-111111111111', path: '/x', cwd: PROJ, title: 't', mtime: 2_000, entrypoint: 'cli' },
    { id: '22222222-2222-4222-8222-222222222222', path: '/y', cwd: OTHER, title: 't', mtime: 1_000, entrypoint: 'cli' },
  ]
  await h.chat.inbound(textFrom('order?', { messageId: tgMsg(17) }))
  const ask = h.chat.sent[0]
  await tap(h, ask.opts!.rows!.find((r) => r[0].text === 'New…')![0].data, ask.id)
  const picker = h.chat.rowEdits.find((e) => e.text === 'Start a session in which folder?')!
  assert.deepEqual(picker.rows.map((r) => r[0].text), ['＋ master', '＋ proj', '＋ other'])
})
