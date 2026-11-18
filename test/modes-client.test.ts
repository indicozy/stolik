// The addon side of the protocol (src/addons/modes/client.ts): host calls are answered, a throw becomes an error
// reply, and the addon's own requests resolve from the host's replies.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AddonClient } from '../src/addons/modes/client.ts'

const tick = () => new Promise((r) => setImmediate(r))

test('a host call is answered with its result; a throw or a rejection is an error reply, and the addon keeps going', async () => {
  const out: string[] = []
  const client = new AddonClient({ write: (s) => out.push(s) }, async (op) => {
    if (op === 'boom') throw new Error('sync boom')
    if (op === 'reject') return Promise.reject(new Error('async boom'))
    return { reply: `got ${op}` }
  })
  client.input('{"id":1,"op":"prefix","payload":{}}\n{"id":2,"op":"boom","payload":{}}\n')
  client.input('{"id":3,"op":"reject","payload":{}}\n')
  for (let i = 0; i < 5; i++) await tick()
  const replies = out.map((l) => JSON.parse(l) as Record<string, unknown>)
  assert.deepEqual(replies.find((r) => r.id === 1), { id: 1, result: { reply: 'got prefix' } })
  assert.deepEqual(replies.find((r) => r.id === 2), { id: 2, error: 'sync boom' })
  assert.deepEqual(replies.find((r) => r.id === 3), { id: 3, error: 'async boom' })
})

test('the addon request resolves from the host reply, and an error reply rejects it', async () => {
  const out: string[] = []
  const client = new AddonClient({ write: (s) => out.push(s) }, async () => null)
  const ok = client.request('send', { text: 'hi' })
  const bad = client.request('spawn', {})
  const sent = JSON.parse(out[0]) as { id: number; op: string }
  assert.equal(sent.op, 'send')
  client.input(`{"id":${sent.id},"result":{"messageIds":[9]}}\n`)
  assert.deepEqual(await ok, { messageIds: [9] })
  const spawnId = (JSON.parse(out[1]) as { id: number }).id
  client.input(`{"id":${spawnId},"error":"not declared"}\n`)
  await assert.rejects(bad, /not declared/)
})

test('a request with no reply times out', async () => {
  const client = new AddonClient({ write: () => {} }, async () => null)
  await assert.rejects(client.request('send', {}, 10), /did not answer send/)
})
