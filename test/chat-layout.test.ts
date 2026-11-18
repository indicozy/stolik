import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunkText, layoutButtonRows } from '../src/brain/chat-layout.ts'
import { offerRows } from '../src/router/handlers/builtins.ts'

// The Telegram and Discord button limits (telegram.ts, discord-map.ts).
const TG = { labelChars: 60, maxRows: 100, maxPerRow: 8 }
const DC = { labelChars: 80, maxRows: 5, maxPerRow: 5 }

const one = (i: number) => [{ text: `Session ${i}`, data: `rt:s:${i}` }]
const menu = (n: number) => Array.from({ length: n }, (_, i) => one(i))

test('Telegram keeps the router menus as they are (one button a row, the offer, a row of eight)', () => {
  const folderRow = Array.from({ length: 8 }, (_, i) => ({ text: `dir ${i}`, data: `fo:${i}` }))
  const shapes = [menu(10), offerRows(), [folderRow], [folderRow, [{ text: 'Back', data: 'fo:back' }]], menu(100)]
  for (const rows of shapes) {
    const laid = layoutButtonRows(rows, TG)
    assert.deepEqual(laid.rows, rows)
    assert.equal(laid.dropped, 0)
  }
})

test('Discord: more rows than maxRows, single-button rows share rows of maxPerRow', () => {
  const laid = layoutButtonRows(menu(10), DC)
  assert.deepEqual(laid.rows.map((r) => r.map((b) => b.text)), [
    ['Session 0', 'Session 1', 'Session 2', 'Session 3', 'Session 4'],
    ['Session 5', 'Session 6', 'Session 7', 'Session 8', 'Session 9'],
  ])
  assert.equal(laid.dropped, 0)
})

test('Discord: a row longer than maxPerRow is split, order kept, and the split pieces fit', () => {
  const row = Array.from({ length: 7 }, (_, i) => ({ text: `b${i}`, data: `d${i}` }))
  const laid = layoutButtonRows([row], DC)
  assert.deepEqual(laid.rows.map((r) => r.map((b) => b.text)), [['b0', 'b1', 'b2', 'b3', 'b4'], ['b5', 'b6']])
  assert.equal(laid.dropped, 0)
})

test('Discord: rows past maxRows are dropped and counted when they cannot share', () => {
  const rows = Array.from({ length: 6 }, (_, i) => [
    { text: `a${i}`, data: `x${i}` },
    { text: `b${i}`, data: `y${i}` },
  ])
  const laid = layoutButtonRows(rows, DC)
  assert.equal(laid.rows.length, 5)
  assert.equal(laid.dropped, 1)
})

test('labels are cut to labelChars by characters, not bytes', () => {
  const laid = layoutButtonRows([[{ text: 'abcdefghij', data: 'a' }, { text: 'ééééééé', data: 'b' }]], { labelChars: 5, maxRows: 5, maxPerRow: 5 })
  assert.deepEqual(laid.rows, [[{ text: 'abcde', data: 'a' }, { text: 'ééééé', data: 'b' }]])
})

test('the layout is idempotent: laying out a fitted keyboard changes nothing', () => {
  const once = layoutButtonRows(menu(12), DC).rows
  const twice = layoutButtonRows(once, DC)
  assert.deepEqual(twice.rows, once)
  assert.equal(twice.dropped, 0)
})

test('chunkText splits a long text at the limit and never past it', () => {
  assert.deepEqual(chunkText('a'.repeat(2393), 1904).map((c) => c.length), [1904, 489])
  assert.deepEqual(chunkText('short', 2000), ['short'])
})
