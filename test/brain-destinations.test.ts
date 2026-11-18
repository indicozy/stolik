// Destination table (plan 2.3, design §4.2): every outbound kind, in DM mode and group mode, with and without a topic.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OUT_KINDS, destinationFor, type OutKind } from '../src/brain/destinations.ts'

const TOPIC = 77

test('DM mode: every kind goes to the DM with no thread (today\'s behaviour)', () => {
  for (const kind of Object.keys(OUT_KINDS) as OutKind[]) {
    assert.deepEqual(destinationFor(kind, { groupMode: false, topicThread: null }), { chat: 'dm' }, kind)
    assert.deepEqual(destinationFor(kind, { groupMode: false, topicThread: TOPIC }), { chat: 'dm' }, kind)
  }
})

test('group mode, session kinds: the session topic when it has one', () => {
  const sessionKinds = Object.keys(OUT_KINDS).filter((k) => OUT_KINDS[k as OutKind] === 'session') as OutKind[]
  assert.deepEqual(sessionKinds.sort(), ['answer', 'approval', 'ask', 'end-of-turn', 'file', 'idle-close', 'plan', 'proactive', 'reminder', 'typing'])
  for (const kind of sessionKinds) {
    assert.deepEqual(destinationFor(kind, { groupMode: true, topicThread: TOPIC }), { chat: 'group', threadId: TOPIC }, kind)
  }
})

test('group mode, session kinds without a topic fall back to General (never to both)', () => {
  assert.deepEqual(destinationFor('answer', { groupMode: true, topicThread: null }), { chat: 'group' })
  assert.deepEqual(destinationFor('approval', { groupMode: true, topicThread: null }), { chat: 'group' })
})

test('group mode, General kinds: no thread id, whatever the topic', () => {
  for (const kind of ['list', 'resume-picker', 'note', 'mode-answer', 'alert', 'route-buttons'] as const) {
    assert.deepEqual(destinationFor(kind, { groupMode: true, topicThread: null }), { chat: 'group' }, kind)
    assert.deepEqual(destinationFor(kind, { groupMode: true, topicThread: TOPIC }), { chat: 'group' }, kind)
  }
})

test('group mode, a reply in place: the thread the owner wrote in (General when none)', () => {
  assert.deepEqual(destinationFor('reply-in-place', { groupMode: true, topicThread: TOPIC }), { chat: 'group', threadId: TOPIC })
  assert.deepEqual(destinationFor('reply-in-place', { groupMode: true, topicThread: null }), { chat: 'group' })
})

test('the DM hint always goes to the DM, in both modes', () => {
  assert.deepEqual(destinationFor('dm-hint', { groupMode: true, topicThread: TOPIC }), { chat: 'dm' })
  assert.deepEqual(destinationFor('dm-hint', { groupMode: false, topicThread: null }), { chat: 'dm' })
})

test('the table covers every kind with a scope', () => {
  const scopes = new Set(Object.values(OUT_KINDS))
  assert.deepEqual([...scopes].sort(), ['dm', 'general', 'inbound', 'session'])
})
