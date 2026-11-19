// Discord's mapping, pure (research/d1-brief.md, batch D1a): capabilities, ChatRef from a message, inbound messages,
// button rows, outbound bodies and the error boundary. No network and no client here: the Discord adapter (D1b) feeds
// it gateway payloads and REST errors, and passes a channel-index lookup in. Imports discord-api-types at run time, so
// only the Discord path may import this module (the Telegram path never does).
import {
  ButtonStyle,
  ChannelType,
  ComponentType,
  MessageFlags,
  MessageReferenceType,
  MessageType,
  RESTJSONErrorCodes,
  type APIActionRowComponent,
  type APIAttachment,
  type APIButtonComponentWithCustomId,
  type GatewayMessageCreateDispatchData,
  type RESTPatchAPIChannelMessageJSONBody,
  type RESTPostAPIChannelMessageJSONBody,
} from 'discord-api-types/v10'
import { escapeMarkdown } from '@discordjs/formatters'
import {
  ChatError,
  type AlbumItem,
  type Capabilities,
  type ChatErrorKind,
  type ChatRef,
  type Inbound,
} from '../../brain/chat-types.ts'
import type { Rows } from '../../router/state.ts'
import { dcChat, dcDm, dcMsg, dcThread, dcUser } from './dc-ids.ts'

// Limits (research/23-discord-limits.md §1-§2). Button payloads are bytes; labels are characters.
export const DC_MAX_TEXT = 2000
export const DC_BUTTONS = { payloadBytes: 100, maxRows: 5, maxPerRow: 5, labelChars: 80 } as const
export const DC_FILE_BYTES = 20 * 1024 * 1024
// Channel names (folder channels) are 1-100 characters (research/23-discord-limits.md).
export const DC_NAME_CHARS = 100
// Folder categories (decision 2): `stolik` (active) and `stolik-idle`, each with numbered overflow `stolik 2`, `stolik 3`…
// A category holds at most 50 channels (channel.mdx, parent_id). The server holds 500 channels (error 30013).
export const FOLDER_CHANNELS_PER_CATEGORY = 50
export const FOLDER_CATEGORY_ACTIVE = 'stolik'
export const FOLDER_CATEGORY_IDLE = 'stolik-idle'
const FOLDER_CATEGORY_RE = /^stolik(-idle)?( ([2-9]|[1-9]\d+))?$/
// The per-chat outbound pace this adapter asks the queue for. Discord publishes no per-channel number (research §3);
// the REST library queues on the bucket headers, so this is a floor, not the server's limit.
export const DC_RATE = { perChatPerMin: 30, burst: 5 } as const

// What Discord can do (plan 23 §2.1, decision 4). The lobby is named by its channel, not by a fixed word.
export const DISCORD_CAPABILITIES: Capabilities = {
  platform: 'dc',
  displayName: 'Discord',
  names: { home: 'server', lobby: 'the lobby channel', thread: 'channel' },
  commandSigil: '/',
  text: { maxChars: DC_MAX_TEXT, format: 'markdown', measure: contentLength },
  threads: { kind: 'channel', maxNameChars: DC_NAME_CHARS, rename: true, close: true },
  buttons: { kind: 'inline', payloadBytes: DC_BUTTONS.payloadBytes, maxRows: DC_BUTTONS.maxRows, maxPerRow: DC_BUTTONS.maxPerRow, labelChars: DC_BUTTONS.labelChars, toast: true, editable: true },
  replies: true,
  // seesOwnerEdits is unverified until the live check (D3): the gateway sends MESSAGE_UPDATE, but this is not tested.
  edits: { own: true, seesOwnerEdits: false },
  reactions: true,
  typing: true,
  silent: true,
  dm: true,
  forwardMarker: true,
  files: { inbound: true, outbound: true, maxUploadBytes: DC_FILE_BYTES, maxDownloadBytes: DC_FILE_BYTES, image: true },
  voice: { inbound: true },
  // sharedPause false: Discord's 429 buckets are per route; the REST library queues each bucket on its own.
  rate: { perChatPerMin: DC_RATE.perChatPerMin, burst: DC_RATE.burst, scope: 'thread', sharedPause: false },
}

// One entry of the in-memory channel index (decision 3). `parentId` is the category of a folder channel; `guildId` null for
// a DM; `name` is set for categories (the folder-category rule reads it).
export type ChannelInfo = { type: ChannelType; parentId: string | null; guildId: string | null; name?: string | null }
// Returns the index entry, or undefined for a channel the index does not know (the adapter fetches it before mapping).
export type ChannelLookup = (channelId: string) => ChannelInfo | undefined
// The bound server and its lobby text channel (where `!bind` was sent; it never moves).
export type HomeBinding = { guildId: string; lobbyId: string }

// The category kind of a channel name: 'active' (stolik, stolik 2…), 'idle' (stolik-idle, stolik-idle 2…), or null. Exact
// names only: `stolik-notes` or `stolik 1` are the owner's, not the bridge's.
export function folderCategoryKind(name: string | null | undefined): 'active' | 'idle' | null {
  if (typeof name !== 'string') return null
  const m = FOLDER_CATEGORY_RE.exec(name)
  if (!m) return null
  return m[1] !== undefined ? 'idle' : 'active'
}

// A folder channel: a text channel directly under a stolik category of the bound server (active or idle).
export function isFolderChannel(info: ChannelInfo | undefined, guildId: string, lookup: ChannelLookup): boolean {
  if (info === undefined || info.type !== ChannelType.GuildText || info.parentId === null) return false
  const parent = lookup(info.parentId)
  return parent !== undefined && parent.type === ChannelType.GuildCategory && parent.guildId === guildId && folderCategoryKind(parent.name) !== null
}

// The name Discord gets for a folder channel (decision 7 and the grill's name rule): lowercase, separators (spaces, `/`,
// `.`) become dashes, only letters, marks, digits, `_` and `-` stay, dashes collapse and are trimmed, at most 100
// characters, and `folder` when nothing is left.
export function folderChannelName(raw: string): string {
  const spaced = raw.toLowerCase().replace(/[\s/.]+/gu, '-')
  const kept = Array.from(spaced).filter((ch) => /[\p{L}\p{M}\p{N}_-]/u.test(ch)).join('')
  const tidy = kept.replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  const clipped = Array.from(tidy).slice(0, DC_NAME_CHARS).join('').replace(/-+$/g, '')
  return clipped === '' ? 'folder' : clipped
}

// The chat a gateway message came from, as the brain sees it (decision 5). A message without guild_id is a DM: bots are
// not in group DMs. The bound lobby is the bound home (thread null). A text channel directly under a stolik category of
// the bound server is the bound home with that channel as its thread (a folder). Any other guild text channel is a home
// with its own id (so `!bind` works there; the brain ignores it as "home other / unbound"). Anything else is other. A
// former forum post is other, so its thread id gets `thread-closed` from the adapter (stale ids recover).
export function chatRefOf(
  msg: { channel_id: string; guild_id?: string },
  binding: HomeBinding | null,
  lookup: ChannelLookup,
): ChatRef {
  if (!msg.guild_id) return { kind: 'dm', id: dcDm(msg.channel_id), thread: null }
  const guildId = msg.guild_id
  const bound = binding !== null && guildId === binding.guildId
  if (bound && msg.channel_id === binding.lobbyId) {
    return { kind: 'home', id: dcChat(binding.guildId, binding.lobbyId), thread: null }
  }
  const info = lookup(msg.channel_id)
  if (info === undefined) return { kind: 'other', id: dcChat(guildId, msg.channel_id), thread: null }
  if (bound && isFolderChannel(info, guildId, lookup)) {
    return { kind: 'home', id: dcChat(binding.guildId, binding.lobbyId), thread: dcThread(msg.channel_id) }
  }
  if (info.type === ChannelType.GuildText || info.type === ChannelType.GuildAnnouncement) {
    return { kind: 'home', id: dcChat(guildId, msg.channel_id), thread: null }
  }
  return { kind: 'other', id: dcChat(guildId, msg.channel_id), thread: null }
}

// True for a message the bridge may act on: the owner's own, from a user account (not a bot, not a webhook).
export function isOwnerMessage(msg: { author: { id: string; bot?: boolean }; webhook_id?: string }, ownerId: string): boolean {
  return msg.webhook_id === undefined && msg.author.bot !== true && msg.author.id === ownerId
}

// The kind of one attachment: the voice flag wins (a voice note is an ogg/opus file), then the MIME type.
function kindOf(a: APIAttachment, flags: number | undefined): AlbumItem['kind'] {
  if (flags !== undefined && (flags & MessageFlags.IsVoiceMessage) !== 0) return 'voice'
  const type = a.content_type ?? ''
  if (type.startsWith('image/')) return 'photo'
  if (type.startsWith('audio/')) return 'audio'
  if (type.startsWith('video/')) return 'video'
  return 'document'
}

// A gateway MESSAGE_CREATE as an Inbound, or null when it is not the owner's message or is a kind the bridge ignores
// (system messages). Forwards carry their text and files in the snapshot. Edits are not mapped here (MESSAGE_UPDATE is
// the adapter's job, and edits are not forwarded anyway).
export function inboundOf(msg: GatewayMessageCreateDispatchData, chat: ChatRef, ownerId: string): Inbound | null {
  if (!isOwnerMessage(msg, ownerId)) return null
  if (
    msg.type !== MessageType.Default &&
    msg.type !== MessageType.Reply &&
    msg.type !== MessageType.ChatInputCommand &&
    msg.type !== MessageType.ContextMenuCommand
  ) {
    return null
  }
  const ref = msg.message_reference
  const forwarded = ref?.type === MessageReferenceType.Forward
  const body = forwarded ? msg.message_snapshots?.[0]?.message : undefined
  const content = body?.content ?? msg.content
  const attachments: readonly APIAttachment[] = body?.attachments ?? msg.attachments
  const flags = msg.flags
  const messageId = dcMsg(msg.channel_id, msg.id)
  const replyToId =
    !forwarded && ref?.message_id !== undefined ? dcMsg(ref.channel_id ?? msg.channel_id, ref.message_id) : null
  const quoted = msg.referenced_message?.content
  const base = {
    messageId,
    replyToId,
    replyToText: replyToId !== null && quoted ? quoted : null,
    forwarded,
    from: msg.author.global_name ?? msg.author.username,
    fromId: dcUser(msg.author.id),
    chat,
  }
  const stickers = body?.sticker_items ?? msg.sticker_items
  if (attachments.length === 0 && stickers !== undefined && stickers.length > 0) {
    return { ...base, kind: 'unsupported', text: content, label: 'sticker' }
  }
  if (attachments.length === 0) return { ...base, kind: 'text', text: content }
  const items: AlbumItem[] = attachments.map((a) => ({
    messageId,
    kind: kindOf(a, flags),
    fileRef: a.url,
    fileName: a.filename,
    fileSize: a.size,
  }))
  const first = items[0]!
  const out: Inbound = {
    ...base,
    kind: first.kind,
    text: content,
    fileRef: first.fileRef,
    fileName: first.fileName,
    fileSize: first.fileSize,
  }
  if (items.length > 1) out.album = items
  return out
}

// Buttons as action rows. The router's callback data is the custom_id (decision 6). Throws on a row, label or payload
// over the limits, or a custom_id that repeats within the message: those are programming errors, not send failures.
export function rowsToComponents(rows: Rows): APIActionRowComponent<APIButtonComponentWithCustomId>[] {
  if (rows.length > DC_BUTTONS.maxRows) throw new ChatError('other', `too many button rows: ${rows.length} > ${DC_BUTTONS.maxRows}`)
  const seen = new Set<string>()
  return rows.map((row) => {
    if (row.length === 0 || row.length > DC_BUTTONS.maxPerRow) {
      throw new ChatError('other', `a button row has ${row.length} buttons (1-${DC_BUTTONS.maxPerRow} allowed)`)
    }
    return {
      type: ComponentType.ActionRow,
      components: row.map((b) => {
        const label = [...b.text]
        if (label.length === 0 || label.length > DC_BUTTONS.labelChars) {
          throw new ChatError('other', `button label must be 1-${DC_BUTTONS.labelChars} characters`)
        }
        if (b.data.length === 0 || Buffer.byteLength(b.data, 'utf8') > DC_BUTTONS.payloadBytes) {
          throw new ChatError('other', `button payload must be 1-${DC_BUTTONS.payloadBytes} bytes`)
        }
        if (seen.has(b.data)) throw new ChatError('other', `duplicate button custom_id in one message: ${JSON.stringify(b.data)}`)
        seen.add(b.data)
        return { type: ComponentType.Button, style: ButtonStyle.Secondary, label: b.text, custom_id: b.data }
      }),
    }
  })
}

// The text as Discord receives it. Agent text (format 'markdown') goes as written; router text is plain and is escaped,
// so a stray "*" or "#" stays literal. Throws ChatError 'too-long' past the limit (checked after escaping: escaping adds
// characters), since the router only chunks plain text.
export function contentFor(text: string, format: 'plain' | 'markdown' = 'plain'): string {
  return format === 'markdown'
    ? text
    : escapeMarkdown(text, { heading: true, bulletedList: true, numberedList: true, maskedLink: true })
}

// The length Discord counts for the text as the adapter sends it (after escaping). Used by the chat boundary to split.
export function contentLength(text: string, format: 'plain' | 'markdown' = 'plain'): number {
  return contentFor(text, format).length
}

export function contentOf(text: string, format: 'plain' | 'markdown' = 'plain'): string {
  const content = contentFor(text, format)
  if (content.length > DC_MAX_TEXT) {
    throw new ChatError('too-long', `message is ${content.length} characters; Discord allows ${DC_MAX_TEXT}`)
  }
  return content
}

export type SendOpts = {
  format?: 'plain' | 'markdown'
  silent?: boolean
  // The message this one answers, in its channel.
  replyTo?: { channelId: string; messageId: string } | null
  rows?: Rows
}

// The body of POST /channels/{id}/messages. `allowed_mentions` is always empty: no text pings anyone.
export function messageBody(text: string, opts: SendOpts = {}): RESTPostAPIChannelMessageJSONBody {
  const body: RESTPostAPIChannelMessageJSONBody = {
    content: contentOf(text, opts.format),
    allowed_mentions: { parse: [] },
  }
  if (opts.silent) body.flags = MessageFlags.SuppressNotifications
  if (opts.replyTo) {
    body.message_reference = {
      message_id: opts.replyTo.messageId,
      channel_id: opts.replyTo.channelId,
      fail_if_not_exists: false,
    }
  }
  if (opts.rows && opts.rows.length > 0) body.components = rowsToComponents(opts.rows)
  return body
}

// The body of PATCH /channels/{id}/messages/{id}. Empty components remove the keyboard (`perm: null` or no rows).
export function editBody(text: string, opts: { format?: 'plain' | 'markdown'; rows?: Rows } = {}): RESTPatchAPIChannelMessageJSONBody {
  return {
    content: contentOf(text, opts.format),
    allowed_mentions: { parse: [] },
    components: opts.rows && opts.rows.length > 0 ? rowsToComponents(opts.rows) : [],
  }
}

// Node and fetch errors that mean the request never got an answer (transient, see ChatError.transient).
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND', 'UND_ERR_SOCKET'])

// Discord's JSON error code to the kind the brain reads (decision 8). Codes come from RESTJSONErrorCodes only. An unknown
// channel is handled apart: thread-closed for a thread target, not-found otherwise.
const CODE_KIND = new Map<number, ChatErrorKind>([
  [RESTJSONErrorCodes.UnknownMessage, 'not-found'],
  [RESTJSONErrorCodes.UnknownInteraction, 'not-found'],
  [RESTJSONErrorCodes.MissingAccess, 'access-lost'],
  [RESTJSONErrorCodes.MissingPermissions, 'access-lost'],
  [RESTJSONErrorCodes.InvalidActionOnArchivedThread, 'thread-closed'],
  [RESTJSONErrorCodes.ThreadLocked, 'thread-closed'],
  [RESTJSONErrorCodes.RequestEntityTooLarge, 'too-long'],
  // Active thread cap of the guild, and the edit cap on messages older than an hour: both are platform quotas.
  [RESTJSONErrorCodes.MaximumActiveThreads, 'quota'],
  // The server's 500-channel cap (a folder cannot be made; the router logs it and the session uses the lobby).
  [RESTJSONErrorCodes.MaximumNumberOfGuildChannelsReached, 'quota'],
  [RESTJSONErrorCodes.MaximumNumberOfEditsToMessagesOlderThanOneHourReached, 'quota'],
  // A DM the bot cannot open (no shared server, or the user blocks DMs from it): the owner's DM route is lost.
  [RESTJSONErrorCodes.CannotSendMessagesToThisUser, 'access-lost'],
  [RESTJSONErrorCodes.CannotSendMessagesToThisUserDueToHavingNoMutualGuilds, 'access-lost'],
  // An empty message: the router never sends one on purpose, so it is a bug, reported as other.
  [RESTJSONErrorCodes.CannotSendAnEmptyMessage, 'other'],
])

// The ChatError behind a thrown value from @discordjs/rest or from the network: DiscordAPIError (`code`, `status`,
// `rawError.retry_after`), RateLimitError (`retryAfter` in ms) or a Node error. `opts.thread` says the request named a
// thread, which decides what "unknown channel" means.
export function toChatError(e: unknown, opts: { thread?: boolean } = {}): ChatError {
  if (e instanceof ChatError) return e
  const o = (typeof e === 'object' && e !== null ? e : {}) as {
    status?: unknown
    code?: unknown
    name?: unknown
    retryAfter?: unknown
    rawError?: { retry_after?: unknown }
  }
  const text = e instanceof Error ? e.message : String(e)
  const status = typeof o.status === 'number' ? o.status : undefined
  const code = typeof o.code === 'number' ? o.code : undefined
  if (status === 429) {
    const secs = o.rawError?.retry_after
    const ms = typeof secs === 'number' && Number.isFinite(secs) && secs >= 0 ? secs * 1000
      : typeof o.retryAfter === 'number' && Number.isFinite(o.retryAfter) && o.retryAfter >= 0 ? o.retryAfter
      : undefined
    return new ChatError('rate-limited', text, { status, description: text, retryAfterMs: ms, cause: e })
  }
  let kind: ChatErrorKind | undefined
  if (code === RESTJSONErrorCodes.UnknownChannel) kind = opts.thread ? 'thread-closed' : 'not-found'
  else if (code !== undefined) kind = CODE_KIND.get(code)
  const networkish = typeof o.code === 'string' && NETWORK_CODES.has(o.code)
  const transient = status !== undefined ? status >= 500 : networkish || o.name === 'AbortError' || o.name === 'TimeoutError'
  return new ChatError(kind ?? 'other', text, {
    status,
    description: text,
    transient: kind === undefined && transient,
    cause: e,
  })
}
