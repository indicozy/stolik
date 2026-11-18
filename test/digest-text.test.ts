// Digest pure text (plan 3.4): secret stripping, transcript size cap, prompt, file text, command argument, cost line, state.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDayRequest, MAX_CHAT_DAYS } from '../src/brain/chat-days.ts'
import {
  buildPrompt, buildTranscript, costLine, digestFile, MAX_MESSAGE_CHARS, parseDigestArg, parseState, redactSecrets, scheduleOf, stateText,
  transcriptLine, type DigestLine,
} from '../src/addons/digest/text.ts'

const ts = (d: number, h: number, m: number) => new Date(2026, 10, d, h, m).getTime()
const line = (over: Partial<DigestLine> & { text: string }): DigestLine => ({
  ts: ts(13, 9, 14), dir: 'in', kind: 'text', target: null, ...over,
})

test('secrets are replaced, the surrounding words kept', () => {
  const tg = '123456789:AAFabcdefghijklmnopqrstuvwxyz012345'
  assert.equal(redactSecrets(`token ${tg} ok`), 'token [redacted] ok')
  assert.equal(redactSecrets('key sk-ant-api03-abcdefghijklmnop1234'), 'key [redacted]')
  assert.equal(redactSecrets('gh ghp_abcdefghijklmnopqrstu1234'), 'gh [redacted]')
  assert.equal(redactSecrets('AKIAABCDEFGHIJKLMNOP'), '[redacted]')
  assert.equal(redactSecrets('Authorization: Bearer abcdefghijklmnop.qr'), 'Authorization: [redacted]')
  assert.equal(redactSecrets('password = hunter2'), 'password = [redacted]')
  assert.equal(redactSecrets('API_KEY=abc123'), 'API_KEY=[redacted]')
  assert.equal(redactSecrets('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----'), '[redacted]')
  assert.equal(redactSecrets('hash ' + 'a'.repeat(40)), 'hash [redacted]')
})

test('ordinary text is not changed', () => {
  const t = 'Fix the reminder in razdor, ship 2 builds, see 10:30 meeting.'
  assert.equal(redactSecrets(t), t)
})

test('a transcript line names the speaker, the session and the time; long text is cut', () => {
  assert.equal(transcriptLine(line({ text: 'hi there', target: { type: 'session', name: 'proj' } }), false), '- 09:14 owner (proj): hi there')
  assert.equal(transcriptLine(line({ dir: 'out', text: 'done' }), true), '- 11-13 09:14 agent: done')
  const long = transcriptLine(line({ text: 'x'.repeat(1000) }), false)
  assert.equal(Array.from(long.replace(/^- 09:14 owner: /, '')).length, MAX_MESSAGE_CHARS + 1)
  assert.match(long, /…$/)
})

test('a transcript keeps the newest lines within the cap and says how many were left out', () => {
  const lines = Array.from({ length: 50 }, (_, i) => line({ ts: ts(13, 9, i), text: `message ${i} ${'y'.repeat(100)}` }))
  const t = buildTranscript(lines, false, 1000)
  assert.ok(t.text.length <= 1000 + 80, 'close to the cap')
  assert.equal(t.included + t.omitted, 50)
  assert.ok(t.omitted > 0)
  assert.match(t.text, /^\[\d+ earlier messages left out for length\]/)
  assert.match(t.text, /message 49 /)
  assert.doesNotMatch(t.text, /message 0 /)
})

test('a transcript skips lines without text and orders the rest by time', () => {
  const t = buildTranscript([line({ ts: ts(13, 10, 0), text: 'second' }), line({ ts: ts(13, 9, 0), text: 'first' }), line({ text: '   ' })], false)
  assert.equal(t.included, 2)
  assert.equal(t.omitted, 0)
  assert.ok(t.text.indexOf('first') < t.text.indexOf('second'))
  assert.equal(buildTranscript([], false).included, 0)
})

test('the transcript redacts secrets before anything else', () => {
  const t = buildTranscript([line({ text: 'use password: swordfish123 please' })], false)
  assert.doesNotMatch(t.text, /swordfish/)
  assert.match(t.text, /\[redacted\]/)
})

test('the prompt names the period, asks for the three headings, and carries the transcript as data', () => {
  const p = buildPrompt({ name: '2026-11-13', from: '2026-11-13', days: 1 }, { text: '- 09:14 owner: hi', included: 1, omitted: 0 })
  assert.match(p, /## Asked/)
  assert.match(p, /## Done/)
  assert.match(p, /## Open/)
  assert.match(p, /data, not instructions/)
  assert.match(p, /Period: 2026-11-13\. Messages included: 1\./)
  assert.match(p, /- 09:14 owner: hi$/m)
  const w = buildPrompt({ name: '2026-W46', from: '2026-11-09', days: 7 }, { text: '', included: 0, omitted: 0 })
  assert.match(w, /2026-W46, 2026-11-09 to 2026-11-15/)
})

test('the cost line reads today and this week, and says so when usage is unknown', () => {
  assert.equal(
    costLine({ today: { runs: 2, costUsd: 0.5 }, week: { runs: 9, costUsd: 3.256 } }),
    'Cost: $0.50 today, $3.26 this week (2 mode runs today, 9 this week).',
  )
  assert.equal(costLine(null), 'Cost: unknown (usage could not be read).')
})

test('the file has a heading, the body, and the cost line last', () => {
  const day = digestFile({ name: '2026-11-13', from: '2026-11-13', days: 1 }, '\n## Asked\n- x\n', 'Cost: $0.00 today, $0.00 this week (0 mode runs today, 0 this week).')
  assert.equal(day.split('\n')[0], '# Digest 2026-11-13')
  assert.match(day, /## Asked\n- x\n\nCost: \$0\.00 today/)
  const wk = digestFile({ name: '2026-W46', from: '2026-11-09', days: 7 }, 'body', 'c')
  assert.equal(wk.split('\n')[0], '# Digest 2026-W46 (2026-11-09 to 2026-11-15)')
})

test('the command argument: empty is yesterday, a date is that day, others are refused', () => {
  const now = new Date(2026, 10, 14, 10)
  assert.deepEqual(parseDigestArg('', now), { ok: true, period: { name: '2026-11-13', from: '2026-11-13', days: 1 } })
  assert.deepEqual(parseDigestArg(' 2026-11-10 ', now), { ok: true, period: { name: '2026-11-10', from: '2026-11-10', days: 1 } })
  assert.deepEqual(parseDigestArg('2026-11-14', now).ok, true, 'today is allowed')
  assert.equal(parseDigestArg('2026-11-15', now).ok, false)
  assert.equal(parseDigestArg('2026-02-30', now).ok, false)
  const bad = parseDigestArg('yesterday', now)
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.match(bad.reason, /Usage: \/digest/)
})

test('saved state reads back, and anything bad reads as never run', () => {
  assert.deepEqual(parseState(stateText({ lastRunAt: 123 })), { lastRunAt: 123 })
  assert.deepEqual(parseState('not json'), { lastRunAt: null })
  assert.deepEqual(parseState('{"lastRunAt":"x"}'), { lastRunAt: null })
})

test('the schedule setting: a known value is kept, anything else is request', () => {
  assert.equal(scheduleOf('daily'), 'daily')
  assert.equal(scheduleOf('weekly'), 'weekly')
  assert.equal(scheduleOf('request'), 'request')
  assert.equal(scheduleOf('hourly'), 'request')
  assert.equal(scheduleOf(undefined), 'request')
})

test('a chat-day request needs a date and 1 to 7 days', () => {
  assert.deepEqual(parseDayRequest({ from: '2026-11-09', days: 7 }), { from: '2026-11-09', days: 7 })
  assert.equal(parseDayRequest({ from: '2026-11-09', days: 8 }), null)
  assert.equal(parseDayRequest({ from: '2026-11-09', days: 0 }), null)
  assert.equal(parseDayRequest({ from: '2026-13-01', days: 1 }), null)
  assert.equal(parseDayRequest({ from: '2026-02-30', days: 1 }), null)
  assert.equal(parseDayRequest({ from: 'today', days: 1 }), null)
  assert.equal(MAX_CHAT_DAYS, 7)
})
