// Protocol 1 extensions (plan 2.11): addon-to-host requests with declared access, the thread and callback calls, the
// messageId pass-through, and the built-in addon folder. Uses the addon-bridge fixture (a real child process).
import './helpers/isolate.ts'
import { tgMsg } from '../src/adapters/chat/tg-ids.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AddonHost, REQUEST_ACCESS } from '../src/addons-host/host.ts'
import { encodeHostReply, parseAddonLine } from '../src/addons-host/protocol.ts'
import { FakeClock, MemorySettings, allowUserAddons, copyFixture, recordingLogger, removeDir, tmpDir, waitFor } from './helpers/addon-fakes.ts'

const pin = (file: string, args: string[]) => ({ file, args })

type Seen = { addon: string; op: string; payload: Record<string, unknown> }

async function bridgeHost(label: string, opts: { builtin?: boolean } = {}) {
  const dir = tmpDir(label)
  const addonsDir = join(dir, 'addons')
  mkdirSync(addonsDir)
  const home = opts.builtin ? join(dir, 'builtin') : undefined
  if (home) {
    mkdirSync(home)
    copyFixture('addon-bridge', home)
  } else {
    copyFixture('addon-bridge', addonsDir)
  }
  const settings = new MemorySettings()
  allowUserAddons(addonsDir, settings)
  settings.setEnabled('addon-bridge', true)
  const seen: Seen[] = []
  const { logger } = recordingLogger()
  const host = new AddonHost({
    addonsDir,
    builtinDir: home,
    settings,
    clock: new FakeClock(),
    logger,
    alert: () => {},
    pin,
    requests: async (addon, op, payload) => {
      seen.push({ addon, op, payload })
      if (op === 'send') return { messageIds: ['tg:77'] }
      return null
    },
  })
  await host.start()
  await waitFor(() => host.running().some((r) => r.name === 'addon-bridge'), 'addon-bridge running')
  return { host, seen, dir }
}

test('an addon request reaches the router with the addon name, and its answer comes back to the addon', async () => {
  const h = await bridgeHost('req-send')
  try {
    const reply = await h.host.general('bridge: hi', tgMsg(9))
    assert.equal(reply, 'sent tg:77')
    assert.deepEqual(h.seen, [{ addon: 'addon-bridge', op: 'send', payload: { text: 'hello', replyTo: 'tg:9' } }])
  } finally {
    await h.host.stop()
    removeDir(h.dir)
  }
})

test('a request the addon did not declare is refused by the host and never reaches the router', async () => {
  const h = await bridgeHost('req-denied')
  try {
    const reply = await h.host.general('bridge: spawn')
    assert.equal(reply, 'error: addon-bridge did not declare sessions.spawn')
    assert.equal(h.seen.some((s) => s.op === 'spawn'), false)
  } finally {
    await h.host.stop()
    removeDir(h.dir)
  }
})

test('a swipe-reply goes to the addon that claims it; other replies are left alone', async () => {
  const h = await bridgeHost('req-thread')
  try {
    assert.equal(await h.host.reply('and more', tgMsg(5), tgMsg(9)), true)
    assert.equal(await h.host.reply('and more', tgMsg(6), tgMsg(9)), false)
  } finally {
    await h.host.stop()
    removeDir(h.dir)
  }
})

test('a button tap is handed to the addon with its data and the message id', async () => {
  const h = await bridgeHost('req-cb')
  try {
    assert.deepEqual(await h.host.callback('addon-bridge', 'c:abcd0123', tgMsg(3)), { toast: 'got c:abcd0123' })
    await assert.rejects(() => h.host.callback('nobody', 'x'), /no addon named nobody/)
  } finally {
    await h.host.stop()
    removeDir(h.dir)
  }
})

test('the built-in folder is read too, and a built-in wins over a user folder of the same name', async () => {
  const builtin = await bridgeHost('req-builtin', { builtin: true })
  try {
    const info = builtin.host.list().find((a) => a.name === 'addon-bridge')
    assert.equal(info?.version, '0.1.0')
  } finally {
    await builtin.host.stop()
    removeDir(builtin.dir)
  }

  const dir = tmpDir('req-override')
  const builtinDir = join(dir, 'builtin')
  const userDir = join(dir, 'addons')
  mkdirSync(join(builtinDir, 'addon-bridge'), { recursive: true })
  mkdirSync(join(userDir, 'addon-bridge'), { recursive: true })
  const manifest = (version: string) =>
    JSON.stringify({ name: 'addon-bridge', version, protocol: 2, command: ['node', 'x.mjs'], provides: [{ point: 'reply' }], access: [], requires: [] })
  writeFileSync(join(builtinDir, 'addon-bridge', 'stolik-addon.json'), manifest('1.0.0'))
  writeFileSync(join(userDir, 'addon-bridge', 'stolik-addon.json'), manifest('9.9.9'))
  const host = new AddonHost({
    addonsDir: userDir,
    builtinDir,
    settings: new MemorySettings(),
    clock: new FakeClock(),
    logger: recordingLogger().logger,
    alert: () => {},
    pin,
  })
  try {
    host.refresh()
    // The built-in is the one that runs; the user folder is read and listed as shadowed, not used.
    const rows = host.list()
    assert.equal(rows.find((a) => a.name === 'addon-bridge' && !a.shadowed)?.version, '1.0.0')
    assert.equal(rows.find((a) => a.shadowed)?.name, 'addon-bridge')
    assert.equal(rows.length, 2)
  } finally {
    await host.stop()
    removeDir(dir)
  }
})

test('stdout lines are classified: a request, a reply, or junk', () => {
  assert.deepEqual(parseAddonLine('{"id":3,"op":"send","payload":{"text":"x"}}'), { kind: 'request', id: 3, op: 'send', payload: { text: 'x' } })
  assert.deepEqual(parseAddonLine('{"id":4,"op":"quota"}'), { kind: 'request', id: 4, op: 'quota', payload: {} })
  assert.deepEqual(parseAddonLine('{"id":5,"result":{"ok":true}}'), { kind: 'reply', reply: { id: 5, ok: true, result: { ok: true } } })
  assert.deepEqual(parseAddonLine('{"id":6,"error":"no"}'), { kind: 'reply', reply: { id: 6, ok: false, error: 'no' } })
  assert.equal(parseAddonLine('plain text'), null)
  assert.equal(parseAddonLine('{"id":"x","op":"send"}'), null)
  assert.equal(parseAddonLine('{"id":7}'), null)
  assert.equal(parseAddonLine('{"id":8,"op":""}'), null)
  assert.equal(parseAddonLine('null'), null)
})

test('host replies to an addon request are one line each, and an error is cut short', () => {
  assert.equal(encodeHostReply(2, { ok: true, result: { messageIds: ['tg:1'] } }), '{"id":2,"result":{"messageIds":["tg:1"]}}\n')
  assert.equal(encodeHostReply(2, { ok: true, result: undefined }), '{"id":2,"result":null}\n')
  const err = JSON.parse(encodeHostReply(3, { ok: false, error: 'e'.repeat(900) })) as { error: string }
  assert.equal(err.error.length, 500)
})


test('the addon request table names the access each request needs', () => {
  assert.deepEqual(REQUEST_ACCESS, {
    send: 'messages.send',
    folders: 'sessions.spawn',
    spawn: 'sessions.spawn',
    usage: 'usage.record',
    quota: 'usage.record',
    chatlog: 'chatlog.read',
    costs: 'usage.read',
    release: 'messages.gate',
    drop: 'messages.gate',
    held: 'messages.gate',
  })
})
