// The folder-topic mute rules (spec 24 §4, src/brain/mute.ts): /silent parsing and durations, the stored map, expiry.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_MUTE_MS, activeMute, muteAckText, muteStatusText, parseMutes, parseSilentCommand, serializeMutes } from '../src/brain/mute.ts'

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const WEEK = 7 * DAY

test('parseSilentCommand: bare /silent is on, off and status are their own words', () => {
  assert.deepEqual(parseSilentCommand('/silent'), { kind: 'on' })
  assert.deepEqual(parseSilentCommand('  /silent  '), { kind: 'on' })
  assert.deepEqual(parseSilentCommand('/silent off'), { kind: 'off' })
  assert.deepEqual(parseSilentCommand('/silent status'), { kind: 'status' })
  assert.deepEqual(parseSilentCommand('/SILENT OFF'), { kind: 'off' }, 'the words are not case sensitive')
})

test('parseSilentCommand: durations in m, h, d, w; /silent@botname is the same command', () => {
  assert.deepEqual(parseSilentCommand('/silent 30m'), { kind: 'for', ms: 30 * MIN })
  assert.deepEqual(parseSilentCommand('/silent 2h'), { kind: 'for', ms: 2 * HOUR })
  assert.deepEqual(parseSilentCommand('/silent 1d'), { kind: 'for', ms: DAY })
  assert.deepEqual(parseSilentCommand('/silent 1w'), { kind: 'for', ms: WEEK }, 'one week is the most allowed')
  assert.deepEqual(parseSilentCommand('/silent 168h'), { kind: 'for', ms: WEEK }, 'exactly the maximum is allowed')
  assert.deepEqual(parseSilentCommand('/silent@stolik_bot 2h'), { kind: 'for', ms: 2 * HOUR })
  assert.deepEqual(parseSilentCommand('/silent@stolik_bot'), { kind: 'on' })
  assert.equal(MAX_MUTE_MS, WEEK)
})

test('parseSilentCommand: a duration over one week is refused with the reason', () => {
  for (const text of ['/silent 8d', '/silent 169h', '/silent 10081m']) {
    const cmd = parseSilentCommand(text)
    assert.equal(cmd?.kind, 'refuse', text)
    if (cmd?.kind === 'refuse') assert.match(cmd.reason, /1w \(7 days\)/, text)
  }
})

test('parseSilentCommand: garbage, zero and fractions are refused with the usage line', () => {
  for (const text of ['/silent banana', '/silent 0m', '/silent 0', '/silent 1.5h', '/silent -2h', '/silent 2h30m', '/silent 30', '/silent 2 h', '/silent 2w', '/silent 5ms']) {
    const cmd = parseSilentCommand(text)
    assert.equal(cmd?.kind, 'refuse', text)
  }
  const usage = parseSilentCommand('/silent banana')
  assert.ok(usage?.kind === 'refuse' && usage.reason.startsWith('Use /silent for until /silent off'))
})

test('parseSilentCommand: other messages are not /silent', () => {
  for (const text of ['/silentx', 'silent', 'hello /silent', '/new', '/silence 2h', '']) {
    assert.equal(parseSilentCommand(text), null, JSON.stringify(text))
  }
})

test('parseMutes: keeps cwd -> until or null; garbage reads as no mutes', () => {
  assert.deepEqual(parseMutes(''), {})
  assert.deepEqual(parseMutes('not json'), {})
  assert.deepEqual(parseMutes('[1,2]'), {})
  assert.deepEqual(parseMutes('null'), {})
  assert.deepEqual(parseMutes('{"/a":null,"/b":123,"/c":"soon","/d":true}'), { '/a': null, '/b': 123 })
  const map = { '/a': null, '/b': 1700000000000 }
  assert.deepEqual(parseMutes(serializeMutes(map)), map)
})

test('activeMute: until null is on until /silent off; a future end is on; a past end is expired; none is off', () => {
  const mutes = { '/a': null, '/b': 1000 }
  assert.deepEqual(activeMute(mutes, '/a', 5000), { until: null })
  assert.deepEqual(activeMute(mutes, '/b', 999), { until: 1000 })
  assert.equal(activeMute(mutes, '/b', 1000), null, 'an end time reached is expired')
  assert.equal(activeMute(mutes, '/b', 2000), null)
  assert.equal(activeMute(mutes, '/c', 0), null)
  assert.equal(activeMute({}, 'constructor', 0), null, 'an inherited key is not a mute')
})

test('muteAckText and muteStatusText name the end of the mute', () => {
  assert.equal(muteAckText(null), '🔕 Muted until /silent off. Approvals and questions still ping.')
  assert.match(muteAckText(Date.UTC(2026, 10, 18, 12, 30)), /^🔕 Muted until (Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d\d:\d\d\. Approvals and questions still ping\.$/)
  assert.equal(muteStatusText(null), "🔔 Not muted. /silent mutes this folder's topic.")
  assert.equal(muteStatusText({ until: null }), '🔕 Muted until /silent off.')
  assert.match(muteStatusText({ until: Date.UTC(2026, 10, 18, 12, 30) }), /^🔕 Muted until \w{3} \d\d:\d\d\.$/)
})
