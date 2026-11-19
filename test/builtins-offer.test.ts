// The one-time built-ins offer (router/handlers/builtins.ts): posted once after /bind and on the first DM start when the
// owner never chose a built-in addon; "Enable all" in dependency order through setEnabled, with each addon's result;
// owner only; the flag is kept in the store; a choice the owner made is never overridden.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ButtonPress } from '../src/brain/chat-types.ts'
import { AddonHost, BUILTINS_OFFERED_FLAG } from '../src/addons-host/host.ts'
import { DbAddonSettings } from '../src/addons-host/settings.ts'
import type { AddonInfo, AddonsPort, BuiltinAddon } from '../src/ports.ts'
import { BO_ALL, BO_CHOOSE, enableOrder, offerBuiltins, offerText, parseBuiltinsCallback } from '../src/router/handlers/builtins.ts'
import { Router } from '../src/router/core.ts'
import { FakeAgent, FakeAudit, FakeClock, FakeLogger, FakePlatform, FakeStore, FakeChat, HOME, OWNER, flush, textFrom } from './helpers/fakes.ts'
import { MemorySettings, removeDir, tmpDir, writeEchoLike, FakeClock as AddonClock, recordingLogger } from './helpers/addon-fakes.ts'

const GROUP = -1001234567890
const GROUP_CHAT = { kind: 'home' as const, id: String(GROUP), thread: null }

const b = (name: string, requires: string[] = [], over: Partial<BuiltinAddon> = {}): BuiltinAddon => ({
  name, version: '1.0.0', enabled: false, choice: false, access: ['message.text'], requires, provides: ['prefix'], ...over,
})

class FakeBuiltins implements AddonsPort {
  readonly toggles: Array<{ name: string; on: boolean }> = []
  readonly refuse = new Map<string, string>()
  offered = false
  list_: BuiltinAddon[]
  constructor(list: BuiltinAddon[]) {
    this.list_ = list
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  list(): AddonInfo[] {
    return []
  }
  async setEnabled(name: string, on: boolean): Promise<string | null> {
    this.toggles.push({ name, on })
    const why = this.refuse.get(name) ?? null
    if (why === null) {
      const a = this.list_.find((x) => x.name === name)
      if (a) a.enabled = on
    }
    return why
  }
  async general(): Promise<string | null> {
    return null
  }
  builtins(): BuiltinAddon[] {
    return this.list_.map((x) => ({ ...x }))
  }
  builtinsOffered(): boolean {
    return this.offered
  }
  markBuiltinsOffered(): void {
    this.offered = true
  }
}

const STANDARD = (): BuiltinAddon[] => [
  b('voice', ['ml-worker']),
  b('digest', ['ml-worker']),
  b('ml-worker'),
  b('modes'),
  b('notes'),
  b('voice-cleanup', ['ml-worker']),
]

function build(addons: AddonsPort, groupId: number | null = null) {
  const chat = new FakeChat()
  const router = new Router({
    ownerId: OWNER,
    groupId,
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

async function tap(router: Router, chat: FakeChat, data: string, messageId: number, fromId = OWNER) {
  const c: ButtonPress = { pressId: 'cb', data, message: messageId, from: fromId }
  await chat.callback(c)
  await flush()
  void router
}

test('enableOrder: every addon comes after the addons it requires', () => {
  const order = enableOrder(STANDARD()).map((x) => x.name)
  const at = (n: string) => order.indexOf(n)
  assert.ok(at('ml-worker') < at('voice'))
  assert.ok(at('ml-worker') < at('digest'))
  assert.ok(at('ml-worker') < at('voice-cleanup'))
  assert.equal(order.length, 6)
})

test('the offer lists each built-in with its access, names the chat app\'s lobby, and has one button', () => {
  const text = offerText([b('modes', [], { access: ['message.text', 'messages.send'] })], 'General')
  assert.match(text, /- modes: answers quick:, read: and web: questions with a model run/)
  assert.match(text, /Access: reads your messages; sends to General\./)
  assert.doesNotMatch(text, /Enable all/)
  assert.equal(offerText([b('modes', [], { access: ['messages.send'] })], 'the lobby channel').includes('sends to the lobby channel.'), true)
  assert.equal(parseBuiltinsCallback(BO_ALL), 'all')
  assert.equal(parseBuiltinsCallback(BO_CHOOSE), 'choose')
  assert.equal(parseBuiltinsCallback('bo:other'), null)
})

test('after /bind the offer is posted once in General, with Choose in /addons only', async () => {
  // A choice already made keeps the DM start from offering, so the bind is what offers.
  const addons = new FakeBuiltins(STANDARD().map((x) => (x.name === 'notes' ? { ...x, choice: true } : x)))
  const { router, chat } = build(addons)
  await router.start()
  assert.equal(addons.offered, false)
  await chat.inbound(textFrom('/bind', { chat: GROUP_CHAT }))
  const offers = chat.sent.filter((s) => s.text.startsWith('stolik has built-in addons'))
  assert.equal(offers.length, 1)
  assert.equal(offers[0].chat, 'group')
  assert.deepEqual(offers[0].opts?.rows, [[{ text: 'Choose in /addons', data: BO_CHOOSE }]])
  assert.equal(addons.offered, true)

  await chat.inbound(textFrom('/bind', { chat: GROUP_CHAT, messageId: 11 }))
  assert.equal(chat.sent.filter((s) => s.text.startsWith('stolik has built-in addons')).length, 1, 'never again')
})

test('the first DM start offers once; with a built-in choice already made it does not', async () => {
  const addons = new FakeBuiltins(STANDARD())
  const { router, chat } = build(addons)
  await router.start()
  assert.equal(chat.sent.filter((s) => s.text.startsWith('stolik has built-in addons')).length, 1)

  const again = build(addons)
  await again.router.start()
  assert.equal(again.chat.sent.filter((s) => s.text.startsWith('stolik has built-in addons')).length, 0, 'flag kept')

  const chosen = new FakeBuiltins(STANDARD().map((x) => (x.name === 'notes' ? { ...x, choice: true } : x)))
  const other = build(chosen)
  await other.router.start()
  assert.equal(other.chat.sent.filter((s) => s.text.startsWith('stolik has built-in addons')).length, 0)
  assert.equal(chosen.offered, false, 'not marked: a later /bind still offers')
})

test('Enable all turns the built-ins on in dependency order through setEnabled, and edits the message with each result', async () => {
  const addons = new FakeBuiltins(STANDARD())
  addons.refuse.set('digest', 'digest needs ml-worker installed and enabled first.')
  const { router, chat } = build(addons)
  await router.start()
  const offer = chat.sent.find((s) => s.text.startsWith('stolik has built-in addons'))!
  await tap(router, chat, BO_ALL, offer.id)

  const on = addons.toggles.map((t) => t.name)
  assert.equal(on[0], 'ml-worker', 'ml-worker first')
  assert.ok(on.indexOf('ml-worker') < on.indexOf('voice'))
  assert.ok(on.indexOf('ml-worker') < on.indexOf('voice-cleanup'))
  assert.ok(addons.toggles.every((t) => t.on === true))
  const edit = chat.rowEdits.find((e) => e.messageId === offer.id)!
  assert.match(edit.text, /- ml-worker: enabled/)
  assert.match(edit.text, /- digest: failed: digest needs ml-worker installed and enabled first\./)
  assert.match(edit.text, /- voice: enabled/)
  assert.deepEqual(edit.rows, [], 'the buttons go')
  assert.ok(chat.answers.some((a) => a.text === 'Done.'))
})

test('Enable all never re-enables or overrides a choice the owner made', async () => {
  const list = STANDARD().map((x) => {
    if (x.name === 'notes') return { ...x, choice: true, enabled: false }
    if (x.name === 'modes') return { ...x, choice: true, enabled: true }
    return x
  })
  const addons = new FakeBuiltins(list)
  const { router, chat } = build(addons)
  await router.start()
  await offerBuiltins(router)
  const offer = chat.sent.find((s) => s.text.startsWith('stolik has built-in addons'))!
  assert.match(offer.text, /- notes: saves note/)
  await tap(router, chat, BO_ALL, offer.id)
  assert.ok(!addons.toggles.some((t) => t.name === 'notes'), 'notes: turned off by the owner, left alone')
  assert.ok(!addons.toggles.some((t) => t.name === 'modes'), 'modes: already on by the owner, left alone')
  const edit = chat.rowEdits.find((e) => e.messageId === offer.id)!
  assert.match(edit.text, /- notes: left off \(you turned it off before\)/)
  assert.match(edit.text, /- modes: on/)
})

test('the offer buttons are owner only: another user is refused and nothing is enabled', async () => {
  const addons = new FakeBuiltins(STANDARD())
  const { router, chat } = build(addons)
  await router.start()
  const offer = chat.sent.find((s) => s.text.startsWith('stolik has built-in addons'))!
  await tap(router, chat, BO_ALL, offer.id, '999')
  assert.equal(addons.toggles.length, 0)
  assert.deepEqual(chat.answers.at(-1), { id: 'cb', text: 'Not allowed' })
})

test('Choose in /addons sends the /addons menu', async () => {
  const addons = new FakeBuiltins(STANDARD())
  const { router, chat } = build(addons)
  await router.start()
  const offer = chat.sent.find((s) => s.text.startsWith('stolik has built-in addons'))!
  await tap(router, chat, BO_CHOOSE, offer.id)
  assert.equal(addons.toggles.length, 0)
  assert.ok(chat.sent.some((s) => s.text.startsWith('No addons installed') || s.text.startsWith('Addons (install on the PC')))
})

test('the flag is stored with the settings: a new host over the same store sees it, and builtins() reads the built-in folder', async () => {
  const dir = tmpDir('offer-host')
  try {
    const builtin = `${dir}/builtin`
    writeEchoLike(builtin, 'modes', { provides: [{ point: 'prefix', words: ['quick'] }], access: ['messages.send'] })
    writeEchoLike(builtin, 'ml-worker', { provides: [], access: ['message.audio'] })
    writeEchoLike(`${dir}/user`, 'mine', { provides: [{ point: 'text-filter' }] })
    const values = new Map<string, string>()
    const db = {
      getAddonSetting: (addon: string, key: string) => values.get(`${addon}\u0000${key}`) ?? null,
      setAddonSetting: (addon: string, key: string, value: string) => void values.set(`${addon}\u0000${key}`, value),
    }
    const mk = () =>
      new AddonHost({
        addonsDir: `${dir}/user`,
        builtinDir: builtin,
        settings: new DbAddonSettings(db),
        clock: new AddonClock(),
        logger: recordingLogger().logger,
        alert: () => {},
        pin: (f, a) => ({ file: f, args: a }),
      })
    const first = mk()
    assert.equal(first.builtinsOffered(), false)
    assert.deepEqual(first.builtins().map((x) => [x.name, x.enabled, x.choice]), [['ml-worker', false, false], ['modes', false, false]])
    first.markBuiltinsOffered()
    assert.equal(mk().builtinsOffered(), true, 'persisted')
    assert.equal(values.get(`_host\u0000${BUILTINS_OFFERED_FLAG}`), '1')
    await first.setEnabled('ml-worker', true)
    assert.deepEqual(mk().builtins().map((x) => [x.name, x.choice]), [['ml-worker', true], ['modes', false]])
    await first.stop()
  } finally {
    removeDir(dir)
  }
})

test('the flags of the json settings file are kept apart from addon names', () => {
  const settings = new MemorySettings()
  settings.setFlag('builtins-offered')
  assert.equal(settings.getFlag('builtins-offered'), true)
  assert.equal(settings.hasChoice('modes'), false)
})
