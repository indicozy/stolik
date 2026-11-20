// Choosing the harness when a session starts from chat (opencode backend, Task 4): the `oc <project>:` prefix, the
// harness buttons of the new-prefix question and the folder confirm, the callback data, the spawn's kind, and the
// config defaultAgent for the bot's own starts. Fakes only: no tmux, no Telegram.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ButtonPress } from '../src/brain/chat-types.ts'
import { parsePrefix } from '../src/brain/prefixes.ts'
import { launchRows, parseRouteCallback, startRows } from '../src/router/state.ts'
import { FakeAgent, HOME, OWNER, flush, harness, textFrom } from './helpers/fakes.ts'
import { tgMsg } from '../src/adapters/chat/tg-ids.ts'

const STOLIK = `${HOME}/stolik`

async function tap(h: ReturnType<typeof harness>, data: string, messageId: number, id = 'cb') {
  const c: ButtonPress = { pressId: id, data, message: tgMsg(messageId), from: OWNER }
  await h.chat.callback(c)
  await flush()
}

function trustStolik(h: ReturnType<typeof harness>): void {
  h.agent.trusted.add(STOLIK)
  h.platform.dirs.add(STOLIK)
}

test('parsePrefix: oc takes a name; new oc and new opencode are oc; new with another name stays new', () => {
  assert.deepEqual(parsePrefix('oc stolik: hi'), { kind: 'oc', name: 'stolik', body: 'hi' })
  assert.deepEqual(parsePrefix('new oc stolik: hi'), { kind: 'oc', name: 'stolik', body: 'hi' })
  assert.deepEqual(parsePrefix('new opencode stolik: hi'), { kind: 'oc', name: 'stolik', body: 'hi' })
  assert.deepEqual(parsePrefix('new stolik: hi'), { kind: 'new', name: 'stolik', body: 'hi' })
  assert.deepEqual(parsePrefix('new ocean: hi'), { kind: 'new', name: 'ocean', body: 'hi' }, 'a word that starts with oc is a name')
})

test('parseRouteCallback: the harness is in the callback data (ofull and oro are opencode)', () => {
  assert.deepEqual(parseRouteCallback('rt:l:0123abcd:ofull'), { kind: 'l', pendingId: '0123abcd', readOnly: false, agent: 'opencode' })
  assert.deepEqual(parseRouteCallback('rt:l:0123abcd:oro'), { kind: 'l', pendingId: '0123abcd', readOnly: true, agent: 'opencode' })
  assert.deepEqual(parseRouteCallback('rt:l:0123abcd:ro'), { kind: 'l', pendingId: '0123abcd', readOnly: true, agent: 'claude' })
  assert.deepEqual(parseRouteCallback('rt:l:0123abcd:full'), { kind: 'l', pendingId: '0123abcd', readOnly: false, agent: 'claude' })
  assert.equal(parseRouteCallback('rt:l:0123abcd:x'), null)
})

test('launchRows and startRows: the harness labels; opencode buttons only when the backend runs', () => {
  assert.deepEqual(launchRows('0a1b2c3d', true), [
    [{ text: 'Claude', data: 'rt:l:0a1b2c3d:full' }, { text: 'Claude read-only', data: 'rt:l:0a1b2c3d:ro' }],
    [{ text: 'opencode', data: 'rt:l:0a1b2c3d:ofull' }, { text: 'opencode plan', data: 'rt:l:0a1b2c3d:oro' }],
  ])
  assert.deepEqual(launchRows('0a1b2c3d', false), [
    [{ text: 'Claude', data: 'rt:l:0a1b2c3d:full' }, { text: 'Claude read-only', data: 'rt:l:0a1b2c3d:ro' }],
  ])
  assert.deepEqual(startRows('0a1b2c3d', true)[0].map((b) => [b.text, b.data]), [
    ['Full', 'rt:l:0a1b2c3d:full'],
    ['👁 Read-only', 'rt:l:0a1b2c3d:ro'],
    ['opencode', 'rt:l:0a1b2c3d:ofull'],
    ['Other…', 'rt:o:0a1b2c3d'],
  ])
  assert.deepEqual(startRows('0a1b2c3d', false)[0].map((b) => b.text), ['Full', '👁 Read-only', 'Other…'])
})

test('oc stolik: hi starts opencode in full at once, and Claude does not start', async () => {
  const opencodeAgent = new FakeAgent()
  const h = harness({ opencodeAgent })
  await h.router.start()
  trustStolik(h)
  await h.chat.inbound(textFrom('oc stolik: hi', { messageId: tgMsg(80) }))
  assert.deepEqual(opencodeAgent.startedSessions, [{ project: 'stolik', dir: STOLIK, extra: [] }])
  assert.deepEqual(h.agent.startedSessions, [])
})

test('new stolik: hi asks first; the Claude button starts Claude only', async () => {
  const opencodeAgent = new FakeAgent()
  const h = harness({ opencodeAgent })
  await h.router.start()
  trustStolik(h)
  await h.chat.inbound(textFrom('new stolik: hi', { messageId: tgMsg(81) }))
  const prompt = h.chat.sent.find((s) => s.text === 'Start stolik: read-only or full?')!
  assert.deepEqual(h.agent.startedSessions, [], 'nothing starts before the answer')
  assert.deepEqual(opencodeAgent.startedSessions, [])
  await tap(h, prompt.opts!.rows![0][0].data, prompt.id) // Claude
  assert.deepEqual(h.agent.startedSessions, [{ project: 'stolik', dir: STOLIK, extra: [] }])
  assert.deepEqual(opencodeAgent.startedSessions, [])
})

test('the opencode plan button starts opencode with its plan agent', async () => {
  const opencodeAgent = new FakeAgent()
  const h = harness({ opencodeAgent })
  await h.router.start()
  trustStolik(h)
  await h.chat.inbound(textFrom('new stolik: hi', { messageId: tgMsg(82) }))
  const prompt = h.chat.sent.find((s) => s.text === 'Start stolik: read-only or full?')!
  await tap(h, prompt.opts!.rows![1][1].data, prompt.id) // opencode plan
  assert.deepEqual(opencodeAgent.startedSessions, [{ project: 'stolik', dir: STOLIK, extra: ['--agent', 'plan'] }])
  assert.deepEqual(h.agent.startedSessions, [])
})

test('without an opencode backend: oc says it is not available and starts nothing; new shows no opencode button', async () => {
  const h = harness()
  await h.router.start()
  trustStolik(h)
  await h.chat.inbound(textFrom('oc stolik: hi', { messageId: tgMsg(83) }))
  assert.deepEqual(h.chat.texts(), ['opencode is not available here.'])
  assert.deepEqual(h.agent.startedSessions, [])

  await h.chat.inbound(textFrom('new stolik: hi', { messageId: tgMsg(84) }))
  const prompt = h.chat.sent.find((s) => s.text === 'Start stolik: read-only or full?')!
  assert.deepEqual(prompt.opts!.rows!.map((r) => r.map((b) => b.text)), [['Claude', 'Claude read-only']])
})

test('claudeModel applies to Claude starts only, never to an opencode start', async () => {
  const opencodeAgent = new FakeAgent()
  const h = harness({ opencodeAgent, claudeModel: 'haiku' })
  await h.router.start()
  trustStolik(h)
  await h.chat.inbound(textFrom('oc stolik: hi', { messageId: tgMsg(85) }))
  assert.deepEqual(opencodeAgent.startedSessions, [{ project: 'stolik', dir: STOLIK, extra: [] }])
})

test('defaultAgent opencode: a name-hit start of the bot runs opencode', async () => {
  const opencodeAgent = new FakeAgent()
  const h = harness({ opencodeAgent, defaultAgent: 'opencode', quotaRefusal: async () => null })
  await h.router.start()
  trustStolik(h)
  await h.chat.inbound(textFrom('stolik: fix the build', { messageId: tgMsg(86) }))
  assert.deepEqual(opencodeAgent.startedSessions, [{ project: 'stolik', dir: STOLIK, extra: [] }])
  assert.deepEqual(h.agent.startedSessions, [])
})

test('defaultAgent claude (the default): a name-hit start runs Claude', async () => {
  const opencodeAgent = new FakeAgent()
  const h = harness({ opencodeAgent, quotaRefusal: async () => null })
  await h.router.start()
  trustStolik(h)
  await h.chat.inbound(textFrom('stolik: fix the build', { messageId: tgMsg(87) }))
  assert.deepEqual(h.agent.startedSessions, [{ project: 'stolik', dir: STOLIK, extra: [] }])
  assert.deepEqual(opencodeAgent.startedSessions, [])
})

test('claudeModel still goes to a Claude start chosen on the new-prefix question', async () => {
  const opencodeAgent = new FakeAgent()
  const h = harness({ opencodeAgent, claudeModel: 'haiku' })
  await h.router.start()
  trustStolik(h)
  await h.chat.inbound(textFrom('new stolik: hi', { messageId: tgMsg(88) }))
  const prompt = h.chat.sent.find((s) => s.text === 'Start stolik: read-only or full?')!
  await tap(h, prompt.opts!.rows![0][0].data, prompt.id) // Claude (full)
  assert.deepEqual(h.agent.startedSessions, [{ project: 'stolik', dir: STOLIK, extra: ['--model', 'haiku'] }])
})
