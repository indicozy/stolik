import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { basename, join } from 'node:path'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { ADDON_STOP_GRACE_MS, AddonHost, BACKOFF_MS, CRASH_LIMIT, defaultSpawn, type SpawnFn } from '../src/addons-host/host.ts'
import { emitEvent, general, media, routeScores, textFilters, tickSchedules } from '../src/addons-host/points.ts'
import { consentHash, readManifest } from '../src/addons-host/manifest.ts'
import { addonsMenuRows } from '../src/addons-host/menu.ts'
import {
  FakeClock, MemorySettings, copyFixture, recordingLogger, removeDir, tmpDir, waitFor, writeEchoLike,
} from './helpers/addon-fakes.ts'

const pin = (file: string, args: string[]) => ({ file, args })
const tick = () => new Promise((r) => setImmediate(r))

// The settings the host reads. MemorySettings (helpers) predates the consent record, so the tests add it here.
export class Settings extends MemorySettings {
  readonly consents = new Map<string, string>()
  consentHash(name: string): string | null {
    return this.consents.get(name) ?? null
  }
  setConsentHash(name: string, hash: string): void {
    this.consents.set(name, hash)
  }
}

// The owner allows every user addon in the folder as it is now (what an install or `stolik addon consent` records).
function allowAll(addonsDir: string, settings: Settings): void {
  for (const name of readdirSync(addonsDir)) {
    const r = readManifest(join(addonsDir, name))
    if ('manifest' in r) settings.setConsentHash(name, consentHash(r.manifest))
  }
}

// The payload an addon received, without the deadline the host adds to every call.
const without = (received: unknown): Record<string, unknown> => {
  const { deadline: _deadline, ...rest } = received as Record<string, unknown>
  return rest
}

type Harness = {
  dir: string
  addonsDir: string
  clock: FakeClock
  settings: Settings
  lines: string[]
  alerts: string[]
  host: AddonHost
  spawned: string[]
}

// A host over a fresh addons folder. Every spawn is recorded (by folder name) so start order can be checked.
function harness(label: string, setup?: (addonsDir: string) => void, extra: { spawn?: SpawnFn; settings?: Settings } = {}): Harness {
  const dir = tmpDir(label)
  const addonsDir = join(dir, 'addons')
  mkdirSync(addonsDir)
  setup?.(addonsDir)
  const clock = new FakeClock()
  const settings = extra.settings ?? new Settings()
  allowAll(addonsDir, settings)
  const { lines, logger } = recordingLogger()
  const alerts: string[] = []
  const spawned: string[] = []
  const realSpawn = extra.spawn ?? defaultSpawn
  const host = new AddonHost({
    addonsDir,
    settings,
    clock,
    logger,
    alert: (t) => alerts.push(t),
    pin,
    reservedCommands: ['list', 'to'],
    spawn: (file, args, opts) => {
      spawned.push(basename(opts.cwd))
      return realSpawn(file, args, opts)
    },
  })
  return { dir, addonsDir, clock, settings, lines, alerts, host, spawned }
}

async function done(h: Harness): Promise<void> {
  await h.host.stop()
  removeDir(h.dir)
}

const running = (h: Harness, name: string) => h.host.running().some((r) => r.name === name)

// ---------- discovery ----------

test('discovery: folders are listed in name order, hidden ones skipped, broken manifests say why', async () => {
  const h = harness('disc', (addonsDir) => {
    copyFixture('addon-echo', addonsDir)
    mkdirSync(join(addonsDir, '.staging-abc'))
    writeFileSync(join(addonsDir, '.staging-abc', 'stolik-addon.json'), '{}')
    mkdirSync(join(addonsDir, 'broken'))
    writeFileSync(join(addonsDir, 'broken', 'stolik-addon.json'), '{ nope')
    writeEchoLike(addonsDir, 'other', {})
    mkdirSync(join(addonsDir, 'wrong-folder'))
    writeFileSync(
      join(addonsDir, 'wrong-folder', 'stolik-addon.json'),
      JSON.stringify({ name: 'right-name', version: '1', protocol: 2, command: ['x'], provides: [{ point: 'listener' }] }),
    )
  })
  try {
    const list = h.host.list()
    assert.deepEqual(list.map((a) => a.name), ['addon-echo', 'broken', 'other', 'wrong-folder'])
    const byName = Object.fromEntries(list.map((a) => [a.name, a]))
    assert.equal(byName['addon-echo'].status, 'off')
    assert.deepEqual(byName['addon-echo'].provides, ['media', 'text-filter', 'prefix', 'command', 'router', 'schedule', 'listener'])
    assert.match(byName.broken.status, /^invalid manifest: stolik-addon\.json is not valid JSON/)
    assert.match(byName['wrong-folder'].status, /must be named right-name/)
  } finally {
    await done(h)
  }
})

test('discovery: no addons folder at all means no addons and start does nothing', async () => {
  const dir = tmpDir('nofolder')
  try {
    const { lines, logger } = recordingLogger()
    const host = new AddonHost({
      addonsDir: join(dir, 'does-not-exist'),
      settings: new Settings(),
      clock: new FakeClock(),
      logger,
      alert: () => {},
      pin,
    })
    await host.start()
    assert.deepEqual(host.list(), [])
    assert.deepEqual(host.running(), [])
    assert.deepEqual(lines, [])
  } finally {
    removeDir(dir)
  }
})

// ---------- enable, disable, calls ----------

test('enable starts the addon, the declared-access filter applies, disable stops it and saves the state', async () => {
  const h = harness('enable', (d) => copyFixture('addon-echo', d))
  try {
    assert.equal(await h.host.setEnabled('addon-echo', true), null)
    assert.equal(h.settings.isEnabled('addon-echo'), true)
    await waitFor(() => running(h, 'addon-echo'), 'echo running')
    assert.equal(h.host.list()[0].status, 'running')
    const r = (await h.host.call('addon-echo', 'echo', { text: 'hi', audioPath: '/a.ogg', sessionNames: ['s1'], filePath: '/x' })) as {
      received: Record<string, unknown>
    }
    // The manifest declares message.text and sessions.names only: the audio path and the file path never leave the host.
    assert.deepEqual(without(r.received), { text: 'hi', sessionNames: ['s1'] })

    assert.equal(await h.host.setEnabled('addon-echo', false), null)
    assert.equal(h.settings.isEnabled('addon-echo'), false)
    assert.equal(running(h, 'addon-echo'), false)
    await assert.rejects(h.host.call('addon-echo', 'echo', {}), /not running/)
    assert.equal(h.clock.pendingTimers(), 0)
  } finally {
    await done(h)
  }
})

test('settings survive a new host: an enabled addon starts again on start()', async () => {
  const settings = new Settings()
  settings.setEnabled('addon-echo', true)
  const h = harness('restart', (d) => copyFixture('addon-echo', d), { settings })
  try {
    await h.host.start()
    await waitFor(() => running(h, 'addon-echo'), 'echo running after start')
  } finally {
    await done(h)
  }
})

test('framing: a reply split over three writes, and a junk line before a reply in one write, both resolve', async () => {
  const h = harness('frame', (d) => copyFixture('addon-echo', d))
  try {
    await h.host.setEnabled('addon-echo', true)
    const split = (await h.host.call('addon-echo', 'split', { text: 'abcdefghijklmnop' })) as { received: unknown }
    assert.deepEqual(without(split.received), { text: 'abcdefghijklmnop' })
    const joined = (await h.host.call('addon-echo', 'joined', { text: 'x' })) as { received: unknown }
    assert.deepEqual(without(joined.received), { text: 'x' })
    assert.ok(h.lines.some((l) => /not a reply was ignored/.test(l)))
  } finally {
    await done(h)
  }
})

test('stderr of an addon is logged with its name', async () => {
  const h = harness('stderr', (d) => copyFixture('addon-echo', d))
  try {
    await h.host.setEnabled('addon-echo', true)
    await h.host.call('addon-echo', 'stderr', {})
    assert.ok(h.lines.includes('addon addon-echo: a line for stderr'))
  } finally {
    await done(h)
  }
})

test('timeout: a call that gets no answer rejects when its time is up, and not before', async () => {
  const h = harness('timeout', (d) => copyFixture('addon-echo', d))
  try {
    await h.host.setEnabled('addon-echo', true)
    let settled: 'pending' | 'rejected' = 'pending'
    let message = ''
    const p = h.host.call('addon-echo', 'sleep', {}, 1000)
    p.then(
      () => {},
      (e: Error) => {
        settled = 'rejected'
        message = e.message
      },
    )
    h.clock.advance(999)
    await tick()
    assert.equal(settled, 'pending')
    h.clock.advance(1)
    await tick()
    assert.equal(settled, 'rejected')
    assert.match(message, /did not answer sleep in 1 s/)
    // The addon is still up after a timeout.
    assert.ok(running(h, 'addon-echo'))
  } finally {
    await done(h)
  }
})

// ---------- crash isolation and restart ----------

test('crash isolation: a call waiting on a crashing addon rejects, and the other addons keep working', async () => {
  const h = harness('crash1', (d) => {
    copyFixture('addon-echo', d)
    copyFixture('addon-crash', d)
  })
  try {
    await h.host.setEnabled('addon-echo', true)
    await h.host.setEnabled('addon-crash', true)
    await assert.rejects(h.host.call('addon-crash', 'anything', {}), /addon-crash stopped/)
    await waitFor(() => h.host.list().find((a) => a.name === 'addon-crash')?.status === 'restarting in 1 s', 'first restart scheduled')
    const r = (await h.host.call('addon-echo', 'echo', { text: 'still here' })) as { received: unknown }
    assert.deepEqual(without(r.received), { text: 'still here' })
    assert.equal(h.alerts.length, 0)
  } finally {
    await done(h)
  }
})

test('restart backoff 1 s, 5 s, then the third crash in ten minutes disables it with one alert', async () => {
  // 1 s after the first crash, 5 s after the second, and the third disables: there is no 30 s step.
  assert.deepEqual([...BACKOFF_MS], [1_000, 5_000])
  assert.equal(CRASH_LIMIT, 3)
  const h = harness('crash3', (d) => copyFixture('addon-crash', d))
  try {
    await h.host.setEnabled('addon-crash', true)
    const status = () => h.host.list().find((a) => a.name === 'addon-crash')?.status ?? ''
    await waitFor(() => status() === 'restarting in 1 s', 'restart in 1 s')
    h.clock.advance(1_000)
    await waitFor(() => status() === 'restarting in 5 s', 'restart in 5 s')
    h.clock.advance(5_000)
    await waitFor(() => h.settings.isEnabled('addon-crash') === false, 'disabled after the third crash')
    assert.equal(status(), 'disabled after 3 crashes in 10 minutes')
    assert.equal(h.alerts.length, 1)
    assert.match(h.alerts[0], /addon-crash crashed 3 times in 10 minutes/)
    // No further restart is scheduled and nothing is running.
    h.clock.advance(60 * 60_000)
    await tick()
    assert.equal(running(h, 'addon-crash'), false)
    assert.equal(h.clock.pendingTimers(), 0)
    assert.equal(h.spawned.filter((n) => n === 'addon-crash').length, 3)
  } finally {
    await done(h)
  }
})

test('a command that cannot be started counts as crashes: three failed starts disable it', async () => {
  const h = harness('nocmd', (d) => writeEchoLike(d, 'no-program', { command: ['definitely-not-a-program-xyz'] }))
  try {
    await h.host.setEnabled('no-program', true)
    await waitFor(() => h.host.list()[0]?.status === 'restarting in 1 s', 'first failed start')
    h.clock.advance(1_000)
    await waitFor(() => h.host.list()[0]?.status === 'restarting in 5 s', 'second failed start')
    h.clock.advance(5_000)
    await waitFor(() => h.settings.isEnabled('no-program') === false, 'disabled after third failed start')
    assert.equal(h.alerts.length, 1)
    assert.equal(running(h, 'no-program'), false)
  } finally {
    await done(h)
  }
})

// A child that only emits what the test tells it to: the host sees exits and kills exactly as from a real process.
class FakeChild extends EventEmitter {
  readonly stdin = { write: (_chunk: string) => true, on: (_e: 'error', _fn: (e: Error) => void) => this.stdin }
  readonly stdout = Object.assign(new EventEmitter(), { setEncoding: (_enc: 'utf8') => {} })
  readonly stderr = Object.assign(new EventEmitter(), { setEncoding: (_enc: 'utf8') => {} })
  readonly killed: string[] = []
  kill(signal?: string): boolean {
    this.killed.push(signal ?? 'SIGTERM')
    return true
  }
}

// Shutdown: systemd's SIGTERM reaches the addons too, so an addon can exit before the router's stop() runs. Once the host
// is marked stopping, that exit is an intended stop: not logged as a crash, not counted, no restart.
test('shutdown: an addon that exits after beginStop is not a crash: no log line, no restart, no alert', async () => {
  const children: FakeChild[] = []
  const h = harness('shutdown', (d) => copyFixture('addon-echo', d), { spawn: () => {
    const c = new FakeChild()
    children.push(c)
    return c as never
  } })
  try {
    await h.host.setEnabled('addon-echo', true)
    assert.equal(children.length, 1)
    assert.ok(running(h, 'addon-echo'))
    h.host.beginStop()
    children[0].emit('exit', null)
    await tick()
    assert.equal(h.lines.filter((l) => /crashed/.test(l)).length, 0)
    assert.equal(h.clock.pendingTimers(), 0, 'no restart is scheduled')
    assert.equal(running(h, 'addon-echo'), false)
    assert.equal(h.alerts.length, 0)
  } finally {
    await done(h)
  }
})

test('shutdown: stop() kills a running addon, and its exit is not a crash', async () => {
  const children: FakeChild[] = []
  const h = harness('shutdown2', (d) => copyFixture('addon-echo', d), { spawn: () => {
    const c = new FakeChild()
    children.push(c)
    return c as never
  } })
  try {
    await h.host.setEnabled('addon-echo', true)
    const stopped = h.host.stop()
    assert.deepEqual(children[0].killed, ['SIGTERM'])
    children[0].emit('exit', 143)
    await stopped
    assert.equal(h.lines.filter((l) => /crashed/.test(l)).length, 0)
    assert.equal(h.clock.pendingTimers(), 0)
  } finally {
    removeDir(h.dir)
  }
})

test('stop waits for each addon to exit; one that ignores SIGTERM gets SIGKILL after the grace period', async () => {
  const children: FakeChild[] = []
  const h = harness('stop-wait', (d) => copyFixture('addon-echo', d), { spawn: () => {
    const c = new FakeChild()
    children.push(c)
    return c as never
  } })
  try {
    await h.host.setEnabled('addon-echo', true)
    let stopped = false
    const p = h.host.stop().then(() => {
      stopped = true
    })
    await tick()
    assert.deepEqual(children[0].killed, ['SIGTERM'])
    assert.equal(stopped, false, 'stop does not return while the addon is alive')
    h.clock.advance(ADDON_STOP_GRACE_MS - 1)
    await tick()
    assert.deepEqual(children[0].killed, ['SIGTERM'], 'no SIGKILL before the grace period is over')
    h.clock.advance(1)
    await tick()
    assert.deepEqual(children[0].killed, ['SIGTERM', 'SIGKILL'])
    assert.equal(stopped, false, 'still waiting for the exit after SIGKILL')
    children[0].emit('exit', null)
    await p
    assert.equal(stopped, true)
    assert.equal(h.clock.pendingTimers(), 0, 'no timer is left behind')
  } finally {
    removeDir(h.dir)
  }
})

test('stop does not wait for an addon that already exited', async () => {
  const children: FakeChild[] = []
  const h = harness('stop-exited', (d) => copyFixture('addon-echo', d), { spawn: () => {
    const c = new FakeChild()
    children.push(c)
    return c as never
  } })
  try {
    await h.host.setEnabled('addon-echo', true)
    children[0].emit('exit', 0)
    await tick()
    await h.host.stop()
    assert.equal(h.clock.pendingTimers(), 0)
    assert.deepEqual(children[0].killed, [])
  } finally {
    removeDir(h.dir)
  }
})

test('an addon started again after a stop is supervised again: its next crash is counted', async () => {
  const children: FakeChild[] = []
  const h = harness('restart-after-stop', (d) => copyFixture('addon-echo', d), { spawn: () => {
    const c = new FakeChild()
    children.push(c)
    return c as never
  } })
  try {
    await h.host.setEnabled('addon-echo', true)
    h.host.beginStop()
    await h.host.setEnabled('addon-echo', false)
    await h.host.setEnabled('addon-echo', true)
    children[1].emit('exit', 1)
    await tick()
    assert.equal(h.lines.filter((l) => /crashed \(1 in 10 min\)/.test(l)).length, 1)
    assert.equal(h.clock.pendingTimers(), 1, 'the restart is scheduled')
  } finally {
    await done(h)
  }
})

test('disabling an addon by hand is not a crash: no restart, no alert', async () => {
  const h = harness('handoff', (d) => copyFixture('addon-echo', d))
  try {
    await h.host.setEnabled('addon-echo', true)
    await waitFor(() => running(h, 'addon-echo'), 'echo running')
    await h.host.setEnabled('addon-echo', false)
    await tick()
    assert.equal(h.clock.pendingTimers(), 0)
    assert.equal(h.alerts.length, 0)
    assert.equal(h.host.list()[0].status, 'off')
  } finally {
    await done(h)
  }
})

test('a crash fails the calls that are waiting on the addon (exit while a call is pending)', async () => {
  const h = harness('crashpending', (d) => copyFixture('addon-crash', d))
  try {
    await h.host.setEnabled('addon-crash', true)
    await assert.rejects(h.host.call('addon-crash', 'boom', {}, 60_000), /addon-crash stopped: exited \(code 1\)/)
  } finally {
    await done(h)
  }
})

// ---------- dependencies ----------

test('requires: refused while the requirement is off, allowed after, and the requirement cannot go off first', async () => {
  const h = harness('deps', (d) => {
    copyFixture('addon-echo', d)
    writeEchoLike(d, 'child-addon', { requires: ['addon-echo'] })
  })
  try {
    const refusal = await h.host.setEnabled('child-addon', true)
    assert.match(refusal ?? '', /needs addon-echo installed and enabled first/)
    assert.equal(h.settings.isEnabled('child-addon'), false)

    assert.equal(await h.host.setEnabled('addon-echo', true), null)
    assert.equal(await h.host.setEnabled('child-addon', true), null)
    await waitFor(() => running(h, 'child-addon'), 'child running')

    const off = await h.host.setEnabled('addon-echo', false)
    assert.match(off ?? '', /child-addon needs addon-echo\. Turn it off first\./)
    assert.ok(running(h, 'addon-echo'))

    assert.equal(await h.host.setEnabled('child-addon', false), null)
    assert.equal(await h.host.setEnabled('addon-echo', false), null)
  } finally {
    await done(h)
  }
})

test('start order: a required addon is started before the addon that needs it', async () => {
  const settings = new Settings()
  settings.setEnabled('child-addon', true)
  settings.setEnabled('addon-echo', true)
  const h = harness(
    'order',
    (d) => {
      copyFixture('addon-echo', d)
      writeEchoLike(d, 'child-addon', { requires: ['addon-echo'] })
    },
    { settings },
  )
  try {
    await h.host.start()
    assert.deepEqual(h.spawned, ['addon-echo', 'child-addon'])
  } finally {
    await done(h)
  }
})

test('a dependency cycle starts nothing', async () => {
  const settings = new Settings()
  settings.setEnabled('cyc-a', true)
  settings.setEnabled('cyc-b', true)
  const h = harness(
    'cycle',
    (d) => {
      writeEchoLike(d, 'cyc-a', { requires: ['cyc-b'] })
      writeEchoLike(d, 'cyc-b', { requires: ['cyc-a'] })
    },
    { settings },
  )
  try {
    await h.host.start()
    assert.deepEqual(h.spawned, [])
    assert.deepEqual(h.host.running(), [])
  } finally {
    await done(h)
  }
})

test('enabling is refused for a broken addon, and for a command the core already uses', async () => {
  const h = harness('refuse', (d) => {
    mkdirSync(join(d, 'broken'))
    writeFileSync(join(d, 'broken', 'stolik-addon.json'), '{}')
    writeEchoLike(d, 'cmd-clash', { provides: [{ point: 'command', name: 'list' }] })
  })
  try {
    assert.match((await h.host.setEnabled('broken', true)) ?? '', /invalid manifest/)
    assert.match((await h.host.setEnabled('cmd-clash', true)) ?? '', /used by stolik itself/)
    assert.match((await h.host.setEnabled('nobody', true)) ?? '', /No addon named nobody/)
    assert.equal(h.settings.isEnabled('cmd-clash'), false)
  } finally {
    await done(h)
  }
})

// ---------- dispatch ----------

test('text filters run in name order, each on the previous output; a stopped addon is skipped', async () => {
  const h = harness('filters', (d) => {
    copyFixture('addon-echo', d)
    writeEchoLike(d, 'echo-b', { provides: [{ point: 'text-filter' }] })
    writeEchoLike(d, 'echo-c', { provides: [{ point: 'text-filter' }] })
  })
  try {
    await h.host.setEnabled('echo-c', true)
    await h.host.setEnabled('addon-echo', true)
    await h.host.setEnabled('echo-b', true)
    assert.equal(await textFilters(h.host, 'hi'), 'hi|addon-echo|echo-b|echo-c')
    await h.host.setEnabled('echo-b', false)
    assert.equal(await textFilters(h.host, 'hi'), 'hi|addon-echo|echo-c')
  } finally {
    await done(h)
  }
})

test('media: the first addon (name order) that takes the kind answers; no taker gives null', async () => {
  const h = harness('media', (d) => {
    copyFixture('addon-echo', d)
    writeEchoLike(d, 'zz-voice', { provides: [{ point: 'media', kinds: ['voice'] }] })
  })
  try {
    await h.host.setEnabled('zz-voice', true)
    await h.host.setEnabled('addon-echo', true)
    const voice = { kind: 'voice' as const, size: 10, mime: 'audio/ogg', path: '/tmp-not-real/a.ogg' }
    assert.deepEqual(await media(h.host, voice), { addon: 'addon-echo', text: 'spoken by addon-echo' })
    assert.equal(await media(h.host, { ...voice, kind: 'photo' }), null)
  } finally {
    await done(h)
  }
})

test('general: a /command and a prefix are answered by their addon; anything else is not handled', async () => {
  const h = harness('general', (d) => copyFixture('addon-echo', d))
  try {
    await h.host.setEnabled('addon-echo', true)
    assert.equal(await general(h.host, 'echo: hi there'), 'echo: hi there')
    assert.equal(await general(h.host, 'ECHO - hi'), 'echo: hi')
    assert.equal(await general(h.host, '/echo a b'), 'cmd echo: a b')
    assert.equal(await general(h.host, 'hello there'), null)
    assert.equal(await general(h.host, 'echo hi'), null)
    await h.host.setEnabled('addon-echo', false)
    assert.equal(await general(h.host, 'echo: hi'), null)
  } finally {
    await done(h)
  }
})

test('route, schedule and listener points: scores, due ticks, and fire-and-forget events', async () => {
  const h = harness('points', (d) => copyFixture('addon-echo', d))
  try {
    await h.host.setEnabled('addon-echo', true)
    assert.deepEqual(await routeScores(h.host, 'what', ['s1', 's2']), {
      addon: 'addon-echo',
      scores: { s1: 0.5, s2: 0.5 },
    })
    const last = new Map<string, number>()
    const t0 = h.clock.now()
    assert.deepEqual(await tickSchedules(h.host, t0, last), ['addon-echo#5'])
    assert.deepEqual(await tickSchedules(h.host, t0 + 30_000, last), [])
    assert.deepEqual(await tickSchedules(h.host, t0 + 60_000, last), ['addon-echo#5'])
    emitEvent(h.host, { kind: 'inbound', text: 'listen to this' })
    await tick()
    assert.ok(!h.lines.some((l) => /listener failed/.test(l)))
  } finally {
    await done(h)
  }
})

test('stop: every addon stops, no timer is left behind, and a stopped addon is not restarted', async () => {
  const h = harness('stop', (d) => copyFixture('addon-echo', d))
  try {
    await h.host.setEnabled('addon-echo', true)
    await waitFor(() => running(h, 'addon-echo'), 'echo running')
    const p = h.host.call('addon-echo', 'sleep', {}, 60_000)
    const failure = p.then(
      () => 'resolved',
      (e: Error) => e.message,
    )
    await h.host.stop()
    assert.match(await failure, /was stopped/)
    assert.equal(running(h, 'addon-echo'), false)
    assert.equal(h.clock.pendingTimers(), 0)
    assert.equal(h.settings.isEnabled('addon-echo'), true)
  } finally {
    removeDir(h.dir)
  }
})

// ---------- deadlines ----------

test('deadline: every call carries the absolute time it is due (clock now + its timeout), even for an addon that declares nothing', async () => {
  const h = harness('deadline', (d) => {
    copyFixture('addon-echo', d)
    writeEchoLike(d, 'bare', { access: [] })
  })
  try {
    await h.host.setEnabled('addon-echo', true)
    await h.host.setEnabled('bare', true)
    const at = h.clock.now()
    const r = (await h.host.call('addon-echo', 'echo', { text: 'hi' }, 5_000)) as { received: Record<string, unknown> }
    assert.equal(r.received.deadline, at + 5_000)
    assert.equal(r.received.text, 'hi')
    const bare = (await h.host.call('bare', 'echo', { text: 'secret' })) as { received: Record<string, unknown> }
    assert.deepEqual(bare.received, { deadline: at + 30_000 })
  } finally {
    await done(h)
  }
})

// ---------- serves ----------

// A caller addon: its `relay` op makes one call to the addon named in its text (JSON {addon, op, payload}) and answers
// with what comes back. It is the same shape as the relay-caller fixture, written here so the test owns it.
const RELAY = `import { createInterface } from 'node:readline'
const out = (s) => process.stdout.write(s)
let seq = 0
const waiting = new Map()
createInterface({ input: process.stdin }).on('line', async (line) => {
  const msg = JSON.parse(line)
  if (typeof msg.op !== 'string') {
    const w = waiting.get(msg.id)
    if (!w) return
    waiting.delete(msg.id)
    if (typeof msg.error === 'string') w.reject(new Error(msg.error))
    else w.resolve(msg.result)
    return
  }
  const want = JSON.parse(msg.payload.text)
  const id = ++seq
  try {
    const result = await new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject })
      out(JSON.stringify({ id, request: 'call', addon: want.addon, op: want.op, payload: want.payload ?? {}, timeoutMs: 5000 }) + '\\n')
    })
    out(JSON.stringify({ id: msg.id, result }) + '\\n')
  } catch (e) {
    out(JSON.stringify({ id: msg.id, error: e.message }) + '\\n')
  }
})
`

test('serves: a required addon can call an op the target serves; any other op of it is refused', async () => {
  const h = harness('serves', (d) => {
    writeEchoLike(d, 'callee', { serves: ['generate'] })
    writeEchoLike(d, 'caller', { command: ['node', 'relay.mjs'], requires: ['callee'] })
    writeFileSync(join(d, 'caller', 'relay.mjs'), RELAY)
  })
  try {
    await h.host.setEnabled('callee', true)
    assert.equal(await h.host.setEnabled('caller', true), null)
    await waitFor(() => running(h, 'caller'), 'caller running')
    const ask = (addon: string, op: string) => h.host.call('caller', 'relay', { text: JSON.stringify({ addon, op, payload: { text: 'hello' } }) })

    const served = (await ask('callee', 'generate')) as { received: Record<string, unknown> }
    assert.equal(served.received.text, 'hello')

    await assert.rejects(ask('callee', 'transcribe'), /callee does not serve transcribe to other addons/)
    assert.ok(h.lines.some((l) => /call to callee\.transcribe refused \(not served\)/.test(l)))
    assert.ok(running(h, 'callee'), 'the callee is untouched by the refused call')
  } finally {
    await done(h)
  }
})

// ---------- built-in wins ----------

test('a built-in wins over a user folder of the same name: the user folder is ignored, reported once, and never switched on', async () => {
  const dir = tmpDir('shadow')
  const builtin = join(dir, 'builtin')
  const user = join(dir, 'user')
  mkdirSync(user, { recursive: true })
  writeEchoLike(builtin, 'modes', { provides: [{ point: 'text-filter' }] })
  writeEchoLike(user, 'modes', { provides: [{ point: 'listener' }] })
  const cwds: string[] = []
  const { lines, logger } = recordingLogger()
  const alerts: string[] = []
  const settings = new Settings()
  const host = new AddonHost({
    addonsDir: user,
    builtinDir: builtin,
    settings,
    clock: new FakeClock(),
    logger,
    alert: (t) => alerts.push(t),
    pin,
    spawn: (file, args, opts) => {
      cwds.push(opts.cwd)
      return defaultSpawn(file, args, opts)
    },
  })
  try {
    const rows = host.list()
    const builtinRow = rows.find((r) => r.name === 'modes' && !r.shadowed)
    assert.deepEqual(builtinRow?.provides, ['text-filter'], 'the built-in manifest is the one in use')
    const shadow = rows.find((r) => r.shadowed)
    assert.equal(shadow?.name, 'modes')
    assert.equal(shadow?.status, 'shadows built-in modes, ignored')
    assert.equal(shadow?.enabled, false)
    host.list()
    assert.equal(alerts.length, 1, 'alerted once')
    assert.match(alerts[0], /shadows the built-in addon modes/)
    assert.equal(lines.filter((l) => /shadows the built-in modes: ignored/.test(l)).length, 1)
    // The shadowed row gets no /addons button; the built-in keeps its own.
    assert.deepEqual(addonsMenuRows(rows).map((r) => r[0].data), ['ad:modes:on'])

    assert.equal(await host.setEnabled('modes', true), null)
    assert.equal(cwds.length, 1)
    assert.equal(cwds[0], join(builtin, 'modes'), 'the built-in folder runs, not the user one')
  } finally {
    await host.stop()
    removeDir(dir)
  }
})
