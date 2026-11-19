// The Discord adapter (plan 23 §2; research/d1-brief.md decisions 2-10, batch D4). It implements ChatPort over an
// injected client (raw REST and gateway, see DiscordClient) and keeps the in-memory channel index that tells a folder
// channel (a text channel under a stolik category) from a lobby message. The pure mapping lives in discord-map.ts; the ids in dc-ids.ts. The real client is built
// by createDiscordClient, which loads @discordjs/* only when called (chat.app 'discord'): nothing here imports them at
// the top, so the Telegram path never loads them.
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import {
  ChannelType,
  InteractionResponseType,
  RESTJSONErrorCodes,
  InteractionType,
  MessageFlags,
  type APIChannel,
  type APIInteraction,
  type APIMessage,
  type APIMessageComponentInteraction,
  type GatewayGuildCreateDispatchData,
  type GatewayGuildDeleteDispatchData,
  type GatewayMessageCreateDispatchData,
} from 'discord-api-types/v10'
import { ChatError, type Capabilities, type ChatEvent, type ChatId, type ButtonPress, type ChatPort, type ChatRef, type Inbound, type MessageId, type PermKeyboard, type Priority, type ReactKind, type SendTarget, type ThreadId } from '../../brain/chat-types.ts'
import type { Check } from '../../brain/observe.ts'
import { ChunkSendError } from '../../brain/outbound-queue.ts'
import type { Verdict } from '../../brain/pairing.ts'
import { permissionButtons, redact, type Rows } from '../../router/state.ts'
import { errMsg, log } from '../../router/log.ts'
import { compareMessages as compareDcMessages, dcMsg, dcThread, dcUser, parseDcChat, parseDcMessage, parseDcThread } from './dc-ids.ts'
import { EVERYONE_DENY_BITS, FOLDER_ALLOW_BITS, FOLDER_EXTRA_PERMS, LOBBY_PERMS, fetchChannelPerms, missingPerms } from './discord-perms.ts'
import { checkDiscordPrivacy, memberCount } from './discord-privacy.ts'
import {
  DISCORD_CAPABILITIES,
  FOLDER_CATEGORY_ACTIVE,
  FOLDER_CATEGORY_IDLE,
  FOLDER_CHANNELS_PER_CATEGORY,
  chatRefOf,
  contentOf,
  editBody,
  folderCategoryKind,
  folderChannelName,
  inboundOf,
  isFolderChannel,
  isOwnerMessage,
  messageBody,
  toChatError,
  type ChannelInfo,
  type HomeBinding,
} from './discord-map.ts'

// A folder goes idle this long after its last session ends (decision 2 of the grill: not at once). Owner may veto.
export const DISCORD_IDLE_DELAY_MS = 2 * 60 * 1000
// The server's channel count at which the owner gets one warning, and the cap Discord enforces (error 30013).
const FOLDER_WARN_CHANNELS = 450
const GUILD_CHANNEL_CAP = 500
// A category or folder move that Discord rate-limits is not waited for past this: the REST queue finishes it later.
const MOVE_WAIT_MS = 3000
const TOPIC_CHARS = 1024
// A button press is answered within 15 minutes (decision 6: the interaction token's lifetime).
const PRESS_TTL_MS = 15 * 60 * 1000
const KEYBOARD_LIST_MAX = 200
const TRACKED_MESSAGES = 5000
const DOWNLOAD_TIMEOUT_MS = 60_000
// The server's member count is re-read this often; growth raises the stranger alert (no GUILD_MEMBERS intent: no join events).
export const MEMBER_RECHECK_MS = 60 * 60 * 1000
// The toast after a press is short; longer texts are cut.
const TOAST_CHARS = 200
const THREAD_TYPES = new Set<number>([ChannelType.PublicThread, ChannelType.AnnouncementThread, ChannelType.PrivateThread])
const CATEGORY_KINDS = ['active', 'idle'] as const
type CategoryKind = (typeof CATEGORY_KINDS)[number]
// The reaction for each kind (the brain's ReactKind). Unicode emoji, which Discord takes without a custom emoji.
export const DISCORD_REACTION_EMOJI: Record<ReactKind, string> = { seen: '👀', queued: '✍️', held: '😴' }

// The REST calls the adapter makes. `route` is the REST path without the API version ('/channels/1/messages').
// `auth: false` marks the interaction endpoints, which use the interaction token and no bot token.
export type DcRequest = { body?: unknown; files?: Array<{ name: string; data: Buffer }>; auth?: boolean; query?: URLSearchParams }
export type DcRest = {
  get(route: string, o?: DcRequest): Promise<unknown>
  post(route: string, o?: DcRequest): Promise<unknown>
  patch(route: string, o?: DcRequest): Promise<unknown>
  put(route: string, o?: DcRequest): Promise<unknown>
  delete(route: string, o?: DcRequest): Promise<unknown>
}
// The gateway as the adapter reads it: gateway events by their name (MESSAGE_CREATE), each with its data.
export type DcGateway = {
  on(event: string, fn: (data: unknown) => void | Promise<void>): void
  connect(): Promise<void>
  destroy(): Promise<void>
}
export type DiscordClient = { rest: DcRest; gateway: DcGateway }

// Pairing as the sender gate sees it (brain/pairing.ts; the same shape as the Telegram hook).
export type DiscordPairing = {
  attempt(text: string): Verdict
  paired(who: { userId: string; name: string; username: string | null }): void
}

// The timers the adapter uses (the router's systemClock in production; a fake in tests). Without one, no hourly re-check.
export type DiscordClock = { setRepeating(fn: () => void, ms: number): unknown; clearTimer(handle: unknown): void }

export type DiscordOptions = {
  clock?: DiscordClock
  // The owner's user snowflake; null until a pairing sets it (then only a pairing code gets through).
  ownerId?: string | null
  // The owner's DM channel, when known. Otherwise it is opened once, on the first DM send.
  dmChannelId?: string | null
  // The bound home (`dc:g<guild>:l<lobby>`), or none.
  homeId?: ChatId | null
  // Strings never to show in a send (the bot token).
  secrets?: string[]
  now?: () => number
  // The wait before a folder moves to idle (default DISCORD_IDLE_DELAY_MS; 0 moves at once).
  idleDelayMs?: number
}

type SendOpts = { replyTo?: MessageId; perm?: PermKeyboard; rows?: Rows; silent?: boolean; format?: 'markdown' } & SendTarget
type IndexedChannel = { id: string; type: number; name?: string; guild_id?: string; parent_id?: string | null }

// Clips a text to `max` UTF-16 units without splitting a code point.
export function clipChars(s: string, max: number): string {
  let out = ''
  for (const ch of s) {
    if (out.length + ch.length > max) break
    out += ch
  }
  return out
}

// The channel index entry of one channel object (GUILD_CREATE, CHANNEL_*, THREAD_*, or a GET /channels reply).
function infoOf(c: IndexedChannel, guildId?: string): ChannelInfo {
  return {
    type: c.type as ChannelType,
    parentId: c.parent_id ?? null,
    guildId: c.guild_id ?? guildId ?? null,
    name: c.name ?? null,
  }
}

// The category kind's number: `stolik 3` is 3, the plain name 1.
function numberOf(name: string): number {
  const m = / (\d+)$/.exec(name)
  return m ? Number(m[1]) : 1
}

// Discord's answer for a full category (50035, an invalid form body), and for the server's channel cap (30013).
function codeOf(e: unknown): number | undefined {
  const c = (e as { code?: unknown } | null)?.code
  return typeof c === 'number' ? c : undefined
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
  })
}

// Runs a REST promise and maps its failure to a ChatError at the boundary. `thread` says the call named a thread.
function boundary<T>(p: Promise<unknown>, thread = false): Promise<T> {
  return p.then(
    (v) => v as T,
    (e: unknown) => {
      throw toChatError(e, { thread })
    },
  )
}

// The button rows of a permission request (the same buttons the Telegram adapter shows).
function permRows(p: PermKeyboard): Rows {
  return [permissionButtons(p.requestId, p).map((b) => ({ text: b.text, data: b.data }))]
}

export class Discord implements ChatPort {
  readonly capabilities: Capabilities = DISCORD_CAPABILITIES
  private readonly client: DiscordClient
  private ownerId: string | null
  private dmChannelId: string | null
  private pairing: DiscordPairing | null = null
  // The bound home: the chat id the brain stores, and its parsed binding (the lobby).
  private groupId: ChatId | null = null
  private binding: HomeBinding | null = null
  // The bot's own user id (READY); the permission checks need it.
  private botId: string | null = null
  // The bot's effective rights in the bound lobby (READY check); the category overwrites grant no more than these.
  private botLobbyPerms: bigint | null = null
  // One lock for "pick a category, then create or move a folder": two folders never pick the same full category.
  private folderLock: Promise<void> = Promise.resolve()
  // Idle moves waiting for the delay (channel id -> timer): a reopen before it fires cancels the move.
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly idleDelayMs: number
  // Owner notices sent once per run (the channel cap, the warning).
  private readonly noticed = new Set<string>()
  // Channels the adapter has seen, by id (decision 3). Filled from gateway events and from GET /channels on a miss.
  private readonly index = new Map<string, ChannelInfo>()
  // Which chat each recent message is in (true: the owner's DM).
  private readonly sentDm = new Map<MessageId, boolean>()
  // Messages that carry buttons the bot sent (messageId -> in the DM).
  private readonly keyboards = new Map<MessageId, boolean>()
  // Button presses waiting for their toast: pressId (the interaction id) -> the interaction token.
  private readonly presses = new Map<string, { token: string; appId: string; at: number }>()
  // Inbound handling per chat and topic runs in order.
  private readonly serial = new Map<string, Promise<void>>()
  private readonly clock: DiscordClock | null
  private memberTimer: unknown = null
  // The member count last read for the bound server (null: not read since the bind).
  private membersSeen: number | null = null
  private readonly secrets: string[]
  private readonly now: () => number
  private inboundCb: ((m: Inbound) => Promise<void>) | null = null
  private callbackCb: ((c: ButtonPress) => Promise<void>) | null = null
  private chatEventCb: ((e: ChatEvent) => Promise<void>) | null = null
  private startedCb: (() => void) | null = null
  private keyboardsCb: ((list: Array<{ messageId: MessageId; dm: boolean }>) => void) | null = null

  constructor(client: DiscordClient, opts: DiscordOptions = {}) {
    this.client = client
    this.ownerId = opts.ownerId ?? null
    this.dmChannelId = opts.dmChannelId ?? null
    this.secrets = (opts.secrets ?? []).filter((s) => s.length > 0)
    this.now = opts.now ?? Date.now
    this.clock = opts.clock ?? null
    this.idleDelayMs = opts.idleDelayMs ?? DISCORD_IDLE_DELAY_MS
    this.setHome(opts.homeId ?? null)
    const g = client.gateway
    g.on('READY', (d) => {
      this.botId = (d as { user?: { id?: string } }).user?.id ?? null
      void this.checkHome()
      if (this.clock !== null) void this.recheckMembers()
      this.startedCb?.()
    })
    g.on('GUILD_CREATE', (d) => {
      this.onGuildCreate(d as GatewayGuildCreateDispatchData)
      if (this.binding !== null && (d as { id: string }).id === this.binding.guildId) void this.checkHome()
    })
    g.on('GUILD_DELETE', (d) => this.onGuildDelete(d as GatewayGuildDeleteDispatchData))
    for (const ev of ['CHANNEL_CREATE', 'CHANNEL_UPDATE', 'THREAD_CREATE', 'THREAD_UPDATE']) {
      g.on(ev, (d) => this.indexChannel(d as IndexedChannel))
    }
    for (const ev of ['CHANNEL_DELETE', 'THREAD_DELETE']) {
      g.on(ev, (d) => {
        this.index.delete((d as { id: string }).id)
      })
    }
    g.on('THREAD_LIST_SYNC', (d) => {
      for (const t of (d as { threads: IndexedChannel[] }).threads) this.indexChannel(t)
    })
    g.on('MESSAGE_CREATE', (d) => this.onMessage(d as GatewayMessageCreateDispatchData))
    g.on('INTERACTION_CREATE', (d) => this.onInteraction(d as APIInteraction))
  }

  // ---- owner, pairing, events ----

  // Makes `userId` the owner from now on (after the owner confirmed a pairing).
  setOwnerUserId(userId: string | null): void {
    this.ownerId = userId
  }

  setPairing(hook: DiscordPairing | null): void {
    this.pairing = hook
  }

  onInbound(fn: (m: Inbound) => Promise<void>): void {
    this.inboundCb = fn
  }

  onButton(fn: (c: ButtonPress) => Promise<void>): void {
    this.callbackCb = fn
  }

  onChatEvent(fn: (e: ChatEvent) => Promise<void>): void {
    this.chatEventCb = fn
  }

  onStarted(fn: () => void): void {
    this.startedCb = fn
  }

  onLiveButtons(fn: (list: Array<{ messageId: MessageId; dm: boolean }>) => void): void {
    this.keyboardsCb = fn
  }

  private emitChatEvent(e: ChatEvent): void {
    if (this.chatEventCb) this.chatEventCb(e).catch((err: unknown) => log(`chat event error: ${errMsg(err)}`))
  }

  // ---- the channel index (decision 3) ----

  private indexChannel(c: IndexedChannel, guildId?: string): void {
    this.index.set(c.id, infoOf(c, guildId))
  }

  // The index entry of a channel; a miss is fetched once and cached, with its category when that is unknown too.
  // Undefined when Discord does not answer (gone).
  private async channelInfo(channelId: string): Promise<ChannelInfo | undefined> {
    const hit = this.index.get(channelId)
    if (hit) return hit
    try {
      const c = (await this.client.rest.get(`/channels/${channelId}`)) as IndexedChannel
      this.indexChannel(c)
      if (c.parent_id && !this.index.has(c.parent_id)) {
        try {
          this.indexChannel((await this.client.rest.get(`/channels/${c.parent_id}`)) as IndexedChannel)
        } catch {
          // The category stays unknown: the channel then maps as other.
        }
      }
      return this.index.get(channelId)
    } catch {
      return undefined
    }
  }

  private onGuildCreate(g: GatewayGuildCreateDispatchData): void {
    for (const c of g.channels ?? []) this.indexChannel(c as IndexedChannel, g.id)
    for (const t of g.threads ?? []) this.indexChannel(t as IndexedChannel, g.id)
  }

  // The bound server is gone (kicked, or deleted): the bot can no longer reach the home. An outage (unavailable) is not.
  private onGuildDelete(d: GatewayGuildDeleteDispatchData): void {
    if (d.unavailable) return
    for (const [id, info] of this.index) if (info.guildId === d.id) this.index.delete(id)
    if (this.binding?.guildId === d.id && this.groupId !== null) {
      this.emitChatEvent({ type: 'access', chat: this.groupId, access: 'lost', reason: 'the bot was removed from the server' })
    }
  }

  // ---- inbound ----

  private async onMessage(msg: GatewayMessageCreateDispatchData): Promise<void> {
    if (msg.guild_id) await this.channelInfo(msg.channel_id)
    const chat = chatRefOf(msg, this.binding, (id) => this.index.get(id))
    const owner = this.ownerId ?? ''
    if (!isOwnerMessage(msg, owner)) {
      // A webhook post in the home has no attributable sender (decision 9).
      if (msg.webhook_id !== undefined && chat.kind === 'home') {
        this.emitChatEvent({ type: 'unattributable-post', chat: chat.id })
      } else if (!msg.guild_id && msg.author.bot !== true && this.pairing && msg.content.length > 0) {
        await this.pairAttempt(msg)
      }
      return
    }
    const inbound = inboundOf(msg, chat, owner)
    if (!inbound) return
    this.rememberChat(inbound.messageId, chat.kind === 'dm')
    this.receive(chat, inbound)
  }

  // A DM from someone other than the owner while pairing is on: the text may be the pairing code (decision 10).
  private async pairAttempt(msg: GatewayMessageCreateDispatchData): Promise<void> {
    if (!this.pairing || this.pairing.attempt(msg.content) !== 'paired') return
    await boundary(this.client.rest.post(`/channels/${msg.channel_id}/messages`, { body: { content: 'Paired.', allowed_mentions: { parse: [] } } })).catch(() => {})
    this.pairing.paired({ userId: msg.author.id, name: msg.author.global_name ?? msg.author.username, username: msg.author.username ?? null })
  }

  private receive(chat: ChatRef, inbound: Inbound): void {
    if (!this.inboundCb) return
    const key = `${chat.id}|${chat.thread ?? ''}`
    const prev = this.serial.get(key) ?? Promise.resolve()
    const next: Promise<void> = prev
      .then(() => this.inboundCb?.(inbound))
      .catch((e: unknown) => log(`inbound error: ${errMsg(e)}`))
      .finally(() => {
        if (this.serial.get(key) === next) this.serial.delete(key)
      })
    this.serial.set(key, next)
  }

  // A button press. The adapter acknowledges it at once (type 6, deferred update: Discord's 3 s deadline), so the
  // toast comes later as an ephemeral follow-up (ackButton). Presses from anyone but the owner are acked and dropped.
  private async onInteraction(i: APIInteraction): Promise<void> {
    if (i.type !== InteractionType.MessageComponent) return
    const press = i as APIMessageComponentInteraction
    const data = press.data as { custom_id?: unknown }
    if (typeof data.custom_id !== 'string') return
    void boundary(
      this.client.rest.post(`/interactions/${i.id}/${i.token}/callback`, {
        body: { type: InteractionResponseType.DeferredMessageUpdate },
        auth: false,
      }),
    ).catch((e: unknown) => log(`button ack failed: ${errMsg(e)}`))
    const user = press.member?.user ?? press.user
    if (!user || this.ownerId === null || user.id !== this.ownerId) return
    if (press.guild_id) await this.channelInfo(press.channel_id)
    const chat = chatRefOf({ channel_id: press.channel_id, guild_id: press.guild_id }, this.binding, (id) => this.index.get(id))
    this.prunePresses()
    this.presses.set(i.id, { token: i.token, appId: i.application_id, at: this.now() })
    if (this.callbackCb) {
      this.callbackCb({
        pressId: i.id,
        data: data.custom_id,
        message: press.message ? dcMsg(press.channel_id, press.message.id) : null,
        from: dcUser(user.id),
        chat,
      }).catch((e: unknown) => log(`button error: ${errMsg(e)}`))
    }
  }

  private prunePresses(): void {
    const now = this.now()
    for (const [id, p] of this.presses) if (now - p.at > PRESS_TTL_MS) this.presses.delete(id)
  }

  // ---- home and folders ----

  setHome(groupId: ChatId | null): void {
    this.groupId = groupId
    if (groupId === null) {
      this.binding = null
      this.membersSeen = null
      return
    }
    const { guildId, channelId } = parseDcChat(groupId)
    if (this.binding?.guildId === guildId && this.binding.lobbyId === channelId) return
    this.binding = { guildId, lobbyId: channelId }
    this.membersSeen = null
    void this.checkHome()
  }

  // The bot's rights in the bound lobby (the replies, and the rights the folder channels need), read at READY, on
  // GUILD_CREATE of the bound server and on setHome. A failure is `access lost` with the reason (the missing permission
  // names, or why the lobby cannot be read); a pass is `access ok`. Nothing is sent when the bot id is not known yet.
  private async checkHome(): Promise<void> {
    const b = this.binding
    const home = this.groupId
    if (b === null || home === null || this.botId === null) return
    const botId = this.botId
    let reason: string | null = null
    try {
      const lobby = await fetchChannelPerms(this.client.rest, b.guildId, b.lobbyId, botId)
      this.botLobbyPerms = lobby
      const missing = missingPerms(lobby, LOBBY_PERMS)
      if (missing.length > 0) reason = `the bot lacks ${missing.join(', ')} in the lobby channel`
      else {
        const extra = missingPerms(lobby, FOLDER_EXTRA_PERMS)
        if (extra.length > 0) reason = `the bot lacks ${extra.join(', ')} in the lobby channel (the folder channels need them)`
      }
    } catch (e) {
      reason = `the lobby channel cannot be read: ${errMsg(e)}`
    }
    this.emitChatEvent({ type: 'access', chat: home, access: reason === null ? 'ok' : 'lost', reason: reason ?? '' })
  }

  // The privacy checks of the bound home (decision 12), for the router's start-up report. Null home: the app checks only.
  privacyChecks(): Promise<Check[]> {
    const b = this.binding
    return checkDiscordPrivacy({ rest: this.client.rest, home: b === null ? null : { guildId: b.guildId, lobbyId: b.lobbyId } })
  }

  // Re-reads the bound server's member count. The first read sets the baseline silently; a later rise raises the stranger
  // alert (a stranger-joined event in the home) and moves the baseline. A failed read is logged and waits for the next hour.
  private async recheckMembers(): Promise<void> {
    const b = this.binding
    const home = this.groupId
    if (b === null || home === null) return
    let n: number | null
    try {
      n = await memberCount(this.client.rest, b.guildId)
    } catch (e) {
      log(`member count not checked: ${errMsg(e)}`)
      return
    }
    if (n === null) return
    const before = this.membersSeen
    this.membersSeen = n
    if (before !== null && n > before) {
      this.emitChatEvent({ type: 'stranger-joined', chat: home, label: `a member who is not the owner (the server now has ${n})` })
    }
  }

  homeLink(): string | null {
    if (this.binding === null) return null
    return `https://discord.com/channels/${this.binding.guildId}/${this.binding.lobbyId}`
  }

  // ---- targets ----

  // The owner's DM channel: given, or opened once with POST /users/@me/channels.
  private async dm(): Promise<string> {
    if (this.dmChannelId !== null) return this.dmChannelId
    if (this.ownerId === null) throw new Error('no owner is paired')
    const ch = await boundary<APIChannel>(this.client.rest.post('/users/@me/channels', { body: { recipient_id: this.ownerId } }))
    this.dmChannelId = ch.id
    return ch.id
  }

  // The channel a send goes to: the thread when named, else the DM when asked or with no home, else the lobby.
  private async targetChannel(target: SendTarget = {}): Promise<string> {
    if (target.thread !== undefined) return parseDcThread(target.thread)
    if (target.dm || this.binding === null) return this.dm()
    return this.binding.lobbyId
  }

  // Whether a channel is a folder channel of the bound server (its thread error kind is thread-closed).
  private isThread(channelId: string): boolean {
    return this.binding !== null && isFolderChannel(this.index.get(channelId), this.binding.guildId, (id) => this.index.get(id))
  }

  // A thread id that is not a folder channel (a former forum post, a channel moved out of the stolik categories, a
  // deleted channel) is thread-closed, so the router makes a new folder channel for it (stale ids recover).
  private async requireFolder(channelId: string): Promise<void> {
    const info = await this.channelInfo(channelId)
    const b = this.binding
    if (b === null || !isFolderChannel(info, b.guildId, (id) => this.index.get(id))) {
      throw new ChatError('thread-closed', 'that channel is not a folder channel of the bound server any more')
    }
  }

  private requireBinding(): HomeBinding {
    if (this.binding === null) throw new Error('no server is bound')
    return this.binding
  }

  private clean(text: string): string {
    return redact(text, this.secrets)
  }

  // ---- messages in memory ----

  private rememberChat(messageId: MessageId, dm: boolean): void {
    this.sentDm.delete(messageId)
    this.sentDm.set(messageId, dm)
    if (this.sentDm.size > TRACKED_MESSAGES) this.sentDm.delete(this.sentDm.keys().next().value as MessageId)
  }

  isDm(messageId: MessageId): boolean | undefined {
    return this.sentDm.get(messageId)
  }

  compareMessages(a: MessageId, b: MessageId): number {
    return compareDcMessages(a, b)
  }

  private trackKeyboard(messageId: MessageId, dm: boolean, on: boolean): void {
    const before = this.keyboards.size
    if (on) {
      this.keyboards.delete(messageId)
      this.keyboards.set(messageId, dm)
      while (this.keyboards.size > KEYBOARD_LIST_MAX) this.keyboards.delete(this.keyboards.keys().next().value as MessageId)
    } else if (!this.keyboards.delete(messageId)) return
    if (this.keyboards.size !== before || on) {
      this.keyboardsCb?.([...this.keyboards].map(([id, d]) => ({ messageId: id, dm: d })))
    }
  }

  // ---- outbound ----

  async sendText(text: string, opts: SendOpts = {}): Promise<MessageId> {
    const channel = await this.targetChannel(opts)
    const thread = opts.thread !== undefined
    if (thread) await this.requireFolder(channel)
    const rows = opts.perm ? permRows(opts.perm) : opts.rows
    const replyTo = opts.replyTo ? parseDcMessage(opts.replyTo) : undefined
    const body = messageBody(this.clean(text), {
      format: opts.format,
      silent: opts.silent,
      replyTo: replyTo ? { channelId: replyTo.channelId, messageId: replyTo.messageId } : null,
      rows,
    })
    const msg = await boundary<APIMessage>(this.client.rest.post(`/channels/${channel}/messages`, { body }), thread)
    const id = dcMsg(channel, msg.id)
    this.afterSend(id, channel, rows)
    return id
  }

  private afterSend(id: MessageId, channel: string, rows: Rows | undefined): void {
    const dm = channel === this.dmChannelId
    this.rememberChat(id, dm)
    if (rows && rows.length > 0) this.trackKeyboard(id, dm, true)
  }

  async sendChunks(
    texts: readonly string[],
    opts: { silent?: boolean; priority?: Priority; replyTo?: MessageId; rows?: Rows; format?: 'markdown' } & SendTarget = {},
  ): Promise<MessageId[]> {
    const { priority: _priority, replyTo, rows, ...rest } = opts
    const ids: MessageId[] = []
    for (let i = 0; i < texts.length; i++) {
      try {
        ids.push(
          await this.sendText(texts[i]!, {
            ...rest,
            ...(i === 0 && replyTo !== undefined ? { replyTo } : {}),
            ...(i === texts.length - 1 && rows ? { rows } : {}),
          }),
        )
      } catch (e) {
        throw new ChunkSendError(e, ids)
      }
    }
    return ids
  }

  async typing(target: SendTarget = {}): Promise<void> {
    const channel = await this.targetChannel(target)
    if (target.thread !== undefined) await this.requireFolder(channel)
    await boundary(this.client.rest.post(`/channels/${channel}/typing`), target.thread !== undefined)
  }

  // One upload kind on Discord: a photo is an image attachment, rendered inline. Files over the cap are refused here.
  async sendFile(path: string, _asPhoto: boolean, target: SendTarget & { silent?: boolean } = {}): Promise<MessageId> {
    const size = (await stat(path)).size
    if (size > this.capabilities.files.maxUploadBytes) {
      throw new ChatError('too-long', `file is ${size} bytes; Discord allows ${this.capabilities.files.maxUploadBytes}`)
    }
    const channel = await this.targetChannel(target)
    if (target.thread !== undefined) await this.requireFolder(channel)
    const data = await readFile(path)
    const body = { allowed_mentions: { parse: [] }, ...(target.silent ? { flags: MessageFlags.SuppressNotifications } : {}) }
    const msg = await boundary<APIMessage>(
      this.client.rest.post(`/channels/${channel}/messages`, { body, files: [{ name: basename(path), data }] }),
      target.thread !== undefined,
    )
    const id = dcMsg(channel, msg.id)
    this.afterSend(id, channel, undefined)
    return id
  }

  // ---- folder channels (decisions 1-3, 5-7) ----

  // Runs fn after the previous folder operation: one lock for "pick a category, then create or move" (decision 2).
  private withFolderLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.folderLock.then(fn)
    this.folderLock = run.then(() => undefined, () => undefined)
    return run
  }

  // The categories of a kind in the bound server, lowest number first.
  private categoriesOf(guildId: string, kind: CategoryKind): Array<{ id: string; name: string; n: number }> {
    const out: Array<{ id: string; name: string; n: number }> = []
    for (const [id, info] of this.index) {
      if (info.type !== ChannelType.GuildCategory || info.guildId !== guildId) continue
      if (folderCategoryKind(info.name) !== kind) continue
      out.push({ id, name: info.name ?? '', n: numberOf(info.name ?? '') })
    }
    return out.sort((a, b) => a.n - b.n)
  }

  // The channels in a category, as the index knows them (the owner's own channels there count too).
  private childCount(categoryId: string): number {
    let n = 0
    for (const info of this.index.values()) if (info.parentId === categoryId) n++
    return n
  }

  // The server's channels (threads do not count toward the cap).
  private guildChannelCount(guildId: string): number {
    let n = 0
    for (const info of this.index.values()) if (info.guildId === guildId && !THREAD_TYPES.has(info.type)) n++
    return n
  }

  // The lowest-numbered category of the kind with room; a new category (the next free number) when all are full or
  // excluded. Runs under the folder lock.
  private async pickCategory(guildId: string, kind: CategoryKind, exclude: ReadonlySet<string>): Promise<string> {
    for (const c of this.categoriesOf(guildId, kind)) {
      if (!exclude.has(c.id) && this.childCount(c.id) < FOLDER_CHANNELS_PER_CATEGORY) return c.id
    }
    const base = kind === 'active' ? FOLDER_CATEGORY_ACTIVE : FOLDER_CATEGORY_IDLE
    const taken = new Set(this.categoriesOf(guildId, kind).map((c) => c.name))
    let name = base
    for (let n = 2; taken.has(name); n++) name = `${base} ${n}`
    const cat = await boundary<APIChannel>(
      this.client.rest.post(`/guilds/${guildId}/channels`, {
        body: { name, type: ChannelType.GuildCategory, permission_overwrites: this.overwrites(guildId) },
      }),
    )
    this.indexChannel(cat as IndexedChannel, guildId)
    return cat.id
  }

  // The overwrites of a new folder channel or category (decision 6): @everyone cannot view it; the bot and the owner get
  // the folder rights, but only those the bot holds itself (Discord refuses an overwrite that grants more).
  private overwrites(guildId: string): Array<{ id: string; type: number; allow: string; deny: string }> {
    const allow = ((this.botLobbyPerms ?? FOLDER_ALLOW_BITS) & FOLDER_ALLOW_BITS).toString()
    const out = [{ id: guildId, type: 0, allow: '0', deny: EVERYONE_DENY_BITS.toString() }]
    if (this.botId !== null) out.push({ id: this.botId, type: 1, allow, deny: '0' })
    if (this.ownerId !== null) out.push({ id: this.ownerId, type: 1, allow, deny: '0' })
    return out
  }

  // Creates a folder channel under the lowest active category with room. One retry when Discord says that category is
  // full (50035), with that category excluded. The owner gets one warning near the cap and one notice at it.
  private createFolderChannel(name: string): Promise<string> {
    return this.withFolderLock(async () => {
      const b = this.requireBinding()
      const exclude = new Set<string>()
      for (let attempt = 0; ; attempt++) {
        const cat = await this.pickCategory(b.guildId, 'active', exclude)
        try {
          const ch = (await this.client.rest.post(`/guilds/${b.guildId}/channels`, {
            body: {
              name: folderChannelName(name),
              type: ChannelType.GuildText,
              parent_id: cat,
              topic: clipChars(name, TOPIC_CHARS),
              permission_overwrites: this.overwrites(b.guildId),
            },
          })) as APIChannel
          this.indexChannel(ch as IndexedChannel, b.guildId)
          const count = this.guildChannelCount(b.guildId)
          if (count >= FOLDER_WARN_CHANNELS) {
            this.notifyOnce('warn', `The server has ${count} channels; Discord allows ${GUILD_CHANNEL_CAP}. New folders stop at ${GUILD_CHANNEL_CAP}. Nothing is deleted automatically.`)
          }
          return ch.id
        } catch (e) {
          if (attempt === 0 && codeOf(e) === RESTJSONErrorCodes.InvalidFormBodyOrContentType) {
            exclude.add(cat)
            continue
          }
          if (codeOf(e) === RESTJSONErrorCodes.MaximumNumberOfGuildChannelsReached) {
            this.notifyOnce('cap', `The server has ${GUILD_CHANNEL_CAP} channels, Discord's limit. Folders without a channel use the lobby. Delete unused channels by hand to make room.`)
          }
          throw toChatError(e, { thread: false })
        }
      }
    })
  }

  // Sends an owner notice once per run, to the lobby (the bot's own message; a failure is logged).
  private notifyOnce(key: string, text: string): void {
    if (this.noticed.has(key)) return
    this.noticed.add(key)
    this.sendText(text).catch((e: unknown) => log(`notice not sent: ${errMsg(e)}`))
  }

  // Puts a folder channel under a category of the kind. A no-op when it is in one already. The REST call is not waited
  // for past MOVE_WAIT_MS (a rate limit leaves it to the queue): the category is cosmetic, and the index says where the
  // channel should be. One retry when the chosen category turns out full.
  private moveFolder(channelId: string, kind: CategoryKind): Promise<void> {
    return this.withFolderLock(async () => {
      const b = this.requireBinding()
      const info = this.index.get(channelId)
      if (!info) return
      if (folderCategoryKind(this.index.get(info.parentId ?? '')?.name) === kind) return
      const exclude = new Set<string>()
      for (let attempt = 0; ; attempt++) {
        const cat = await this.pickCategory(b.guildId, kind, exclude)
        try {
          await this.patchParent(channelId, cat)
          this.index.set(channelId, { ...info, parentId: cat })
          return
        } catch (e) {
          if (attempt === 0 && codeOf(e) === RESTJSONErrorCodes.InvalidFormBodyOrContentType) {
            exclude.add(cat)
            continue
          }
          throw toChatError(e, { thread: true })
        }
      }
    })
  }

  private async patchParent(channelId: string, parentId: string): Promise<void> {
    const req = this.client.rest.patch(`/channels/${channelId}`, { body: { parent_id: parentId } })
    const outcome = await Promise.race([req.then(() => 'done' as const), delay(MOVE_WAIT_MS).then(() => 'late' as const)])
    if (outcome === 'late') {
      log(`folder move to ${parentId} is still queued (rate limit); the channel is in its old category for now`)
      req.catch((e: unknown) => log(`folder move failed: ${errMsg(e)}`))
    }
  }

  private cancelIdle(channelId: string): void {
    const t = this.idleTimers.get(channelId)
    if (t !== undefined) clearTimeout(t)
    this.idleTimers.delete(channelId)
  }

  async createThread(name: string): Promise<ThreadId> {
    return dcThread(await this.createFolderChannel(name))
  }

  async renameThread(threadId: ThreadId, name: string): Promise<void> {
    const id = parseDcThread(threadId)
    await this.requireFolder(id)
    await boundary(this.client.rest.patch(`/channels/${id}`, { body: { name: folderChannelName(name) } }), true)
  }

  // Closing a folder moves it to the idle category after the delay (decision 2 of the grill). A reopen before then
  // cancels the move; a move already made is not repeated.
  async closeThread(threadId: ThreadId): Promise<void> {
    const id = parseDcThread(threadId)
    await this.requireFolder(id)
    this.cancelIdle(id)
    if (this.idleDelayMs <= 0) {
      await this.moveFolder(id, 'idle')
      return
    }
    const t = setTimeout(() => {
      this.idleTimers.delete(id)
      this.moveFolder(id, 'idle').catch((e: unknown) => log(`folder move to idle failed: ${errMsg(e)}`))
    }, this.idleDelayMs)
    t.unref?.()
    this.idleTimers.set(id, t)
  }

  async reopenThread(threadId: ThreadId): Promise<void> {
    const id = parseDcThread(threadId)
    await this.requireFolder(id)
    this.cancelIdle(id)
    await this.moveFolder(id, 'active')
  }

  async editText(messageId: MessageId, text: string, perm: PermKeyboard | null, _priority?: Priority): Promise<void> {
    await this.editWith(messageId, text, perm ? permRows(perm) : [])
    this.trackKeyboard(messageId, this.sentDm.get(messageId) ?? false, perm !== null)
  }

  async editRows(messageId: MessageId, text: string, rows: Rows, _priority?: Priority): Promise<void> {
    await this.editWith(messageId, text, rows)
    this.trackKeyboard(messageId, this.sentDm.get(messageId) ?? false, rows.length > 0)
  }

  private async editWith(messageId: MessageId, text: string, rows: Rows): Promise<void> {
    const { channelId, messageId: msg } = parseDcMessage(messageId)
    await boundary(
      this.client.rest.patch(`/channels/${channelId}/messages/${msg}`, { body: editBody(this.clean(text), { rows }) }),
      this.isThread(channelId),
    )
  }

  // Removes a message's buttons and keeps its text (the request carries no content, so Discord keeps it).
  async clearButtons(messageId: MessageId, target?: SendTarget): Promise<void> {
    const { channelId, messageId: msg } = parseDcMessage(messageId)
    await boundary(this.client.rest.patch(`/channels/${channelId}/messages/${msg}`, { body: { components: [] } }), this.isThread(channelId))
    this.trackKeyboard(messageId, this.sentDm.get(messageId) ?? target?.dm ?? false, false)
  }

  async react(messageId: MessageId, kind: ReactKind): Promise<void> {
    const { channelId, messageId: msg } = parseDcMessage(messageId)
    const emoji = encodeURIComponent(DISCORD_REACTION_EMOJI[kind])
    await boundary(this.client.rest.put(`/channels/${channelId}/messages/${msg}/reactions/${emoji}/@me`), this.isThread(channelId))
  }

  // Answers a button press. The type-6 ack went out on the press; the text is an ephemeral follow-up (a toast). No text
  // means nothing more is sent, and a press that is unknown or expired is a no-op.
  async ackButton(id: string, text?: string): Promise<void> {
    const p = this.presses.get(id)
    if (!text || !p) return
    this.presses.delete(id)
    const content = contentOf(text.slice(0, TOAST_CHARS))
    await boundary(
      this.client.rest.post(`/webhooks/${p.appId}/${p.token}`, {
        body: { content, flags: MessageFlags.Ephemeral, allowed_mentions: { parse: [] } },
        auth: false,
      }),
    )
  }

  // Downloads an attachment (its https URL) to dest, refusing anything over maxBytes.
  async download(fileRef: string, dest: string, maxBytes: number): Promise<void> {
    const url = new URL(fileRef)
    if (url.protocol !== 'https:') throw new Error('attachment link is not https')
    const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > maxBytes) throw new Error('file is too large')
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 })
    await writeFile(dest, buf, { mode: 0o600 })
  }

  // ---- lifecycle ----

  start(): void {
    if (this.clock !== null && this.memberTimer === null) {
      this.memberTimer = this.clock.setRepeating(() => void this.recheckMembers(), MEMBER_RECHECK_MS)
    }
    void this.client.gateway.connect().catch((e: unknown) => log(`gateway error: ${errMsg(e)}`))
  }

  async stop(): Promise<void> {
    for (const id of [...this.idleTimers.keys()]) this.cancelIdle(id)
    if (this.clock !== null && this.memberTimer !== null) this.clock.clearTimer(this.memberTimer)
    this.memberTimer = null
    await this.client.gateway.destroy()
  }
}

// One listener on the gateway's dispatch event, and the handlers kept per event name. A gateway.on per event would add a
// listener to WebSocketManager for each (the adapter listens to 11 events; Node warns past 10). Returns the `on` of
// DiscordClient.gateway.
export function routeDispatch(
  source: { on(event: string, listener: (payload: unknown) => void): unknown },
  dispatchEvent: string,
): (event: string, fn: (d: unknown) => void) => void {
  const handlers = new Map<string, Array<(d: unknown) => void>>()
  source.on(dispatchEvent, (payload) => {
    const p = payload as { t?: string; d?: unknown }
    for (const fn of handlers.get(p.t ?? '') ?? []) fn(p.d)
  })
  return (event, fn) => {
    handlers.set(event, [...(handlers.get(event) ?? []), fn])
  }
}

// The real client, built on first use (chat.app 'discord'). @discordjs/core's Client over @discordjs/rest (REST) and
// @discordjs/ws (the gateway). Gateway events arrive as dispatch payloads; `on` picks one by its name (routeDispatch).
export async function createDiscordClient(token: string, intents?: number): Promise<DiscordClient> {
  const [rest, ws, core, types] = await Promise.all([
    import('@discordjs/rest'),
    import('@discordjs/ws'),
    import('@discordjs/core'),
    import('discord-api-types/v10'),
  ])
  const api = new rest.REST({ version: '10' }).setToken(token)
  const bits = types.GatewayIntentBits
  const gatewayIntents =
    intents ?? bits.Guilds | bits.GuildMessages | bits.MessageContent | bits.DirectMessages
  const gateway = new ws.WebSocketManager({ token, intents: gatewayIntents, rest: api })
  const client = new core.Client({ rest: api, gateway })
  return {
    rest: {
      get: (r, o) => api.get(r as `/${string}`, o as never),
      post: (r, o) => api.post(r as `/${string}`, o as never),
      patch: (r, o) => api.patch(r as `/${string}`, o as never),
      put: (r, o) => api.put(r as `/${string}`, o as never),
      delete: (r, o) => api.delete(r as `/${string}`, o as never),
    },
    gateway: {
      on: routeDispatch(gateway as unknown as { on(event: string, listener: (payload: unknown) => void): unknown }, ws.WebSocketShardEvents.Dispatch),
      connect: () => gateway.connect(),
      destroy: async () => {
        await gateway.destroy()
      },
    },
  }
}

