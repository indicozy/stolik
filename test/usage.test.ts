// Usage and quota (plan 2.8, design §4.9): pace reading, the refusal at the weekly limit, the once-a-day alert, the
// week window, the usage log and the /usage text.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  QuotaCache, UsageLog, alertDue, dayKey, formatUsage, parseQuotaGate, parseUsageEvent, paceAlert, refusal, weekStart,
} from '../src/brain/usage.ts'

const QG_JSON = (used: number, ahead: number) =>
  JSON.stringify({ allowed: true, usage: { weekly: { used_pct: used, pacing: { used_minus_expected_pct: ahead } } } })

test('quota-gate output: the weekly used percent and the pace', () => {
  assert.deepEqual(parseQuotaGate(QG_JSON(37, -48.21)), { weeklyUsedPct: 37, aheadBy: -48.21 })
  assert.equal(parseQuotaGate('nope'), null)
  assert.equal(parseQuotaGate(JSON.stringify({ usage: { weekly: { used_pct: 'x' } } })), null)
  assert.equal(parseQuotaGate(JSON.stringify({ usage: { weekly: { used_pct: 5 } } })), null, 'no pacing means unknown')
  assert.equal(parseQuotaGate('null'), null)
})

test('refusal: 98.9 runs, 99.0 is refused (default limit 99)', () => {
  assert.equal(refusal({ weeklyUsedPct: 98.9, aheadBy: 0 }, 99).refuse, false)
  const at = refusal({ weeklyUsedPct: 99.0, aheadBy: 0 }, 99)
  assert.ok(at.refuse && /99%/.test(at.reason))
  assert.equal(refusal({ weeklyUsedPct: 99.5, aheadBy: 0 }, 99).refuse, true)
  assert.equal(refusal({ weeklyUsedPct: 90, aheadBy: 0 }, 95).refuse, false, 'a lower configured limit moves the line')
  assert.equal(refusal({ weeklyUsedPct: 95, aheadBy: 0 }, 95).refuse, true)
})

test('an unknown quota is refused (fail closed)', () => {
  const r = refusal(null, 99)
  assert.ok(r.refuse && /could not be read/.test(r.reason))
})

test('the alert is due once a day, and only when ahead of the pace', () => {
  assert.equal(alertDue(3.2, '2026-11-14', null), true)
  assert.equal(alertDue(3.2, '2026-11-14', '2026-11-13'), true)
  assert.equal(alertDue(3.2, '2026-11-14', '2026-11-14'), false, 'already sent today')
  assert.equal(alertDue(-1, '2026-11-14', null), false, 'not ahead')
  assert.equal(alertDue(0, '2026-11-14', null), false, 'exactly on the pace is not ahead')
})

test('the week starts Sunday 05:00 local, and a time before that belongs to the week before', () => {
  const sunday0500 = new Date(2026, 10, 8, 5, 0, 0) // 2026-11-08 is a Sunday
  assert.equal(weekStart(new Date(2026, 10, 14, 12, 0)).getTime(), sunday0500.getTime())
  assert.equal(weekStart(new Date(2026, 10, 8, 4, 59)).getTime(), new Date(2026, 10, 1, 5, 0).getTime())
  assert.equal(weekStart(new Date(2026, 10, 8, 5, 0)).getTime(), sunday0500.getTime())
  assert.equal(dayKey(new Date(2026, 10, 14, 23, 59)), '2026-11-14')
})

const DAY = 86_400_000
test('the usage log totals today and this week, per mode', () => {
  const now = new Date(2026, 10, 14, 15, 0) // Saturday afternoon
  const t0 = now.getTime()
  const log = new UsageLog()
  log.add({ mode: 'quick', costUsd: 0.02, durationMs: 1000, ts: t0 - 60_000, outcome: 'answer' })
  log.add({ mode: 'read', costUsd: 0.25, durationMs: 9000, ts: t0 - 2 * 3600_000, outcome: 'limit' })
  log.add({ mode: 'web', costUsd: 0.1, durationMs: 4000, ts: t0 - 2 * DAY, outcome: 'answer' })
  log.add({ mode: 'web', costUsd: 0.5, durationMs: 4000, ts: t0 - 9 * DAY, outcome: 'answer' })
  const s = log.summary(now)
  assert.equal(s.today.runs, 2)
  assert.ok(Math.abs(s.today.costUsd - 0.27) < 1e-9)
  assert.equal(s.byModeToday.read.runs, 1)
  assert.equal(s.week.runs, 3, 'the run nine days back is outside the week')
  assert.ok(Math.abs(s.week.costUsd - 0.37) < 1e-9)
  assert.equal(s.byModeWeek.web.runs, 1)
})

test('the usage log round-trips, drops bad records, and prunes old ones', () => {
  const now = 1_800_000_000_000
  const log = new UsageLog()
  log.add({ mode: 'quick', costUsd: 0.1, durationMs: 5, ts: now, outcome: 'answer' })
  log.add({ mode: 'quick', costUsd: 0.1, durationMs: 5, ts: now - 100 * DAY, outcome: 'answer' })
  log.prune(now)
  assert.equal(log.size, 1)
  const back = UsageLog.fromJSON(JSON.stringify([{ mode: 'nope', costUsd: 1, durationMs: 1, ts: now, outcome: 'answer' }, { mode: 'web', costUsd: 0.3, durationMs: 1, ts: now, outcome: 'error' }, 'x']))
  assert.equal(back.size, 1)
  assert.equal(UsageLog.fromJSON('garbage').size, 0)
})

test('a usage event from an addon is checked field by field', () => {
  const now = 42
  assert.deepEqual(parseUsageEvent({ mode: 'read', costUsd: 0.04, durationMs: 12000, outcome: 'answer' }, now), { mode: 'read', costUsd: 0.04, durationMs: 12000, ts: now, outcome: 'answer' })
  assert.equal(parseUsageEvent({ mode: 'read', costUsd: -1, durationMs: 1, outcome: 'answer' }, now), null)
  assert.equal(parseUsageEvent({ mode: 'read', costUsd: 1, durationMs: 1, outcome: 'weird' }, now), null)
  assert.equal(parseUsageEvent({ mode: 'shell', costUsd: 1, durationMs: 1, outcome: 'answer' }, now), null)
  assert.equal(parseUsageEvent(null, now), null)
})

test('the /usage text: today, week, per mode, and the pace in words', () => {
  const now = new Date(2026, 10, 14, 15, 0)
  const log = new UsageLog()
  log.add({ mode: 'read', costUsd: 0.04, durationMs: 1, ts: now.getTime(), outcome: 'answer' })
  const ahead = formatUsage(log.summary(now), { weeklyUsedPct: 80, aheadBy: 4.25 }, 99)
  assert.match(ahead, /Today: 1 mode runs, \$0\.04\. By mode: read 1 \(\$0\.04\)/)
  assert.match(ahead, /Weekly quota: 80% used, ahead of the pace by 4\.3 points\. Modes stop at 99%\./)
  const behind = formatUsage(log.summary(now), { weeklyUsedPct: 37, aheadBy: -48.2 }, 99)
  assert.match(behind, /on or under the pace \(48\.2 points to spare\)/)
  const unknown = formatUsage(log.summary(now), null, 99)
  assert.match(unknown, /Weekly quota: unknown/)
  assert.match(paceAlert({ weeklyUsedPct: 80, aheadBy: 4.25 }), /ahead of the pace/)
})

test('the quota is cached for five minutes; a failed read is retried after one', async () => {
  let t = 0
  let calls = 0
  const cache = new QuotaCache(async () => (++calls === 1 ? null : { weeklyUsedPct: 10, aheadBy: 0 }), () => t)
  assert.equal(await cache.get(), null, 'the first read failed')
  t += 30_000
  assert.equal(await cache.get(), null, 'a failure is kept for a minute')
  assert.equal(calls, 1)
  t += 31_000
  assert.deepEqual(await cache.get(), { weeklyUsedPct: 10, aheadBy: 0 }, 'then retried')
  t += 2 * 60_000
  assert.deepEqual(await cache.get(), { weeklyUsedPct: 10, aheadBy: 0 }, 'a good reading is reused')
  assert.equal(calls, 2)
  t += 4 * 60_000
  await cache.get()
  assert.equal(calls, 3, 'refreshed after five minutes')
  const throwing = new QuotaCache(async () => { throw new Error('boom') }, () => t)
  assert.equal(await throwing.get(), null, 'a throwing read is unknown, not an error')
})
