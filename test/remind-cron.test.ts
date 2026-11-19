// Remind cron: parsing, next run and description. The whole file runs in Berlin time so the DST cases are real.
import './helpers/isolate.ts'
process.env.TZ = 'Europe/Berlin'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeSchedule, nextAfter, nextRun, parseCron } from '../src/addons/remind/cron.ts'

// Local time as epoch ms.
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const localStr = (ms: number) => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

test('the test file runs in Berlin time', () => {
  assert.equal(new Date(2026, 2, 28, 12).getTimezoneOffset(), -60)
  assert.equal(new Date(2026, 2, 29, 12).getTimezoneOffset(), -120)
})

test('parseCron accepts the supported fields and rejects bad ones', () => {
  assert.notEqual(parseCron('0 9 * * 1-5'), null)
  assert.notEqual(parseCron('*/15 * * * *'), null)
  assert.notEqual(parseCron('0 9 1,15 * 7'), null)
  assert.equal(parseCron('61 * * * *'), null)
  assert.equal(parseCron('* * *'), null)
  assert.equal(parseCron('0 9 * * 8'), null)
  assert.equal(parseCron('a b c d e'), null)
})

test('dow 7 is Sunday, same as 0', () => {
  const c = parseCron('0 9 * * 7')!
  assert.deepEqual([...c.dow], [0])
})

test('daily 09:00 from Wed 18 Nov 10:00 is Thu 19 Nov 09:00', () => {
  assert.equal(localStr(nextAfter(parseCron('0 9 * * *')!, at(2026, 11, 18, 10))!), '2026-11-19 09:00')
  assert.equal(localStr(nextAfter(parseCron('0 9 * * *')!, at(2026, 11, 19, 10))!), '2026-11-20 09:00')
})

test('weekday cron from Fri 20 Nov 10:00 is Mon 23 Nov 09:00', () => {
  // 2026-11-20 is a Friday.
  assert.equal(localStr(nextAfter(parseCron('0 9 * * 1-5')!, at(2026, 11, 20, 10))!), '2026-11-23 09:00')
})

test('*/15 from 10:07 is 10:15', () => {
  assert.equal(localStr(nextAfter(parseCron('*/15 * * * *')!, at(2026, 11, 19, 10, 7))!), '2026-11-19 10:15')
})

test('a minute exactly at afterMs is not returned again', () => {
  assert.equal(localStr(nextAfter(parseCron('0 9 * * *')!, at(2026, 11, 19, 9, 0))!), '2026-11-20 09:00')
})

test('an expression that never matches gives null', () => {
  assert.equal(nextAfter(parseCron('0 0 31 2 *')!, at(2026, 11, 19)), null)
  assert.equal(nextRun({ kind: 'cron', expr: '0 0 31 2 *' }, at(2026, 11, 19)), null)
})

test('day rule: with dom and dow both restricted, either may match', () => {
  // 1st of the month OR Mondays. From Wed 2026-11-18: Mon 2026-11-23 comes before Tue 2026-12-01.
  assert.equal(localStr(nextAfter(parseCron('0 9 1 * 1')!, at(2026, 11, 18))!), '2026-11-23 09:00')
})

test('DST: a daily 09:00 stays at 09:00 local across the spring change', () => {
  // Europe/Berlin clocks go forward on 2026-03-29 at 02:00.
  const c = parseCron('0 9 * * *')!
  const first = nextAfter(c, at(2026, 3, 28, 10))!
  assert.equal(localStr(first), '2026-03-29 09:00')
  const d = new Date(first)
  assert.equal(d.getHours(), 9)
  assert.equal(d.getMinutes(), 0)
  assert.equal(first - at(2026, 3, 28, 9), 23 * 3_600_000)
  assert.equal(localStr(nextAfter(c, first)!), '2026-03-30 09:00')
})

test('once: the time when it is in the future, null when past', () => {
  const now = at(2026, 11, 19, 10)
  assert.equal(nextRun({ kind: 'once', at: at(2026, 11, 20, 9) }, now), at(2026, 11, 20, 9))
  assert.equal(nextRun({ kind: 'once', at: at(2026, 11, 19, 9) }, now), null)
})

test('describeSchedule: daily, weekdays, once and generic cron', () => {
  const now = at(2026, 11, 19, 10)
  assert.ok(describeSchedule({ kind: 'cron', expr: '0 9 * * *' }, now).startsWith('Daily 09:00, next: Fri 20 Nov 09:00'))
  assert.ok(describeSchedule({ kind: 'cron', expr: '0 9 * * 1-5' }, now).startsWith('Mon–Fri 09:00'))
  assert.equal(describeSchedule({ kind: 'once', at: at(2026, 11, 20, 9) }, now), 'Once, Fri 20 Nov 09:00')
  assert.ok(describeSchedule({ kind: 'cron', expr: '*/15 * * * *' }, now).startsWith('Cron */15 * * * *'))
})
