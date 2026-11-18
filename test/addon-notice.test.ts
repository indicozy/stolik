// The notice when no addon answers a prefix word (fix 1): "not installed" only when no installed addon declares it; a
// declared-but-off (or not running) addon is named, with a button that opens /addons. AddonHost.declaring reads the
// installed manifests, enabled or not.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ButtonPress } from '../src/brain/chat-types.ts'
import { AddonHost } from '../src/addons-host/host.ts'
import type { AddonInfo, AddonsPort, DeclaringAddon } from '../src/ports.ts'
import { Router } from '../src/router/core.ts'
import { FakeAgent, FakeAudit, FakeClock, FakeLogger, FakePlatform, FakeStore, FakeChat, HOME, OWNER, flush, textFrom } from './helpers/fakes.ts'
import { MemorySettings, allowUserAddons, recordingLogger, removeDir, tmpDir, writeEchoLike, FakeClock as AddonClock } from './helpers/addon-fakes.ts'

class DeclaringAddons implements AddonsPort {
  readonly decl: DeclaringAddon | null
  constructor(decl: DeclaringAddon | null) {
    this.decl = decl
  }
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
  declaring(): DeclaringAddon | null {
    return this.decl
  }
}

function build(addons: AddonsPort) {
  const chat = new FakeChat()
  const router = new Router({
    ownerId: OWNER,
    secrets: ['SECRET-TOKEN'],
    home: HOME,
    socketPath: '/fake/router.sock',
    chat,
    store: new FakeStore(),
    platform: new FakePlatform(),
    agent: new FakeAgent(),
    ml: { transcribe: async () => '', close: () => {} },
    clock: new FakeClock(),
    audit: new FakeAudit(),
    logger: new FakeLogger(),
    addons,
  })
  return { router, chat }
}

async function quickTyped(addons: AddonsPort) {
  const { router, chat } = build(addons)
  await router.start()
  await chat.inbound(textFrom('quick: why is the sky blue', { messageId: 90 }))
  return { router, chat }
}

test('no installed addon declares the word: "not installed", no button', async () => {
  const { chat } = await quickTyped(new DeclaringAddons(null))
  const notice = chat.sent.find((s) => s.text.includes('quick'))!
  assert.equal(notice.text, '"quick" is not installed.')
  assert.equal(notice.opts?.rows, undefined)
})

test('an installed addon declares it but it is off: the notice names the addon and offers its /addons entry', async () => {
  const { chat } = await quickTyped(new DeclaringAddons({ name: 'modes', enabled: false, running: false, status: 'off' }))
  const notice = chat.sent.find((s) => s.text.includes('quick'))!
  assert.equal(notice.text, '"quick" comes from the modes addon, which is off. Turn it on in /addons.')
  assert.deepEqual(notice.opts?.rows, [[{ text: 'Open modes in /addons', data: 'ad:modes:show' }]])
  assert.equal(notice.opts?.replyTo, 90)
})

test('enabled but not running (restarting): the notice says so, with its status', async () => {
  const { chat } = await quickTyped(new DeclaringAddons({ name: 'modes', enabled: true, running: false, status: 'restarting in 5 s' }))
  const notice = chat.sent.find((s) => s.text.includes('quick'))!
  assert.equal(notice.text, '"quick" comes from the modes addon, which is not running (restarting in 5 s). Check /addons.')
})

test('the "Open … in /addons" button sends the /addons menu, replying to the notice', async () => {
  const { router, chat } = await quickTyped(new DeclaringAddons({ name: 'modes', enabled: false, running: false, status: 'off' }))
  const notice = chat.sent.find((s) => s.text.includes('quick'))!
  const c: ButtonPress = { pressId: 'cb-show', data: 'ad:modes:show', message: notice.id, from: OWNER }
  await chat.callback(c)
  await flush()
  void router
  const menu = chat.sent.find((s) => s.text.startsWith('No addons installed') || s.text.startsWith('Addons (install on the PC'))
  assert.ok(menu, 'the menu is sent')
  assert.equal(menu.opts?.replyTo, notice.id)
  assert.deepEqual(chat.answers.at(-1), { id: 'cb-show', text: 'Addons.' })
})

test('AddonHost.declaring: a prefix word or a command of an installed addon, enabled or not; invalid manifests ignored', async () => {
  const dir = tmpDir('declaring')
  try {
    writeEchoLike(`${dir}/user`, 'modes', { provides: [{ point: 'prefix', words: ['quick', 'read'] }] })
    writeEchoLike(`${dir}/user`, 'digest', { provides: [{ point: 'command', name: 'digest' }] })
    const settings = new MemorySettings()
    allowUserAddons(`${dir}/user`, settings)
    settings.setEnabled('digest', true)
    const host = new AddonHost({
      addonsDir: `${dir}/user`,
      settings,
      clock: new AddonClock(),
      logger: recordingLogger().logger,
      alert: () => {},
      pin: (f, a) => ({ file: f, args: a }),
    })
    assert.deepEqual(host.declaring('prefix', 'QUICK'), { name: 'modes', enabled: false, running: false, status: 'off' })
    assert.equal(host.declaring('prefix', 'nope'), null)
    assert.equal(host.declaring('prefix', 'digest'), null, 'a command is not a prefix word')
    assert.deepEqual(host.declaring('command', 'digest')?.name, 'digest')
    assert.equal(host.declaring('command', 'digest')?.enabled, true)
  } finally {
    removeDir(dir)
  }
})
