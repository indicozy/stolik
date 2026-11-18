// Discord direct send (batch D2): chunking, one DM open, silent flag, errors without the token.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sendDirectDiscord, type DirectRest } from '../src/adapters/chat/discord-direct.ts'

type Post = { route: string; body: { content?: string; flags?: number; allowed_mentions?: unknown; recipient_id?: string } }

function recorder(fail?: Error) {
  const posts: Post[] = []
  const rest: DirectRest = {
    post: async (route: string, o?: { body?: unknown }) => {
      if (fail) throw fail
      posts.push({ route, body: (o?.body ?? {}) as Post['body'] })
      if (route === '/users/@me/channels') return { id: 'dm1' }
      return {}
    },
  }
  return { rest, posts, make: async () => rest }
}

const TOKEN = 'MTIzNDU2.' + 'x'.repeat(60)
const cfg = { token: TOKEN, ownerId: '42' }
const opts = { project: null, plain: false, silent: false }

test('a long text is split into chunks of at most 2000 characters, the DM opened once', async () => {
  const r = recorder()
  const err = await sendDirectDiscord(cfg, 'a'.repeat(4500), opts, r.make)
  assert.equal(err, null)
  const dmOpens = r.posts.filter((p) => p.route === '/users/@me/channels')
  assert.equal(dmOpens.length, 1)
  assert.equal(dmOpens[0]!.body.recipient_id, '42')
  const msgs = r.posts.filter((p) => p.route === '/channels/dm1/messages')
  assert.deepEqual(msgs.map((m) => m.body.content!.length), [2000, 2000, 500])
  assert.deepEqual(msgs[0]!.body.allowed_mentions, { parse: [] })
})

test('plain text with characters that escape is still split under the limit', async () => {
  const r = recorder()
  const err = await sendDirectDiscord(cfg, '*'.repeat(1500), { ...opts, plain: true }, r.make)
  assert.equal(err, null)
  const msgs = r.posts.filter((p) => p.route === '/channels/dm1/messages')
  assert.ok(msgs.length >= 2)
  for (const m of msgs) assert.ok(m.body.content!.length <= 2000)
})

test('the project tag goes in front of the first chunk', async () => {
  const r = recorder()
  await sendDirectDiscord(cfg, 'hello', { ...opts, project: 'proj' }, r.make)
  const msgs = r.posts.filter((p) => p.route === '/channels/dm1/messages')
  assert.equal(msgs[0]!.body.content, '[proj] hello')
})

test('silent sets SuppressNotifications (4096) on each message', async () => {
  const r = recorder()
  await sendDirectDiscord(cfg, 'a'.repeat(2500), { ...opts, silent: true }, r.make)
  const msgs = r.posts.filter((p) => p.route === '/channels/dm1/messages')
  for (const m of msgs) assert.equal(m.body.flags, 4096)
})

test('an error is returned as a string and never contains the token', async () => {
  const r = recorder(new Error(`request failed with ${TOKEN}`))
  const err = await sendDirectDiscord(cfg, 'hi', opts, r.make)
  assert.equal(typeof err, 'string')
  assert.ok(err!.length > 0)
  assert.ok(!err!.includes(TOKEN))
})
