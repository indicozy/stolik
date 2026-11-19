// Topic lifecycle (ticket 22, one topic per folder): naming, connect planning, the /new command, persistence.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  connectPlan, folderTopicName, newTopic, openTopicOfDir, parseNewCommand, parseTopics, serializeTopics,
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

test('connectPlan: a folder with an open topic needs nothing, whichever session connects', () => {
  assert.deepEqual(connectPlan([open()], { cwd: CWD }), { effect: 'none' })
})

test('connectPlan: a folder with a closed record needs nothing: the record is reopened at start, never replaced', () => {
  assert.deepEqual(connectPlan([open({ state: 'closed', endedAt: T0 })], { cwd: CWD }), { effect: 'none' })
})

test('the topic records of a folder never end: a new topic is open, with no end or deadline', () => {
  assert.deepEqual(newTopic(tgThread(1), 'proj', 'proj', CWD), { threadId: tgThread(1), name: 'proj', project: 'proj', cwd: CWD, sessionKey: null, backendSessionId: null, state: 'open', endedAt: null, deleteAt: null })
})

test('connectPlan: a folder with no topic gets one named after the folder', () => {
  assert.deepEqual(connectPlan([], { cwd: CWD }), { effect: 'create', name: 'proj' })
})

test('connectPlan: another folder with the same basename gets parent/basename', () => {
  assert.deepEqual(connectPlan([open({ cwd: '/other/proj' })], { cwd: CWD }), { effect: 'create', name: 'projects/proj' })
})

test('connectPlan: a legacy record never matches a folder (its name still counts as taken until start-up removes it)', () => {
  assert.deepEqual(connectPlan([legacy({ state: 'closed', endedAt: T0 })], { cwd: CWD }), { effect: 'create', name: 'projects/proj' })
})

test('connectPlan: a folder whose topic was deleted gets a fresh one', () => {
  const deleted = open({ state: 'deleted' })
  assert.deepEqual(connectPlan([deleted], { cwd: CWD }), { effect: 'create', name: 'proj' })
})

test('openTopicOfDir finds the open topic of a folder only', () => {
  const closed = open({ state: 'closed', endedAt: T0 })
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
  const recs = [open(), open({ threadId: tgThread(102), name: 'b', cwd: '/x/b', state: 'closed', endedAt: T0 })]
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
