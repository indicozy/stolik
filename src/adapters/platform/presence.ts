import { evaluateIdle, holdReading, NO_HOLD, type HoldState, type IdleAlert, type IdleState } from '../../brain/away.ts'
import { log } from '../../router/log.ts'
import type { IdleSource } from './index.ts'

const CACHE_MS = 5000

export class Presence {
  private overrideAway = false
  private hereSetAt: number | null = null
  private cache: { value: IdleState; at: number } | null = null
  private hold: HoldState = NO_HOLD
  private alert: IdleAlert | null = null
  private unreadable = false
  private loggedOut = false
  private readonly source: IdleSource
  private readonly now: () => number

  // The idle and lock source comes from the platform factory (index.ts); tests pass a fake source and a clock.
  constructor(source: IdleSource, now: () => number = Date.now) {
    this.source = source
    this.now = now
  }

  // The tri-state answer. An unreadable source keeps its last good reading for a minute (brain/away.ts), then the
  // answer is unknown. Alerts are queued for takeAlert().
  async awayState(): Promise<IdleState> {
    const now = this.now()
    if (this.cache && now - this.cache.at < CACHE_MS) return this.cache.value
    const raw = await this.source.read()
    const h = holdReading(this.hold, raw, now)
    this.hold = h.state
    if (h.alert !== null) this.alert = h.alert
    // Log only when the reading flips, not on every check. No graphical login is away and gets its own line, not the
    // "idle time unavailable" one.
    const loggedOut = h.reading.loggedOut === true
    if (loggedOut !== this.loggedOut) {
      this.loggedOut = loggedOut
      log(loggedOut ? 'no graphical login; away' : 'graphical login back')
    }
    if (loggedOut) {
      this.unreadable = false
    } else if (raw.idleMs === null && !this.unreadable) {
      this.unreadable = true
      log(`idle time unavailable (${this.source.name}); the state is unknown, not away`)
    } else if (raw.idleMs !== null && this.unreadable) {
      this.unreadable = false
      log('idle time readable again')
    }
    const r = evaluateIdle({
      overrideAway: this.overrideAway,
      hereSetAt: this.hereSetAt,
      idleMs: h.reading.idleMs,
      locked: h.reading.locked,
      loggedOut,
    }, now)
    this.hereSetAt = r.hereSetAt
    this.cache = { value: r.state, at: now }
    return r.state
  }

  async isAway(): Promise<boolean> {
    return (await this.awayState()) !== 'active'
  }

  takeAlert(): IdleAlert | null {
    const a = this.alert
    this.alert = null
    return a
  }

  setAway(): void {
    this.overrideAway = true
    this.hereSetAt = null
    this.cache = null
  }

  setHere(now: number): void {
    this.overrideAway = false
    this.hereSetAt = now
    this.cache = null
  }
}
