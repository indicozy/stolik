// Addon-to-addon calls through the host (plan 3.1): a caller addon asks the host to call the ml-worker stand-in, and
// the answer comes back on the caller's stdin. Real child processes (test/fixtures), a fake clock for nothing here.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { AddonHost, defaultSpawn } from '../src/addons-host/host.ts'
import { cleanText, media } from '../src/addons-host/points.ts'
import { encodeCallReply, parseAddonCall } from '../src/addons-host/protocol.ts'
import { FakeClock, MemorySettings, allowUserAddons, copyFixture, recordingLogger, removeDir, tmpDir } from './helpers/addon-fakes.ts'

const pin = (file: string, args: string[]) => ({ file, args })

function harness(label: string) {
  const dir = tmpDir(label)
  const addonsDir = join(dir, 'addons')
  mkdirSync(addonsDir)
  copyFixture('ml-fake', addonsDir)
  copyFixture('relay-caller', addonsDir)
  const settings = new MemorySettings()
  allowUserAddons(addonsDir, settings)
  const { logger, lines } = recordingLogger()
  const host = new AddonHost({
    addonsDir,
    settings,
    clock: new FakeClock(),
    logger,
    alert: () => {},
    pin,
    spawn: defaultSpawn,
  })
  return { dir, host, lines }
}

async function finish(h: { dir: string; host: AddonHost }): Promise<void> {
  await h.host.stop()
  removeDir(h.dir)
}

test('parseAddonCall: a call request parses; replies and host requests are not calls', () => {
  const req = parseAddonCall('{"id":3,"request":"call","addon":"ml-worker","op":"clean","payload":{"text":"hi"},"timeoutMs":5000}')
  assert.deepEqual(req, { id: 3, addon: 'ml-worker', op: 'clean', payload: { text: 'hi' }, timeoutMs: 5000 })
  assert.equal(parseAddonCall('{"id":3,"result":{"text":"hi"}}'), null)
  assert.equal(parseAddonCall('{"id":3,"op":"media","payload":{}}'), null)
  assert.equal(parseAddonCall('{"id":"3","request":"call","addon":"x","op":"y"}'), null)
  assert.deepEqual(parseAddonCall('{"id":3,"request":"call","addon":"x","op":"y"}')?.payload, {})
  assert.equal(parseAddonCall('not json'), null)
})

test('encodeCallReply: one line with the id and either a result or an error', () => {
  assert.equal(encodeCallReply(4, { result: { text: 'x' } }), '{"id":4,"result":{"text":"x"}}\n')
  assert.equal(encodeCallReply(5, { error: 'nope' }), '{"id":5,"error":"nope"}\n')
})

test('a caller addon cannot be enabled before the addon it requires', async () => {
  const h = harness('relay-req')
  try {
    const refused = await h.host.setEnabled('relay-caller', true)
    assert.match(refused ?? '', /needs ml-fake/)
  } finally {
    await finish(h)
  }
})

test('media: the caller relays transcribe to ml-fake and the transcript comes back', async () => {
  const h = harness('relay-media')
  try {
    assert.equal(await h.host.setEnabled('ml-fake', true), null)
    assert.equal(await h.host.setEnabled('relay-caller', true), null)
    const got = await media(h.host, { kind: 'voice', size: 10, mime: 'audio/ogg', path: '/inbox/7_voice.oga' })
    assert.deepEqual(got, { addon: 'relay-caller', text: 'heard 7_voice.oga' })
  } finally {
    await finish(h)
  }
})

test('cleanText: the vocabulary goes through the relay; the cleaned text comes back marked clean', async () => {
  const h = harness('relay-clean')
  try {
    await h.host.setEnabled('ml-fake', true)
    await h.host.setEnabled('relay-caller', true)
    const r = await cleanText(h.host, 'um hi there', { sessionNames: ['Alpha', 'Tarasov'] })
    assert.deepEqual(r, { text: 'clean(um hi there)[Alpha,Tarasov]', unpolished: false })
  } finally {
    await finish(h)
  }
})

test('cleanText: a failed clean keeps the raw text and marks it unpolished', async () => {
  const h = harness('relay-fail')
  try {
    await h.host.setEnabled('ml-fake', true)
    await h.host.setEnabled('relay-caller', true)
    assert.deepEqual(await cleanText(h.host, 'FAIL', { sessionNames: [] }), { text: 'FAIL', unpolished: true })
  } finally {
    await finish(h)
  }
})

test('a call to an addon that is not in requires is refused by the host and never reaches it', async () => {
  const h = harness('relay-forbidden')
  try {
    await h.host.setEnabled('ml-fake', true)
    await h.host.setEnabled('relay-caller', true)
    await assert.rejects(h.host.call('relay-caller', 'forbidden', {}), /may not call not-required/)
    assert.ok(h.lines.some((l) => /call to not-required refused/.test(l)))
  } finally {
    await finish(h)
  }
})
