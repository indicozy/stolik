// The addon side of the protocol (src/addons/sdk.ts): serving the host's requests, and calling another addon through it.
import './helpers/isolate.ts'
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AddonPeer } from '../src/addons/sdk.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

const tick = () => new Promise((r) => setImmediate(r))

test('peer: a host request is served and its result written back on the same id', async () => {
  const out: string[] = []
  const peer = new AddonPeer((l) => out.push(l), { media: async (p) => ({ text: `got ${String(p.audioPath)}` }) })
  peer.receive('{"id":5,"op":"media","payload":{"audioPath":"/a.oga"}}')
  await tick()
  assert.deepEqual(JSON.parse(out[0]), { id: 5, result: { text: 'got /a.oga' } })
})

test('peer: an unknown op, a handler error and a junk line each answer correctly (junk gets no answer)', async () => {
  const out: string[] = []
  const peer = new AddonPeer((l) => out.push(l), { boom: async () => { throw new Error('bad input') } })
  peer.receive('{"id":1,"op":"nope","payload":{}}')
  peer.receive('{"id":2,"op":"boom","payload":{}}')
  peer.receive('not json')
  peer.receive('{"no":"id"}')
  await tick()
  assert.deepEqual(JSON.parse(out[0]), { id: 1, error: 'this addon does not handle nope' })
  assert.deepEqual(JSON.parse(out[1]), { id: 2, error: 'bad input' })
  assert.equal(out.length, 2)
})

test('peer: a call writes a call request and resolves on the reply with the same id', async () => {
  const out: string[] = []
  const peer = new AddonPeer((l) => out.push(l), {})
  const pending = peer.call('ml-worker', 'transcribe', { audioPath: '/a.oga' }, 1000)
  const req = JSON.parse(out[0])
  assert.deepEqual(req, { id: req.id, request: 'call', addon: 'ml-worker', op: 'transcribe', payload: { audioPath: '/a.oga' }, timeoutMs: 1000 })
  peer.receive(JSON.stringify({ id: req.id, result: { text: 'hi' } }))
  assert.deepEqual(await pending, { text: 'hi' })
})

test('peer: an error reply rejects the call', async () => {
  const out: string[] = []
  const peer = new AddonPeer((l) => out.push(l), {})
  const pending = peer.call('ml-worker', 'clean', { text: 'x' }, 1000)
  const req = JSON.parse(out[0])
  peer.receive(JSON.stringify({ id: req.id, error: 'addon ml-worker is not running' }))
  await assert.rejects(pending, /not running/)
})

test('peer: a call nobody answers is given up on', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const peer = new AddonPeer(() => {}, {})
  const pending = peer.call('ml-worker', 'clean', { text: 'x' }, 1000)
  t.mock.timers.tick(6_000)
  await assert.rejects(pending, /did not answer clean in time/)
})

// An addon process: startAddon on its stdin and stdout. Run as a real child so process exit can be observed.
test('startAddon: the addon process exits with 0 when its stdin ends, so it never outlives the router', async () => {
  const sdk = pathToFileURL(join(HERE, '..', 'src', 'addons', 'sdk.ts')).href
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', `import { startAddon } from '${sdk}'; startAddon(() => ({}))`],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  let stderr = ''
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(child.exitCode, null, 'it stays up while its stdin is open')
  child.stdin.end()
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
  const code = await exited
  clearTimeout(timer)
  assert.equal(code, 0, stderr)
})
