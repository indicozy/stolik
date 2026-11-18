// Digest schedule (plan 3.4, design §4.9): when a digest is made. Pure: local-time run times, the period each run covers,
// and the catch-up list for runs missed while tg-bridge was down. Run times are built from local calendar parts, so 04:00
// stays 04:00 across DST changes.

export type Schedule = 'request' | 'daily' | 'weekly'
export const SCHEDULES: readonly Schedule[] = ['request', 'daily', 'weekly']

// Scheduled runs happen at this local hour. A daily run covers the day before; a weekly run (Monday) covers the week before.
export const RUN_HOUR = 4
// At most this many missed runs are caught up at start; older misses are dropped (the newest ones are kept).
export const CATCH_UP_CAP = 7

// What one digest file covers: a local day (`YYYY-MM-DD`) or an ISO week (`YYYY-Www`), with its first day and day count.
export type Period = { name: string; from: string; days: number }
export type Run = { runAt: number; period: Period }

const pad = (n: number) => String(n).padStart(2, '0')

// `YYYY-MM-DD` of a local calendar date.
export function localDayOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// The local date `n` days after `day` (`YYYY-MM-DD`). Negative n goes back. Built from calendar parts (DST-safe).
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return localDayOf(new Date(y, m - 1, d + n))
}

// The local 04:00 of a calendar day, as epoch milliseconds.
function runTimeOf(day: string): number {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, RUN_HOUR, 0, 0, 0).getTime()
}

// Day of week of a `YYYY-MM-DD` (0 Sunday to 6 Saturday), from its calendar parts.
function weekdayOf(day: string): number {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).getDay()
}

// Whether a scheduled run happens on this day: every day for daily, Mondays for weekly, never for request.
function runsOn(schedule: Schedule, day: string): boolean {
  if (schedule === 'daily') return true
  if (schedule === 'weekly') return weekdayOf(day) === 1
  return false
}

// ISO week key of a `YYYY-MM-DD`: `YYYY-Www`, with the ISO week-year (late December can belong to week 1 of the next year).
export function isoWeekKey(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  const dayNum = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${t.getUTCFullYear()}-W${pad(week)}`
}

// The period of a manual or daily digest for one local day.
export function dayPeriod(day: string): Period {
  return { name: day, from: day, days: 1 }
}

// The period a scheduled run covers: the day before a daily run, or the Monday-to-Sunday week before a weekly run.
export function periodOf(schedule: Schedule, runAt: string): Period {
  if (schedule === 'weekly') {
    const monday = addDays(runAt, -7)
    return { name: isoWeekKey(monday), from: monday, days: 7 }
  }
  return dayPeriod(addDays(runAt, -1))
}

// The latest scheduled run at or before `now`, as its local day, or null when the schedule has no runs.
function latestRunDay(schedule: Schedule, now: number): string | null {
  if (schedule === 'request') return null
  let day = localDayOf(new Date(now))
  // A run earlier today (before 04:00) is not yet due; step back to the previous run day. Bounded: a week covers both schedules.
  for (let i = 0; i < 8; i++) {
    if (runsOn(schedule, day) && runTimeOf(day) <= now) return day
    day = addDays(day, -1)
  }
  return null
}

// The next scheduled run strictly after `now` (epoch ms), or null for request-only.
export function nextRun(schedule: Schedule, now: number): number | null {
  if (schedule === 'request') return null
  let day = localDayOf(new Date(now))
  for (let i = 0; i < 9; i++) {
    if (runsOn(schedule, day) && runTimeOf(day) > now) return runTimeOf(day)
    day = addDays(day, 1)
  }
  return null
}

// The runs due and not yet done, oldest first, at most CATCH_UP_CAP (the newest are kept). `lastRunAt` is the run time of
// the last run done (null: never run). A schedule that never ran gets only its latest run, not a backlog: turning it on
// does not make a week of digests at once.
export function dueRuns(schedule: Schedule, lastRunAt: number | null, now: number): Run[] {
  const latest = latestRunDay(schedule, now)
  if (latest === null) return []
  if (lastRunAt === null) return [{ runAt: runTimeOf(latest), period: periodOf(schedule, latest) }]
  const out: Run[] = []
  let day: string | null = latest
  while (day !== null && out.length < CATCH_UP_CAP) {
    const at = runTimeOf(day)
    if (at <= lastRunAt) break
    out.push({ runAt: at, period: periodOf(schedule, day) })
    day = previousRunDay(schedule, day)
  }
  return out.reverse()
}

// The scheduled run day before `day`, or null when none is found within a week.
function previousRunDay(schedule: Schedule, day: string): string | null {
  let d = addDays(day, -1)
  for (let i = 0; i < 7; i++) {
    if (runsOn(schedule, d)) return d
    d = addDays(d, -1)
  }
  return null
}
