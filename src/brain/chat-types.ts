// Chat port types: what the router brain calls on a chat platform (Telegram today). Moved from src/ports.ts (chat
// connector step 0a). Interfaces and types only, no behaviour. Adapters implement ChatPort (src/adapters/chat/*).
// The types an adapter hands to the brain (Inbound, ButtonPress, ChatRef, ChatEvent, PermKeyboard, AlbumItem) live here,
// so no brain or router file imports an adapter for them (chat connector step 0d).
import type { Rows } from '../router/state.ts'
import type { NotifyLevel } from './notify-level.ts'

// Outbound priority class (queue order). Defined here so callers and the queue share one type.
export type Priority = 'urgent' | 'normal'

// What a reaction says about a message: seen (plain acknowledgement), queued (waits for the running turn), held (a
// gate holds it). The chat adapter picks the platform's emoji for each kind.
export type ReactKind = 'seen' | 'queued' | 'held'

// Opaque ids (plan 23 §2.1). Only the adapter that made an id may parse it. Always "<platform>:<rest>"; Telegram's are
// "tg:<n>" (helpers in src/adapters/chat/tg-ids.ts), end-to-end driver ids are "e2e:<n>" (src/router/e2e.ts).
export type Platform = 'tg' | 'dc' | 'sl' | 'mx' | 'e2e'
export type ChatId = string & { readonly __chat: unique symbol }      // tg:-1001234  dc:<guild>  sl:<team>  mx:<space>
export type ThreadId = string & { readonly __thread: unique symbol }  // tg:<n>  dc:<channel>  sl:<channel>  mx:<room>
export type MessageId = string & { readonly __msg: unique symbol }    // tg:<n>  dc:<channel>:<msg>  sl:<channel>:<ts>  mx:<room>:<event>
export type UserId = string & { readonly __user: unique symbol }      // tg:<n>  dc:<snowflake>  sl:<team>:<user>  mx:@u:server

// What a chat platform can do and its limits (plan 23 §2.1). The brain reads these instead of asking which platform it
// is.

export type Capabilities = {
  platform: Platform
  displayName: string                       // "Telegram", "Discord": used in help, setup and the agent instructions
  names: { home: string; lobby: string; thread: string }   // "group" / "General" / "topic"; "server" / "#general" / "post"
  commandSigil: '/' | '!'                   // Slack takes "/…" for itself, so it uses "!"
  // measure: the length the platform counts for a text after its own escaping (Discord escapes plain text); absent = the raw length.
  text: { maxChars: number; format: 'plain' | 'markdown' | 'mrkdwn' | 'html'; measure?: (text: string, format: 'plain' | 'markdown') => number }
  threads:
    | { kind: 'none' }
    | { kind: 'forum-topic' | 'forum-post' | 'channel' | 'room'
        maxNameChars: number; rename: boolean }
  buttons:
    | { kind: 'none' }
    | { kind: 'inline'; payloadBytes: number; maxRows: number; maxPerRow: number; labelChars: number
        toast: boolean; editable: boolean }
  replies: boolean                          // the owner can reply to one message and the bot sees which
  edits: { own: boolean; seesOwnerEdits: boolean }
  reactions: boolean
  typing: boolean
  silent: boolean
  dm: boolean                               // a private chat with the owner exists beside the home
  forwardMarker: boolean                    // inbound says "this text was written by someone else"
  files: { inbound: boolean; outbound: boolean; maxUploadBytes: number; maxDownloadBytes: number; image: boolean }
  voice: { inbound: boolean }
  rate: { perChatPerMin: number; burst: number; scope: 'chat' | 'thread'; sharedPause: boolean }
}

// The kinds of failure the brain tells apart. An adapter maps its platform's errors to these at its boundary (the
// Telegram adapter: toChatError in src/adapters/chat/telegram.ts). The brain never reads a platform error shape.
// 'quota': the platform's cap on an action (Discord: active threads per guild, edits of messages older than an hour).
export type ChatErrorKind = 'rate-limited' | 'not-found' | 'thread-closed' | 'access-lost' | 'too-long' | 'not-modified' | 'quota' | 'other'

export class ChatError extends Error {
  readonly kind: ChatErrorKind
  // The platform's HTTP-style status when it gave one (Telegram: error_code), else undefined.
  readonly status?: number
  // The platform's own words for the failure (Telegram: the API description), else undefined.
  readonly description?: string
  // For 'rate-limited': how long to wait before the next try.
  readonly retryAfterMs?: number
  // True when the same request may succeed later (a 5xx, a network error, a timeout). Used by the outbound queue.
  readonly transient: boolean

  constructor(
    kind: ChatErrorKind,
    message: string,
    opts: { status?: number; description?: string; retryAfterMs?: number; transient?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause })
    this.name = 'ChatError'
    this.kind = kind
    this.status = opts.status
    this.description = opts.description
    this.retryAfterMs = opts.retryAfterMs
    this.transient = opts.transient ?? false
  }
}

// The ChatError behind a thrown value: the value itself, or `reason` of a chunk group error (ChunkSendError in
// src/brain/outbound-queue.ts, duck-typed here so this file does not import the queue). Null for anything else.
export function chatErrorOf(e: unknown): ChatError | null {
  if (e instanceof ChatError) return e
  if (typeof e === 'object' && e !== null && 'reason' in e && (e as { reason: unknown }).reason instanceof ChatError) {
    return (e as { reason: ChatError }).reason
  }
  return null
}

// Where a send goes inside the group: `thread` is the forum topic's message_thread_id (omitted for General);
// `dm` sends to the owner's private chat instead of the group (fallback only). Chosen by src/brain/destinations.ts.
// `session` names the session a message is about: the queue serves sessions round-robin. Not sent to Telegram.
export type SendTarget = { thread?: ThreadId; dm?: boolean; session?: string }

// Where an update came from. `home` is a shared chat that can be the bridge's home (Telegram: any supergroup, so
// `/bind` works in an unbound one); `dm` is the owner's private chat with the bot; `other` is anything else (a plain
// group, a channel). `thread` is the topic inside the chat (null outside topics and in DMs).
export type ChatRef = { kind: 'dm' | 'home' | 'other'; id: ChatId; thread: ThreadId | null }

// One file of an album (a media group sent as one message to the bot).
export type AlbumItem = { messageId: MessageId; kind: Inbound['kind']; fileRef?: string; fileName?: string; fileSize?: number }

export type Inbound = {
  // 'edited': the owner edited a message (edits are not forwarded). 'unsupported': a kind the bot cannot forward
  // (a sticker, a location, a poll...); `label` names it.
  kind: 'text' | 'photo' | 'document' | 'audio' | 'video' | 'video_note' | 'voice' | 'edited' | 'unsupported'
  messageId: MessageId
  text: string // message text, or caption for media ('' if none)
  replyToId: MessageId | null
  // The text (or caption) of the message replied to, null when there is none. Starts a session with the quote.
  replyToText: string | null
  forwarded: boolean
  from: string
  // Telegram user id of the sender (the owner's id for every message that gets this far).
  fromId: UserId
  // Set by the router for a message it makes on an addon's behalf (addon-bridge spawn). Such a message is never the owner,
  // whatever its fromId says: identity meta reads this field, not names.
  origin?: 'addon'
  fileRef?: string
  fileName?: string
  fileSize?: number
  label?: string
  // An album: every file of the media group, in order (the first one is also in the fields above).
  album?: AlbumItem[]
  // Where the message came from. Required: an adapter always says it.
  chat: ChatRef
}

// A button tap. `message` is null when the platform left the message out. `pressId` is what `ackButton` answers.
export type ButtonPress = { pressId: string; data: string; message: MessageId | null; from: UserId; chat: ChatRef }

export type PermKeyboard = { requestId: string; withMore: boolean; redacted: boolean }

// Service events from the chat platform. The adapter classifies them (member status, the bot's rights, group
// migration); the brain decides what they mean (src/brain/inbound.ts decideChatEvent).
export type ChatEvent =
  // The bound home moved to another id (a group became a supergroup). `from` is the old id, `to` the new one.
  | { type: 'home-moved'; from: ChatId; to: ChatId }
  // Someone other than the owner and the bot joined a chat. `label` names the member.
  | { type: 'stranger-joined'; chat: ChatId; label: string }
  // The bot gained or lost the rights it needs in a chat. `reason` is the platform's word for its state.
  | { type: 'access'; chat: ChatId; access: 'ok' | 'lost'; reason: string }
  // A message in the chat has no attributable sender (posted as the chat itself, e.g. by an anonymous admin).
  | { type: 'unattributable-post'; chat: ChatId }

// The bot's Telegram side: inbound updates in, messages and file transfers out. The adapter forwards updates from
// the owner only (`fromId`) with their chat (`chat`); the brain decides what each one means (src/brain/inbound.ts).
// Implemented by the Telegram adapter (src/adapters/chat/telegram.ts, grammY inside).
export interface ChatPort {
  // What this platform can do and its limits (see Capabilities). Constant for the life of the adapter.
  readonly capabilities: Capabilities
  // Sends a text message; returns its message id. `replyTo` makes it a reply, `perm`/`rows` attach buttons.
  // `priority: 'urgent'` jumps the outbound queue (approvals, questions, plan approvals); default 'normal'.
  // `level` (spec 24): how loud the message is. The router's send wrapper (src/router/mute.ts) turns it into `silent`
  // (muted folder topics included) and strips it before the adapter sees the send. Adapters ignore it.
  sendText(
    text: string,
    opts?: { replyTo?: MessageId; perm?: PermKeyboard; rows?: Rows; silent?: boolean; level?: NotifyLevel; priority?: Priority; quiet?: boolean; format?: 'markdown' } & SendTarget,
  ): Promise<MessageId>
  // `quiet`: a failed send is not reported to the Logs topic (the Logs topic's own sends).
  // Sends several texts as one group: in order, one after another, so no normal send lands between them. An urgent
  // send may land between chunks (it is never held behind a whole group), and the group then goes on in order. Returns
  // the message ids in order. Stops at the first failure and throws a ChunkSendError (src/brain/outbound-queue.ts)
  // whose `sentIds` are the chunks that did go out.
  // `replyTo` answers the first chunk; `rows` (buttons) go on the last chunk only.
  sendChunks(
    texts: readonly string[],
    opts?: { silent?: boolean; level?: NotifyLevel; priority?: Priority; replyTo?: MessageId; rows?: Rows; format?: 'markdown' } & SendTarget,
  ): Promise<MessageId[]>
  // `format: 'markdown'`: the text is Markdown, sent as Telegram HTML (src/markdown.ts), plain text when Telegram refuses it.
  // Sends a local file as a document, or as a photo when `asPhoto`. Returns the message id.
  // `silent` (in the target): no ping, as for sendText.
  sendFile(path: string, asPhoto: boolean, target?: SendTarget & { silent?: boolean; level?: NotifyLevel }): Promise<MessageId>
  // Sets the bound supergroup (null: DM mode). Sends and edits without a `dm` target go there, else to the DM chat.
  setHome(groupId: ChatId | null): void
  // The link that opens the bound home for its members (Telegram: t.me/c/<id>), null when there is none. Optional.
  homeLink?(): string | null
  // Forum topics in the bound group (plan 2.2). `createThread` returns the new topic's message_thread_id.
  createThread(name: string): Promise<ThreadId>
  renameThread(threadId: ThreadId, name: string): Promise<void>
  reopenThread(threadId: ThreadId): Promise<void>
  // Replaces a message's text. `perm: null` removes its keyboard. The edit goes to the chat the message was sent to
  // (the adapter remembers it). `priority: 'urgent'` for approval and question edits.
  editText(messageId: MessageId, text: string, perm: PermKeyboard | null, priority?: Priority): Promise<void>
  // Replaces a message's text and buttons. An empty row list removes the keyboard.
  editRows(messageId: MessageId, text: string, rows: Rows, priority?: Priority): Promise<void>
  // Removes a message's keyboard and leaves its text alone.
  // `target` names the chat when the adapter has no record of the message (for stored messages after a restart).
  clearButtons?(messageId: MessageId, target?: SendTarget): Promise<void>
  // Whether a message was sent to the owner's DM (undefined when the adapter has no record of it).
  isDm?(messageId: MessageId): boolean | undefined
  // Answers a button tap (clears the spinner; `text` is the toast shown to the user).
  ackButton(id: string, text?: string): Promise<void>
  // Puts a reaction of the given kind on a message. The adapter maps the kind to the platform's own reaction.
  react(messageId: MessageId, kind: ReactKind): Promise<void>
  // Sets the bot's command menu (names and descriptions, see brain/commands.ts). Optional: a platform without a menu skips it.
  setCommands?(list: ReadonlyArray<{ command: string; description: string }>): void
  // Called when Telegram refuses a send to the bound group for good (the bot was removed or lost its rights).
  onAccessError?(fn: (reason: string) => void): void
  // Keyboards on messages the bot sent, as the adapter tracks them, and the stored list at start (see the router).
  onLiveButtons?(fn: (list: Array<{ messageId: MessageId; dm: boolean }>) => void): void
  // Shows the "typing" action in the chat (in a topic when `target.thread` is set).
  typing(target?: SendTarget): Promise<void>
  // Downloads a Telegram file to `dest`, refusing anything over `maxBytes`.
  download(fileRef: string, dest: string, maxBytes: number): Promise<void>
  // Registers the handlers for inbound messages, button taps, service events (group migration, member joins, the
  // bot's own rights), and for the first successful connect.
  onInbound(fn: (m: Inbound) => Promise<void>): void
  onButton(fn: (c: ButtonPress) => Promise<void>): void
  onChatEvent(fn: (e: ChatEvent) => Promise<void>): void
  onStarted(fn: () => void): void
  // Orders two message ids of this chat: negative when a is older, 0 when equal, positive when a is newer. The
  // adapter knows how (Telegram: numeric; Matrix: a timestamp cache), so callers never parse ids.
  compareMessages(a: MessageId, b: MessageId): number
  // Starts and stops polling. `stop` resolves once polling has ended, so unconfirmed updates stay on Telegram's side.
  start(): void
  stop(): Promise<void>
  // Shutdown of the outbound side: urgent sends still go out for `budgetMs` (a duration from now), the rest is refused.
  // Optional: an adapter that sends directly has nothing to drain.
  drain?(budgetMs: number): Promise<void>
}
