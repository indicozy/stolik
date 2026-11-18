// End to end with fakes, Discord side: a paired owner's DM goes through the Discord adapter to the router's inbound
// rules, and the channel meta carries the router's own id form (user_id "dc:<snowflake>"). The owner id is the raw
// snowflake in the adapter (never Number()), the router's is dc:<snowflake>: the pairing sets both (app.ts).
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Discord, type DcGateway, type DcRest, type DiscordClient } from '../src/adapters/chat/discord.ts'
import { dcUser } from '../src/adapters/chat/dc-ids.ts'
import { decideInbound } from '../src/brain/inbound.ts'
import type { Inbound, UserId } from '../src/brain/chat-types.ts'
import { prepare } from '../src/router/deliver.ts'
import { Router } from '../src/router/core.ts'
import { FakeAgent, FakeAudit, FakeClock, FakeLogger, FakePlatform, FakeStore } from './helpers/fakes.ts'

const OWNER = '800000000000000001'
const STRANGER = '800000000000000002'
const DM = '900000000000000005'

// The minimum a DM needs from the REST side: the DM channel and the sends. Gateway events are injected by the test.
class Client implements DiscordClient {
  readonly calls: Array<{ method: string; route: string }> = []
  private readonly listeners = new Map<string, Array<(d: unknown) => unknown>>()
  readonly rest: DcRest
  readonly gateway: DcGateway

  constructor() {
    const req = (method: string) => async (route: string) => {
      this.calls.push({ method, route })
      if (method === 'post' && route === '/users/@me/channels') return { id: DM }
      if (method === 'post' && route.endsWith('/messages')) return { id: '1000000000000000001', channel_id: DM }
      return undefined
    }
    this.rest = { get: req('get'), post: req('post'), patch: req('patch'), put: req('put'), delete: req('delete') }
    this.gateway = {
      on: (event, fn) => {
        this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn])
      },
      connect: async () => {},
      destroy: async () => {},
    }
  }

  async emit(event: string, data: unknown): Promise<void> {
    await Promise.all((this.listeners.get(event) ?? []).map((fn) => fn(data)))
  }
}

function dm(author: string, content: string): unknown {
  return {
    id: '1000000000000000050',
    channel_id: DM,
    author: { id: author, username: 'owner', global_name: 'Owner', bot: false },
    content,
    type: 0,
    timestamp: '2026-11-18T00:00:00.000Z',
    attachments: [],
    mentions: [],
    mention_roles: [],
    embeds: [],
    pinned: false,
    tts: false,
    mention_everyone: false,
    edited_timestamp: null,
  }
}

function routerOver(chat: Discord, ownerId: UserId): Router {
  return new Router({
    ownerId,
    groupId: null,
    secrets: ['TOKEN-NOT-TO-LEAK'],
    home: '/home/u',
    socketPath: '/fake/router.sock',
    chat,
    store: new FakeStore(),
    platform: new FakePlatform(),
    agent: new FakeAgent(),
    ml: { transcribe: async () => '', close: () => {} },
    clock: new FakeClock(),
    audit: new FakeAudit(),
    logger: new FakeLogger(),
    chatApp: 'discord',
  })
}

test('paired owner: the DM reaches the router as an owner message, with user_id dc:<snowflake> in the meta', async () => {
  const client = new Client()
  const chat = new Discord(client, { ownerId: null, dmChannelId: DM })
  // What the pairing callback in app.ts does: the adapter gets the raw snowflake, the router the dc: form.
  chat.setOwnerUserId(OWNER)
  const router = routerOver(chat, dcUser(OWNER))
  const got: Inbound[] = []
  const verdicts: string[] = []
  chat.onInbound(async (m) => {
    got.push(m)
    verdicts.push(
      decideInbound({
        update: 'message',
        chatKind: m.chat.kind,
        chatId: m.chat.id,
        fromId: m.fromId,
        ownerUserId: router.ownerId,
        groupId: router.groupId,
        text: m.text,
        forwarded: m.forwarded,
      }).action,
    )
  })
  await client.emit('MESSAGE_CREATE', dm(OWNER, 'hello from the phone'))
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(got.length, 1)
  assert.equal(got[0]!.fromId, 'dc:800000000000000001')
  assert.deepEqual(verdicts, ['route'])
  const live = await prepare(router, got[0]!, 'hello from the phone')
  assert.equal(live?.meta.user_id, 'dc:800000000000000001')
  assert.equal(live?.meta.chat_app, 'discord')
})

test('a stranger DM is not an owner message: nothing reaches the router', async () => {
  const client = new Client()
  const chat = new Discord(client, { ownerId: null, dmChannelId: DM })
  chat.setOwnerUserId(OWNER)
  const got: Inbound[] = []
  chat.onInbound(async (m) => {
    got.push(m)
  })
  await client.emit('MESSAGE_CREATE', dm(STRANGER, 'hi'))
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(got.length, 0)
})
