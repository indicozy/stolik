// The route point in the host: the manifest accepts it with the sessions.read access; the payload's sessions and folders
// reach an addon only when it declares sessions.read; a route answer is read strictly.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterPayload } from '../src/addons-host/access.ts'
import { ACCESS_FIELDS, ManifestSchema, POINTS } from '../src/addons-host/manifest.ts'
import { parseRouteAnswer } from '../src/addons-host/points.ts'
import { describeAccess } from '../src/addons-host/consent.ts'

const base = { name: 'router', version: '1.0.0', protocol: 2, command: ['node', 'main.js'], requires: ['ml-worker'] }

test('the manifest accepts the route point and sessions.read', () => {
  assert.ok((POINTS as readonly string[]).includes('route'))
  assert.ok((ACCESS_FIELDS as readonly string[]).includes('sessions.read'))
  const m = ManifestSchema.parse({ ...base, provides: [{ point: 'route' }], access: ['message.text', 'sessions.read'] })
  assert.equal(m.provides[0].point, 'route')
  assert.throws(() => ManifestSchema.parse({ ...base, provides: [{ point: 'route', extra: 1 }], access: [] }))
  assert.throws(() => ManifestSchema.parse({ ...base, provides: [], access: ['sessions.reed'] }), 'a typo is an error')
  assert.match(describeAccess(m).join('\n'), /see the names, folders and recent activity/)
})

test('the sessions and folders of a route call reach only an addon that declares sessions.read', () => {
  const payload = { text: 'hi', sessions: [{ name: 'a', folder: '/h/a', lastActiveAt: 1 }], folders: [{ name: 'a', path: '/h/a' }] }
  const with_ = filterPayload(payload, { access: ['message.text', 'sessions.read'] })
  assert.deepEqual(with_.payload, payload)
  const without = filterPayload(payload, { access: ['message.text'] })
  assert.deepEqual(without.payload, { text: 'hi' })
  assert.deepEqual(without.dropped.sort(), ['folders', 'sessions'])
})

test('parseRouteAnswer: a session or a new folder with a confidence from 0 to 1; anything else is no answer', () => {
  assert.deepEqual(parseRouteAnswer({ target: { kind: 'session', name: 'a' }, confidence: 1, reason: 'why' }), {
    target: { kind: 'session', name: 'a' }, confidence: 1, reason: 'why',
  })
  assert.deepEqual(parseRouteAnswer({ target: { kind: 'new', folder: '/h/a' }, confidence: 0.6 }), {
    target: { kind: 'new', folder: '/h/a' }, confidence: 0.6, reason: '',
  })
  assert.deepEqual(parseRouteAnswer({ target: null, confidence: 0 })?.target, null)
  for (const bad of [
    null,
    'x',
    { target: { kind: 'session' }, confidence: 1 },
    { target: { kind: 'new', folder: 'relative' }, confidence: 1 },
    { target: { kind: 'other', name: 'a' }, confidence: 1 },
    { target: null, confidence: 1.5 },
    { target: null, confidence: NaN },
    { target: null },
  ]) {
    assert.equal(parseRouteAnswer(bad), null, JSON.stringify(bad))
  }
})
