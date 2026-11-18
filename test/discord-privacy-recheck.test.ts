// The Discord adapter's hourly member re-check (decision 12) with an injected clock and a fake client: growth raises the
// stranger alert in the home; the first read is the baseline; a failed read is logged, not thrown.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Discord, MEMBER_RECHECK_MS, type DiscordClock } from '../src/adapters/chat/discord.ts'
import type { ChatEvent, ChatId } from '../src/brain/chat-types.ts'

const HOME = 'dc:g7:l5' as ChatId
const flush = () => new Promise<void>((r) => setImmediate(r))

// A client whose guild 7 reports `count.n` members (or throws when `count.fail` is set). Gateway handlers are kept.
function client(count: { n: number; fail: boolean }) {
  const rest = {
    get: async (route: string) => {
      if (route === '/applications/@me') return { bot_public: false, flags: 1 << 18 }
      if (route === '/channels/5') return { id: '5', name: 'bridge', type: 0 }
      if (route === '/guilds/7/channels') return []
      if (route === '/guilds/7') {
        if (count.fail) throw new Error('503 Service Unavailable')
        return { id: '7', owner_id: '99', roles: [{ id: '7', permissions: '0' }], approximate_member_count: count.n }
      }
      throw new Error(`404 ${route}`)
    },
    post: async () => ({}),
    patch: async () => ({}),
    put: async () => ({}),
    delete: async () => ({}),
  }
  const gateway = { on: () => {}, connect: async () => {}, destroy: async () => {} }
  return { rest, gateway }
}

// A clock that keeps the repeating callbacks and the cleared handles.
function clock() {
  const repeating: Array<{ fn: () => void; ms: number; handle: string }> = []
  const cleared: unknown[] = []
  const c: DiscordClock = {
    setRepeating: (fn, ms) => {
      const handle = `h${repeating.length + 1}`
      repeating.push({ fn, ms, handle })
      return handle
    },
    clearTimer: (h) => {
      cleared.push(h)
    },
  }
  return { c, repeating, cleared, tick: () => repeating[0]!.fn() }
}

function adapter(count: { n: number; fail: boolean }, clk: ReturnType<typeof clock> | null) {
  const d = new Discord(client(count), { homeId: HOME, ownerId: '99', clock: clk?.c })
  const events: ChatEvent[] = []
  d.onChatEvent(async (e) => {
    events.push(e)
  })
  return { d, events }
}

test('start registers one hourly re-check and stop clears it', async () => {
  const clk = clock()
  const { d } = adapter({ n: 2, fail: false }, clk)
  d.start()
  assert.equal(clk.repeating.length, 1)
  assert.equal(clk.repeating[0]!.ms, MEMBER_RECHECK_MS)
  assert.equal(MEMBER_RECHECK_MS, 3_600_000)
  await d.stop()
  assert.deepEqual(clk.cleared, ['h1'])
})

test('without a clock there is no re-check at all', () => {
  const { d } = adapter({ n: 2, fail: false }, null)
  d.start()
  assert.ok(d)
})

test('the first read is the baseline; growth raises the stranger alert in the home, once per rise', async () => {
  const clk = clock()
  const count = { n: 2, fail: false }
  const { d, events } = adapter(count, clk)
  d.start()
  clk.tick()
  await flush()
  assert.equal(events.length, 0, 'the baseline is silent')
  count.n = 3
  clk.tick()
  await flush()
  assert.deepEqual(events.map((e) => e.type), ['stranger-joined'])
  assert.equal((events[0] as { chat: ChatId }).chat, HOME)
  clk.tick()
  await flush()
  assert.equal(events.length, 1, 'an unchanged count is not alerted again')
  count.n = 4
  clk.tick()
  await flush()
  assert.equal(events.length, 2)
})

test('a failed read is logged and waits for the next hour; no alert', async () => {
  const clk = clock()
  const count = { n: 2, fail: true }
  const { d, events } = adapter(count, clk)
  d.start()
  clk.tick()
  await flush()
  count.fail = false
  count.n = 5
  clk.tick()
  await flush()
  assert.equal(events.length, 0, 'the first good read is the baseline again')
  void d
})

test('the baseline resets on a new bind, so the next server does not inherit a count', async () => {
  const clk = clock()
  const count = { n: 2, fail: false }
  const { d, events } = adapter(count, clk)
  d.start()
  clk.tick()
  await flush()
  d.setHome(null)
  count.n = 9
  d.setHome(HOME)
  clk.tick()
  await flush()
  assert.equal(events.length, 0)
})

test('privacyChecks reads the bound server: the app and server privacy checks, all in the privacy group', async () => {
  const { d } = adapter({ n: 2, fail: false }, null)
  const checks = await d.privacyChecks()
  assert.ok(checks.length >= 4)
  assert.ok(checks.every((c) => c.group === 'privacy'))
  assert.ok(checks.some((c) => c.id === 'public' && c.status === 'ok'))
  assert.ok(checks.some((c) => c.id === 'members' && c.status === 'ok'))
})
