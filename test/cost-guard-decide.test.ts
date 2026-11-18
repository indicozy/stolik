// cost-guard's decision table and its texts (pure). The thresholds are the named constants in decide.ts.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BIG_CTX, CACHE_TTL_MIN, RELEASE_WINDOW_MIN, decide, fmtContext, fmtIdle, holdNotice, newSessionPrompt } from '../src/addons/cost-guard/decide.ts'

const MIN = 60_000
const NOW = Date.parse('2026-11-17T12:00:00.000Z')
const big = (idleMin: number) => ({ contextTokens: 154_000, lastAt: NOW - idleMin * MIN })
const base = { backendSessionId: 'sess-1', now: NOW, releasedAt: undefined }

test('the thresholds are the named values', () => {
  assert.equal(BIG_CTX, 100_000)
  assert.equal(CACHE_TTL_MIN, 60)
  assert.equal(RELEASE_WINDOW_MIN, 10)
})

test('holds an idle, big session: the context is at least 100k and the last turn is at least 60 minutes old', () => {
  const d = decide({ ...base, analysis: big(125) })
  assert.equal(d.hold, true)
  if (d.hold) {
    assert.equal(d.idleMs, 125 * MIN)
    assert.equal(d.contextTokens, 154_000)
  }
  assert.equal(decide({ ...base, analysis: { contextTokens: 100_000, lastAt: NOW - 60 * MIN } }).hold, true, 'both limits are inclusive')
})

test('passes when the session id is unknown, the transcript is unusable, the context is small, or the cache is still warm', () => {
  assert.equal(decide({ ...base, backendSessionId: null, analysis: big(125) }).hold, false)
  assert.equal(decide({ ...base, analysis: null }).hold, false)
  assert.equal(decide({ ...base, analysis: { contextTokens: 99_999, lastAt: NOW - 600 * MIN } }).hold, false, 'a small context')
  assert.equal(decide({ ...base, analysis: big(59) }).hold, false, 'a warm cache')
  assert.equal(decide({ ...base, analysis: { contextTokens: 154_000, lastAt: NOW - 59 * MIN - 59_999 } }).hold, false, 'one ms short of 60 min')
})

test('a release of this session in the last 10 minutes lets its follow-ups through; after 10 minutes it holds again', () => {
  assert.equal(decide({ ...base, analysis: big(125), releasedAt: NOW - 9 * MIN - 59_000 }).hold, false)
  assert.equal(decide({ ...base, analysis: big(125), releasedAt: NOW - 10 * MIN }).hold, true)
  assert.equal(decide({ ...base, analysis: big(125), releasedAt: undefined }).hold, true)
})

test('formats idle time and context the way the notice shows them', () => {
  assert.equal(fmtIdle(125 * MIN), '2h 05m')
  assert.equal(fmtIdle(9 * MIN), '9m')
  assert.equal(fmtIdle(60 * MIN), '1h 00m')
  assert.equal(fmtContext(154_000), '154k')
  assert.equal(fmtContext(100_999), '100k')
})

test('the notice has the week line only when the quota could be read', () => {
  const p = { name: 'proj', idleMs: 125 * MIN, contextTokens: 154_000 }
  assert.equal(
    holdNotice(p),
    "⏸ Held: proj's cache expired (idle 2h 05m, context 154k). Sending now re-reads the whole history uncached, about 10-15x a normal turn.",
  )
  assert.equal(
    holdNotice({ ...p, week: { usedPct: 58, pacePct: 36 } }),
    "⏸ Held: proj's cache expired (idle 2h 05m, context 154k). Sending now re-reads the whole history uncached, about 10-15x a normal turn.\n" +
      'Week: 58% used, pace 36%.',
  )
})

test('the new session prompt names the old transcript and carries the owner message', () => {
  assert.equal(
    newSessionPrompt('/h/.claude/projects/p/x.jsonl', 'go on'),
    "Continuing from an earlier session in this folder (transcript: /h/.claude/projects/p/x.jsonl; read only the parts you need, never the whole file).\n\nThe owner's message:\ngo on",
  )
  assert.equal(newSessionPrompt(null, 'go on'), "Continuing from an earlier session in this folder.\n\nThe owner's message:\ngo on")
})
