// Digest schedule (plan 3.4): next run, the period each run covers, the catch-up list, ISO weeks, DST and week boundaries.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addDays, dueRuns, isoWeekKey, nextRun, periodOf, CATCH_UP_CAP } from '../src/brain/schedule.ts'

// Local time as epoch ms (the tests run in the machine's zone; DST cases set TZ themselves).
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const localStr = (ms: number) => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

test('request is never scheduled', () => {
  assert.equal(nextRun('request', at(2026, 11, 14, 9)), null)
  assert.deepEqual(dueRuns('request', null, at(2026, 11, 14, 9)), [])
  assert.deepEqual(dueRuns('request', at(2026, 11, 1), at(2026, 11, 14, 9)), [])
})

test('daily next run is 04:00 local: later today before 04:00, tomorrow after it', () => {
  assert.equal(localStr(nextRun('daily', at(2026, 11, 14, 3, 59))!), '2026-11-14 04:00')
  assert.equal(localStr(nextRun('daily', at(2026, 11, 14, 4, 0))!), '2026-11-15 04:00')
  assert.equal(localStr(nextRun('daily', at(2026, 11, 14, 23, 30))!), '2026-11-15 04:00')
})

test('weekly next run is Monday 04:00 local', () => {
  // 2026-11-14 is a Saturday; the next Monday is 2026-11-16.
  assert.equal(localStr(nextRun('weekly', at(2026, 11, 14, 9))!), '2026-11-16 04:00')
  // On Monday before 04:00 it is still today; after 04:00 it is the Monday after.
  assert.equal(localStr(nextRun('weekly', at(2026, 11, 16, 3, 0))!), '2026-11-16 04:00')
  assert.equal(localStr(nextRun('weekly', at(2026, 11, 16, 4, 0))!), '2026-11-23 04:00')
})

test('a never-run daily schedule gets only its latest run, not a backlog', () => {
  const runs = dueRuns('daily', null, at(2026, 11, 14, 10))
  assert.equal(runs.length, 1)
  assert.equal(localStr(runs[0].runAt), '2026-11-14 04:00')
  assert.deepEqual(runs[0].period, { name: '2026-11-13', from: '2026-11-13', days: 1 })
})

test('before 04:00 the latest daily run is the one of two days ago', () => {
  const runs = dueRuns('daily', null, at(2026, 11, 14, 2))
  assert.equal(localStr(runs[0].runAt), '2026-11-13 04:00')
  assert.equal(runs[0].period.name, '2026-11-12')
})

test('catch-up lists the missed daily runs oldest first, each covering its day before', () => {
  const last = at(2026, 11, 10, 4)
  const runs = dueRuns('daily', last, at(2026, 11, 14, 9))
  // The 11-10 run was done. Missed: the runs of 11-11, 11-12, 11-13 and today (11-14, 04:00), covering the days before.
  assert.deepEqual(runs.map((r) => r.period.name), ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'])
  assert.deepEqual(runs.map((r) => localStr(r.runAt)), ['2026-11-11 04:00', '2026-11-12 04:00', '2026-11-13 04:00', '2026-11-14 04:00'])
})

test('catch-up keeps at most CATCH_UP_CAP runs, the newest', () => {
  assert.equal(CATCH_UP_CAP, 7)
  const runs = dueRuns('daily', at(2026, 10, 1, 4), at(2026, 11, 14, 9))
  assert.equal(runs.length, 7)
  assert.equal(runs[6].period.name, '2026-11-13')
  assert.equal(runs[0].period.name, '2026-11-07')
})

test('no catch-up when the last run is the latest one', () => {
  assert.deepEqual(dueRuns('daily', at(2026, 11, 14, 4), at(2026, 11, 14, 9)), [])
})

test('weekly runs are Mondays and each covers the Monday-to-Sunday week before', () => {
  const runs = dueRuns('weekly', null, at(2026, 11, 18, 9))
  assert.equal(localStr(runs[0].runAt), '2026-11-16 04:00')
  assert.deepEqual(runs[0].period, { name: '2026-W46', from: '2026-11-09', days: 7 })
  const missed = dueRuns('weekly', at(2026, 11, 2, 4), at(2026, 11, 18, 9))
  assert.deepEqual(missed.map((r) => r.period.name), ['2026-W45', '2026-W46'])
})

test('a Sunday 23:59 belongs to the week that ends then; Monday 00:00 starts the next', () => {
  // Monday 2026-11-16 04:00 covers 2026-11-09..15. A run at Monday 2026-11-23 covers 16..22.
  assert.equal(periodOf('weekly', '2026-11-16').name, '2026-W46')
  assert.equal(periodOf('weekly', '2026-11-23').name, '2026-W47')
  assert.equal(periodOf('weekly', '2026-11-23').from, '2026-11-16')
})

test('ISO week keys, including the year boundaries', () => {
  assert.equal(isoWeekKey('2026-11-09'), '2026-W46')
  assert.equal(isoWeekKey('2026-11-15'), '2026-W46')
  assert.equal(isoWeekKey('2027-01-01'), '2026-W53')
  assert.equal(isoWeekKey('2024-12-30'), '2025-W01')
  assert.equal(isoWeekKey('2026-01-01'), '2026-W01')
})

test('addDays crosses month and year ends', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01')
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
  assert.equal(addDays('2026-03-01', -1), '2026-02-28')
})

test('DST: the 04:00 run stays at 04:00 local across the spring and autumn changes (Europe/Berlin)', () => {
  const before = process.env.TZ
  process.env.TZ = 'Europe/Berlin'
  try {
    // Spring forward: 2026-03-29 02:00 to 03:00. The 04:00 run that day is still 04:00 local.
    const next = nextRun('daily', at(2026, 3, 28, 12))!
    assert.equal(localStr(next), '2026-03-29 04:00')
    assert.equal(new Date(next).getHours(), 4)
    // Autumn back: 2026-10-25 03:00 to 02:00. Also 04:00 local.
    const autumn = nextRun('daily', at(2026, 10, 24, 12))!
    assert.equal(localStr(autumn), '2026-10-25 04:00')
    assert.equal(new Date(autumn).getHours(), 4)
    // A week spanning the spring change gives seven distinct local days.
    const runs = dueRuns('daily', at(2026, 3, 25, 4), at(2026, 3, 31, 9))
    assert.deepEqual(runs.map((r) => r.period.name), ['2026-03-25', '2026-03-26', '2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30'])
    for (const r of runs) assert.equal(new Date(r.runAt).getHours(), 4)
  } finally {
    if (before === undefined) delete process.env.TZ
    else process.env.TZ = before
  }
})
