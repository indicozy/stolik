// Run results (ticket 08 JSON fields), the footer, the thread map, and the Upgrade prompt.
import './helpers/isolate.ts'
import { tgMsg } from '../src/adapters/chat/tg-ids.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ThreadMap, classifyRun, formatFooter, upgradePrompt, type ThreadEntry } from '../src/brain/modes.ts'

const SID = '1ad1ce43-2b77-4566-a349-25c65eaa004d'
const json = (o: unknown) => JSON.stringify(o)

test('a successful run is an answer with its cost, steps and session', () => {
  const out = classifyRun(json({ type: 'result', subtype: 'success', is_error: false, result: ' ok ', session_id: SID, num_turns: 3, total_cost_usd: 0.0411, permission_denials: [{ tool_name: 'Bash' }] }))
  assert.deepEqual(out, { kind: 'answer', text: 'ok', sessionId: SID, costUsd: 0.0411, numTurns: 3, denials: 1 })
})

test('a run that hit its step limit is a limit, with the partial text and the session to continue', () => {
  const out = classifyRun(json({ subtype: 'error_max_turns', is_error: true, result: 'partial', session_id: SID, num_turns: 30, total_cost_usd: 0.2 }))
  assert.equal(out.kind, 'limit')
  assert.ok(out.kind === 'limit' && out.text === 'partial' && out.sessionId === SID && out.numTurns === 30)
})

test('an error, garbage or an empty output is an error with a short message', () => {
  assert.deepEqual(classifyRun(json({ subtype: 'error_during_execution', is_error: true, result: 'boom' })), { kind: 'error', message: 'boom', costUsd: 0 })
  assert.equal(classifyRun('not json').kind, 'error')
  assert.equal(classifyRun('[]').kind, 'error')
  assert.equal(classifyRun('').kind, 'error')
  const long = classifyRun(json({ subtype: 'error_x', is_error: true, result: 'x'.repeat(900) }))
  assert.ok(long.kind === 'error' && long.message.length === 500)
})

test('a bad session id is dropped, not trusted', () => {
  const out = classifyRun(json({ subtype: 'success', is_error: false, result: 'a', session_id: '../../etc' }))
  assert.ok(out.kind === 'answer' && out.sessionId === '')
})

test('the footer is cost and wall time, e.g. "· $0.04 · 12 s"', () => {
  assert.equal(formatFooter(0.0411, 12_300), '· $0.04 · 12 s')
  assert.equal(formatFooter(0, 200), '· $0.00 · 1 s')
})

const entry = (over: Partial<ThreadEntry> = {}): ThreadEntry => ({
  key: 'abcd0123', mode: 'read', sessionId: SID, question: 'disk?', answer: 'full', partial: false, ts: 1, ...over,
})

test('the thread map is keyed by message id, finds by button key, and is capped', () => {
  const m = new ThreadMap(3)
  m.set(tgMsg(10), entry({ key: 'aaaaaaaa' }))
  m.set(tgMsg(11), entry({ key: 'bbbbbbbb' }))
  m.set(tgMsg(12), entry({ key: 'cccccccc' }))
  m.set(tgMsg(13), entry({ key: 'dddddddd' }))
  assert.equal(m.size, 3)
  assert.equal(m.get(tgMsg(10)), undefined, 'the oldest is dropped')
  assert.equal(m.get(tgMsg(13))?.key, 'dddddddd')
  assert.equal(m.byKey('bbbbbbbb')?.key, 'bbbbbbbb')
  assert.equal(m.byKey('ffffffff'), undefined)
})

test('the thread map survives a save and load, and bad entries are skipped', () => {
  const m = new ThreadMap()
  m.set(tgMsg(7), entry())
  const text = m.toJSON()
  const back = ThreadMap.fromJSON(text)
  assert.deepEqual(back.get(tgMsg(7)), entry())
  const mixed = JSON.stringify([
    [8, { ...entry(), sessionId: 'bad' }],
    [9, { ...entry(), mode: 'nope' }],
    ['x', entry()],
    [10, entry({ key: 'zz' as string })],
    [11, entry()],
  ])
  const loaded = ThreadMap.fromJSON(mixed)
  assert.equal(loaded.size, 1)
  assert.ok(loaded.get(tgMsg(11)))
  assert.equal(ThreadMap.fromJSON('garbage').size, 0)
  assert.equal(ThreadMap.fromJSON('{"a":1}').size, 0)
})

test('the Upgrade prompt carries the question and the answer, clipped', () => {
  const p = upgradePrompt('what uses the disk?', 'the browser')
  assert.match(p, /Question: what uses the disk\?/)
  assert.match(p, /Answer given: the browser/)
  const clipped = upgradePrompt('q'.repeat(2000), 'a'.repeat(9000))
  assert.ok(clipped.length < 5300, 'clipped to the limits')
  assert.match(clipped, /…/)
})
