// The chat adapter contract (chat connector 0d batch 3, plan 23 D1b) run against the Discord adapter through a fake
// client: REST calls are answered from an in-memory guild (a lobby, a `sessions` forum, a DM), gateway events are
// injected by the rig, and every platform write is recorded in the contract's terms. No network: fetch is stubbed for
// the download case. The Discord-specific cases below cover what the contract does not: the channel index, the type-6
// ack, archived posts, the forum, the bound server's removal, webhook posts and the pairing gate.
import './helpers/isolate.ts'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType, InteractionResponseType, MessageFlags } from 'discord-api-types/v10'
import { ChatError, type ButtonPress, type ChatEvent, type Inbound, type MessageId, type ThreadId } from '../src/brain/chat-types.ts'
import { Discord, type DcGateway, type DcRest, type DiscordClient } from '../src/adapters/chat/discord.ts'
import { BRIDGE_PERMS_INTEGER } from '../src/adapters/chat/discord-perms.ts'
import { dcChat, dcDm, dcMsg, dcThread, dcUser, parseDcMessage, parseDcThread } from '../src/adapters/chat/dc-ids.ts'
import { chatContract, type Failure, type Out, type Rig, type Where } from './helpers/chat-contract.ts'
import { ISOLATED_ROOT } from './helpers/isolate.ts'

const GUILD = '900000000000000001'
const LOBBY = '900000000000000002'
const OTHER = '900000000000000003'
const CATEGORY = '900000000000000004'
const FOLDER = '900000000000000006'
const DM = '900000000000000005'
const APP = '600000000000000001'
const OWNER = '800000000000000001'
const STRANGER = '800000000000000002'
const SECRET = 'TOKEN-NOT-TO-LEAK'

type Call = { method: string; route: string; body?: any; files?: Array<{ name: string; data: Buffer }>; auth?: boolean }

// A Discord error as @discordjs/rest throws it (DiscordAPIError: code, status, rawError) or a Node network error.
function refusal(f: Failure): Error {
  const api = (status: number, code: number, message: string, extra: object = {}) => Object.assign(new Error(message), { status, code, ...extra })
  switch (f) {
    case 'rate-limited': return api(429, 0, 'You are being rate limited.', { rawError: { retry_after: 2 } })
    case 'access-lost': return api(403, 50001, 'Missing Access')
    case 'thread-closed': return api(400, 50083, 'Thread is archived')
    case 'too-long': return api(413, 40005, 'Request entity too large')
    case 'not-modified': return api(400, 0, 'not modified')
    case 'server': return api(500, 0, 'Internal Server Error')
    case 'client': return api(400, 0, 'Bad Request')
    case 'network': return Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
  }
}

// The permissions the bot gets from @everyone in the fake guild: every right the bridge needs (lobby and folders).
export const BOT_PERMS = BRIDGE_PERMS_INTEGER
const BOT = '600000000000000002'

class FakeDiscord implements DiscordClient {
  readonly outs: Out[] = []
  // The guild as the permission checks read it: @everyone's rights.
  everyone = BOT_PERMS
  features: string[] = ['COMMUNITY']
  readonly calls: Call[] = []
  readonly channels = new Map<string, any>()
  readonly gone = new Set<string>()
  readonly tokens = new Map<string, string>()
  // Channels created by the adapter (id, type, name, parent), and the server's channel cap (30013 at it).
  readonly created: Array<{ id: string; type: number; name: string; parent: string }> = []
  guildCap = 500
  channelsUnder(parent: string | undefined): number {
    let n = 0
    for (const c of this.channels.values()) if (c.parent_id === parent) n++
    return n
  }
  private readonly listeners = new Map<string, Array<(d: unknown) => unknown>>()
  private failure: { kind: Failure; skip: number } | null = null
  private counter = 10n ** 17n

  readonly rest: DcRest
  readonly gateway: DcGateway

  constructor() {
    const req = (method: string) => (route: string, o?: { body?: any; files?: any; auth?: boolean }) => this.request(method, route, o)
    this.rest = { get: req('get'), post: req('post'), patch: req('patch'), put: req('put'), delete: req('delete') }
    this.gateway = {
      on: (event, fn) => {
        this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn])
      },
      connect: async () => {
        setImmediate(() => void this.emit('READY', {}))
      },
      destroy: async () => {},
    }
  }

  // The next platform call is refused, after `skip` calls went through.
  fail(kind: Failure, skip = 0): void {
    this.failure = { kind, skip }
  }

  snow(): string {
    this.counter += 1n
    return this.counter.toString()
  }

  async emit(event: string, data: unknown): Promise<void> {
    await Promise.all((this.listeners.get(event) ?? []).map((fn) => fn(data)))
  }

  channel(id: string): any {
    return this.channels.get(id)
  }

  private where(channelId: string): Where {
    if (channelId === DM) return 'dm'
    return this.channel(channelId)?.guild_id === GUILD && channelId !== OTHER ? 'home' : 'other'
  }

  // A folder channel: a text channel under a category (the rig's folders are thread ids on the wire).
  private isThread(channelId: string): boolean {
    const c = this.channel(channelId)
    return c?.type === ChannelType.GuildText && this.channel(c.parent_id)?.type === ChannelType.GuildCategory
  }

  private async request(method: string, route: string, o?: { body?: any; files?: any; auth?: boolean }): Promise<unknown> {
    this.calls.push({ method, route, body: o?.body, files: o?.files, auth: o?.auth })
    if (this.failure) {
      if (this.failure.skip > 0) this.failure.skip--
      else {
        const kind = this.failure.kind
        this.failure = null
        throw refusal(kind)
      }
    }
    return this.handle(method, route, o)
  }

  private unknownChannel(): never {
    throw Object.assign(new Error('Unknown Channel'), { status: 404, code: 10003 })
  }

  private handle(method: string, route: string, o?: { body?: any; files?: any }): unknown {
    let m: RegExpMatchArray | null
    const body = o?.body ?? {}
    if (method === 'get' && (m = route.match(/^\/channels\/(\d+)$/))) {
      const c = this.channel(m[1]!)
      if (!c || this.gone.has(m[1]!)) this.unknownChannel()
      return c
    }
    if (method === 'get' && (m = route.match(/^\/guilds\/(\d+)\/channels$/))) {
      return [...this.channels.values()].filter((c) => c.guild_id === m![1])
    }
    if (method === 'get' && (m = route.match(/^\/guilds\/(\d+)$/))) {
      return { id: m[1], owner_id: OWNER, roles: [{ id: m[1], permissions: this.everyone.toString() }], features: this.features }
    }
    if (method === 'get' && (m = route.match(/^\/guilds\/(\d+)\/members\/(\d+)$/))) {
      return { user: { id: m[2] }, roles: [] }
    }
    if (method === 'post' && route === '/users/@me/channels') return { id: DM, type: ChannelType.DM }
    if (method === 'post' && (m = route.match(/^\/channels\/(\d+)\/messages$/))) {
      const ch = m[1]!
      if (this.gone.has(ch) || (!this.channel(ch) && ch !== DM)) this.unknownChannel()
      const id = this.snow()
      const comps: string[] = (body.components ?? []).flatMap((r: any) => r.components.map((c: any) => c.custom_id))
      if (o?.files) {
        this.outs.push({ op: 'file', chat: this.where(ch), path: o.files[0].name, asPhoto: false, id: dcMsg(ch, id) })
      } else {
        this.outs.push({
          op: 'send',
          chat: this.where(ch),
          thread: this.isThread(ch) ? dcThread(ch) : undefined,
          text: body.content,
          replyTo: body.message_reference !== undefined,
          buttons: comps,
          id: dcMsg(ch, id),
        })
      }
      return { id, channel_id: ch, content: body.content }
    }
    if (method === 'patch' && (m = route.match(/^\/channels\/(\d+)\/messages\/(\d+)$/))) {
      const id = dcMsg(m[1]!, m[2]!)
      if (body.content !== undefined) {
        const comps: string[] = (body.components ?? []).flatMap((r: any) => r.components.map((c: any) => c.custom_id))
        this.outs.push({ op: 'edit', chat: this.where(m[1]!), id, text: body.content, buttons: comps })
      } else {
        this.outs.push({ op: 'clear', chat: this.where(m[1]!), id })
      }
      return { id: m[2], channel_id: m[1] }
    }
    if (method === 'put' && (m = route.match(/^\/channels\/(\d+)\/messages\/(\d+)\/reactions\/(.+)\/@me$/))) {
      this.outs.push({ op: 'react', chat: this.where(m[1]!), id: dcMsg(m[1]!, m[2]!), emoji: decodeURIComponent(m[3]!) })
      return undefined
    }
    if (method === 'post' && (m = route.match(/^\/channels\/(\d+)\/typing$/))) {
      this.outs.push({ op: 'typing', chat: this.where(m[1]!), thread: this.isThread(m[1]!) ? dcThread(m[1]!) : undefined })
      return undefined
    }
    if (method === 'post' && (m = route.match(/^\/guilds\/(\d+)\/channels$/))) {
      const id = this.snow()
      const c = { id, type: body.type, guild_id: GUILD, name: body.name, parent_id: body.parent_id, topic: body.topic, permission_overwrites: body.permission_overwrites ?? [] }
      if (this.channels.size >= this.guildCap) throw Object.assign(new Error('Maximum number of server channels reached (500)'), { code: 30013, status: 400 })
      if (body.type === ChannelType.GuildText && this.channelsUnder(body.parent_id) >= 50) {
        throw Object.assign(new Error('Maximum number of channels in category reached'), { code: 50035, status: 400 })
      }
      this.channels.set(id, c)
      this.created.push({ id, type: body.type, name: body.name, parent: body.parent_id })
      if (body.type === ChannelType.GuildText) this.outs.push({ op: 'topic', action: 'create', thread: dcThread(id), name: body.name })
      return c
    }
    if (method === 'patch' && (m = route.match(/^\/channels\/(\d+)$/))) {
      const c = this.channel(m[1]!)
      if (!c || this.gone.has(m[1]!)) this.unknownChannel()
      const thread = dcThread(m[1]!)
      if (body.name !== undefined) {
        c.name = body.name
        this.outs.push({ op: 'topic', action: 'rename', thread, name: body.name })
      }
      if (body.parent_id !== undefined) {
        const idle = String(this.channel(body.parent_id)?.name ?? '').startsWith('stolik-idle')
        c.parent_id = body.parent_id
        this.outs.push({ op: 'topic', action: idle ? 'close' : 'reopen', thread, parent: body.parent_id })
      }
      return c
    }
    if (method === 'post' && (m = route.match(/^\/interactions\/(\d+)\/([^/]+)\/callback$/))) return undefined
    if (method === 'post' && (m = route.match(/^\/webhooks\/(\d+)\/([^/]+)$/))) {
      this.outs.push({ op: 'ack', id: this.tokens.get(m[2]!) ?? m[2]!, text: body.content })
      return { id: this.snow() }
    }
    throw new Error(`fake Discord: no route for ${method} ${route}`)
  }

}

// A guild with a lobby (the bound home), a second text channel, the `stolik` category with one folder channel, and the
// owner's DM.
function seedGuild(fake: FakeDiscord, extra: object[] = []): void {
  for (const c of [
    { id: LOBBY, type: ChannelType.GuildText, guild_id: GUILD, name: 'bridge' },
    { id: OTHER, type: ChannelType.GuildText, guild_id: GUILD, name: 'other' },
    { id: CATEGORY, type: ChannelType.GuildCategory, guild_id: GUILD, name: 'stolik' },
    { id: FOLDER, type: ChannelType.GuildText, guild_id: GUILD, name: 'app', parent_id: CATEGORY },
    { id: DM, type: ChannelType.DM },
    ...extra,
  ]) fake.channels.set(c.id, c)
}

// The gateway's GUILD_CREATE for the seeded guild: the channels the bot can see.
async function openGuild(fake: FakeDiscord): Promise<void> {
  await fake.emit('GUILD_CREATE', { id: GUILD, name: 'server', channels: [...fake.channels.values()].filter((c) => c.guild_id === GUILD), threads: [] })
}

async function discordRig(): Promise<Rig> {
  const fake = new FakeDiscord()
  seedGuild(fake)
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response('hello')) as unknown as typeof fetch
  const chat = new Discord(fake, { ownerId: OWNER, dmChannelId: DM, secrets: [SECRET] })
  await openGuild(fake)
  const inject = {
    async message(o: { text?: string; kind?: 'text' | 'sticker' | 'photo'; from?: 'owner' | 'stranger'; chat?: 'dm' | 'home'; thread?: ThreadId; replyTo?: MessageId }) {
      const channel = o.thread !== undefined ? parseDcThread(o.thread) : o.chat === 'home' ? LOBBY : DM
      const from = o.from === 'stranger' ? STRANGER : OWNER
      const msg: any = {
        id: fake.snow(),
        channel_id: channel,
        author: { id: from, username: from === OWNER ? 'owner' : 'stranger', global_name: null, bot: false },
        content: o.text ?? '',
        timestamp: '2026-11-18T00:00:00Z',
        type: o.replyTo ? 19 : 0,
        attachments: [],
        mentions: [],
      }
      if (channel !== DM) msg.guild_id = GUILD
      if (o.replyTo) {
        const r = parseDcMessage(o.replyTo)
        msg.message_reference = { type: 0, message_id: r.messageId, channel_id: r.channelId }
      }
      if (o.kind === 'sticker') msg.sticker_items = [{ id: '1', name: 'st', format_type: 1 }]
      if (o.kind === 'photo') {
        msg.attachments = [{ id: '2', filename: 'pic.png', size: 5, url: 'https://cdn.discordapp.com/attachments/1/2/pic.png', content_type: 'image/png' }]
      }
      await fake.emit('MESSAGE_CREATE', msg)
    },
    async press(o: { data: string; from?: 'owner' | 'stranger'; chat?: 'dm' | 'home'; message?: MessageId }) {
      const interaction = fake.snow()
      const token = `tok${interaction}`
      fake.tokens.set(token, interaction)
      const channel = o.message ? parseDcMessage(o.message).channelId : o.chat === 'home' ? LOBBY : DM
      const user = { id: o.from === 'stranger' ? STRANGER : OWNER }
      const i: any = {
        id: interaction,
        token,
        application_id: APP,
        type: 3,
        channel_id: channel,
        data: { custom_id: o.data, component_type: 2 },
        message: o.message ? { id: parseDcMessage(o.message).messageId, channel_id: channel } : undefined,
        user: channel === DM ? user : undefined,
        member: channel === DM ? undefined : { user },
      }
      if (channel !== DM) i.guild_id = GUILD
      await fake.emit('INTERACTION_CREATE', i)
    },
    async event(e: { type: string; who?: string; label?: string }) {
      if (e.type !== 'member-joined') throw new Error(`not provoked on Discord: ${e.type}`)
      await fake.emit('GUILD_MEMBER_ADD', { guild_id: GUILD, user: { id: e.who === 'owner' ? OWNER : STRANGER, username: e.label ?? 'x' } })
    },
  }
  return {
    chat,
    dm: dcDm(DM),
    home: dcChat(GUILD, LOBBY),
    otherHome: dcChat(GUILD, OTHER),
    owner: dcUser(OWNER),
    ghost: dcMsg(DM, '999999999999999999'),
    adapterFilters: true,
    out: () => fake.outs,
    fail: (kind, skip) => fake.fail(kind, skip),
    goneThread: (t) => {
      fake.gone.add(parseDcThread(t))
    },
    inject: inject as Rig['inject'],
    async close() {
      await chat.stop()
      globalThis.fetch = realFetch
    },
  }
}

// Cases the Discord rig cannot run, with the reason. Each is a platform fact, not a skipped check of the adapter.
chatContract('Discord', discordRig, {
  skip: {
    E8: 'Discord has no home move (guild ids never change) and no member-join event without the privileged GUILD_MEMBERS intent, which the bridge does not request (decision 9); the rights and webhook-post events are covered below',
    'E9:not-modified': 'Discord has no refusal for "already in that state": an unarchive of an open post succeeds, and toChatError has no code to map',
    E15: 'Discord has one upload kind: asPhoto is not on the wire, so the rig cannot observe it (images render inline); the size refusal (E15:cap) runs',
  },
})

// ---- Discord-specific cases ----

function discordFake(): { fake: FakeDiscord; make: (over?: { pairing?: unknown; secrets?: string[] }) => Promise<Discord> } {
  const fake = new FakeDiscord()
  seedGuild(fake)
  return {
    fake,
    make: async (over = {}) => {
      const chat = new Discord(fake, { ownerId: OWNER, dmChannelId: DM, secrets: over.secrets ?? [] })
      if (over.pairing) chat.setPairing(over.pairing as never)
      return chat
    },
  }
}

test('Discord index: a channel the gateway never announced is fetched once and cached', async () => {
  const { fake, make } = discordFake()
  const chat = await make()
  const extra = '900000000000000009'
  fake.channels.set(extra, { id: extra, type: ChannelType.GuildText, guild_id: GUILD, name: 'late' })
  await fake.emit('GUILD_CREATE', { id: GUILD, channels: [], threads: [] })
  const seen: Inbound[] = []
  chat.onInbound(async (m) => { seen.push(m) })
  const deliver = (text: string) => fake.emit('MESSAGE_CREATE', {
    id: fake.snow(), channel_id: extra, guild_id: GUILD, author: { id: OWNER, username: 'owner' }, content: text, type: 0, attachments: [], mentions: [],
  })
  await deliver('one')
  await deliver('two')
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(fake.calls.filter((c) => c.method === 'get' && c.route === `/channels/${extra}`).length, 1, 'one GET for the unknown channel')
  assert.deepEqual(seen.map((m) => m.chat), [{ kind: 'home', id: dcChat(GUILD, extra), thread: null }, { kind: 'home', id: dcChat(GUILD, extra), thread: null }])
})

test('Discord index: a thread created by the adapter is known without a fetch and carries its parent', async () => {
  const { fake, make } = discordFake()
  const chat = await make()
  await openGuild(fake)
  chat.setHome(dcChat(GUILD, LOBBY))
  const thread = await chat.createThread('topic')
  const gets = fake.calls.filter((c) => c.method === 'get' && c.route.startsWith('/channels/')).length
  await chat.sendText('in the post', { thread })
  assert.equal(fake.calls.filter((c) => c.method === 'get' && c.route.startsWith('/channels/')).length, gets, 'no channel fetch for a known post')
})

test('Discord press: the type-6 ack goes out before the handler; the toast is an ephemeral follow-up', async () => {
  const { fake, make } = discordFake()
  const chat = await make()
  const presses: ButtonPress[] = []
  chat.onButton(async (p) => { presses.push(p) })
  await fake.emit('INTERACTION_CREATE', {
    id: '555', token: 'tt', application_id: APP, type: 3, channel_id: DM, data: { custom_id: 'go', component_type: 2 },
    user: { id: OWNER }, message: { id: '777', channel_id: DM },
  })
  await new Promise((r) => setTimeout(r, 5))
  const ack = fake.calls.find((c) => c.route === '/interactions/555/tt/callback')
  assert.ok(ack, 'the interaction is acknowledged')
  assert.equal(ack.body.type, InteractionResponseType.DeferredMessageUpdate)
  assert.equal(ack.auth, false, 'the interaction token is the auth')
  assert.equal(presses.length, 1)
  assert.equal(presses[0]!.message, dcMsg(DM, '777'))
  await chat.ackButton('555', 'Done')
  const follow = fake.calls.find((c) => c.route === `/webhooks/${APP}/tt`)
  assert.ok(follow, 'the toast is a follow-up on the interaction token')
  assert.equal(follow.body.flags, MessageFlags.Ephemeral)
  assert.equal(follow.body.content, 'Done')
  await chat.ackButton('555')
  assert.equal(fake.calls.filter((c) => c.route === `/webhooks/${APP}/tt`).length, 1, 'no second toast')
})

test('Discord press: a stranger is acknowledged and dropped', async () => {
  const { fake, make } = discordFake()
  const chat = await make()
  const presses: ButtonPress[] = []
  chat.onButton(async (p) => { presses.push(p) })
  await fake.emit('INTERACTION_CREATE', {
    id: '556', token: 'ts', application_id: APP, type: 3, channel_id: DM, data: { custom_id: 'x', component_type: 2 },
    user: { id: STRANGER }, message: { id: '778', channel_id: DM },
  })
  await new Promise((r) => setTimeout(r, 5))
  assert.ok(fake.calls.some((c) => c.route === '/interactions/556/ts/callback'), 'acked so Discord does not fail it')
  assert.deepEqual(presses, [])
})

test('Discord folders: a stale forum-post id is thread-closed, never sent to; a folder channel takes a plain send', async () => {
  const { fake, make } = discordFake()
  const chat = await make()
  await openGuild(fake)
  chat.setHome(dcChat(GUILD, LOBBY))
  // A post of the old forum mode: a public thread under a forum channel (not a text channel under stolik).
  fake.channels.set('900000000000000007', { id: '900000000000000007', type: ChannelType.PublicThread, guild_id: GUILD, parent_id: '900000000000000008', name: 'old', thread_metadata: { archived: false } })
  await openGuild(fake)
  const stale = dcThread('900000000000000007')
  await assert.rejects(chat.sendText('late', { thread: stale }), (e: unknown) => e instanceof ChatError && e.kind === 'thread-closed')
  await assert.rejects(chat.reopenThread(stale), (e: unknown) => e instanceof ChatError && e.kind === 'thread-closed')
  assert.equal(fake.calls.filter((c) => c.method === 'post' && c.route.startsWith('/channels/900000000000000007')).length, 0, 'nothing reaches the old post')
  const id = await chat.sendText('in the folder', { thread: dcThread(FOLDER) })
  assert.ok(id.startsWith('dc:'))
})

test('Discord folders: a folder is a text channel under stolik; the category is made when missing, with the private overwrites', async () => {
  const { fake, make } = discordFake()
  fake.channels.delete(CATEGORY)
  fake.channels.delete(FOLDER)
  const chat = await make()
  await openGuild(fake)
  chat.setHome(dcChat(GUILD, LOBBY))
  const thread = await chat.createThread('parent/app')
  const cat = fake.created.find((c) => c.type === ChannelType.GuildCategory)
  const ch = fake.created.find((c) => c.type === ChannelType.GuildText)
  assert.equal(cat?.name, 'stolik')
  assert.equal(ch?.parent, cat?.id)
  assert.equal(ch?.name, 'parent-app')
  const overwrites = (fake.calls.find((c) => c.method === 'post' && c.route === `/guilds/${GUILD}/channels` && (c.body as any)?.type === ChannelType.GuildCategory)?.body as any).permission_overwrites
  const everyone = overwrites.find((o: any) => o.id === GUILD)
  assert.equal(everyone.deny, '1024', '@everyone cannot view the category')
  assert.ok(overwrites.some((o: any) => o.id === OWNER && o.type === 1), 'the owner gets an overwrite')
  assert.equal(thread, dcThread(ch!.id))
})

test('Discord folders: a full category (50 children) makes stolik 2, and the next folder goes there', async () => {
  const { fake, make } = discordFake()
  // The seeded folder is the 49th child: 48 more fill the category up to 49, so the first new folder takes the 50th.
  for (let i = 0; i < 48; i++) {
    const id = `9100000000000${String(i).padStart(4, '0')}`
    fake.channels.set(id, { id, type: ChannelType.GuildText, guild_id: GUILD, parent_id: CATEGORY, name: `c${i}` })
  }
  const chat = await make()
  await openGuild(fake)
  chat.setHome(dcChat(GUILD, LOBBY))
  await chat.createThread('first')
  assert.equal(fake.created.filter((c) => c.type === ChannelType.GuildText)[0]?.parent, CATEGORY, 'the 50th child fits')
  await chat.createThread('second')
  const made = fake.created.filter((c) => c.type === ChannelType.GuildCategory)
  assert.deepEqual(made.map((c) => c.name), ['stolik 2'])
  assert.equal(fake.created.filter((c) => c.type === ChannelType.GuildText)[1]?.parent, made[0]!.id)
})

test('Discord folders: at the server cap (30013) a folder is refused as quota, once with a notice to the lobby', async () => {
  const { fake, make } = discordFake()
  fake.guildCap = 3
  const chat = await make()
  await openGuild(fake)
  chat.setHome(dcChat(GUILD, LOBBY))
  for (const n of ['a', 'b']) await chat.createThread(n).catch(() => undefined)
  await assert.rejects(chat.createThread('c'), (e: unknown) => e instanceof ChatError && e.kind === 'quota')
  await assert.rejects(chat.createThread('d'), (e: unknown) => e instanceof ChatError && e.kind === 'quota')
  const notices = fake.outs.filter((o) => o.op === 'send' && String(o.text).includes("Discord's limit"))
  assert.equal(notices.length, 1, 'one notice per run')
})

test('Discord start: with every right in the lobby and the forum, the home is access ok', async () => {
  const { fake, make } = discordFake()
  const chat = await make()
  const events: ChatEvent[] = []
  chat.onChatEvent(async (e) => { events.push(e) })
  chat.setHome(dcChat(GUILD, LOBBY))
  await start(fake, chat)
  assert.deepEqual(events.map((e) => (e as { access?: string }).access), ['ok'])
})

test('Discord start: a missing right in the lobby is access lost, and the reason names it', async () => {
  const { fake, make } = discordFake()
  fake.everyone = BOT_PERMS & ~32768n
  const chat = await make()
  const events: ChatEvent[] = []
  chat.onChatEvent(async (e) => { events.push(e) })
  chat.setHome(dcChat(GUILD, LOBBY))
  await start(fake, chat)
  const lost = events.find((e) => e.type === 'access') as { access: string; reason: string }
  assert.equal(lost.access, 'lost')
  assert.match(lost.reason, /Attach Files/)
  assert.match(lost.reason, /lobby/)
})

async function start(fake: FakeDiscord, chat: Discord): Promise<void> {
  void chat
  await fake.emit('READY', { user: { id: BOT } })
  await new Promise((r) => setTimeout(r, 20))
}

test('Discord start: a channel overwrite that denies the bot in the lobby is access lost', async () => {
  const { fake, make } = discordFake()
  fake.channels.get(LOBBY).permission_overwrites = [{ id: GUILD, type: 0, allow: '0', deny: '2048' }]
  const chat = await make()
  const events: ChatEvent[] = []
  chat.onChatEvent(async (e) => { events.push(e) })
  chat.setHome(dcChat(GUILD, LOBBY))
  await start(fake, chat)
  const lost = events.find((e) => e.type === 'access') as { access: string; reason: string }
  assert.equal(lost.access, 'lost')
  assert.match(lost.reason, /Send Messages/)
})

test('Discord home: removal of the bound server is access lost; an outage is not', async () => {
  const { fake, make } = discordFake()
  const chat = await make()
  const events: ChatEvent[] = []
  chat.onChatEvent(async (e) => { events.push(e) })
  chat.setHome(dcChat(GUILD, LOBBY))
  await fake.emit('GUILD_DELETE', { id: GUILD, unavailable: true })
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(events, [], 'an outage is not an access event')
  await fake.emit('GUILD_DELETE', { id: GUILD })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(events.length, 1)
  assert.deepEqual(events[0], { type: 'access', chat: dcChat(GUILD, LOBBY), access: 'lost', reason: 'the bot was removed from the server' })
})

test('Discord home: a webhook post in the home is an unattributable post; a stranger is dropped', async () => {
  const { fake, make } = discordFake()
  const chat = await make()
  const events: ChatEvent[] = []
  const inbound: Inbound[] = []
  chat.onChatEvent(async (e) => { events.push(e) })
  chat.onInbound(async (m) => { inbound.push(m) })
  await fake.emit('MESSAGE_CREATE', {
    id: fake.snow(), channel_id: LOBBY, guild_id: GUILD, webhook_id: '123', author: { id: '124', username: 'hook', bot: true }, content: 'as the server', type: 0, attachments: [], mentions: [],
  })
  await fake.emit('MESSAGE_CREATE', {
    id: fake.snow(), channel_id: LOBBY, guild_id: GUILD, author: { id: STRANGER, username: 'stranger' }, content: 'hi', type: 0, attachments: [], mentions: [],
  })
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(events, [{ type: 'unattributable-post', chat: dcChat(GUILD, LOBBY) }])
  assert.deepEqual(inbound, [])
})

test('Discord pairing: a DM from a stranger with the code pairs; the reply says so; other text is not an inbound', async () => {
  const { fake, make } = discordFake()
  const paired: Array<{ userId: string; name: string; username: string | null }> = []
  const attempts: string[] = []
  const chat = await make({
    pairing: {
      attempt: (text: string) => { attempts.push(text); return text === '123456' ? 'paired' : 'wrong' },
      paired: (who: { userId: string; name: string; username: string | null }) => { paired.push(who) },
    },
  })
  const inbound: Inbound[] = []
  chat.onInbound(async (m) => { inbound.push(m) })
  const dm = (id: string, content: string) => fake.emit('MESSAGE_CREATE', {
    id, channel_id: DM, author: { id: STRANGER, username: 'stranger', global_name: 'Stranger' }, content, type: 0, attachments: [], mentions: [],
  })
  await dm(fake.snow(), 'hello?')
  await dm(fake.snow(), '123456')
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(attempts, ['hello?', '123456'])
  assert.deepEqual(paired, [{ userId: STRANGER, name: 'Stranger', username: 'stranger' }])
  assert.ok(fake.outs.some((o) => o.op === 'send' && o.text === 'Paired.'), 'the stranger is told')
  assert.deepEqual(inbound, [])
})

test('Discord sendFile: the upload is one multipart POST with the file name; mentions are empty', async () => {
  const { fake, make } = discordFake()
  const chat = await make()
  const dir = join(ISOLATED_ROOT, 'discord-upload')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'report.txt')
  writeFileSync(path, 'data')
  chat.setHome(dcChat(GUILD, LOBBY))
  const id = await chat.sendFile(path, false, { silent: true })
  const post = fake.calls.find((c) => c.method === 'post' && c.route === `/channels/${LOBBY}/messages`)
  assert.equal(post?.files?.[0]?.name, 'report.txt')
  assert.deepEqual(post?.body.allowed_mentions, { parse: [] })
  assert.equal(post?.body.flags, MessageFlags.SuppressNotifications)
  assert.ok(id.startsWith(`dc:${LOBBY}:`), 'the message is in the lobby')
  rmSync(path, { force: true })
})

test('Discord secrets: the bot token never reaches a send', async () => {
  const { fake, make } = discordFake()
  const chat = await make({ secrets: [SECRET] })
  await chat.sendText(`token ${SECRET} inside`, { dm: true })
  const sent = fake.outs.find((o) => o.op === 'send')
  assert.ok(sent && sent.op === 'send' && !sent.text.includes(SECRET), 'the token is redacted')
})

test('Discord reactions: a folder channel takes the reaction with no unarchive or move first', async () => {
  const { fake, make } = discordFake()
  const chat = await make()
  await openGuild(fake)
  chat.setHome(dcChat(GUILD, LOBBY))
  const thread = await chat.createThread('topic')
  const id = await chat.sendText('react', { thread })
  fake.calls.length = 0
  await chat.react(id, 'seen')
  assert.equal(fake.calls.filter((c) => c.method === 'patch').length, 0, 'no patch on a reaction')
  assert.equal(fake.calls.length, 1)
})
