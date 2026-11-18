// The addon host's observability (src/addons-host/host.ts): the trace in calls and requests, stderr capture with levels,
// crash counts and the last error, and query(). A fake child process stands in for the addon.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { AddonHost, CRASH_LIMIT, type ChildLike, type SpawnFn } from '../src/addons-host/host.ts'
import { currentTrace, runTraced, type Level } from '../src/brain/observe.ts'
import { FakeClock, MemorySettings, allowUserAddons, removeDir, tmpDir, writeEchoLike } from './helpers/addon-fakes.ts'

class FakeChild extends EventEmitter implements ChildLike {
  readonly written: string[] = []
  readonly stdin = { write: (chunk: string) => (this.written.push(chunk), true), on: () => this.stdin }
  readonly stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} })
  readonly stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} })
  // A killed process exits (the host's stop() waits for the exit, on the clock).
  kill(): boolean {
    queueMicrotask(() => this.emit('exit', null))
    return true
  }
  // The request ids the host wrote, as numbers, in order.
  requestIds(): number[] {
    return this.written.map((l) => JSON.parse(l).id as number)
  }
  reply(id: number, result: unknown): void {
    this.stdout.emit('data', JSON.stringify({ id, result }) + '\n')
  }
  line(obj: unknown): void {
    this.stdout.emit('data', JSON.stringify(obj) + '\n')
  }
}

const tick = () => new Promise((r) => setImmediate(r))

type Logged = { level: Level; msg: string; component?: string }
type Requests = (a: string, op: string, p: Record<string, unknown>) => Promise<unknown>

function setup(label: string, opts: { manifest?: Record<string, unknown>; requests?: Requests } = {}) {
  const dir = tmpDir(label)
  const addonsDir = join(dir, 'addons')
  writeEchoLike(addonsDir, 'addon-echo', opts.manifest ?? {})
  const settings = new MemorySettings()
  allowUserAddons(addonsDir, settings) // the owner's consent to the addon as it is (its manifest is not yet allowed otherwise)
  const children: FakeChild[] = []
  const spawn: SpawnFn = () => {
    const c = new FakeChild()
    children.push(c)
    return c
  }
  const logged: Logged[] = []
  const lines: string[] = []
  const stderrFiles: Array<{ name: string; level: Level; msg: string }> = []
  const clock = new FakeClock()
  const host = new AddonHost({
    addonsDir,
    settings,
    clock,
    logger: {
      log: (m) => lines.push(m),
      debug: () => {},
      warn: (m, component) => logged.push({ level: 'warn', msg: m, component }),
      error: (m, component) => logged.push({ level: 'error', msg: m, component }),
    },
    alert: () => {},
    pin: (file, args) => ({ file, args }),
    spawn,
    addonLog: (name, level, msg) => stderrFiles.push({ name, level, msg }),
    requests: opts.requests,
  })
  return { dir, host, children, logged, lines, stderrFiles, clock }
}

test('call: the caller\'s trace id travels in the payload (protocol 2, optional); outside a flow there is none', async () => {
  const h = setup('call-trace')
  try {
    await h.host.setEnabled('addon-echo', true)
    const child = h.children[0]
    const p1 = runTraced('ca11ca11', () => h.host.call('addon-echo', 'ping', { text: 'hi' }))
    p1.catch(() => {})
    const sent = JSON.parse(child.written[0])
    assert.equal(sent.op, 'ping')
    assert.equal(sent.payload.trace, 'ca11ca11')
    const p2 = h.host.call('addon-echo', 'ping', {})
    p2.catch(() => {})
    assert.equal(JSON.parse(child.written[1]).payload.trace, undefined)
  } finally {
    await h.host.stop()
    removeDir(h.dir)
  }
})

test('query: a call that the caller awaits resolves with the addon\'s answer', async () => {
  const h = setup('query')
  try {
    await h.host.setEnabled('addon-echo', true)
    const child = h.children[0]
    const p = h.host.query('addon-echo', 'status', {}, 5_000)
    const id = child.requestIds()[0]
    child.reply(id, { models: [] })
    assert.deepEqual(await p, { models: [] })
  } finally {
    await h.host.stop()
    removeDir(h.dir)
  }
})

test('query: an addon that is not running rejects with a clear message', async () => {
  const h = setup('query-off')
  try {
    await assert.rejects(h.host.query('addon-echo', 'status', {}), /no addon named|not running/)
    await assert.rejects(h.host.query('nope', 'status', {}), /no addon named nope/)
  } finally {
    await h.host.stop()
    removeDir(h.dir)
  }
})

test('stderr: each line goes to the addon\'s log with its level; warnings and errors reach the logger\'s warn and error', async () => {
  const h = setup('stderr')
  try {
    await h.host.setEnabled('addon-echo', true)
    const child = h.children[0]
    child.stderr.emit('data', 'Traceback (most recent call last):\nall fine here\n[ml] whisper: cuda load failed, using cpu\n')
    assert.deepEqual(h.stderrFiles.map((x) => [x.name, x.level]), [
      ['addon-echo', 'error'], ['addon-echo', 'info'], ['addon-echo', 'warn'],
    ])
    assert.ok(h.lines.some((l) => l === 'addon addon-echo: all fine here'), 'the journal keeps info lines as before')
    assert.deepEqual(h.logged.map((x) => [x.level, x.component]), [['error', 'addon:addon-echo'], ['warn', 'addon:addon-echo']])
  } finally {
    await h.host.stop()
    removeDir(h.dir)
  }
})

test('crash: a warning with the reason goes to the logger; the restart count and the last error are kept for /debug', async () => {
  const h = setup('crash')
  try {
    await h.host.setEnabled('addon-echo', true)
    h.children[0].emit('exit', 1)
    await tick()
    const warn = h.logged.find((x) => x.level === 'warn' && /crashed/.test(x.msg))
    assert.ok(warn, 'a crash warning is logged')
    assert.equal(warn?.component, 'addons')
    assert.match(warn?.msg ?? '', /exited \(code 1\)/)
    const info = h.host.list().find((a) => a.name === 'addon-echo')
    assert.equal(info?.restarts, 1)
    assert.equal(info?.lastError, 'exited (code 1)')
  } finally {
    await h.host.stop()
    removeDir(h.dir)
  }
})

test('crash limit: the third crash in the window is an error (the addon is disabled)', async () => {
  const h = setup('crash-limit')
  try {
    await h.host.setEnabled('addon-echo', true)
    for (let i = 0; i < CRASH_LIMIT; i++) {
      h.children[h.children.length - 1].emit('exit', 2)
      await tick()
      // Each restart waits on the fake clock (1 s, then 5 s); the third crash disables the addon instead.
      if (i < CRASH_LIMIT - 1) h.clock.advance(60_000)
    }
    assert.equal(h.children.length, CRASH_LIMIT - 1 + 1, 'one child per start, the last crash starts none')
    const err = h.logged.find((x) => x.level === 'error')
    assert.ok(err, 'the disable is an error')
    assert.match(err?.msg ?? '', /disabled after 3 crashes/)
    assert.equal(h.host.list().find((a) => a.name === 'addon-echo')?.enabled, false)
  } finally {
    await h.host.stop()
    removeDir(h.dir)
  }
})

test('request: the trace an addon sends in its request is used for the request; a missing or bad one gets a new trace', async () => {
  const seen: Array<string | undefined> = []
  const h = setup('request-trace', {
    manifest: { access: ['message.text', 'usage.record'] },
    requests: async () => {
      seen.push(currentTrace())
      return { ok: true }
    },
  })
  try {
    await h.host.setEnabled('addon-echo', true)
    const child = h.children[0]
    child.line({ id: 41, op: 'usage', payload: { trace: 'feedface', mode: 'quick' } })
    child.line({ id: 42, op: 'usage', payload: { trace: 'not-a-trace' } })
    await tick()
    await tick()
    assert.equal(seen[0], 'feedface')
    assert.match(seen[1] ?? '', /^[0-9a-f]{8}$/)
    assert.notEqual(seen[1], 'not-a-trace')
  } finally {
    await h.host.stop()
    removeDir(h.dir)
  }
})
