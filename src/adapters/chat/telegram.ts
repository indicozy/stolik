import { Api, Bot, GrammyError, InlineKeyboard, InputFile, type Context, type Transformer } from 'grammy'
import type { ReactionTypeEmoji, UserFromGetMe } from 'grammy/types'
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { isOwnerUser, permissionButtons, redact, type Btn, type Rows } from '../../router/state.ts'
import { isE2eCallbackId, isE2eFileId, isE2eId, e2eNum, SYNTHETIC_ID_BASE, type E2e } from '../../router/e2e.ts'
import { debug, log, errMsg } from '../../router/log.ts'
import { mdToTelegramHtml } from '../../markdown.ts'
import { ChatError, type Capabilities, type ChatErrorKind, type ChatEvent, type ChatRef, type ButtonPress, type Inbound, type AlbumItem, type PermKeyboard, type Priority, type ReactKind, type SendTarget, type ChatPort, type ChatId, type MessageId, type ThreadId, type UserId } from '../../brain/chat-types.ts'
import { TG_PREFIX, isTgId, tgChat, tgGroupLink, tgMsg, tgNum, tgThread, tgUser } from './tg-ids.ts'
import { ChunkSendError, RATE_CAPACITY, RATE_PER_MINUTE } from '../../brain/outbound-queue.ts'
import type { Verdict } from '../../brain/pairing.ts'

const IN_CHAT = new Set(['member', 'administrator', 'creator', 'restricted'])

// The bot can run the bound home: it is the creator, or an administrator with Manage Topics. Anything else (removed,
// left, restricted, demoted, or admin without topic rights) cannot take the session topics.
export function botAccess(status: string, canManageTopics: boolean): 'ok' | 'lost' {
  if (status === 'creator') return 'ok'
  return status === 'administrator' && canManageTopics ? 'ok' : 'lost'
}

// The reaction emoji for each kind. All are on Telegram's allowed list (grammY's ReactionTypeEmoji).
export const REACTION_EMOJI: Record<ReactKind, string> = { seen: '👀', queued: '✍', held: '😴' }

// Client timeouts. A normal call is bounded at 30 s (the poll uses 20 s, see start); an upload may take longer.
export const API_TIMEOUT_S = 30
export const UPLOAD_TIMEOUT_S = 300
// Telegram takes photos up to 10 MB; larger images and GIFs go as documents.
export const PHOTO_MAX_BYTES = 10 * 1024 * 1024
// How many recent messages keep their chat (DM or group) and keyboard state in memory.
const TRACKED_MESSAGES = 5000
// Keyboards kept for the store, so stale ones are stripped after a restart.
const KEYBOARD_LIST_MAX = 200

function permKeyboard(p: PermKeyboard): InlineKeyboard {
  const kb = new InlineKeyboard()
  for (const b of permissionButtons(p.requestId, p)) kb.text(b.text, b.data)
  return kb
}

// The keyboard of a sent message as plain rows (callback data included), for the driver's ring buffer.
function buttonRows(perm: PermKeyboard | null | undefined, rows: Rows | undefined): Btn[][] {
  if (perm) return [permissionButtons(perm.requestId, perm).map((b) => ({ text: b.text, data: b.data }))]
  return (rows ?? []).map((row) => row.map((b) => ({ text: b.text, data: b.data })))
}

// One row of buttons per inner array.
function rowsKeyboard(rows: Rows): InlineKeyboard {
  const kb = new InlineKeyboard()
  rows.forEach((row, i) => {
    if (i > 0) kb.row()
    for (const b of row) kb.text(b.text, b.data)
  })
  return kb
}

// Chat kind as the brain sees it: the owner's private chat is 'dm', a supergroup (a group with topics) is 'home' (it
// can be bound as the home), a plain group or a channel is 'other'.
export function chatRef(chat: { type: string; id: number }, msg?: { is_topic_message?: boolean; message_thread_id?: number }): ChatRef {
  const kind = chat.type === 'private' ? 'dm' : chat.type === 'supergroup' ? 'home' : 'other'
  const thread = msg?.is_topic_message && msg.message_thread_id !== undefined ? tgThread(msg.message_thread_id) : null
  return { kind, id: tgChat(chat.id), thread }
}

// Telegram user id as the router keeps it: the same string form as the owner id. '' when there is no sender.
export function fromId(id: number | undefined): UserId {
  return id === undefined ? ('' as UserId) : tgUser(id)
}

// The chat id of the owner's private chat (kept as the raw string Telegram uses).
function tgChatOf(raw: string): ChatId {
  return `${TG_PREFIX}${raw}` as ChatId
}

// Telegram's number for a thread id (undefined: no thread).
function threadNum(t: ThreadId | undefined): number | undefined {
  return t === undefined ? undefined : tgNum(t)
}

// The number the E2E ring keeps for a message: real Telegram numbers, and the driver's own ids as negative numbers.
export function ringNum(id: MessageId): number {
  return isE2eId(id) ? -(SYNTHETIC_ID_BASE + e2eNum(id)) : tgNum(id)
}

// The order of two message ids of one chat: Telegram's numbers, or the driver's counter.
function orderOf(id: MessageId): number {
  return isE2eId(id) ? e2eNum(id) : tgNum(id)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// A file download (the lookup and the fetch) gives up after this long, so a stalled transfer cannot hang the router.
const DOWNLOAD_TIMEOUT_MS = 60_000
// Files of one album arrive as separate updates; they are joined when this long has passed since the last one.
export const ALBUM_WINDOW_MS = 1_000

// Thin grammy wrapper. Owns the bot token and the chat gate; every outbound text is redacted.
// Telegram's limit on the text of one message.
const TG_MAX_TEXT = 4096

// Telegram's answer when the bot can no longer post in the group (removed, restricted, or without rights).
const ACCESS_LOST_RE = /bot was kicked|bot is not a member|not enough rights|have no rights|chat not found|bot was blocked|CHAT_WRITE_FORBIDDEN|forbidden/i
// Telegram's answer when a topic is gone: deleted by hand, or never there. A send to it must not be retried there.
const THREAD_GONE_RE = /thread not found|topic_id_invalid|topic not found|topic_deleted|message thread/i
// Telegram's answer when a topic is already in the state asked for (reopen an open topic, close a closed one).
const NOT_MODIFIED_RE = /TOPIC_NOT_MODIFIED|topic.*not modified/i
// Node error codes of a failed connection (a transient failure, see ChatError.transient).
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND', 'UND_ERR_SOCKET'])

// What a chat platform can do, with Telegram's values (plan 23 §2.1). The rate is the outbound queue's (one group).
export const TELEGRAM_CAPABILITIES: Capabilities = {
  platform: 'tg',
  displayName: 'Telegram',
  names: { home: 'group', lobby: 'General', thread: 'topic' },
  commandSigil: '/',
  text: { maxChars: TG_MAX_TEXT, format: 'html' },
  threads: { kind: 'forum-topic', maxNameChars: 128, rename: true, close: true },
  buttons: { kind: 'inline', payloadBytes: 64, maxRows: 100, maxPerRow: 8, labelChars: 60, toast: true, editable: true },
  replies: true,
  edits: { own: true, seesOwnerEdits: true },
  reactions: true,
  typing: true,
  silent: true,
  dm: true,
  forwardMarker: true,
  files: { inbound: true, outbound: true, maxUploadBytes: 50 * 1024 * 1024, maxDownloadBytes: 20 * 1024 * 1024, image: true },
  voice: { inbound: true },
  rate: { perChatPerMin: RATE_PER_MINUTE, burst: RATE_CAPACITY, scope: 'chat', sharedPause: true },
}

// The text of an error as the brain used to read it (grammY puts the description into the message).
function textOf(e: unknown): string {
  if (e instanceof Error) return e.message
  return typeof e === 'string' ? e : String(e)
}

// Maps a grammY (or Node) error to a ChatError. The matches are the ones the brain and router made before the
// boundary existed: access-lost reads the API description, thread-closed and not-modified read the error text.
export function toChatError(e: unknown): ChatError {
  if (e instanceof ChatError) return e
  const o = (e !== null && typeof e === 'object' ? e : {}) as {
    error_code?: unknown
    description?: unknown
    parameters?: { retry_after?: unknown }
    name?: unknown
    code?: unknown
  }
  const status = typeof o.error_code === 'number' ? o.error_code : undefined
  const description = typeof o.description === 'string' ? o.description : undefined
  const text = textOf(e)
  const retryAfter = o.parameters?.retry_after
  if (status === 429 && typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return new ChatError('rate-limited', text, { status, description, retryAfterMs: retryAfter * 1000, cause: e })
  }
  // A 4xx is never transient: the same request would be refused again.
  const transient =
    status !== undefined
      ? status >= 500
      : o.name === 'HttpError' || o.name === 'AbortError' || o.name === 'TimeoutError' || (typeof o.code === 'string' && NETWORK_CODES.has(o.code))
  let kind: ChatErrorKind = 'other'
  if (description !== undefined && ACCESS_LOST_RE.test(description)) kind = 'access-lost'
  else if (THREAD_GONE_RE.test(text)) kind = 'thread-closed'
  else if (NOT_MODIFIED_RE.test(text)) kind = 'not-modified'
  return new ChatError(kind, text, { status, description, transient, cause: e })
}

// Every call into grammY passes its rejection through here, so nothing above the adapter sees a grammY error.
function boundary<T>(p: Promise<T>): Promise<T> {
  return p.catch((e: unknown) => {
    throw toChatError(e)
  })
}

// Telegram's "can't parse entities" refusal: the HTML of a markdown send was malformed for Telegram.
export function isEntityParseError(e: unknown): boolean {
  return e instanceof GrammyError && e.error_code === 400 && /can't parse entities/i.test(e.description)
}

// Test seam (chat connector 0d): the bot's own identity (so grammY does not call getMe) and a transformer on every Bot
// API call (so a test records the calls and answers them without the network). Production passes nothing.
export type TelegramSeam = { botInfo?: UserFromGetMe; transformer?: Transformer }

// Pairing as the sender gate sees it (see brain/pairing.ts). attempt() consumes a private text: 'paired' when the code
// matched, 'wrong' or 'closed' otherwise. paired() gets the sender once, on a match.
export type PairingHook = {
  attempt(text: string): Verdict
  paired(who: { userId: string; name: string; username: string | null }): void
}

export class Telegram implements ChatPort {
  readonly capabilities: Capabilities = TELEGRAM_CAPABILITIES
  private readonly bot: Bot
  // Uploads use their own client with a longer bound, so a large file does not trip the normal 30 s limit.
  private readonly uploads: Api
  private readonly token: string
  // The owner's private chat (TG_CHAT): where DM-mode sends go, and the fallback hint in group mode.
  private chatId: string
  // The owner's Telegram user id: the only sender whose messages and taps are passed on. Null before pairing: then nobody
  // but a pairing code gets through (see PairingHook).
  private ownerUserId: string | null
  // Pairing (brain/pairing.ts): set by the composition root. Private texts from anyone but the owner go to it.
  private pairing: PairingHook | null = null
  // The bound supergroup, or null in DM mode. Sends and edits go here when set.
  private groupId: ChatId | null = null
  private chatEventCb: ((e: ChatEvent) => Promise<void>) | null = null
  private readonly secrets: string[]
  // E2E driver (docs/e2e.md): when set, every send is recorded here, and synthetic messages and files are served. Null
  // in normal operation, so nothing changes then.
  private readonly e2e: E2e | null
  private inboundCb: ((m: Inbound) => Promise<void>) | null = null
  private callbackCb: ((c: ButtonPress) => Promise<void>) | null = null
  private startedCb: (() => void) | null = null
  private keyboardsCb: ((list: Array<{ messageId: MessageId; dm: boolean }>) => void) | null = null
  private stopping = false
  // Which chat each recent message is in (true: the owner's DM). Edits and reactions go to the same chat.
  private readonly sentDm = new Map<MessageId, boolean>()
  // Messages that carry a keyboard the bot sent (messageId -> in the DM).
  private readonly keyboards = new Map<MessageId, boolean>()
  // Makes `userId` the owner from now on (after the owner confirmed a pairing).
  setOwnerUserId(userId: string | null): void {
    this.ownerUserId = userId
  }

  // The owner's DM chat (a private chat's id is the user's id), set when the owner pairs.
  setDmChat(chatId: string): void {
    this.chatId = chatId
  }

  setPairing(hook: PairingHook | null): void {
    this.pairing = hook
  }

  // Inbound handling per chat and topic runs in order (see KeyedSerial).
  private readonly serial = new KeyedSerial()
  // Albums being collected: media group id -> the messages so far and the flush timer.
  private readonly albums = new Map<string, { items: Inbound[]; timer: ReturnType<typeof setTimeout> }>()

  constructor(token: string, chatId: string, extraSecrets: string[], ownerUserId: string | null = chatId, e2e: E2e | null = null, seam: TelegramSeam = {}) {
    this.token = token
    this.chatId = chatId
    this.ownerUserId = ownerUserId
    this.e2e = e2e
    this.secrets = [token, ...extraSecrets].filter((s) => s.length > 0)
    this.bot = new Bot(token, { client: { timeoutSeconds: API_TIMEOUT_S } })
    this.uploads = new Api(token, { timeoutSeconds: UPLOAD_TIMEOUT_S })
    if (seam.botInfo) this.bot.botInfo = seam.botInfo
    if (seam.transformer) {
      this.bot.api.config.use(seam.transformer)
      this.uploads.config.use(seam.transformer)
    }

    // Anonymous admin posts: the group itself is the sender, so the owner's messages look like anyone's. Told once.
    this.bot.use(async (ctx, next) => {
      const sc = ctx.message?.sender_chat
      if (sc && ctx.chat && sc.id === ctx.chat.id && ctx.chat.type !== 'private') {
        this.emitChatEvent({ type: 'unattributable-post', chat: tgChat(ctx.chat.id) })
        return
      }
      await next()
    })
    // Sender gate: messages and taps from the owner's user id only, whatever the chat (the brain picks the chat).
    // Chat membership, the bot's own rights and group migration come from Telegram itself, so they pass whatever the sender.
    this.bot.use(async (ctx, next) => {
      if (ctx.chatMember || ctx.myChatMember || ctx.message?.migrate_to_chat_id !== undefined) return next()
      const from = String(ctx.from?.id ?? '')
      if (this.ownerUserId !== null && from === this.ownerUserId) return next()
      // A private text from anyone else is a pairing attempt while pairing is on. It is never an Inbound.
      if (this.pairing && ctx.chat?.type === 'private' && typeof ctx.message?.text === 'string') {
        if (this.pairing.attempt(ctx.message.text) === 'paired') {
          const u = ctx.from
          await ctx.reply('Paired.').catch(() => {})
          this.pairing.paired({ userId: from, name: [u?.first_name, u?.last_name].filter(Boolean).join(' '), username: u?.username ?? null })
        }
      }
    })
    this.bot.catch((err) => log(`handler error: ${errMsg(err.error)}`))

    this.bot.on('message:text', (ctx) => this.emitInbound(ctx, 'text', { text: ctx.message.text }))
    this.bot.on('message:photo', (ctx) => {
      const best = ctx.message.photo[ctx.message.photo.length - 1]
      this.emitInbound(ctx, 'photo', { fileRef: best.file_id, fileSize: best.file_size })
    })
    this.bot.on('message:document', (ctx) => {
      const d = ctx.message.document
      this.emitInbound(ctx, 'document', { fileRef: d.file_id, fileName: d.file_name, fileSize: d.file_size })
    })
    // A GIF sent as an animation arrives as a document (the file is the same).
    this.bot.on('message:animation', (ctx) => {
      const a = ctx.message.animation
      this.emitInbound(ctx, 'document', { fileRef: a.file_id, fileName: a.file_name ?? 'animation.gif', fileSize: a.file_size })
    })
    this.bot.on('message:audio', (ctx) => {
      const a = ctx.message.audio
      this.emitInbound(ctx, 'audio', { fileRef: a.file_id, fileName: a.file_name, fileSize: a.file_size })
    })
    this.bot.on('message:video', (ctx) => {
      const v = ctx.message.video
      this.emitInbound(ctx, 'video', { fileRef: v.file_id, fileName: v.file_name, fileSize: v.file_size })
    })
    this.bot.on('message:video_note', (ctx) => {
      const v = ctx.message.video_note
      this.emitInbound(ctx, 'video_note', { fileRef: v.file_id, fileSize: v.file_size })
    })
    this.bot.on('message:voice', (ctx) => {
      const v = ctx.message.voice
      this.emitInbound(ctx, 'voice', { fileRef: v.file_id, fileSize: v.file_size })
    })
    // Kinds the bot cannot forward: the owner is told so (the brain replies), instead of the message vanishing.
    this.bot.on('message:sticker', (ctx) => this.emitInbound(ctx, 'unsupported', { label: 'a sticker' }))
    this.bot.on('message:location', (ctx) => this.emitInbound(ctx, 'unsupported', { label: 'a location' }))
    this.bot.on('message:venue', (ctx) => this.emitInbound(ctx, 'unsupported', { label: 'a venue' }))
    this.bot.on('message:contact', (ctx) => this.emitInbound(ctx, 'unsupported', { label: 'a contact' }))
    this.bot.on('message:poll', (ctx) => this.emitInbound(ctx, 'unsupported', { label: 'a poll' }))
    this.bot.on('message:dice', (ctx) => this.emitInbound(ctx, 'unsupported', { label: 'a dice roll' }))
    this.bot.on('message:game', (ctx) => this.emitInbound(ctx, 'unsupported', { label: 'a game' }))
    // Edits are not forwarded; the brain says so once per message.
    this.bot.on('edited_message', (ctx) => this.emitInbound(ctx, 'edited', {}, ctx.editedMessage))
    this.bot.on('callback_query:data', (ctx) => {
      const cb = ctx.callbackQuery
      const cbMsg = cb.message
      // A tap whose message Telegram left out is taken as the owner's private chat.
      const chat = cbMsg ? chatRef(cbMsg.chat, cbMsg) : { kind: 'dm' as const, id: tgChatOf(this.chatId), thread: null }
      const cb2: ButtonPress = { pressId: cb.id, data: cb.data, message: cbMsg ? tgMsg(cbMsg.message_id) : null, from: fromId(cb.from.id), chat }
      if (this.callbackCb) this.callbackCb(cb2).catch((e) => log(`callback error: ${errMsg(e)}`))
    })
    // A service message in the old group when it became a supergroup: the new id arrives here. The brain moves the
    // stored home id if the old one is the bound home. Live as long as the bot is still in the old group.
    this.bot.on('message:migrate_to_chat_id', (ctx) => {
      const to = tgChat(ctx.message.migrate_to_chat_id)
      if (isTgId(to)) this.emitChatEvent({ type: 'home-moved', from: tgChat(ctx.chat.id), to })
    })
    // A member's status changed. Only a join by someone other than the owner and a bot is news (no kick, one alert).
    this.bot.on('chat_member', (ctx) => {
      const u = ctx.chatMember
      const joined = IN_CHAT.has(u.new_chat_member.status) && !IN_CHAT.has(u.old_chat_member.status)
      const member = u.new_chat_member.user
      if (!joined || member.is_bot || String(member.id) === this.ownerUserId) return
      this.emitChatEvent({ type: 'stranger-joined', chat: tgChat(ctx.chat.id), label: member.first_name })
    })
    // The bot's own status: removed, demoted, or given or without Manage Topics.
    this.bot.on('my_chat_member', (ctx) => {
      const u = ctx.myChatMember
      const rights = u.new_chat_member as { status: string; can_manage_topics?: boolean }
      const canManageTopics = rights.status === 'creator' || rights.can_manage_topics === true
      this.emitChatEvent({
        type: 'access',
        chat: tgChat(ctx.chat.id),
        access: botAccess(rights.status, canManageTopics),
        reason: rights.status,
      })
    })
  }

  onChatEvent(fn: (e: ChatEvent) => Promise<void>): void {
    this.chatEventCb = fn
  }

  private emitChatEvent(e: ChatEvent): void {
    if (this.chatEventCb) this.chatEventCb(e).catch((err) => log(`chat event error: ${errMsg(err)}`))
  }

  setHome(groupId: ChatId | null): void {
    this.groupId = groupId
  }

  homeLink(): string | null {
    return this.groupId === null ? null : tgGroupLink(this.groupId)
  }

  onInbound(fn: (m: Inbound) => Promise<void>): void {
    this.inboundCb = fn
  }

  onButton(fn: (c: ButtonPress) => Promise<void>): void {
    this.callbackCb = fn
  }

  // Called each time polling starts (after a reconnect too), so callers must guard against repeats.
  onStarted(fn: () => void): void {
    this.startedCb = fn
  }

  // Called with the keyboards the bot has live (messageId, in the DM or not) whenever that set changes.
  onLiveButtons(fn: (list: Array<{ messageId: MessageId; dm: boolean }>) => void): void {
    this.keyboardsCb = fn
  }

  private emitInbound(
    ctx: Context,
    kind: Inbound['kind'],
    extra: { text?: string; fileRef?: string; fileName?: string; fileSize?: number; label?: string },
    msgOverride?: Context['message'],
  ): void {
    const msg = msgOverride ?? ctx.message
    if (!msg || !this.inboundCb) return
    const from = ctx.from?.username ?? ctx.from?.first_name ?? 'user'
    const chat = chatRef(msg.chat, msg)
    this.rememberChat(tgMsg(msg.message_id), chat.kind === 'dm')
    const m: Inbound = {
      chat,
      kind,
      messageId: tgMsg(msg.message_id),
      text: extra.text ?? msg.caption ?? '',
      // In a forum topic Telegram sets reply_to_message to the topic's root (its forum_topic_created message) on every
      // plain message: that is not a reply.
      replyToId: msg.reply_to_message && msg.reply_to_message.forum_topic_created === undefined && !(msg.is_topic_message && msg.reply_to_message.message_id === msg.message_thread_id)
        ? tgMsg(msg.reply_to_message.message_id)
        : null,
      replyToText: msg.reply_to_message?.text ?? msg.reply_to_message?.caption ?? null,
      forwarded: msg.forward_origin !== undefined,
      from,
      fromId: fromId(ctx.from?.id),
      fileRef: extra.fileRef,
      fileName: extra.fileName,
      fileSize: extra.fileSize,
      label: extra.label,
    }
    const group = 'media_group_id' in msg ? (msg as { media_group_id?: string }).media_group_id : undefined
    if (group !== undefined && (kind === 'photo' || kind === 'document' || kind === 'audio' || kind === 'video')) {
      this.collectAlbum(`${chat.id}|${group}`, m)
      return
    }
    this.receive(m)
  }

  // Album files arrive as separate updates. They are joined into one inbound (the first message's id, every file, and
  // the caption of whichever file has one) once ALBUM_WINDOW_MS passes without another.
  private collectAlbum(key: string, m: Inbound): void {
    const cur = this.albums.get(key)
    if (cur) clearTimeout(cur.timer)
    const items = cur ? [...cur.items, m] : [m]
    const timer = setTimeout(() => {
      this.albums.delete(key)
      this.receive(joinAlbum(items))
    }, ALBUM_WINDOW_MS)
    this.albums.set(key, { items, timer })
  }

  // Inbound handling: one chain per chat and topic, so messages of one conversation are handled in the order they
  // arrived. Other chats and topics do not wait for it.
  private receive(m: Inbound): void {
    if (!this.inboundCb) return
    const key = `${m.chat.id}|${m.chat.thread ?? ''}`
    this.serial.run(key, () => this.inboundCb?.(m) ?? Promise.resolve()).catch((e) => log(`inbound error: ${errMsg(e)}`))
  }

  // Polling loop with backoff, adapted from the official telegram plugin. Retries forever; systemd restarts on crash.
  start(): void {
    void (async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          await this.bot.start({
            // The long poll is shorter than the client's bound, so a poll that ends normally is not taken for a timeout.
            timeout: 20,
            allowed_updates: ['message', 'edited_message', 'callback_query', 'chat_member', 'my_chat_member'],
            onStart: (info) => {
              attempt = 0
              log(`polling as @${info.username}`)
              this.startedCb?.()
            },
          })
          return
        } catch (err) {
          if (this.stopping) return
          if (err instanceof Error && err.message === 'Aborted delay') return
          const is409 = err instanceof GrammyError && err.error_code === 409
          const delay = Math.min(1000 * attempt, 15000)
          const detail = is409 ? '409 Conflict (another poller holds this token)' : `polling error: ${errMsg(err)}`
          log(`${detail}, retrying in ${delay / 1000}s`)
          await sleep(delay)
        }
      }
    })()
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.bot.isRunning()) await this.bot.stop()
  }

  private clean(text: string): string {
    return redact(text, this.secrets)
  }

  // The chat for a send: the DM when asked, else the bound group, else the DM.
  private chatFor(target: SendTarget = {}): string {
    if (target.dm || this.groupId === null) return this.chatId
    return String(tgNum(this.groupId))
  }

  // Where a send with these options lands, as the driver names it.
  private chatRefFor(target: SendTarget = {}): ChatRef {
    if (target.dm || this.groupId === null) return { kind: 'dm', id: tgChatOf(this.chatId), thread: null }
    return { kind: 'home', id: this.groupId, thread: target.thread ?? null }
  }

  // The bound group for topic calls. Throws when no group is bound.
  private topicChat(): string {
    if (this.groupId === null) throw new Error('no group is bound')
    return String(tgNum(this.groupId))
  }

  // The chat an existing message is in: the one it was sent or received in (kept per message), else the given target.
  private chatOfMessage(messageId: MessageId, fallback: SendTarget = {}): string {
    const dm = this.sentDm.get(messageId)
    if (dm === undefined) return this.chatFor(fallback)
    return dm || this.groupId === null ? this.chatId : String(tgNum(this.groupId))
  }

  private rememberChat(messageId: MessageId, dm: boolean): void {
    this.sentDm.delete(messageId)
    this.sentDm.set(messageId, dm)
    if (this.sentDm.size > TRACKED_MESSAGES) this.sentDm.delete(this.sentDm.keys().next().value as MessageId)
  }

  isDm(messageId: MessageId): boolean | undefined {
    return this.sentDm.get(messageId)
  }

  // Telegram message ids are numbers per chat, so the order is the numeric order.
  compareMessages(a: MessageId, b: MessageId): number {
    return orderOf(a) - orderOf(b)
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

  // message_thread_id is omitted for General (the usual form). If Telegram rejects that for General, pass 1.
  async sendText(
    text: string,
    opts: { replyTo?: MessageId; perm?: PermKeyboard; rows?: Rows; silent?: boolean; format?: 'markdown' } & SendTarget = {},
  ): Promise<MessageId> {
    // A synthetic (driver) message has no Telegram id to reply to: the text is sent without a reply.
    const replyTo = opts.replyTo && !isE2eId(opts.replyTo) ? tgNum(opts.replyTo) : undefined
    const chat = this.chatFor(opts)
    const plain = this.clean(text)
    const options = {
      link_preview_options: { is_disabled: true },
      reply_parameters: replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined,
      reply_markup: opts.perm ? permKeyboard(opts.perm) : opts.rows ? rowsKeyboard(opts.rows) : undefined,
      disable_notification: opts.silent ? true : undefined,
      message_thread_id: threadNum(opts.thread),
    }
    let msg: { message_id: number }
    if (opts.format === 'markdown') {
      const html = mdToTelegramHtml(plain)
      // Telegram refuses an empty message, and one whose HTML is only tags (an empty code block) is empty too.
      if (html.length > TG_MAX_TEXT || html.replace(/<[^>]*>/g, '').trim() === '') {
        debug(`markdown send as plain text: ${html.length > TG_MAX_TEXT ? 'HTML over the limit' : 'no visible text'}`)
        msg = await boundary(this.bot.api.sendMessage(chat, plain, options))
      } else {
        // The refusal is read here, before the boundary maps it.
        msg = await boundary(
          this.bot.api.sendMessage(chat, html, { ...options, parse_mode: 'HTML' }).catch(async (e: unknown) => {
            if (!isEntityParseError(e)) throw e
            debug(`markdown send refused by Telegram, sent as plain text: ${errMsg(e)}`)
            return this.bot.api.sendMessage(chat, plain, options)
          }),
        )
      }
    } else {
      msg = await boundary(this.bot.api.sendMessage(chat, plain, options))
    }
    this.rememberChat(tgMsg(msg.message_id), this.chatRefFor(opts).kind === 'dm')
    if (opts.perm || (opts.rows && opts.rows.length > 0)) this.trackKeyboard(tgMsg(msg.message_id), this.chatRefFor(opts).kind === 'dm', true)
    this.recordSent(tgMsg(msg.message_id), opts, plain, buttonRows(opts.perm, opts.rows))
    return tgMsg(msg.message_id)
  }

  private recordSent(messageId: MessageId, target: SendTarget, text: string, buttons: Btn[][]): void {
    this.e2e?.ring.record({ messageId: tgNum(messageId), chat: this.chatRefFor(target), text, buttons })
  }

  // Several texts in order, one send after another (the queue decorator makes them one queue group, see
  // telegram-queued.ts). `replyTo` answers the first chunk; `rows` go on the last. Stops at the first failure with a
  // ChunkSendError listing the chunks already sent.
  async sendChunks(
    texts: readonly string[],
    opts: { silent?: boolean; priority?: Priority; replyTo?: MessageId; rows?: Rows; format?: 'markdown' } & SendTarget = {},
  ): Promise<MessageId[]> {
    const { priority: _priority, replyTo, rows, ...rest } = opts
    const ids: MessageId[] = []
    for (let i = 0; i < texts.length; i++) {
      try {
        ids.push(
          await this.sendText(texts[i], {
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

  // Shows the "typing..." action in the chat (lasts about 5 s on Telegram's side).
  async typing(target: SendTarget = {}): Promise<void> {
    await boundary(this.bot.api.sendChatAction(this.chatFor(target), 'typing', { message_thread_id: threadNum(target.thread) }))
  }

  // A photo goes as a photo when Telegram takes it that way; a large image, a GIF, or a photo Telegram refuses goes as
  // a document. Uploads use the longer-bounded client.
  async sendFile(path: string, asPhoto: boolean, target: SendTarget & { silent?: boolean } = {}): Promise<MessageId> {
    const input = new InputFile(path)
    const extra = { message_thread_id: threadNum(target.thread), disable_notification: target.silent ? true : undefined }
    const chat = this.chatFor(target)
    const size = (await stat(path)).size
    let msg: { message_id: number }
    const asDocument = (): ReturnType<Api['sendDocument']> => boundary(this.uploads.sendDocument(chat, input, extra))
    if (!asPhoto || size > PHOTO_MAX_BYTES || /\.gif$/i.test(path)) {
      msg = await asDocument()
    } else {
      try {
        msg = await boundary(this.uploads.sendPhoto(chat, input, extra))
      } catch (e) {
        if (!(e instanceof ChatError) || e.status !== 400) throw e
        log(`photo refused, sending as a document: ${errMsg(e)}`)
        msg = await asDocument()
      }
    }
    this.rememberChat(tgMsg(msg.message_id), this.chatRefFor(target).kind === 'dm')
    this.recordSent(tgMsg(msg.message_id), target, `(file: ${basename(path)})`, [])
    return tgMsg(msg.message_id)
  }

  async createThread(name: string): Promise<ThreadId> {
    const topic = await boundary(this.bot.api.createForumTopic(this.topicChat(), name.slice(0, 128)))
    return tgThread(topic.message_thread_id)
  }

  async renameThread(threadId: ThreadId, name: string): Promise<void> {
    await boundary(this.bot.api.editForumTopic(this.topicChat(), tgNum(threadId), { name: name.slice(0, 128) }))
  }

  async closeThread(threadId: ThreadId): Promise<void> {
    await boundary(this.bot.api.closeForumTopic(this.topicChat(), tgNum(threadId)))
  }

  async reopenThread(threadId: ThreadId): Promise<void> {
    await boundary(this.bot.api.reopenForumTopic(this.topicChat(), tgNum(threadId)))
  }

  // Edits a message; perm null removes any inline keyboard. The edit goes to the message's own chat. `priority` is
  // accepted for the decorator (the queue uses it); the adapter does not queue.
  async editText(messageId: MessageId, text: string, perm: PermKeyboard | null, _priority?: Priority): Promise<void> {
    if (isE2eId(messageId)) return this.e2e?.ring.update(ringNum(messageId), { text: this.clean(text), buttons: buttonRows(perm, undefined) })
    const dm = this.sentDm.get(messageId) ?? false
    await boundary(this.bot.api.editMessageText(this.chatOfMessage(messageId), tgNum(messageId), this.clean(text), {
      link_preview_options: { is_disabled: true },
      reply_markup: perm ? permKeyboard(perm) : undefined,
    }))
    this.trackKeyboard(messageId, dm, perm !== null)
    this.e2e?.ring.update(ringNum(messageId), { text: this.clean(text), buttons: buttonRows(perm, undefined) })
  }

  // Edits a message's text and buttons. An empty row list removes the keyboard.
  async editRows(messageId: MessageId, text: string, rows: Rows, _priority?: Priority): Promise<void> {
    if (isE2eId(messageId)) return this.e2e?.ring.update(ringNum(messageId), { text: this.clean(text), buttons: buttonRows(undefined, rows) })
    const dm = this.sentDm.get(messageId) ?? false
    await boundary(this.bot.api.editMessageText(this.chatOfMessage(messageId), tgNum(messageId), this.clean(text), {
      link_preview_options: { is_disabled: true },
      reply_markup: rows.length > 0 ? rowsKeyboard(rows) : undefined,
    }))
    this.trackKeyboard(messageId, dm, rows.length > 0)
    this.e2e?.ring.update(ringNum(messageId), { text: this.clean(text), buttons: buttonRows(undefined, rows) })
  }

  // Removes a message's keyboard, keeping its text. `target` names the chat when the message is not remembered.
  async clearButtons(messageId: MessageId, target?: SendTarget): Promise<void> {
    if (isE2eId(messageId)) return
    const dm = this.sentDm.get(messageId) ?? target?.dm ?? false
    await boundary(this.bot.api.editMessageReplyMarkup(this.chatOfMessage(messageId, target ?? {}), tgNum(messageId)))
    this.trackKeyboard(messageId, dm, false)
  }

  async react(messageId: MessageId, kind: ReactKind): Promise<void> {
    if (isE2eId(messageId)) return
    await boundary(this.bot.api.setMessageReaction(this.chatOfMessage(messageId), tgNum(messageId), [
      { type: 'emoji', emoji: REACTION_EMOJI[kind] as ReactionTypeEmoji['emoji'] },
    ]))
  }

  setCommands(list: ReadonlyArray<{ command: string; description: string }>): void {
    void this.bot.api.setMyCommands([...list], { scope: { type: 'all_private_chats' } }).catch(() => {})
  }

  async ackButton(id: string, text?: string): Promise<void> {
    // A driver tap has no Telegram callback to answer.
    if (isE2eCallbackId(id)) return
    await boundary(this.bot.api.answerCallbackQuery(id, text ? { text } : undefined))
  }

  // Downloads a Telegram file to dest. Errors never include the download URL (it contains the token).
  async download(fileRef: string, dest: string, maxBytes: number): Promise<void> {
    // A driver file: a local copy of the file the driver named (voice, photo or document).
    if (isE2eFileId(fileRef)) {
      const src = this.e2e?.files.get(fileRef)
      if (!src) throw new Error('unknown driver file')
      if ((await stat(src)).size > maxBytes) throw new Error('file is too large')
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 })
      await copyFile(src, dest)
      return
    }
    // grammY types its signal with the abort-controller package; the platform AbortSignal is the same object at run time.
    const lookupSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) as unknown as Parameters<Bot['api']['getFile']>[1]
    const file = await boundary(this.bot.api.getFile(fileRef, lookupSignal))
    if (!file.file_path) throw new Error('Telegram returned no file path (the file may have expired)')
    if (file.file_size !== undefined && file.file_size > maxBytes) throw new Error('file is too large')
    const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > maxBytes) throw new Error('file is too large')
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 })
    await writeFile(dest, buf, { mode: 0o600 })
  }
}

// Runs async jobs one after another per key; different keys run independently. A job that throws does not stop its key.
export class KeyedSerial {
  private readonly chains = new Map<string, Promise<void>>()

  run(key: string, job: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(key) ?? Promise.resolve()
    const next: Promise<void> = prev.then(job, job).finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key)
    })
    this.chains.set(key, next)
    return next
  }
}

// One inbound for an album: the first message's fields, every file in order, and the first caption found.
export function joinAlbum(items: Inbound[]): Inbound {
  const sorted = [...items].sort((a, b) => tgNum(a.messageId) - tgNum(b.messageId))
  const first = sorted[0]
  return {
    ...first,
    text: sorted.find((i) => i.text !== '')?.text ?? '',
    album: sorted.map((i) => ({ messageId: i.messageId, kind: i.kind, fileRef: i.fileRef, fileName: i.fileName, fileSize: i.fileSize })),
  }
}
