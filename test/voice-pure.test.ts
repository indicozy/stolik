// Pure voice pieces (plan 3.2, 3.3): the echo text and its raw toggle, the cleanup guard, the vocabulary.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tgMsg } from '../src/adapters/chat/tg-ids.ts'
import { echoRows, echoShown, echoText, parseVoiceCallback, type VoiceEcho } from '../src/router/voice-echo.ts'
import { guardClean, vocabulary, VOCAB_MAX } from '../src/addons/voice-cleanup/clean.ts'

const messy: VoiceEcho = { raw: 'um so the the meeting is at four', clean: 'So the meeting is at four.', unpolished: false }

test('echo: the clean text in quotes, with a raw button that toggles to the raw text and back', () => {
  assert.equal(echoText(messy, 'clean'), '🎙 "So the meeting is at four."')
  assert.deepEqual(echoRows(tgMsg(42), messy, 'clean'), [[{ text: 'raw', data: 'vt:tg:42:raw' }]])
  assert.equal(echoText(messy, 'raw'), '🎙 "um so the the meeting is at four"')
  assert.deepEqual(echoRows(tgMsg(42), messy, 'raw'), [[{ text: 'clean', data: 'vt:tg:42:clean' }]])
})

test('echo: unpolished shows the raw text marked, with no toggle', () => {
  const e: VoiceEcho = { raw: 'uh hello', clean: 'uh hello', unpolished: true }
  assert.equal(echoText(e, 'clean'), '🎙 "uh hello" (unpolished)')
  assert.equal(echoShown(e, 'raw'), 'uh hello')
  assert.deepEqual(echoRows(tgMsg(42), e, 'clean'), [])
})

test('echo: when the two versions are the same there is nothing to toggle', () => {
  const e: VoiceEcho = { raw: 'hello', clean: 'hello', unpolished: false }
  assert.equal(echoText(e, 'clean'), '🎙 "hello"')
  assert.deepEqual(echoRows(tgMsg(7), e, 'clean'), [])
})

test('echo callbacks: only vt:<message id>:raw|clean parses, the id is an opaque string', () => {
  assert.deepEqual(parseVoiceCallback('vt:tg:42:raw'), { messageId: tgMsg(42), show: 'raw' })
  assert.deepEqual(parseVoiceCallback('vt:dc:1:2:clean'), { messageId: 'dc:1:2', show: 'clean' })
  assert.equal(parseVoiceCallback('vt::raw'), null)
  assert.equal(parseVoiceCallback('vt:tg:42:other'), null)
  assert.equal(parseVoiceCallback('rt:tg:42:raw'), null)
})

test('guard: a sensible clean text is used', () => {
  assert.deepEqual(guardClean('um so yeah four', 'So, yeah, four.'), { text: 'So, yeah, four.', unpolished: false })
})

test('guard: an empty answer gives the raw text, marked unpolished', () => {
  assert.deepEqual(guardClean('um so yeah four', '   '), { text: 'um so yeah four', unpolished: true })
})

test('guard: an answer over 1.3x the input gives the raw text, marked unpolished', () => {
  const input = 'four o clock'
  const limit = Math.floor(1.3 * input.length)
  // At the limit: used. One character over: rejected.
  assert.equal(guardClean(input, 'x'.repeat(limit)).unpolished, false)
  assert.deepEqual(guardClean(input, 'x'.repeat(limit + 1)), { text: input, unpolished: true })
})

test('guard: lengths count characters, so Russian is measured as written', () => {
  const input = 'ну короче в четыре'
  const cleaned = 'В четыре.'
  assert.deepEqual(guardClean(input, cleaned), { text: cleaned, unpolished: false })
  const long = 'я'.repeat(Math.floor(1.3 * [...input].length) + 1)
  assert.equal(guardClean(input, long).unpolished, true)
})

test('guard: empty input is passed through as it is', () => {
  assert.deepEqual(guardClean('', 'anything'), { text: '', unpolished: false })
})

test('vocabulary: session names, project names and prefix words, no repeats, trimmed, capped', () => {
  assert.deepEqual(vocabulary(['Alpha', ' alpha ', ''], ['note', 'Alpha', 3]), ['Alpha', 'alpha', 'note'])
  assert.deepEqual(vocabulary(undefined, 'not a list'), [])
  const many = Array.from({ length: VOCAB_MAX + 10 }, (_, i) => `name${i}`)
  assert.equal(vocabulary(many, []).length, VOCAB_MAX)
})
