// Presence over a fake idle source and a fake clock: the tri-state answer, the 60 s hold, unknown after it, and the
// one-shot down/up alerts. No X11, no logind.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IDLE_DOWN_ALERT_MS, IDLE_HOLD_MS, type IdleReading } from '../src/brain/away.ts'
import { Presence } from '../src/adapters/platform/presence.ts'
import type { IdleSource } from '../src/adapters/platform/index.ts'

const T0 = 1_700_000_000_000
const STEP = 30_000

function fixture() {
  let now = T0
  let reading: IdleReading = { idleMs: 0, locked: false }
  const source: IdleSource = {
    name: 'fake',
    async read() {
      return reading
    },
  }
  const presence = new Presence(source, () => now)
  return {
    presence,
    // Moves the clock on by one step (more than the 5 s cache) and makes one read.
    async tick(next: IdleReading | null = null) {
      now += STEP
      if (next) reading = next
      return presence.awayState()
    },
    set(r: IdleReading) {
      reading = r
    },
    get now() {
      return now
    },
  }
}

test('presence: a readable active source is active, then idle past the threshold', async () => {
  const f = fixture()
  assert.equal(await f.presence.awayState(), 'active')
  assert.equal(await f.tick({ idleMs: 5 * 60_000, locked: false }), 'idle')
  assert.equal(await f.presence.isAway(), true)
})

test('presence: an unreadable source keeps the last good reading for about 60 s, then the state is unknown', async () => {
  const f = fixture()
  assert.equal(await f.presence.awayState(), 'active') // good read at T0
  assert.equal(await f.tick({ idleMs: null, locked: false }), 'active', 'held at 30 s')
  assert.equal(await f.tick(), 'unknown', 'at 60 s after the last good reading the hold is over: unknown, not away')
  assert.equal(await f.presence.isAway(), true, 'isAway still relays while unknown')
  assert.ok(f.now - T0 >= IDLE_HOLD_MS)
})

test('presence: a held reading that was idle stays idle for the hold, then becomes unknown', async () => {
  const f = fixture()
  await f.tick({ idleMs: 6 * 60_000, locked: false })
  assert.equal(await f.tick({ idleMs: null, locked: false }), 'idle')
  assert.equal(await f.tick(), 'unknown')
})

test('presence: a lock is away even while the idle source is unreadable', async () => {
  const f = fixture()
  await f.tick({ idleMs: null, locked: true })
  assert.equal(await f.tick({ idleMs: null, locked: true }), 'idle')
  assert.equal(await f.tick({ idleMs: null, locked: true }), 'idle')
})

test('presence: the down alert is queued once after 5 minutes, and the up alert once on recovery', async () => {
  const f = fixture()
  await f.presence.awayState()
  assert.equal(f.presence.takeAlert(), null)
  await f.tick({ idleMs: null, locked: false }) // first unreadable read
  const alerts: Array<string | null> = []
  while (f.now - T0 < IDLE_DOWN_ALERT_MS + 2 * STEP) {
    await f.tick()
    alerts.push(f.presence.takeAlert())
  }
  assert.deepEqual(alerts.filter((a) => a !== null), ['down'], 'exactly one down alert')
  await f.tick({ idleMs: 0, locked: false })
  assert.equal(f.presence.takeAlert(), 'up')
  assert.equal(f.presence.takeAlert(), null)
})

test('presence: /away forces idle; /here does not hide an unreadable source', async () => {
  const f = fixture()
  f.presence.setAway()
  assert.equal(await f.presence.awayState(), 'idle')
  f.presence.setHere(f.now)
  await f.tick({ idleMs: null, locked: false })
  assert.equal(await f.tick(), 'unknown', 'an unreadable source is not hidden by /here')
})

test('presence: no graphical login is away at once and for as long as it lasts, with no down alert', async () => {
  const f = fixture()
  assert.equal(await f.presence.awayState(), 'active')
  assert.equal(await f.tick({ idleMs: null, locked: false, loggedOut: true }), 'idle', 'away at once, no hold')
  for (let i = 0; i < 12; i++) {
    assert.equal(await f.tick(), 'idle', `still away after ${f.now - T0} ms`)
    assert.equal(f.presence.takeAlert(), null, 'no down alert for a logged-out PC')
  }
  assert.ok(f.now - T0 > IDLE_DOWN_ALERT_MS, 'the logged-out stretch is over five minutes')
  assert.equal(await f.presence.isAway(), true)
})

test('presence: a graphical login coming back goes to normal idle time, not to unknown', async () => {
  const f = fixture()
  await f.tick({ idleMs: null, locked: false, loggedOut: true })
  assert.equal(await f.tick({ idleMs: 0, locked: false }), 'active', 'the session is back and the keyboard was just used')
  assert.equal(await f.tick({ idleMs: 6 * 60_000, locked: false }), 'idle', 'idle time counts again')
})

test('presence: loginctl failing (not a logged-out reading) stays unknown after the hold', async () => {
  const f = fixture()
  await f.tick({ idleMs: 0, locked: false })
  assert.equal(await f.tick({ idleMs: null, locked: false, loggedOut: false }), 'active', 'held at 30 s as before')
  assert.equal(await f.tick(), 'unknown', 'not away just because the source cannot be read')
})

test('presence: /away and a logged-out reading are both away, whatever /here says', async () => {
  const f = fixture()
  f.presence.setAway()
  assert.equal(await f.tick({ idleMs: null, locked: false, loggedOut: true }), 'idle')
  f.presence.setHere(f.now)
  assert.equal(await f.tick(), 'idle', 'still away')
})
