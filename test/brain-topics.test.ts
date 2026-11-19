// Topic lifecycle (ticket 22, one topic per folder): naming, transitions, the folder's reopen on the next session, the
// the /new command, persistence.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  connectPlan, folderTopicName, newTopic, openTopicOfDir, parseNewCommand, parseTopics, serializeTopics, step,
  type TopicRec,
} from '../src/brain/topics.ts'
import { tgThread } from '../src/adapters/chat/tg-ids.ts'

const DAY = 24 * 60 * 60 * 1000
const T0 = 1_700_000_000_000
const CWD = '/home/u/Documents/projects/proj'

function open(over: Partial<TopicRec> = {}): TopicRec {
  return { ...newTopic(tgThread(101), 'proj', 'proj', CWD), ...over }
}

// A legacy record (one topic per session, before ticket 22): no cwd.
function legacy(over: Partial<TopicRec> = {}): TopicRec {
  return { threadId: tgThread(201), name: 'proj', project: 'proj', cwd: null, sessionKey: 4242, backendSessionId: null, state: 'open', endedAt: null, deleteAt: null, ...over }
}

test('folderTopicName: the folder basename, then parent/basename when that name is taken, then #N', () => {
  assert.equal(folderTopicName(CWD, []), 'proj')
  assert.equal(folderTopicName(CWD, [open({ threadId: tgThread(300), cwd: '/elsewhere/proj', name: 'proj' })]), 'projects/proj')
  assert.equal(
    folderTopicName(CWD, [open({ threadId: tgThread(300), cwd: '/elsewhere/proj', name: 'proj' }), open({ threadId: tgThread(301), cwd: '/x/projects/proj', name: 'projects/proj' })]),
    'projects/proj#2',
  )
})

test('folderTopicName: a deleted topic frees its name', () => {
  assert.equal(folderTopicName(CWD, [open({ state: 'deleted', name: 'proj' })]), 'proj')
})

test('transitions: a folder topic closes on end with no deadline, and reopens', () => {
  const end = step(open(), { type: 'end', now: T0 })
  assert.equal(end.effect, 'close')
  assert.equal(end.rec.state, 'closed')
  assert.equal(end.rec.endedAt, T0)
  assert.equal(end.rec.deleteAt, null, 'a folder topic has no deadline')

  const back = step(end.rec, { type: 'reopen', now: T0 + DAY })
  assert.equal(back.effect, 'reopen')
  assert.equal(back.rec.state, 'open')
  assert.equal(back.rec.endedAt, null)
})

test('transitions: nothing happens for events that do not apply', () => {
  const o = open()
  assert.deepEqual(step(o, { type: 'reopen', now: T0 }), { rec: o, effect: 'none' })
  const closed = step(o, { type: 'end', now: T0 }).rec
  assert.deepEqual(step(closed, { type: 'end', now: T0 + 1 }), { rec: closed, effect: 'none' })
})

test('connectPlan: a folder with an open topic needs nothing, whichever session connects', () => {
  assert.deepEqual(connectPlan([open()], { cwd: CWD }), { effect: 'none' })
})

test('connectPlan: a folder with no topic gets one named after the folder', () => {
  assert.deepEqual(connectPlan([], { cwd: CWD }), { effect: 'create', name: 'proj' })
})

test('connectPlan: another folder with the same basename gets parent/basename', () => {
  assert.deepEqual(connectPlan([open({ cwd: '/other/proj' })], { cwd: CWD }), { effect: 'create', name: 'projects/proj' })
})

test('connectPlan: the next session in a folder whose topic is closed reopens it, not a new topic', () => {
  const closed = step(open(), { type: 'end', now: T0 }).rec
  assert.deepEqual(connectPlan([closed], { cwd: CWD }), { effect: 'reopen', threadId: tgThread(101) })
})

test('connectPlan: a folder reopens its most recently ended closed topic', () => {
  const older = step(open({ threadId: tgThread(110) }), { type: 'end', now: T0 }).rec
  const newer = step(open({ threadId: tgThread(111) }), { type: 'end', now: T0 + DAY }).rec
  assert.deepEqual(connectPlan([older, newer], { cwd: CWD }), { effect: 'reopen', threadId: tgThread(111) })
})

test('connectPlan: a legacy record never matches a folder (its name still counts as taken until start-up removes it)', () => {
  assert.deepEqual(connectPlan([legacy({ state: 'closed', endedAt: T0 })], { cwd: CWD }), { effect: 'create', name: 'projects/proj' })
})

test('connectPlan: a folder whose topic was deleted gets a fresh one', () => {
  const deleted = open({ state: 'deleted' })
  assert.deepEqual(connectPlan([deleted], { cwd: CWD }), { effect: 'create', name: 'proj' })
})

test('openTopicOfDir finds the open topic of a folder only', () => {
  const closed = step(open(), { type: 'end', now: T0 }).rec
  assert.equal(openTopicOfDir([open()], CWD)?.threadId, tgThread(101))
  assert.equal(openTopicOfDir([closed], CWD), undefined)
  assert.equal(openTopicOfDir([open()], '/other'), undefined)
})

test('parseNewCommand: /new alone, /new with text, and /new@bot; other words are not /new', () => {
  assert.deepEqual(parseNewCommand('/new'), { body: '' })
  assert.deepEqual(parseNewCommand('/new  '), { body: '' })
  assert.deepEqual(parseNewCommand('/new hi there'), { body: 'hi there' })
  assert.deepEqual(parseNewCommand('/new@stolik_bot go'), { body: 'go' })
  assert.deepEqual(parseNewCommand('/new\nline two'), { body: 'line two' })
  assert.equal(parseNewCommand('/newfoo'), null)
  assert.equal(parseNewCommand('please /new'), null)
  assert.equal(parseNewCommand('/list'), null)
})

test('parseTopics and serializeTopics round-trip; junk is dropped, not thrown', () => {
  const recs = [open(), step(open({ threadId: tgThread(102), name: 'b', cwd: '/x/b' }), { type: 'end', now: T0 }).rec]
  assert.deepEqual(parseTopics(serializeTopics(recs)), recs)
  assert.deepEqual(parseTopics(''), [])
  assert.deepEqual(parseTopics('not json'), [])
  assert.deepEqual(parseTopics('{"threadId":1}'), [])
  assert.deepEqual(parseTopics(JSON.stringify([{ threadId: 'x' }, { ...recs[0], threadId: 101 }])), [recs[0]])
})

test('parseTopics keeps old JSON without a cwd as a legacy record (cwd null)', () => {
  const old = { threadId: 5, name: 'old', project: 'old', sessionKey: 42, backendSessionId: 'sid', state: 'closed', endedAt: T0, deleteAt: T0 + DAY }
  // A deadline from before (deleteAt) is no longer read: it comes back null.
  assert.deepEqual(parseTopics(JSON.stringify([old])), [{ ...old, threadId: tgThread(5), cwd: null, deleteAt: null }])
})
