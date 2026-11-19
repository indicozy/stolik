// Remind schedules (pure): a 5-field cron parser, the next local run, and a short description. Run times are built from
// local calendar parts (`new Date(y, m, d, h, min)`), so 09:00 stays 09:00 across DST changes, as in src/brain/schedule.ts.

export type Cron = {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  domStar: boolean
  dowStar: boolean
}

export type Schedule = { kind: 'once'; at: number } | { kind: 'cron'; expr: string }

// How far ahead nextAfter looks. An expression that never matches (e.g. Feb 31) gives null after this.
const SEARCH_DAYS = 732

const pad = (n: number) => String(n).padStart(2, '0')
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Parses one field (`*`, `a`, `a,b`, `a-b`, `*/n`, `a-b/n`, `a/n`) into the set of values it matches, or null.
function parseField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const [base, stepRaw, ...rest] = part.split('/')
    if (rest.length > 0) return null
    let step = 1
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw)) return null
      step = Number(stepRaw)
      if (step < 1) return null
    }
    let lo: number
    let hi: number
    if (base === '*') {
      lo = min
      hi = max
    } else if (/^\d+-\d+$/.test(base)) {
      const [a, b] = base.split('-').map(Number)
      lo = a
      hi = b
    } else if (/^\d+$/.test(base)) {
      lo = Number(base)
      hi = stepRaw !== undefined ? max : lo
    } else {
      return null
    }
    if (lo < min || hi > max || lo > hi) return null
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out.size > 0 ? out : null
}

// Parses a 5-field cron expression (minute hour day-of-month month day-of-week). Day-of-week 7 is Sunday. Null when bad.
export function parseCron(expr: string): Cron | null {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [m, h, dom, mon, dowRaw] = fields
  const minute = parseField(m, 0, 59)
  const hour = parseField(h, 0, 23)
  const domSet = parseField(dom, 1, 31)
  const month = parseField(mon, 1, 12)
  const dowSet = parseField(dowRaw, 0, 7)
  if (!minute || !hour || !domSet || !month || !dowSet) return null
  const dow = new Set([...dowSet].map((d) => (d === 7 ? 0 : d)))
  return {
    minute,
    hour,
    dom: domSet,
    month,
    dow,
    domStar: dom.startsWith('*'),
    dowStar: dowRaw.startsWith('*'),
  }
}

// The first local minute strictly after afterMs that the cron matches, or null when none within about two years.
// Day rule as standard cron: when both day-of-month and day-of-week are restricted, either may match.
export function nextAfter(cron: Cron, afterMs: number): number | null {
  const start = new Date(afterMs)
  const hours = [...cron.hour].sort((a, b) => a - b)
  const minutes = [...cron.minute].sort((a, b) => a - b)
  for (let i = 0; i < SEARCH_DAYS; i++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    if (!cron.month.has(day.getMonth() + 1)) continue
    const domMatch = cron.dom.has(day.getDate())
    const dowMatch = cron.dow.has(day.getDay())
    const dayMatch = cron.domStar || cron.dowStar ? domMatch && dowMatch : domMatch || dowMatch
    if (!dayMatch) continue
    for (const h of hours) {
      for (const mi of minutes) {
        const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, mi).getTime()
        // A DST gap moves the wall time, so require the local clock to read exactly h:mi.
        const got = new Date(t)
        if (got.getHours() !== h || got.getMinutes() !== mi) continue
        if (t > afterMs) return t
      }
    }
  }
  return null
}

// The next run after afterMs: a once item at its time (if still in the future), or the next cron match.
export function nextRun(s: Schedule, afterMs: number): number | null {
  if (s.kind === 'once') return s.at > afterMs ? s.at : null
  const cron = parseCron(s.expr)
  return cron ? nextAfter(cron, afterMs) : null
}

// `Ddd D Mon HH:MM`, for example `Fri 20 Nov 09:00`.
export function fmtWhen(ms: number): string {
  const d = new Date(ms)
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// A short label for a schedule. Cron gets `, next: <when>` after the label.
export function describeSchedule(s: Schedule, now: number): string {
  if (s.kind === 'once') return `Once, ${fmtWhen(s.at)}`
  const cron = parseCron(s.expr)
  if (!cron) return `Cron ${s.expr}`
  const next = nextAfter(cron, now)
  const nextText = next === null ? 'never' : fmtWhen(next)
  const single = cron.minute.size === 1 && cron.hour.size === 1 && cron.dom.size === 31 && cron.month.size === 12
  const clock = `${pad([...cron.hour][0])}:${pad([...cron.minute][0])}`
  if (single && cron.dow.size === 7) return `Daily ${clock}, next: ${nextText}`
  if (single && isWeekdays(cron.dow)) return `Mon–Fri ${clock}, next: ${nextText}`
  return `Cron ${s.expr}, next: ${nextText}`
}

function isWeekdays(dow: Set<number>): boolean {
  return dow.size === 5 && [1, 2, 3, 4, 5].every((d) => dow.has(d))
}
