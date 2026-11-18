// The router addon's pure parts (src/addons/router/route.ts): the option list the model picks from, the model prompt, and
// the strict reading of the model's answer. The name match (deterministic) lives in src/brain/route-match.ts and is tested
// in test/route-policy.test.ts.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fromChoice, options, parseChoice, prompt, type RouteInput } from '../src/addons/router/route.ts'

const input = (over: Partial<RouteInput>): RouteInput => ({ text: '', sessions: [], folders: [], ...over })

test('options and prompt: sessions first (most recent first), then folders, numbered from 1; 0 is none', () => {
  const opts = options(input({
    sessions: [
      { name: 'a', folder: '/h/a', lastActiveAt: 1 },
      { name: 'b', folder: '/h/b', lastActiveAt: 2 },
    ],
    folders: [{ name: 'c', path: '/h/c' }],
  }))
  assert.deepEqual(opts.map((o) => o.target), [
    { kind: 'session', name: 'b' },
    { kind: 'session', name: 'a' },
    { kind: 'new', folder: '/h/c' },
  ])
  const p = prompt('which one?', opts)
  assert.match(p, /1\. session "b" in b/)
  assert.match(p, /3\. a new session in c/)
  assert.match(p, /0\. none of these/)
})

test('parseChoice: "<number> <confidence>", strictly', () => {
  assert.deepEqual(parseChoice('2 0.9', 3), { option: 2, confidence: 0.9 })
  assert.deepEqual(parseChoice(' 0 0.2 ', 3), { option: 0, confidence: 0.2 })
  assert.deepEqual(parseChoice('1 1', 3), { option: 1, confidence: 1 })
  assert.deepEqual(parseChoice('1 1.0.', 3), { option: 1, confidence: 1 })
  for (const bad of ['4 0.9', '2', 'option 2', '2 1.5', '2 0.9 extra', '-1 0.5', '2 .5', '', 'two 0.9', '2 0.9\n3 0.1']) {
    assert.equal(parseChoice(bad, 3), null, JSON.stringify(bad))
  }
})

test('fromChoice: none is no target; an option is its target with the model confidence', () => {
  const opts = options(input({ sessions: [{ name: 'a', folder: '/h/a', lastActiveAt: 1 }] }))
  assert.deepEqual(fromChoice(opts, { option: 0, confidence: 0.7 }), { target: null, confidence: 0.7, reason: 'the model chose none' })
  const r = fromChoice(opts, { option: 1, confidence: 0.8 })
  assert.deepEqual(r.target, { kind: 'session', name: 'a' })
  assert.equal(r.confidence, 0.8)
})
