// Usage and quota (plan 2.8, design §4.9): pure pace math, the refusal rule for modes, the once-a-day alert guard, the
// usage log of mode runs, and the text of `/usage`. The quota-gate call and the file are in the router (addon-bridge).
import type { ModeName } from './modes.ts'

// The week counts from Sunday 05:00 local (owner's pacing rule, CLAUDE.md "Claude quota").
export const WEEK_START_DAY = 0
export const WEEK_START_HOUR = 5
export const DEFAULT_WEEKLY_LIMIT_PCT = 99

export type QuotaStatus = {
  // `usage.weekly.used_pct` from quota-gate.
  weeklyUsedPct: number
  // `usage.weekly.pacing.used_minus_expected_pct`: above 0 is ahead of the weekly pace.
  aheadBy: number
}

// Reads quota-gate's JSON. Null when the fields are missing or not numbers (the caller treats that as unknown).
export function parseQuotaGate(text: string): QuotaStatus | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const weekly = (raw as { usage?: { weekly?: unknown } } | null)?.usage?.weekly as
    | { used_pct?: unknown; pacing?: { used_minus_expected_pct?: unknown } }
    | undefined
  const used = weekly?.used_pct
  const ahead = weekly?.pacing?.used_minus_expected_pct
  if (typeof used !== 'number' || !Number.isFinite(used)) return null
  if (typeof ahead !== 'number' || !Number.isFinite(ahead)) return null
  return { weeklyUsedPct: used, aheadBy: ahead }
}

export type Refusal = { refuse: false } | { refuse: true; reason: string }

// Modes refuse at or above the weekly limit (98.9 runs, 99.0 is refused at the default limit). An unknown quota is
// refused too: the quota-gate skill says to fail closed when the quota cannot be read.
export function refusal(q: QuotaStatus | null, limitPct: number = DEFAULT_WEEKLY_LIMIT_PCT): Refusal {
  if (q === null) return { refuse: true, reason: 'the quota could not be read, so modes are paused' }
  if (q.weeklyUsedPct >= limitPct) {
    return { refuse: true, reason: `the weekly quota is at ${q.weeklyUsedPct}% (limit ${limitPct}%)` }
  }
  return { refuse: false }
}

// Local calendar day as yyyy-mm-dd (the key of the once-a-day alert).
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// One alert a day, and only when ahead of the pace.
export function alertDue(aheadBy: number, today: string, lastAlertDay: string | null): boolean {
  return aheadBy > 0 && lastAlertDay !== today
}

// The start of the current week: the latest Sunday 05:00 local that is not after `now`.
export function weekStart(now: Date): Date {
  const d = new Date(now.getTime())
  d.setHours(WEEK_START_HOUR, 0, 0, 0)
  const back = (d.getDay() - WEEK_START_DAY + 7) % 7
  d.setDate(d.getDate() - back)
  if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 7)
  return d
}

export function startOfToday(now: Date): Date {
  const d = new Date(now.getTime())
  d.setHours(0, 0, 0, 0)
  return d
}

// ---------- usage log ----------

export type UsageRecord = {
  mode: ModeName
  costUsd: number
  durationMs: number
  ts: number
  // 'answer', 'limit' (partial) or 'error'.
  outcome: 'answer' | 'limit' | 'error'
}

// Retention of the usage rows (days, and at most this many rows). The store prunes to these.
export const USAGE_KEEP_DAYS = 60
export const USAGE_KEEP_RECORDS = 5000
const MODES: readonly string[] = ['quick', 'read', 'web']

export type Totals = { runs: number; costUsd: number }
export type UsageSummary = {
  today: Totals
  week: Totals
  byModeToday: Record<ModeName, Totals>
  byModeWeek: Record<ModeName, Totals>
}

export class UsageLog {
  private readonly records: UsageRecord[] = []

  get size(): number {
    return this.records.length
  }

  add(r: UsageRecord): void {
    this.records.push(r)
    if (this.records.length > USAGE_KEEP_RECORDS) this.records.splice(0, this.records.length - USAGE_KEEP_RECORDS)
  }

  // Drops what is older than USAGE_KEEP_DAYS before `now`.
  prune(now: number): void {
    const cut = now - USAGE_KEEP_DAYS * 86_400_000
    const kept = this.records.filter((r) => r.ts >= cut)
    this.records.splice(0, this.records.length, ...kept)
  }

  summary(now: Date): UsageSummary {
    const todayFrom = startOfToday(now).getTime()
    const weekFrom = weekStart(now).getTime()
    const out: UsageSummary = {
      today: { runs: 0, costUsd: 0 },
      week: { runs: 0, costUsd: 0 },
      byModeToday: { quick: { runs: 0, costUsd: 0 }, read: { runs: 0, costUsd: 0 }, web: { runs: 0, costUsd: 0 } },
      byModeWeek: { quick: { runs: 0, costUsd: 0 }, read: { runs: 0, costUsd: 0 }, web: { runs: 0, costUsd: 0 } },
    }
    for (const r of this.records) {
      if (r.ts >= weekFrom) add(out.week, out.byModeWeek[r.mode], r.costUsd)
      if (r.ts >= todayFrom) add(out.today, out.byModeToday[r.mode], r.costUsd)
    }
    return out
  }

  toJSON(): string {
    return JSON.stringify(this.records)
  }

  // A log of records read from the store, oldest first.
  static fromRecords(recs: readonly UsageRecord[]): UsageLog {
    const log = new UsageLog()
    for (const r of recs) log.add(r)
    return log
  }

  // Reads the file body. Bad records are skipped; a bad file gives an empty log.
  static fromJSON(text: string): UsageLog {
    const log = new UsageLog()
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return log
    }
    if (!Array.isArray(raw)) return log
    for (const x of raw) {
      if (!x || typeof x !== 'object') continue
      const r = x as Record<string, unknown>
      if (typeof r.mode !== 'string' || !MODES.includes(r.mode)) continue
      if (typeof r.costUsd !== 'number' || !Number.isFinite(r.costUsd) || r.costUsd < 0) continue
      if (typeof r.durationMs !== 'number' || typeof r.ts !== 'number') continue
      if (r.outcome !== 'answer' && r.outcome !== 'limit' && r.outcome !== 'error') continue
      log.add({ mode: r.mode as ModeName, costUsd: r.costUsd, durationMs: r.durationMs, ts: r.ts, outcome: r.outcome })
    }
    return log
  }
}

function add(t: Totals, m: Totals, cost: number): void {
  t.runs++
  t.costUsd += cost
  m.runs++
  m.costUsd += cost
}

// Validates a usage event from an addon. Null when a field is wrong (the event is then dropped).
export function parseUsageEvent(raw: unknown, now: number): UsageRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.mode !== 'string' || !MODES.includes(r.mode)) return null
  const costUsd = typeof r.costUsd === 'number' && Number.isFinite(r.costUsd) && r.costUsd >= 0 ? r.costUsd : null
  const durationMs = typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) && r.durationMs >= 0 ? r.durationMs : null
  const outcome = r.outcome === 'answer' || r.outcome === 'limit' || r.outcome === 'error' ? r.outcome : null
  if (costUsd === null || durationMs === null || outcome === null) return null
  return { mode: r.mode as ModeName, costUsd, durationMs, ts: now, outcome }
}

const money = (n: number): string => `$${n.toFixed(2)}`

function modesLine(by: Record<ModeName, Totals>): string {
  const parts = (['quick', 'read', 'web'] as const).filter((m) => by[m].runs > 0).map((m) => `${m} ${by[m].runs} (${money(by[m].costUsd)})`)
  return parts.length > 0 ? parts.join(', ') : 'none'
}

// The `/usage` text: today and this week, per mode, and the weekly pace. `quota` null means the quota could not be read.
export function formatUsage(s: UsageSummary, quota: QuotaStatus | null, limitPct: number): string {
  const lines = [
    'Usage',
    `Today: ${s.today.runs} mode runs, ${money(s.today.costUsd)}. By mode: ${modesLine(s.byModeToday)}.`,
    `This week (since Sunday 05:00): ${s.week.runs} mode runs, ${money(s.week.costUsd)}. By mode: ${modesLine(s.byModeWeek)}.`,
    'Sessions: per-session token totals are not recorded yet (the Stop hook payload has no usage fields).',
  ]
  if (quota === null) {
    lines.push(`Weekly quota: unknown (quota-gate did not answer). Modes are paused until it does. Limit ${limitPct}%.`)
  } else {
    const pace =
      quota.aheadBy > 0
        ? `ahead of the pace by ${quota.aheadBy.toFixed(1)} points`
        : `on or under the pace (${Math.abs(quota.aheadBy).toFixed(1)} points to spare)`
    lines.push(`Weekly quota: ${quota.weeklyUsedPct}% used, ${pace}. Modes stop at ${limitPct}%.`)
  }
  return lines.join('\n')
}

// The alert text sent once a day when the week is ahead of the pace.
export function paceAlert(q: QuotaStatus): string {
  return `⚠️ Weekly quota is ahead of the pace: ${q.weeklyUsedPct}% used, ${q.aheadBy.toFixed(1)} points over. Modes keep working until the limit. See /usage.`
}

// The quota read through quota-gate, kept for five minutes. A failed read is kept for one minute, so a broken script
// is retried soon and never looks like a healthy quota.
export class QuotaCache {
  private value: QuotaStatus | null = null
  private at = Number.NEGATIVE_INFINITY
  private ttl = 0
  private readonly fetch: () => Promise<QuotaStatus | null>
  private readonly now: () => number
  private readonly okTtlMs: number
  private readonly failTtlMs: number

  constructor(fetch: () => Promise<QuotaStatus | null>, now: () => number, okTtlMs: number = 5 * 60_000, failTtlMs: number = 60_000) {
    this.fetch = fetch
    this.now = now
    this.okTtlMs = okTtlMs
    this.failTtlMs = failTtlMs
  }

  async get(): Promise<QuotaStatus | null> {
    const t = this.now()
    if (t - this.at < this.ttl) return this.value
    let next: QuotaStatus | null = null
    try {
      next = await this.fetch()
    } catch {
      next = null
    }
    this.value = next
    this.at = t
    this.ttl = next === null ? this.failTtlMs : this.okTtlMs
    return next
  }
}
