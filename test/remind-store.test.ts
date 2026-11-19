// Remind store: the JSON item file (atomic save, tolerant load) and the due logic (one fire per item, catch-up).
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LATE_MS, loadItems, newId, saveItems, takeDue, type Item } from '../src/addons/remind/store.ts'

const dir = mkdtempSync(join(process.env.XDG_STATE_HOME!, 'remind-store-'))
const file = join(dir, 'remind', 'items.json')

const DAY = 86_400_000
const now = new Date(2026, 10, 19, 10, 0).getTime() // Thu 19 Nov 2026 10:00 local

const daily: Item = {
  id: 'daily001',
  kind: 'remind',
  text: 'take the bins out',
  schedule: { kind: 'cron', expr: '0 9 * * *' },
  nextRun: now - 3 * DAY,
  createdAt: now - 10 * DAY,
}
const once: Item = {
  id: 'once0001',
  kind: 'task',
  text: 'summarise the inbox',
  schedule: { kind: 'once', at: now - 30_000 },
  nextRun: now - 30_000,
  createdAt: now - DAY,
  dir: '/x/stolik',
}
const future: Item = {
  id: 'later001',
  kind: 'remind',
  text: 'call mom',
  schedule: { kind: 'once', at: now + DAY },
  nextRun: now + DAY,
  createdAt: now,
}

test('save then load round-trips the items', () => {
  saveItems(file, [daily, once])
  assert.deepEqual(loadItems(file), [daily, once])
  assert.equal(existsSync(file + '.tmp'), false)
})

test('a missing file loads as an empty list', () => {
  assert.deepEqual(loadItems(join(dir, 'nope', 'items.json')), [])
})

test('bad JSON loads as an empty list and does not throw', () => {
  const bad = join(dir, 'bad.json')
  writeFileSync(bad, '{oops')
  assert.deepEqual(loadItems(bad), [])
})

test('a file that is not a list loads as an empty list and is moved aside, not overwritten', () => {
  const wrong = join(dir, 'wrong.json')
  writeFileSync(wrong, JSON.stringify({ items: [daily] }))
  assert.deepEqual(loadItems(wrong), [])
  assert.equal(existsSync(wrong), false)
  assert.ok(readdirSync(dir).some((f) => f.startsWith('wrong.json.bad-')))
})

test('an invalid item in a list is skipped and the valid ones are kept', () => {
  const mixed = join(dir, 'mixed.json')
  writeFileSync(mixed, JSON.stringify([{ id: 'x', kind: 'nope' }]))
  assert.deepEqual(loadItems(mixed), [])
  writeFileSync(mixed, JSON.stringify([daily, { id: 'x', kind: 'nope' }, once]))
  assert.deepEqual(loadItems(mixed), [daily, once])
})

test('one bad item among two good ones loads two items', () => {
  const bad = join(dir, 'one-bad.json')
  writeFileSync(bad, JSON.stringify([daily, { ...once, nextRun: 'soon' }, future]))
  assert.deepEqual(loadItems(bad), [daily, future])
})

test('a garbage file loads as an empty list and a .bad- copy is kept next to it', () => {
  const garbage = join(dir, 'garbage.json')
  writeFileSync(garbage, '{oops')
  assert.deepEqual(loadItems(garbage), [])
  assert.equal(existsSync(garbage), false)
  assert.ok(readdirSync(dir).some((f) => f.startsWith('garbage.json.bad-')))
})

test('the file on disk is valid JSON after save', () => {
  saveItems(file, [future])
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), [future])
})

test('a daily item missed for 3 days fires once, late, and waits for its next future run', () => {
  const { fire, keep } = takeDue([daily], now)
  assert.equal(fire.length, 1)
  assert.equal(fire[0].late, true)
  assert.equal(fire[0].item.nextRun, daily.nextRun)
  assert.equal(keep.length, 1)
  assert.ok(keep[0].nextRun > now)
  assert.equal(keep[0].nextRun, new Date(2026, 10, 20, 9, 0).getTime())
  // A second pass at the same time fires nothing.
  assert.equal(takeDue(keep, now).fire.length, 0)
})

test('a once item due 30 seconds ago fires on time and is dropped', () => {
  const { fire, keep } = takeDue([once], now)
  assert.equal(fire.length, 1)
  assert.equal(fire[0].late, false)
  assert.equal(keep.length, 0)
})

test('the late flag uses LATE_MS, two minutes', () => {
  assert.equal(LATE_MS, 120_000)
  const edge = { ...once, nextRun: now - 120_000, schedule: { kind: 'once' as const, at: now - 120_000 } }
  assert.equal(takeDue([edge], now).fire[0].late, false)
  const past = { ...once, nextRun: now - 120_001, schedule: { kind: 'once' as const, at: now - 120_001 } }
  assert.equal(takeDue([past], now).fire[0].late, true)
})

test('a not-due item is kept unchanged', () => {
  const { fire, keep } = takeDue([future], now)
  assert.equal(fire.length, 0)
  assert.deepEqual(keep, [future])
})

test('newId gives 8 characters from a-z0-9, different each time', () => {
  const a = newId()
  const b = newId()
  assert.match(a, /^[a-z0-9]{8}$/)
  assert.notEqual(a, b)
})
