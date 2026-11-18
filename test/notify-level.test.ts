// The notification level rules (src/brain/notify-level.ts): who pings, and how an outside level is parsed.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LEVEL_ERROR, LEVELS, isSilentSend, parseLevel, pingFor } from '../src/brain/notify-level.ts'

test('pingFor: silent never pings, critical always pings, default pings unless muted', () => {
  assert.equal(pingFor('silent', false), false)
  assert.equal(pingFor('silent', true), false)
  assert.equal(pingFor('default', false), true)
  assert.equal(pingFor('default', true), false, 'a muted topic silences a default message')
  assert.equal(pingFor('critical', false), true)
  assert.equal(pingFor('critical', true), true, 'critical pings even in a muted topic')
})

test('isSilentSend: an explicit silent always is; otherwise the level and the mute decide (no level is default)', () => {
  assert.equal(isSilentSend({ silent: true }, false), true)
  assert.equal(isSilentSend({ level: 'silent' }, false), true)
  assert.equal(isSilentSend({ level: 'default' }, false), false)
  assert.equal(isSilentSend({}, false), false, 'no level: default, pings')
  assert.equal(isSilentSend({ level: 'default' }, true), true, 'a muted topic silences a default send')
  assert.equal(isSilentSend({ level: 'critical' }, true), false, 'critical pings even when muted')
})

test('parseLevel: no level is the default; the three names are accepted; anything else is refused', () => {
  assert.equal(parseLevel(undefined), 'default')
  assert.equal(parseLevel(null), 'default')
  assert.equal(parseLevel('silent'), 'silent')
  assert.equal(parseLevel('default'), 'default')
  assert.equal(parseLevel('critical'), 'critical')
  for (const bad of ['loud', 'Silent', '', 0, true, ['silent']]) assert.equal(parseLevel(bad), null, JSON.stringify(bad))
  assert.equal(LEVEL_ERROR, 'level must be one of silent, default, critical')
  assert.deepEqual([...LEVELS], ['silent', 'default', 'critical'])
})
