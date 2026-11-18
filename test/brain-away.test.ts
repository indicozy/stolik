import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AWAY_IDLE_MS, IDLE_DOWN_ALERT_MS, IDLE_HOLD_MS, NO_HOLD, awayFromPlatform, evaluateAway, evaluateIdle, holdReading,
  idleAlertText, type HoldState,
} from '../src/brain/away.ts'
import { MINUTE } from '../src/brain/common.ts'

const T0 = 1_700_000_000_000
const base = { overrideAway: false, hereSetAt: null, idleMs: 0, locked: false }

test('away rule: AWAY_IDLE_MS is five minutes', () => {
  assert.equal(AWAY_IDLE_MS, 5 * MINUTE)
})

test('away rule: active keyboard, unlocked, no override is not away', () => {
  assert.deepEqual(evaluateAway(base, T0), { away: false, hereSetAt: null })
})

test('away rule: idle at 5 min minus 1 ms is present, at 5 min is away', () => {
  assert.equal(evaluateAway({ ...base, idleMs: AWAY_IDLE_MS - 1 }, T0).away, false)
  assert.equal(evaluateAway({ ...base, idleMs: AWAY_IDLE_MS }, T0).away, true)
})

test('away rule: unknown idle time (null) counts as away', () => {
  assert.equal(evaluateAway({ ...base, idleMs: null }, T0).away, true)
})

test('away rule: a locked screen is away whatever the idle time', () => {
  assert.equal(evaluateAway({ ...base, locked: true, idleMs: 0 }, T0).away, true)
})

test('away rule: /away forces away and clears a pending /here', () => {
  assert.deepEqual(evaluateAway({ ...base, overrideAway: true, hereSetAt: T0 - MINUTE }, T0), {
    away: true,
    hereSetAt: null,
  })
})

test('away rule: a lock keeps a pending /here (it is not cleared)', () => {
  const here = T0 - MINUTE
  assert.deepEqual(evaluateAway({ ...base, locked: true, hereSetAt: here }, T0), { away: true, hereSetAt: here })
})

test('away rule: /here suppresses away until a keypress after it', () => {
  // Idle for 12 min, /here set 10 min ago: no keypress since /here, so still suppressed and /here stays.
  const here = T0 - 10 * MINUTE
  assert.deepEqual(evaluateAway({ ...base, idleMs: 12 * MINUTE, hereSetAt: here }, T0), {
    away: false,
    hereSetAt: here,
  })
})

test('away rule: a keypress after /here (idle below the time since /here) clears /here and applies the idle rule', () => {
  const here = T0 - 10 * MINUTE
  // 3 min idle: a keypress came after /here, so /here is cleared; 3 min is under the threshold.
  assert.deepEqual(evaluateAway({ ...base, idleMs: 3 * MINUTE, hereSetAt: here }, T0), { away: false, hereSetAt: null })
  // 7 min idle is below 10 min (the time since /here) and over 5 min: away again once /here is cleared.
  assert.deepEqual(evaluateAway({ ...base, idleMs: 7 * MINUTE, hereSetAt: here }, T0), { away: true, hereSetAt: null })
})

// Fake platform port: only the two reads the rule needs.
function fakePort(idle: number | null, locked: boolean) {
  const calls: string[] = []
  return {
    calls,
    port: {
      idleMs: async () => {
        calls.push('idleMs')
        return idle
      },
      isLocked: async () => {
        calls.push('isLocked')
        return locked
      },
    },
  }
}

test('awayFromPlatform: reads idle and lock from the port and applies the rule', async () => {
  const { port, calls } = fakePort(AWAY_IDLE_MS + 1, false)
  assert.deepEqual(await awayFromPlatform(port, { overrideAway: false, hereSetAt: null }, T0), {
    away: true,
    hereSetAt: null,
  })
  assert.deepEqual(calls.sort(), ['idleMs', 'isLocked'])
})

test('awayFromPlatform: a locked fake screen is away even when the keyboard was just used', async () => {
  const { port } = fakePort(0, true)
  assert.equal((await awayFromPlatform(port, { overrideAway: false, hereSetAt: null }, T0)).away, true)
})

test('awayFromPlatform: unreadable idle time (null) is away', async () => {
  const { port } = fakePort(null, false)
  assert.equal((await awayFromPlatform(port, { overrideAway: false, hereSetAt: null }, T0)).away, true)
})

test('awayFromPlatform: /here set and an active keyboard keeps the owner present', async () => {
  const { port } = fakePort(2 * MINUTE, false)
  const here = T0 - MINUTE
  assert.deepEqual(await awayFromPlatform(port, { overrideAway: false, hereSetAt: here }, T0), {
    away: false,
    hereSetAt: here,
  })
})

test('evaluateIdle: tri-state, active under the threshold, idle at it, unknown when unreadable', () => {
  assert.equal(evaluateIdle({ ...base, idleMs: AWAY_IDLE_MS - 1 }, T0).state, 'active')
  assert.equal(evaluateIdle({ ...base, idleMs: AWAY_IDLE_MS }, T0).state, 'idle')
  assert.equal(evaluateIdle({ ...base, idleMs: null }, T0).state, 'unknown')
  // /away and the lock are away whatever the idle time, so an unreadable source does not change them.
  assert.equal(evaluateIdle({ ...base, idleMs: null, overrideAway: true }, T0).state, 'idle')
  assert.equal(evaluateIdle({ ...base, idleMs: null, locked: true }, T0).state, 'idle')
  // /here does not hide unreadable idle time: the state stays unknown until the source reads again.
  assert.equal(evaluateIdle({ ...base, idleMs: null, hereSetAt: T0 }, T0).state, 'unknown')
})

test('evaluateAway keeps its boolean answer: unknown is away, active is not', () => {
  assert.equal(evaluateAway({ ...base, idleMs: null }, T0).away, true)
  assert.equal(evaluateAway({ ...base, idleMs: 0 }, T0).away, false)
})

test('holdReading: a readable reading passes through and clears a down period', () => {
  const r = holdReading({ good: null, downSince: T0, alerted: false }, { idleMs: 7, locked: false }, T0 + 10)
  assert.deepEqual(r, {
    reading: { idleMs: 7, locked: false },
    held: false,
    state: { good: { reading: { idleMs: 7, locked: false }, at: T0 + 10 }, downSince: null, alerted: false },
    alert: null,
  })
})

test('holdReading: an unreadable source keeps the last good reading for 60 s, then gives unknown', () => {
  const good = { reading: { idleMs: 1000, locked: false }, at: T0 }
  let s: HoldState = { good, downSince: null, alerted: false }
  const inHold = holdReading(s, { idleMs: null, locked: false }, T0 + IDLE_HOLD_MS - 1)
  assert.equal(inHold.held, true)
  assert.deepEqual(inHold.reading, good.reading)
  assert.equal(evaluateIdle({ overrideAway: false, hereSetAt: null, ...inHold.reading }, T0).state, 'active')
  assert.equal(inHold.state.downSince, T0 + IDLE_HOLD_MS - 1, 'the down period starts at the first unreadable read')

  s = inHold.state
  const after = holdReading(s, { idleMs: null, locked: false }, T0 + IDLE_HOLD_MS)
  assert.equal(after.held, false)
  assert.equal(after.reading.idleMs, null)
  assert.equal(evaluateIdle({ overrideAway: false, hereSetAt: null, ...after.reading }, T0 + IDLE_HOLD_MS).state, 'unknown')
})

test('holdReading: the down alert is raised once, after 5 minutes of unreadable reads', () => {
  const t = (ms: number) => T0 + ms
  let s: HoldState = NO_HOLD
  const alerts: Array<string | null> = []
  // First unreadable read at t(0); reads every 30 s.
  for (let ms = 0; ms <= IDLE_DOWN_ALERT_MS + 60_000; ms += 30_000) {
    const r = holdReading(s, { idleMs: null, locked: false }, t(ms))
    s = r.state
    alerts.push(r.alert)
  }
  const fired = alerts.map((a, i) => (a === 'down' ? i : -1)).filter((i) => i >= 0)
  assert.deepEqual(fired, [10], 'one down alert, at the read 5 minutes after the first unreadable one')
  assert.equal(s.alerted, true)
})

test('holdReading: a readable reading after the down alert raises the up alert once', () => {
  const s: HoldState = { good: null, downSince: T0, alerted: true }
  const back = holdReading(s, { idleMs: 3, locked: false }, T0 + IDLE_DOWN_ALERT_MS + 1)
  assert.equal(back.alert, 'up')
  assert.equal(holdReading(back.state, { idleMs: 3, locked: false }, T0 + IDLE_DOWN_ALERT_MS + 2).alert, null)
})

test('holdReading: a short outage (under 5 minutes) raises no alert at all', () => {
  let s: HoldState = NO_HOLD
  const alerts: unknown[] = []
  for (const [ms, idle] of [[0, 5], [30_000, null], [60_000, null], [90_000, 5]] as const) {
    const r = holdReading(s, { idleMs: idle, locked: false }, T0 + ms)
    s = r.state
    alerts.push(r.alert)
  }
  assert.deepEqual(alerts, [null, null, null, null])
})

test('idleAlertText: the down text names the 5 minutes and the terminal fallback; the up text says it is back', () => {
  assert.match(idleAlertText('down'), /5 minutes.*terminal/)
  assert.match(idleAlertText('up'), /readable again/)
})

test('away rule: a logged-out reading (no graphical login) is away, like the lock, and keeps a pending /here', () => {
  const loggedOut = { ...base, idleMs: null, loggedOut: true }
  assert.deepEqual(evaluateIdle(loggedOut, T0), { state: 'idle', hereSetAt: null })
  const here = T0 - MINUTE
  assert.deepEqual(evaluateIdle({ ...loggedOut, hereSetAt: here }, T0), { state: 'idle', hereSetAt: here })
  assert.equal(evaluateIdle({ ...loggedOut, overrideAway: true }, T0).state, 'idle')
  assert.equal(evaluateAway(loggedOut, T0).away, true)
})

test('holdReading: a logged-out reading is a good reading: no hold, no down alert after 5 minutes', () => {
  let s: HoldState = NO_HOLD
  const loggedOut = { idleMs: null, locked: false, loggedOut: true }
  for (let ms = 0; ms <= IDLE_DOWN_ALERT_MS + 2 * MINUTE; ms += MINUTE) {
    const r = holdReading(s, loggedOut, T0 + ms)
    assert.equal(r.alert, null, `no alert at ${ms} ms`)
    assert.equal(r.held, false)
    assert.deepEqual(r.reading, loggedOut)
    s = r.state
  }
  assert.equal(s.downSince, null)
})

test('holdReading: a graphical login back with unreadable idle time is unknown, not a held logged-out reading', () => {
  const s: HoldState = { good: { reading: { idleMs: null, locked: false, loggedOut: true }, at: T0 }, downSince: null, alerted: false }
  const back = holdReading(s, { idleMs: null, locked: false }, T0 + 10_000)
  assert.equal(back.held, false)
  assert.equal(back.reading.loggedOut, undefined)
  assert.equal(evaluateIdle({ ...base, idleMs: back.reading.idleMs }, T0).state, 'unknown')
})

test('holdReading: after an outage alert, a logged-out reading raises the up alert once', () => {
  let s: HoldState = { good: null, downSince: T0, alerted: false }
  s = holdReading(s, { idleMs: null, locked: false }, T0 + IDLE_DOWN_ALERT_MS).state
  assert.equal(s.alerted, true)
  const back = holdReading(s, { idleMs: null, locked: false, loggedOut: true }, T0 + IDLE_DOWN_ALERT_MS + 1)
  assert.equal(back.alert, 'up')
  assert.equal(holdReading(back.state, { idleMs: null, locked: false, loggedOut: true }, T0 + IDLE_DOWN_ALERT_MS + 2).alert, null)
})
