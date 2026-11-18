// Pure rules: a stale inTurn is cleared (idle_prompt, or 15 minutes without activity), and which pending ask a text
// message answers in group mode (a reply, or the topic of the ask's session; never a plain General message).
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Session } from '../src/router/state.ts'
import { IN_TURN_IDLE_MS, MINUTE, markNotification, markPrompt, markStop, turnBusy } from '../src/router/state.ts'
import { findTextTarget } from '../src/router/ask.ts'
import { OutboundLedger } from '../src/router/outbound.ts'

const T0 = 1_000_000_000_000

function sess(over: Partial<Session> = {}): Session {
  return {
    key: 1, name: 'proj', project: 'proj', cwd: '/home/u/proj', pid: 1,
    hasChannel: true, connected: true, spawned: false, lastActive: T0, turnStart: T0, inTurn: false,
    outbound: new OutboundLedger(), lastSentAt: 0, lastProactiveAt: 0, waiting: false, history: [], backendSessionId: null, pendingTg: null, ...over,
  }
}

test('inTurn: an idle_prompt Notification ends the turn (an interrupted turn has no Stop hook)', () => {
  const s = sess()
  markPrompt(s, T0)
  assert.equal(s.inTurn, true)
  markNotification(s, 'permission_prompt', T0 + MINUTE)
  assert.equal(s.inTurn, true, 'other notifications do not end it')
  markNotification(s, 'idle_prompt', T0 + 2 * MINUTE)
  assert.equal(s.inTurn, false)
  assert.equal(s.waiting, true, 'idle_prompt still marks the session as waiting')
})

test('inTurn: a turn with no activity for 15 minutes is no longer busy', () => {
  assert.equal(IN_TURN_IDLE_MS, 15 * MINUTE)
  const s = sess()
  markPrompt(s, T0)
  assert.equal(turnBusy(s, T0 + IN_TURN_IDLE_MS - 1), true, 'still busy just before the timeout')
  assert.equal(s.inTurn, true)
  assert.equal(turnBusy(s, T0 + IN_TURN_IDLE_MS), false, 'busy no longer at the timeout')
  assert.equal(s.inTurn, false, 'the stale flag is cleared')
})

test('inTurn: activity restarts the 15-minute clock; a normal Stop clears it at once', () => {
  const s = sess()
  markPrompt(s, T0)
  markNotification(s, 'elicitation_dialog', T0 + 10 * MINUTE)
  assert.equal(turnBusy(s, T0 + 20 * MINUTE), true, '10 minutes since the last activity')
  markStop(s, false, T0 + 21 * MINUTE)
  assert.equal(turnBusy(s, T0 + 21 * MINUTE), false)
})

const ask = (id: string, messageIds: number[], sessionKey: number) => ({ id, messageIds, sessionKey })
const topicOf = (key: number) => ({ inTopic: (a: { sessionKey: number }) => a.sessionKey === key })

test('group mode: a reply to the ask answers it, from General or from its topic', () => {
  const asks = [ask('a', [10], 1), ask('b', [20], 2)]
  assert.equal(findTextTarget(asks, 20, topicOf(1))?.id, 'b', 'the reply names the ask, whatever the topic')
  assert.equal(findTextTarget(asks, 10, null)?.id, 'a', 'group mode without a topic still honours a reply')
  assert.equal(findTextTarget(asks, 99, topicOf(1)), null, 'a reply to something else is not an answer')
})

test('group mode: a plain General message is never an answer, even with exactly one pending ask', () => {
  const one = [ask('a', [10], 1)]
  assert.equal(findTextTarget(one, null, { inTopic: () => false }), null, 'General (no topic) in group mode: no answer')
  assert.equal(findTextTarget(one, null, topicOf(2)), null, 'a topic of another session: no answer')
})

test('group mode: a message in the topic of the ask session answers that ask', () => {
  const asks = [ask('a', [10], 1), ask('b', [20], 2)]
  assert.equal(findTextTarget(asks, null, topicOf(2))?.id, 'b')
  assert.equal(findTextTarget(asks, null, topicOf(3)), null, 'a topic with no pending ask')
})

test('DM mode (no group): a plain message answers the only pending ask, as before', () => {
  assert.equal(findTextTarget([ask('a', [10], 1)], null)?.id, 'a')
  assert.equal(findTextTarget([ask('a', [10], 1), ask('b', [20], 2)], null), null)
})
