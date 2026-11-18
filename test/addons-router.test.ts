// The router's General path with an addons port (plan 2.9 wiring): an addon's prefix or command answers before the
// message is routed, a reply to a session message is never captured, /addons shows the menu, and its buttons toggle.
import './helpers/isolate.ts'
import { tgMsg } from '../src/adapters/chat/tg-ids.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddonInfo, AddonsPort } from '../src/ports.ts'
import { Router } from '../src/router/core.ts'
import { FakeAgent, FakeAudit, FakeClock, FakeLogger, FakePlatform, FakeStore, FakeChat, HOME, OWNER, flush, textFrom } from './helpers/fakes.ts'

class FakeAddons implements AddonsPort {
  readonly toggles: Array<{ name: string; on: boolean }> = []
  readonly seen: string[] = []
  info: AddonInfo[] = [
    { name: 'notes', version: '1.0.0', enabled: true, running: true, status: 'running', provides: ['prefix'] },
  ]
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  list(): AddonInfo[] {
    return this.info
  }
  async setEnabled(name: string, on: boolean): Promise<string | null> {
    this.toggles.push({ name, on })
    if (name === 'blocked') return 'blocked needs something first.'
    return null
  }
  async general(text: string): Promise<string | null> {
    this.seen.push(text)
    return text.startsWith('todo:') ? `saved: ${text.slice(5).trim()}` : null
  }
}

function build(addons: AddonsPort) {
  const chat = new FakeChat()
  const agent = new FakeAgent()
  const router = new Router({
    ownerId: OWNER,
    secrets: ['SECRET-TOKEN'],
    home: HOME,
    socketPath: '/fake/router.sock',
    chat,
    store: new FakeStore(),
    platform: new FakePlatform(),
    agent,
    ml: { transcribe: async () => '', close: () => {} },
    clock: new FakeClock(),
    audit: new FakeAudit(),
    logger: new FakeLogger(),
    addons,
  })
  return { router, chat, agent }
}

test('an addon prefix answers a General message before it is routed', async () => {
  const addons = new FakeAddons()
  const { router, chat, agent } = build(addons)
  await router.start()
  await chat.inbound(textFrom('todo: buy milk'))
  assert.deepEqual(addons.seen, ['todo: buy milk'])
  assert.deepEqual(chat.texts(), ['saved: buy milk'])
  assert.equal(agent.sent.length, 0)
})

test('a message with no addon match goes on to routing as before', async () => {
  const addons = new FakeAddons()
  const { router, chat } = build(addons)
  await router.start()
  await chat.inbound(textFrom('hello there'))
  assert.deepEqual(addons.seen, ['hello there'])
  // No live session: the router answers with its usual unknown-target text, not an addon reply.
  assert.equal(chat.texts().length, 1)
  assert.doesNotMatch(chat.texts()[0], /saved:/)
})

test('a swipe-reply to a session message is never captured by an addon', async () => {
  const addons = new FakeAddons()
  const { router, chat } = build(addons)
  await router.start()
  await chat.inbound(textFrom('todo: x', { replyToId: tgMsg(5) }))
  assert.deepEqual(addons.seen, [])
})

test('/addons shows the list with on and off buttons', async () => {
  const addons = new FakeAddons()
  const { router, chat } = build(addons)
  await router.start()
  await chat.inbound(textFrom('/addons'))
  const menu = chat.sent.find((s) => /Addons \(install on the PC/.test(s.text))
  assert.ok(menu, 'menu sent')
  assert.deepEqual(menu.opts?.rows, [[{ text: 'Turn off notes', data: 'ad:notes:off' }]])
})

test('an addon button toggles the addon and refreshes the menu; a refusal is shown as the toast', async () => {
  const addons = new FakeAddons()
  const { router, chat } = build(addons)
  await router.start()
  addons.info = [{ name: 'notes', version: '1.0.0', enabled: false, running: false, status: 'off', provides: ['prefix'] }]
  await chat.callback({ pressId: 'cb1', data: 'ad:notes:on', message: tgMsg(20), from: OWNER })
  assert.deepEqual(addons.toggles, [{ name: 'notes', on: true }])
  assert.equal(chat.edits.length, 1)
  assert.match(chat.edits[0].text, /notes 1\.0\.0: off/)

  await chat.callback({ pressId: 'cb2', data: 'ad:blocked:on', message: tgMsg(20), from: OWNER })
  assert.deepEqual(addons.toggles[1], { name: 'blocked', on: true })
  await flush()
})

test('without an addons port the General path is unchanged and /addons says so', async () => {
  const { router, chat } = build(undefined as unknown as AddonsPort)
  await router.start()
  await chat.inbound(textFrom('/addons'))
  assert.ok(chat.texts().includes('Addons are not set up.'))
})
