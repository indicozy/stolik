// Away rule (design section 4.7, plan S3). The idle state is tri-state: active (at the desk), idle (away: /away is on,
// the screen is locked, or idle >= AWAY_IDLE_MS) or unknown (the idle source cannot be read for longer than the hold).
// /here suppresses the idle answer until the next keypress. Pure: takes the facts as parameters.
import { MINUTE } from './common.ts'
import type { PlatformPort } from '../ports.ts'

export const AWAY_IDLE_MS = 5 * MINUTE
// An unreadable idle source keeps the last good reading this long, then the state is unknown.
export const IDLE_HOLD_MS = MINUTE
// The source down this long (since the last good reading) raises one alert in General.
export const IDLE_DOWN_ALERT_MS = 5 * MINUTE

// One reading of the idle source: idle milliseconds (null when unreadable) and the lock state. `loggedOut` is set
// when the source is readable as "no graphical login at all" (the PC sits at the greeter): that is away, not unknown.
export type IdleReading = { idleMs: number | null; locked: boolean; loggedOut?: boolean }

// The answer of the rule. `idle` means away (by /away, the lock or idle time); `unknown` means the source is down.
export type IdleState = 'active' | 'idle' | 'unknown'

// ---------- presence ----------

export type PresenceInput = {
  overrideAway: boolean
  hereSetAt: number | null
  // null when idle time cannot be read (no X display, e.g. logged out): the state is unknown.
  idleMs: number | null
  locked: boolean
  // No graphical login for the owner: away, like the lock.
  loggedOut?: boolean
}

// /away, the lock and a missing graphical login give `idle`, whatever the idle time. Unknown idle time gives `unknown`
// (not away). /here wins over idle time until a keypress (idle drops below the time since /here). Returns the updated
// hereSetAt.
export function evaluateIdle(p: PresenceInput, now: number): { state: IdleState; hereSetAt: number | null } {
  if (p.overrideAway) return { state: 'idle', hereSetAt: null }
  if (p.locked || p.loggedOut) return { state: 'idle', hereSetAt: p.hereSetAt }
  if (p.idleMs === null) return { state: 'unknown', hereSetAt: p.hereSetAt }
  let hereSetAt = p.hereSetAt
  if (hereSetAt !== null) {
    if (p.idleMs >= now - hereSetAt) return { state: 'active', hereSetAt }
    hereSetAt = null
  }
  return { state: p.idleMs >= AWAY_IDLE_MS ? 'idle' : 'active', hereSetAt }
}

// The boolean form used by callers that only ask "away?": unknown counts as away here, as it always has.
export function evaluateAway(p: PresenceInput, now: number): { away: boolean; hereSetAt: number | null } {
  const r = evaluateIdle(p, now)
  return { away: r.state !== 'active', hereSetAt: r.hereSetAt }
}

// The same rule over the platform port: reads idle time and the lock state, then applies evaluateAway. The
// adapter's own isAway() composes the same answer; this keeps the rule testable with a fake port.
export async function awayFromPlatform(
  port: Pick<PlatformPort, 'idleMs' | 'isLocked'>,
  flags: { overrideAway: boolean; hereSetAt: number | null },
  now: number,
): Promise<{ away: boolean; hereSetAt: number | null }> {
  const [idleMs, locked] = await Promise.all([port.idleMs(), port.isLocked()])
  return evaluateAway({ overrideAway: flags.overrideAway, hereSetAt: flags.hereSetAt, idleMs, locked }, now)
}

// ---------- hold and alert ----------

export type IdleAlert = 'down' | 'up'

// What the watch remembers between reads: the last good reading and when it was taken, when the source went down
// (null while readable), and whether the one-shot "down" alert has gone out.
export type HoldState = {
  good: { reading: IdleReading; at: number } | null
  downSince: number | null
  alerted: boolean
}

export const NO_HOLD: HoldState = { good: null, downSince: null, alerted: false }

// One read of the source. A readable reading is used as is. An unreadable one (idleMs null) gives the last good
// reading while it is at most IDLE_HOLD_MS old; after that the reading stays unreadable, so evaluateIdle says unknown.
// `alert` is 'down' once the source has been down IDLE_DOWN_ALERT_MS, and 'up' when a readable reading follows that alert.
export function holdReading(
  s: HoldState,
  raw: IdleReading,
  now: number,
): { reading: IdleReading; held: boolean; state: HoldState; alert: IdleAlert | null } {
  // A logged-out reading is a good reading too: it is not held, and it is not an outage.
  if (raw.idleMs !== null || raw.loggedOut) {
    return {
      reading: raw,
      held: false,
      state: { good: { reading: raw, at: now }, downSince: null, alerted: false },
      alert: s.alerted ? 'up' : null,
    }
  }
  const downSince = s.downSince ?? now
  let alerted = s.alerted
  let alert: IdleAlert | null = null
  if (!alerted && now - downSince >= IDLE_DOWN_ALERT_MS) {
    alerted = true
    alert = 'down'
  }
  const state: HoldState = { good: s.good, downSince, alerted }
  // A held reading is never a logged-out one: a graphical login that is back but has unreadable idle time is unknown.
  if (s.good && !s.good.reading.loggedOut && now - s.good.at < IDLE_HOLD_MS) return { reading: s.good.reading, held: true, state, alert }
  return { reading: raw, held: false, state, alert }
}

// The one-shot General alert text. `down` says how the owner is reached meanwhile; `up` says the source is back.
export function idleAlertText(alert: IdleAlert): string {
  if (alert === 'up') return 'Idle time is readable again. Presence is back to normal.'
  return (
    'Idle time has been unreadable for 5 minutes. Questions from Claude go to the terminal until it recovers; ' +
    'permission prompts still come here, marked "away status unknown".'
  )
}

// Added to a permission prompt sent while the idle state is unknown.
export const UNKNOWN_AWAY_NOTE = 'Away status unknown: idle time cannot be read. Answer here or at the desk.'
