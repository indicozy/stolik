// The gate point (protocol 2; cost-guard): a router hold stops delivery, a release delivers once, a drop forgets,
// a failing gate passes (fail open), an addon acts only on its own holds, forwarded and addon-sent messages are never gated,
// and the manifest and payload rules. The real-host test runs the echo fixture as a gate provider.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Inbound } from '../src/brain/chat-types.ts'
import { tgMsg } from '../src/adapters/chat/tg-ids.ts'
import { AddonHost, REQUEST_ACCESS, type AddonHost as AddonHostType } from '../src/addons-host/host.ts'
import { filterPayload } from '../src/addons-host/access.ts'
import { ACCESS_FIELDS, POINTS, parseManifest, type Manifest } from '../src/addons-host/manifest.ts'
import { GATE_TIMEOUT_MS, gate } from '../src/addons-host/points.ts'
import { AddonBridge } from '../src/router/addon-bridge.ts'
import { send } from '../src/router/deliver.ts'
import { HOLD_CAP, Holds, type Hold } from '../src/router/gate.ts'
import type { AddonInfo, AddonsPort } from '../src/ports.ts'
import { FakeConn, HOME, OWNER, flush, harness, textFrom } from './helpers/fakes.ts'
import { FakeClock, MemorySettings, allowUserAddons, copyFixture, recordingLogger, removeDir, tmpDir, waitFor } from './helpers/addon-fakes.ts'

const PROJ = `${HOME}/proj`

// An addons port whose gate answer the test sets: hold, pass, or fail (throw).
class GateAddons implements AddonsPort {
  mode: 'hold' | 'pass' | 'throw' = 'hold'
  readonly gateCalls: Record<string, unknown>[] = []
  infos: AddonInfo[] = [{ name: 'cost-guard', version: '1.0.0', enabled: true, running: true, status: 'running', provides: ['gate'] }]
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  list(): AddonInfo[] {
    return this.infos
  }
  async setEnabled(): Promise<string | null> {
    return null
  }
  async general(): Promise<string | null> {
    return null
  }
  async media(): Promise<null> {
    return null
  }
  async cleanText(text: string): Promise<{ text: string; unpolished: boolean }> {
    return { text, unpolished: false }
  }
  isAddon(name: string): boolean {
    return this.infos.some((i) => i.name === name)
  }
  async gate(payload: Record<string, unknown>): Promise<{ addon: string } | null> {
    this.gateCalls.push(payload)
    if (this.mode === 'throw') throw new Error('gate broke')
    return this.mode === 'hold' ? { addon: 'cost-guard' } : null
  }
}

// Registers a channel session in PROJ and gives it a backend session id (the transcript's name).
function register(h: ReturnType<typeof harness>): void {
  h.platform.dirs.add(PROJ)
  h.agent.receive(new FakeConn(), { t: 'register', claudePid: 4242, cwd: PROJ })
}

async function setup(mode: GateAddons['mode'] = 'hold') {
  const addons = new GateAddons()
  addons.mode = mode
  const h = harness({ addons })
  await h.router.start()
  register(h)
  await flush()
  const s = h.router.registry.list()[0]
  s.backendSessionId = 'sess-abc'
  return { h, addons, s }
}

function bridgeFor(h: ReturnType<typeof harness>): AddonBridge {
  const db = { getAddonSetting: () => null, setAddonSetting: () => {}, addUsage: () => {}, listUsage: () => [], pruneUsage: () => {} }
  const bridge = new AddonBridge({
    db: db as unknown as ConstructorParameters<typeof AddonBridge>[0]['db'],
    weeklyLimitPct: 99,
    quota: async () => null,
    now: () => 0,
  })
  bridge.attach(h.router)
  return bridge
}

test('a gate hold stops delivery: the session gets nothing, the message is held and marked with the hold reaction', async () => {
  const { h, addons } = await setup('hold')
  await h.chat.inbound(textFrom('hello', { messageId: tgMsg(50) }))
  assert.equal(h.agent.sent.length, 0, 'nothing reached the session')
  assert.equal(h.router.holds.size, 1)
  assert.deepEqual(h.chat.reactions.at(-1), { messageId: tgMsg(50), emoji: '😴' })
  assert.equal(addons.gateCalls.length, 1)
  const g = addons.gateCalls[0]
  assert.deepEqual(g.session, { name: 'proj', cwd: PROJ, backendSessionId: 'sess-abc' })
  assert.equal(g.messageId, 'tg:50')
  assert.equal(g.kind, 'text')
  assert.equal(g.length, 5)
  assert.equal('text' in g, false, 'the gate payload never carries the text')
})

test('a release delivers the held message exactly once; a second release is an error; a release is not gated again', async () => {
  const { h, addons } = await setup('hold')
  const bridge = bridgeFor(h)
  await h.chat.inbound(textFrom('hello', { messageId: tgMsg(50) }))
  assert.deepEqual(await bridge.request('cost-guard', 'release', { messageId: 'tg:50' }), { ok: true })
  assert.equal(h.agent.sent.length, 1)
  assert.equal(h.agent.sent[0].content, 'hello')
  assert.equal(h.router.holds.size, 0)
  const again = (await bridge.request('cost-guard', 'release', { messageId: 'tg:50' })) as { ok: boolean; error?: string }
  assert.equal(again.ok, false)
  assert.match(again.error ?? '', /no message of yours/)
  assert.equal(h.agent.sent.length, 1, 'still delivered once')
  assert.equal(addons.gateCalls.length, 1, 'the release skipped the gate')
})

test('a drop forgets the held message: a later release finds nothing, and nothing is delivered', async () => {
  const { h } = await setup('hold')
  const bridge = bridgeFor(h)
  await h.chat.inbound(textFrom('hello', { messageId: tgMsg(50) }))
  assert.deepEqual(await bridge.request('cost-guard', 'drop', { messageId: 'tg:50' }), { ok: true })
  assert.equal(h.router.holds.size, 0)
  assert.equal(((await bridge.request('cost-guard', 'release', { messageId: 'tg:50' })) as { ok: boolean }).ok, false)
  assert.equal(h.agent.sent.length, 0)
})

test('a throwing gate lets the message through (fail open), and the reason is logged', async () => {
  const { h } = await setup('throw')
  await h.chat.inbound(textFrom('hello', { messageId: tgMsg(50) }))
  assert.equal(h.agent.sent.length, 1, 'delivered')
  assert.equal(h.router.holds.size, 0)
  assert.ok(h.logger.lines.some((l) => /gate failed, message passes: gate broke/.test(l)), 'the failure is logged')
})

test('a gate that passes delivers the message as before', async () => {
  const { h } = await setup('pass')
  await h.chat.inbound(textFrom('hello', { messageId: tgMsg(50) }))
  assert.equal(h.agent.sent.length, 1)
  assert.equal(h.router.holds.size, 0)
})

test('an addon cannot release, drop or read a message another addon held', async () => {
  const { h } = await setup('hold')
  const bridge = bridgeFor(h)
  await h.chat.inbound(textFrom('hello', { messageId: tgMsg(50) }))
  const stranger = 'other-addon'
  assert.equal(((await bridge.request(stranger, 'release', { messageId: 'tg:50' })) as { ok: boolean }).ok, false)
  assert.equal(((await bridge.request(stranger, 'drop', { messageId: 'tg:50' })) as { ok: boolean }).ok, false)
  assert.equal(((await bridge.request(stranger, 'held', { messageId: 'tg:50' })) as { ok: boolean }).ok, false)
  assert.equal(h.router.holds.size, 1, 'the hold is still there')
  assert.equal(h.agent.sent.length, 0)
  // The holder still can.
  assert.equal(((await bridge.request('cost-guard', 'held', { messageId: 'tg:50' })) as { ok: boolean }).ok, true)
})

test('held returns the held text and its session to the addon that held it', async () => {
  const { h } = await setup('hold')
  const bridge = bridgeFor(h)
  await h.chat.inbound(textFrom('the owner text', { messageId: tgMsg(50) }))
  assert.deepEqual(await bridge.request('cost-guard', 'held', { messageId: 'tg:50' }), {
    ok: true,
    text: 'the owner text',
    session: { name: 'proj', cwd: PROJ, backendSessionId: 'sess-abc' },
  })
})

test('a forwarded message is never gated', async () => {
  const { h, addons, s } = await setup('hold')
  await send(h.router, s, textFrom('forwarded', { messageId: tgMsg(60), forwarded: true }), { body: 'forwarded', meta: {} })
  assert.equal(addons.gateCalls.length, 0)
  assert.equal(h.agent.sent.length, 1)
})

test("a message sent from an addon's name (a spawned session's first prompt) is never gated", async () => {
  const { h, addons, s } = await setup('hold')
  await send(h.router, s, textFrom('prompt', { messageId: tgMsg(61), from: 'cost-guard' }), { body: 'prompt', meta: {} })
  assert.equal(addons.gateCalls.length, 0)
  assert.equal(h.agent.sent.length, 1)
})

test('a release sent with the gate skipped is delivered even while the gate would hold it', async () => {
  const { h, addons, s } = await setup('hold')
  const m: Inbound = textFrom('bypass', { messageId: tgMsg(62) })
  assert.equal(await send(h.router, s, m, { body: 'bypass', meta: {} }, { bypassGate: true }), true)
  assert.equal(addons.gateCalls.length, 0)
  assert.equal(h.agent.sent.length, 1)
})

test('the held list keeps at most HOLD_CAP messages and pushes out the oldest', () => {
  assert.equal(HOLD_CAP, 50)
  const holds = new Holds()
  for (let i = 1; i <= HOLD_CAP + 1; i++) {
    holds.put({ sessionKey: 'k', m: { messageId: tgMsg(i) } as Inbound, p: { body: 'x', meta: {} }, addon: 'a', heldAt: i } as Hold)
  }
  assert.equal(holds.size, HOLD_CAP)
  assert.equal(holds.get(tgMsg(1)), undefined, 'the oldest is gone')
  assert.ok(holds.get(tgMsg(HOLD_CAP + 1)), 'the newest is kept')
  assert.equal(holds.take(tgMsg(2))?.heldAt, 2)
  assert.equal(holds.take(tgMsg(2)), undefined, 'a taken hold is gone')
})

test('the gate dispatch asks each gate provider in turn, takes the first hold, and passes on error or timeout', async () => {
  const calls: Array<{ name: string; op: string; timeoutMs: number }> = []
  const logs: string[] = []
  const host = {
    running: () => [
      { name: 'a', manifest: { provides: [{ point: 'gate' }] } },
      { name: 'b', manifest: { provides: [{ point: 'gate' }] } },
      { name: 'c', manifest: { provides: [{ point: 'gate' }] } },
    ],
    call: async (name: string, op: string, _payload: unknown, timeoutMs: number) => {
      calls.push({ name, op, timeoutMs })
      if (name === 'a') throw new Error('timed out')
      return name === 'b' ? { hold: true } : { hold: false }
    },
    log: (m: string) => logs.push(m),
  } as unknown as AddonHostType
  assert.equal(GATE_TIMEOUT_MS, 3000)
  assert.deepEqual(await gate(host, { messageId: 'tg:1' }), { addon: 'b' })
  assert.deepEqual(calls.map((c) => c.name), ['a', 'b'], 'the first hold ends the asking')
  assert.ok(calls.every((c) => c.op === 'gate' && c.timeoutMs === GATE_TIMEOUT_MS))
  assert.ok(logs.some((l) => /a: gate failed, message passes: timed out/.test(l)))
  const none = { ...host, call: async () => ({ hold: false }) } as unknown as AddonHostType
  assert.equal(await gate(none, { messageId: 'tg:1' }), null)
})

test('the gate point needs messages.gate access, gate is a reserved op, and the gate payload keeps only declared fields', () => {
  assert.ok((POINTS as readonly string[]).includes('gate'))
  assert.ok((ACCESS_FIELDS as readonly string[]).includes('messages.gate'))
  const base = { name: 'gate-x', version: '1', protocol: 2, command: ['node', 'x.js'] }
  assert.throws(() => parseManifest({ ...base, provides: [{ point: 'gate' }], access: [] }), /needs messages\.gate access/)
  const m: Manifest = parseManifest({ ...base, provides: [{ point: 'gate' }], access: ['messages.gate'] })
  assert.equal(m.provides[0].point, 'gate')
  assert.throws(() => parseManifest({ ...base, provides: [{ point: 'gate', extra: 1 }], access: ['messages.gate'] }))
  assert.throws(() => parseManifest({ ...base, provides: [], access: [], serves: ['gate'] }), /host op/)
  for (const op of ['release', 'drop', 'held']) assert.equal(REQUEST_ACCESS[op], 'messages.gate')

  const { payload, dropped } = filterPayload(
    { session: { name: 'p' }, messageId: 'tg:1', kind: 'text', length: 5, text: 'secret', deadline: 9 },
    m,
  )
  assert.deepEqual(payload.session, { name: 'p' })
  assert.equal(payload.length, 5)
  assert.equal(payload.messageId, 'tg:1')
  assert.equal('text' in payload, false, 'the text needs message.text, which the gate addon does not declare')
  assert.ok(dropped.includes('text'))
})

test('through the real addon host, a gate call reaches a messages.gate addon with session and length, and no text', async () => {
  const dir = tmpDir('gate-host')
  try {
    const addonsDir = join(dir, 'addons')
    mkdirSync(addonsDir)
    const folder = copyFixture('addon-echo', addonsDir)
    writeFileSync(
      join(folder, 'stolik-addon.json'),
      JSON.stringify({ name: 'addon-echo', version: '0.1.0', protocol: 2, command: ['node', 'index.mjs'], provides: [{ point: 'gate' }], access: ['messages.gate'], requires: [] }),
    )
    const settings = new MemorySettings()
    allowUserAddons(addonsDir, settings)
    settings.setEnabled('addon-echo', true)
    const host = new AddonHost({
      addonsDir,
      settings,
      clock: new FakeClock(),
      logger: recordingLogger().logger,
      alert: () => {},
      pin: (file: string, args: string[]) => ({ file, args }),
    })
    await host.start()
    try {
      await waitFor(() => host.running().some((r) => r.name === 'addon-echo'), 'addon-echo running')
      const payload = { session: { name: 'proj', cwd: PROJ, backendSessionId: 'sess-abc' }, messageId: 'tg:7', kind: 'text', length: 5, text: 'secret' }
      const r = (await host.call('addon-echo', 'gate', payload)) as { received: Record<string, unknown> }
      assert.deepEqual(r.received.session, payload.session)
      assert.equal(r.received.length, 5)
      assert.equal(r.received.messageId, 'tg:7')
      assert.equal('text' in r.received, false, 'the text is not sent to a gate addon that does not declare message.text')
      assert.equal(await host.gate(payload), null, 'the echo answers no hold, so the message passes')
    } finally {
      await host.stop()
    }
  } finally {
    removeDir(dir)
  }
})
