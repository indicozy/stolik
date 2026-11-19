// In-memory ports for router tests (plan S11). No network, no files, no real timers: every port records what the
// router asked for, and the test drives inbound messages, socket messages and the clock by hand.
import { REACTION_EMOJI, TELEGRAM_CAPABILITIES, toChatError } from '../../src/adapters/chat/telegram.ts'
import type { TranscriptMeta } from '../../src/brain/resume.ts'
import { ChunkSendError } from '../../src/brain/outbound-queue.ts'
import { existsSync, statSync } from 'node:fs'
import { ChatError, type ChatErrorKind, type ButtonPress, type Capabilities, type ChatEvent, type Inbound, type PermKeyboard, type Priority, type ReactKind, type SendTarget, type MessageId } from '../../src/brain/chat-types.ts'
import type { StartupOutcome } from '../../src/adapters/tmux.ts'
import type { IdleAlert, IdleState } from '../../src/brain/away.ts'
import type { Rows, SessionKey } from '../../src/router/state.ts'
import type { AgentBackend, Audit, Clock, LedgerRecord, Logger, MlPort, PlatformPort, ResourceMode, SocketConn, SocketHandler, StorePort } from '../../src/ports.ts'
import type { ChatPort } from '../../src/brain/chat-types.ts'
import { tgGroupLink, tgMsg, tgNum, tgThread } from '../../src/adapters/chat/tg-ids.ts'
import type { ChatId, ThreadId } from '../../src/brain/chat-types.ts'
import { Router } from '../../src/router/core.ts'
import type { E2e } from '../../src/router/e2e.ts'
import type { AddonsPort, ChatLogPort } from '../../src/ports.ts'

export const OWNER = 'tg:111'
export const HOME = '/home/u'

// A socket connection the test controls. Everything the router writes to it lands in `sent`.
export class FakeConn implements SocketConn {
  readonly sent: any[] = []
  ended = false
  destroyed = false

  send(msg: object): void {
    this.sent.push(msg)
  }

  end(): void {
    this.ended = true
    this.destroyed = true
  }
}

type SendOpts = { replyTo?: MessageId; perm?: PermKeyboard; rows?: Rows; silent?: boolean; thread?: ThreadId; dm?: boolean; format?: 'markdown' }
// `chat` is where the send went: 'group' (the bound supergroup) or 'dm' (the owner's private chat).
export type SentText = { id: MessageId; text: string; opts: SendOpts | undefined; chat: 'group' | 'dm' }
export type TopicOp = { op: 'create' | 'edit' | 'close' | 'reopen' | 'delete'; threadId?: ThreadId; name?: string }

// The Discord-shaped profile of the fake (plan 23 §2.1 ids, decision 2 in research/d1-brief.md). Snowflakes are 19 digits
// and differ by 1 from one message to the next, so a Number() on them would collapse two ids. The ids are these:
// message dc:<channel>:<message>, thread (post) dc:<channel>, home dc:g<guild>:l<lobby>, DM dc:d<channel>, user dc:<snowflake>.
export const DISCORD_GUILD = 'dc:g100000000000000001:l100000000000000002'
export const DISCORD_OWNER = 'dc:1000000000000000099'
const DISCORD_LOBBY = '100000000000000002'
const DISCORD_DM = '100000000000000003'
const DISCORD_SNOWFLAKE = 1_000_000_000_000_000_000n
export const DISCORD_FAKE_CAPABILITIES: Capabilities = {
  ...TELEGRAM_CAPABILITIES,
  platform: 'dc',
  displayName: 'Discord',
  names: { home: 'server', lobby: '#general', thread: 'post' },
  commandSigil: '/',
  text: { maxChars: 2000, format: 'markdown' },
  threads: { kind: 'channel', maxNameChars: 100, rename: true, close: true },
  buttons: { kind: 'inline', payloadBytes: 100, maxRows: 5, maxPerRow: 5, labelChars: 80, toast: true, editable: true },
  rate: { perChatPerMin: 30, burst: 5, scope: 'thread', sharedPause: false },
}

export class FakeChat implements ChatPort {
  // Telegram's capabilities unless a test passes others (the adapter contract, a Discord-shaped smoke test).
  readonly capabilities: Capabilities
  private readonly discord: boolean
  constructor(opts: { capabilities?: Capabilities; discord?: boolean } = {}) {
    this.discord = opts.discord === true
    this.capabilities = opts.capabilities ?? (this.discord ? DISCORD_FAKE_CAPABILITIES : TELEGRAM_CAPABILITIES)
  }

  // The id of the n-th message sent to `opts` (a thread, a DM or the home lobby).
  private msgId(n: number, opts?: { thread?: ThreadId; dm?: boolean }): MessageId {
    if (!this.discord) return tgMsg(n)
    const channel = opts?.thread !== undefined ? this.snowflake(opts.thread) : this.chatFor(opts) === 'dm' ? DISCORD_DM : DISCORD_LOBBY
    return `dc:${channel}:${DISCORD_SNOWFLAKE + BigInt(n)}` as MessageId
  }

  private threadId(n: number): ThreadId {
    return this.discord ? (`dc:${DISCORD_SNOWFLAKE + 1_000_000n + BigInt(n)}` as ThreadId) : tgThread(n)
  }

  private snowflake(thread: ThreadId): string {
    return thread.slice('dc:'.length)
  }
  // The next platform call is refused with this failure, after `skip` calls went through (chat contract, E9 and E3).
  private platformFailure: { kind: ChatErrorKind | 'network' | 'server' | 'client'; skip: number } | null = null
  readonly sent: SentText[] = []
  readonly files: Array<{ id: MessageId; path: string; asPhoto: boolean; target: { thread?: ThreadId; dm?: boolean } | undefined; chat: 'group' | 'dm' }> = []
  readonly typings: Array<{ thread?: ThreadId; dm?: boolean; chat: 'group' | 'dm' }> = []
  readonly edits: Array<{ messageId: MessageId; text: string }> = []
  readonly reactions: Array<{ messageId: MessageId; emoji: string }> = []
  readonly topicOps: TopicOp[] = []
  // Topic operations named here throw (simulates Telegram refusing, e.g. a topic deleted by hand).
  readonly failTopicOps = new Set<TopicOp['op']>()
  // Topic operations that throw with this Telegram description (e.g. TOPIC_NOT_MODIFIED).
  readonly topicErrors = new Map<TopicOp['op'], string>()
  // Threads Telegram no longer has: a send into one fails with "message thread not found".
  readonly goneThreads = new Set<ThreadId>()
  // When set, createThread / edits wait for it (lets a test end a session while its topic is being made, or hold an edit).
  createGate: Promise<void> | null = null
  editGate: Promise<void> | null = null
  // Keyboard removals (clearButtons), in call order.
  readonly clearedKeyboards: Array<{ messageId: MessageId; target?: SendTarget }> = []
  private accessFn: ((reason: string) => void) | null = null
  // The bound supergroup (null: DM mode). Mirrors what the adapter does with setHome.
  group: ChatId | null = null
  private nextId = 1
  private nextThread = 100
  private inboundFn: ((m: Inbound) => Promise<void>) | null = null
  private callbackFn: ((c: ButtonPress) => Promise<void>) | null = null
  private chatEventFn: ((e: ChatEvent) => Promise<void>) | null = null

  private chatFor(target?: { dm?: boolean }): 'group' | 'dm' {
    return target?.dm || this.group === null ? 'dm' : 'group'
  }

  // Arms the next platform failure (see platformFailure). The adapter maps platform errors to these kinds; the fake
  // throws the mapped ChatError itself.
  fail(kind: NonNullable<FakeChat['platformFailure']>['kind'], skip = 0): void {
    this.platformFailure = { kind, skip }
  }

  private refuse(): void {
    const f = this.platformFailure
    if (!f) return
    if (f.skip > 0) {
      f.skip--
      return
    }
    this.platformFailure = null
    switch (f.kind) {
      case 'rate-limited': throw new ChatError('rate-limited', 'fake telegram: rate limited', { retryAfterMs: 2000 })
      case 'network': throw new ChatError('other', 'fake telegram: network', { transient: true })
      case 'server': throw new ChatError('other', 'fake telegram: server', { status: 500, transient: true })
      case 'client': throw new ChatError('other', 'fake telegram: client', { status: 400 })
      default: throw new ChatError(f.kind, `fake telegram: ${f.kind}`)
    }
  }

  // Telegram refuses a text over its limit; the router splits first (chunkText), so this is the platform's refusal.
  private checkTextLength(text: string): void {
    if (text.length > this.capabilities.text.maxChars) throw new ChatError('too-long', 'fake telegram: message is too long')
  }

  async sendText(text: string, opts?: SendOpts): Promise<MessageId> {
    this.refuse()
    this.checkTextLength(text)
    if (opts?.thread !== undefined && this.goneThreads.has(opts.thread)) {
      throw new ChatError('thread-closed', 'Bad Request: message thread not found')
    }
    const id = this.msgId(this.nextId++, opts)
    this.sent.push({ id, text, opts, chat: this.chatFor(opts) })
    return id
  }

  // Chunk groups, in call order: the texts and the options of each sendChunks call.
  readonly chunkCalls: Array<{ texts: string[]; opts: SendOpts | undefined }> = []
  // Set to a chunk index: the next sendChunks call fails on that chunk (the chunks before it go out).
  failChunkIndex: number | null = null

  // Like the adapter: `replyTo` on the first chunk, `rows` on the last only.
  async sendChunks(
    texts: readonly string[],
    opts?: { silent?: boolean; priority?: Priority; replyTo?: MessageId; rows?: Rows; format?: 'markdown' } & { thread?: ThreadId; dm?: boolean },
  ): Promise<MessageId[]> {
    this.chunkCalls.push({ texts: [...texts], opts })
    const ids: MessageId[] = []
    const { replyTo, rows, ...common } = opts ?? {}
    for (let i = 0; i < texts.length; i++) {
      if (this.failChunkIndex === i) {
        this.failChunkIndex = null
        throw new ChunkSendError(new Error('fake telegram: chunk refused'), ids)
      }
      const chunkOpts: SendOpts = {
        ...common,
        ...(i === 0 && replyTo !== undefined ? { replyTo } : {}),
        ...(i === texts.length - 1 && rows ? { rows } : {}),
      }
      try {
        ids.push(await this.sendText(texts[i], chunkOpts))
      } catch (e) {
        // Like the adapter: a failed chunk stops the group with a ChunkSendError listing the chunks already sent.
        throw new ChunkSendError(e, ids)
      }
    }
    return ids
  }

  async sendFile(path: string, asPhoto: boolean, target?: { thread?: ThreadId; dm?: boolean; silent?: boolean }): Promise<MessageId> {
    this.refuse()
    if (existsSync(path) && statSync(path).size > this.capabilities.files.maxUploadBytes) throw new ChatError('too-long', 'fake telegram: file is too big')
    const id = this.msgId(this.nextId++, target)
    this.files.push({ id, path, asPhoto, target, chat: this.chatFor(target) })
    return id
  }

  setHome(groupId: ChatId | null): void {
    this.group = groupId
  }

  // Mirrors the Telegram adapter: the link to the bound home (null in DM mode or when there is no link).
  homeLink(): string | null {
    return this.group === null ? null : tgGroupLink(this.group)
  }

  private topicOp(op: TopicOp): void {
    this.refuse()
    if (this.failTopicOps.has(op.op)) throw new Error(`fake telegram: ${op.op} refused`)
    const msg = this.topicErrors.get(op.op)
    if (msg !== undefined) throw toChatError(new Error(msg))
    this.topicOps.push(op)
  }

  async createThread(name: string): Promise<ThreadId> {
    if (this.createGate) await this.createGate
    const threadId = this.threadId(this.nextThread++)
    const max = this.capabilities.threads.kind === 'none' ? name.length : this.capabilities.threads.maxNameChars
    this.topicOp({ op: 'create', threadId, name: name.slice(0, max) })
    return threadId
  }

  async renameThread(threadId: ThreadId, name: string): Promise<void> {
    this.topicOp({ op: 'edit', threadId, name })
  }

  async closeThread(threadId: ThreadId): Promise<void> {
    this.topicOp({ op: 'close', threadId })
  }

  async reopenThread(threadId: ThreadId): Promise<void> {
    this.topicOp({ op: 'reopen', threadId })
  }

  // Every editText call, with its keyboard (null removes it).
  readonly permEdits: Array<{ messageId: MessageId; text: string; perm: PermKeyboard | null }> = []

  async editText(messageId: MessageId, text: string, perm: PermKeyboard | null): Promise<void> {
    this.refuse()
    if (this.editGate) await this.editGate
    this.edits.push({ messageId, text })
    this.permEdits.push({ messageId, text, perm })
  }

  async clearButtons(messageId: MessageId, target?: SendTarget): Promise<void> {
    this.refuse()
    this.clearedKeyboards.push({ messageId, target })
  }

  // Whether a message was sent to the DM (undefined when it was not sent here).
  isDm(messageId: MessageId): boolean | undefined {
    const m = this.sent.find((x) => x.id === messageId) ?? this.files.find((x) => x.id === messageId)
    return m ? m.chat === 'dm' : undefined
  }

  onAccessError(fn: (reason: string) => void): void {
    this.accessFn = fn
  }

  // Test driver: Telegram refused a send to the group for good.
  accessError(reason: string): void {
    this.accessFn?.(reason)
  }

  // Every editRows call, with its buttons (empty when the keyboard was removed).
  readonly rowEdits: Array<{ messageId: MessageId; text: string; rows: Rows }> = []

  async editRows(messageId: MessageId, text: string, rows: Rows): Promise<void> {
    this.refuse()
    if (this.editGate) await this.editGate
    this.edits.push({ messageId, text })
    this.rowEdits.push({ messageId, text, rows })
  }

  readonly answers: Array<{ id: string; text?: string }> = []

  async ackButton(id: string, text?: string): Promise<void> {
    this.refuse()
    this.answers.push({ id, text })
  }

  async react(messageId: MessageId, kind: ReactKind): Promise<void> {
    this.refuse()
    this.reactions.push({ messageId, emoji: REACTION_EMOJI[kind] })
  }

  async typing(target?: { thread?: ThreadId; dm?: boolean }): Promise<void> {
    this.refuse()
    this.typings.push({ ...target, chat: this.chatFor(target) })
  }

  async download(): Promise<void> {
    throw new Error('fake telegram: downloads are not modelled')
  }

  onInbound(fn: (m: Inbound) => Promise<void>): void {
    this.inboundFn = fn
  }

  onButton(fn: (c: ButtonPress) => Promise<void>): void {
    this.callbackFn = fn
  }

  onChatEvent(fn: (e: ChatEvent) => Promise<void>): void {
    this.chatEventFn = fn
  }

  onStarted(_fn: () => void): void {}

  compareMessages(a: MessageId, b: MessageId): number {
    if (!this.discord) return tgNum(a) - tgNum(b)
    // The snowflake is the last part of a Discord message id; BigInt, never Number.
    const x = BigInt(a.slice(a.lastIndexOf(':') + 1))
    const y = BigInt(b.slice(b.lastIndexOf(':') + 1))
    return x === y ? 0 : x > y ? 1 : -1
  }

  start(): void {}

  async stop(): Promise<void> {}

  // Test drivers: hand a message to the router the way the Telegram adapter would.
  // A message or tap without a chat is the owner's DM (the fakes always had that default; the adapter always sets one).
  async inbound(m: Omit<Inbound, 'chat'> & { chat?: Inbound['chat'] }): Promise<void> {
    if (!this.inboundFn) throw new Error('router has not started')
    await this.inboundFn({ ...m, chat: m.chat ?? { kind: 'dm', id: '' as ChatId, thread: null } })
  }

  async callback(c: Omit<ButtonPress, 'chat'> & { chat?: ButtonPress['chat'] }): Promise<void> {
    if (!this.callbackFn) throw new Error('router has not started')
    await this.callbackFn({ ...c, chat: c.chat ?? { kind: 'dm', id: '' as ChatId, thread: null } })
  }

  async chatEvent(e: ChatEvent): Promise<void> {
    if (!this.chatEventFn) throw new Error('router has not started')
    await this.chatEventFn(e)
  }

  texts(): string[] {
    return this.sent.map((s) => s.text)
  }
}

export class FakeStore implements StorePort {
  liveButtons = ''
  msgMap = ''
  locked = false
  model: string | null = null
  bootId: string | null = null
  groupId: ChatId | null = null
  topicsJson = ''
  mutesJson = ''
  privacyJson = ''
  readonly notes: string[] = []
  readonly startupNotices: string[] = []
  private ledger: LedgerRecord[] = []

  listLedger(sessionKey: SessionKey): LedgerRecord[] {
    return this.ledger.filter((r) => r.sessionKey === sessionKey)
  }

  appendLedger(entries: readonly LedgerRecord[]): void {
    this.ledger.push(...entries)
  }

  pruneOutboundLedger(olderThanMs: number): number {
    const before = this.ledger.length
    this.ledger = this.ledger.filter((r) => r.at >= olderThanMs)
    return before - this.ledger.length
  }

  readGroupId(): ChatId | null {
    return this.groupId
  }

  readLiveButtons(): string {
    return this.liveButtons
  }

  writeLiveButtons(json: string): void {
    this.liveButtons = json
  }

  writeGroupId(id: ChatId): void {
    this.groupId = id
  }

  readTopics(): string {
    return this.topicsJson
  }

  writeTopics(json: string): void {
    this.topicsJson = json
  }

  readMutes(): string {
    return this.mutesJson
  }

  readPrivacyReported(): string {
    return this.privacyJson
  }

  writePrivacyReported(text: string): void {
    this.privacyJson = text
  }

  writeMutes(json: string): void {
    this.mutesJson = json
  }

  readMsgMap(): string {
    return this.msgMap
  }

  writeMsgMap(json: string): void {
    this.msgMap = json
  }

  isLocked(): boolean {
    return this.locked
  }

  setLocked(on: boolean): void {
    this.locked = on
  }

  defaultModel(): string | null {
    return this.model
  }

  setDefaultModel(model: string | null): void {
    this.model = model
  }

  readLastBootId(): string | null {
    return this.bootId
  }

  writeBootId(bootId: string): void {
    this.bootId = bootId
  }

  appendNote(entry: string): void {
    this.notes.push(entry)
  }

  async saveAttachment(_src: string, fileName: string): Promise<string> {
    return `/fake/attachments/${fileName}`
  }

  inboxPath(fileName: string): string {
    return `/fake/inbox/${fileName}`
  }

  attachmentPath(fileName: string): string {
    return `/fake/attachments/${fileName}`
  }

  attachmentExists(_fileName: string): boolean {
    return false
  }
}

export class FakePlatform implements PlatformPort {
  away = false
  hereAt: number | null = null
  readonly dirs = new Set<string>()
  readonly files = new Map<string, { isFile: boolean; size: number }>()
  readonly dead = new Set<number>()

  async idleMs(): Promise<number | null> {
    return 0
  }

  async isLocked(): Promise<boolean> {
    return false
  }

  // Set to 'unknown' (or 'active') to force the tri-state answer; null derives it from `away`.
  stateOverride: IdleState | null = null
  // Alerts the next takeIdleAlert calls return, oldest first.
  readonly idleAlerts: IdleAlert[] = []

  async isAway(): Promise<boolean> {
    return (await this.awayState()) !== 'active'
  }

  async awayState(): Promise<IdleState> {
    return this.stateOverride ?? (this.away ? 'idle' : 'active')
  }

  takeIdleAlert(): IdleAlert | null {
    return this.idleAlerts.shift() ?? null
  }

  // The owner's desk or away mode (the ai-resources file). Default 'desk'.
  mode: ResourceMode = 'desk'

  async resourceMode(): Promise<ResourceMode> {
    return this.mode
  }

  setAway(): void {
    this.away = true
  }

  setHere(now: number): void {
    this.away = false
    this.hereAt = now
  }

  pidAlive(pid: number): boolean {
    return !this.dead.has(pid)
  }

  processArgv(_pid: number): string[] | null {
    return ['claude']
  }

  // Start times default to `start-<pid>`; a test sets `starts` to model a reused pid.
  readonly starts = new Map<number, string>()

  processStart(pid: number): string | null {
    return this.starts.get(pid) ?? `start-${pid}`
  }

  // Parent pids for the spawn fallback (a register without a token). Unset pids have no parent.
  readonly parents = new Map<number, number>()

  parentPid(pid: number): number | null {
    return this.parents.get(pid) ?? null
  }

  // The process tree for idle detection: children per pid, argv and names per pid. Unset pids have no children and no
  // name. `treeUnreadable` makes childPids and descendants return null, as an unreadable /proc does.
  readonly children = new Map<number, number[]>()
  readonly names = new Map<number, string>()
  readonly argvs = new Map<number, string[]>()
  readonly signals: Array<{ pid: number; sig: string }> = []
  treeUnreadable = false
  // What terminalWindowPid returns for any claude pid. Null by default (no terminal window hosts the session).
  terminalWindow: number | null = null

  childPids(pid: number): number[] | null {
    if (this.treeUnreadable) return null
    return [...(this.children.get(pid) ?? [])]
  }

  descendants(pid: number): Array<{ pid: number; argv: string[] }> | null {
    if (this.treeUnreadable) return null
    const out: Array<{ pid: number; argv: string[] }> = []
    const stack = [pid]
    while (stack.length > 0) {
      for (const kid of this.children.get(stack.pop() as number) ?? []) {
        out.push({ pid: kid, argv: this.argvs.get(kid) ?? [] })
        stack.push(kid)
      }
    }
    return out
  }

  processName(pid: number): string | null {
    return this.names.get(pid) ?? null
  }

  signal(pid: number, sig: 'SIGTERM' | 'SIGKILL'): boolean {
    this.signals.push({ pid, sig })
    return !this.dead.has(pid)
  }

  terminalWindowPid(_claudePid: number): number | null {
    return this.terminalWindow
  }

  bootId(): string {
    return 'boot-test'
  }

  uptimeSeconds(): number | null {
    return 1000
  }

  realpath(path: string): string | null {
    return this.dirs.has(path) || this.files.has(path) ? path : null
  }

  isDirectory(path: string): boolean {
    return this.dirs.has(path)
  }

  fileInfo(path: string): { isFile: boolean; size: number } | null {
    return this.files.get(path) ?? null
  }

  pinCpus(_cpus: readonly number[]): void {}
}

export class FakeAgent implements AgentBackend {
  // Folders the agent trusts (the same set is what trustedFolders lists).
  readonly trusted = new Set<string>()
  transcripts: TranscriptMeta[] = []
  readonly live = new Map<string, number>()
  readonly startedSessions: Array<{ project: string; dir: string; extra: readonly string[] }> = []
  // The spawn token each start was given, in the same order as startedSessions.
  readonly spawnTokens: string[] = []
  readonly sent: Array<{ key: SessionKey; content: string; meta: Record<string, string> }> = []
  readonly permissions: Array<{ key: SessionKey; requestId: string; behavior: 'allow' | 'deny' }> = []
  private readonly sessions = new Map<SessionKey, SocketConn>()
  private handler: SocketHandler | null = null

  onEvent(_fn: unknown): void {}

  async start(handler: SocketHandler): Promise<void> {
    this.handler = handler
  }

  async stop(): Promise<void> {
    this.handler = null
  }

  isInteractive(_pid: number | null): boolean {
    return true
  }

  sweep(): void {}

  attachSession(key: SessionKey, conn: SocketConn): void {
    this.sessions.set(key, conn)
  }

  detachSession(conn: SocketConn): SessionKey | null {
    for (const [key, c] of this.sessions) {
      if (c === conn) {
        this.sessions.delete(key)
        return key
      }
    }
    return null
  }

  dropSession(key: SessionKey): void {
    this.sessions.delete(key)
  }

  isConnected(key: SessionKey): boolean {
    return this.sessions.has(key)
  }

  sendToSession(key: SessionKey, content: string, meta: Record<string, string>): boolean {
    if (!this.sessions.has(key)) return false
    this.sent.push({ key, content, meta })
    return true
  }

  answerPermission(key: SessionKey, requestId: string, behavior: 'allow' | 'deny'): boolean {
    if (!this.sessions.has(key)) return false
    this.permissions.push({ key, requestId, behavior })
    return true
  }

  // Every answer to a PermissionRequest hook: the decision sent (null for none, the terminal dialog shows).
  readonly askDecisions: Array<{ conn: SocketConn; decision: unknown }> = []

  respondToAsk(conn: SocketConn, decision: unknown): void {
    this.askDecisions.push({ conn, decision })
    conn.end()
  }

  async startSession(project: string, dir: string, extra: readonly string[] = [], spawnToken?: string): Promise<string> {
    this.startedSessions.push({ project, dir, extra })
    if (spawnToken !== undefined) this.spawnTokens.push(spawnToken)
    return `tg-${project}`
  }

  // Stopped (killed) tmux sessions, in order. `panes` maps a session name to its pane pid (default null).
  readonly killedSessions: string[] = []
  readonly panes = new Map<string, number>()

  async killSession(name: string): Promise<void> {
    this.killedSessions.push(name)
  }

  async panePid(name: string): Promise<number | null> {
    return this.panes.get(name) ?? null
  }

  // Startup watches resolve at once as `done` unless a test sets `startupOutcome`. `paneLines` is what paneTail returns.
  startupOutcome: StartupOutcome = { kind: 'done' }
  paneLines: string[] = []

  async watchStartup(_name: string, _timeoutMs: number, _isRegistered: () => boolean, _onMiss?: (pane: string[]) => void): Promise<StartupOutcome> {
    return this.startupOutcome
  }

  async paneTail(_name: string): Promise<string[]> {
    return this.paneLines
  }

  liveSessionIds(): Map<string, number> {
    return new Map(this.live)
  }

  async listTranscripts(): Promise<TranscriptMeta[]> {
    return [...this.transcripts]
  }

  isTrusted(realFolder: string): boolean {
    return this.trusted.has(realFolder)
  }

  trustedFolders(): string[] {
    return [...this.trusted]
  }

  // Test drivers: a socket message arrives on `conn`, or the connection closes.
  receive(conn: SocketConn, msg: unknown): void {
    if (!this.handler) throw new Error('router has not started')
    this.handler.message(conn, msg)
  }

  disconnect(conn: SocketConn): void {
    if (!this.handler) throw new Error('router has not started')
    this.handler.close(conn)
  }
}

type Timer = { id: number; at: number; fn: () => void; every: number | null; cancelled: boolean }

// Timers fire only when the test calls advance(ms), in time order. Repeating timers re-arm.
export class FakeClock implements Clock {
  private t = 1_700_000_000_000
  private seq = 0
  private readonly timers: Timer[] = []

  now(): number {
    return this.t
  }

  date(): Date {
    return new Date(this.t)
  }

  setTimer(fn: () => void, ms: number): unknown {
    return this.add(fn, ms, null)
  }

  setRepeating(fn: () => void, ms: number): unknown {
    return this.add(fn, ms, ms)
  }

  clearTimer(handle: unknown): void {
    const timer = this.timers.find((x) => x.id === handle)
    if (timer) timer.cancelled = true
  }

  advance(ms: number): void {
    const end = this.t + ms
    for (;;) {
      const due = this.timers
        .filter((x) => !x.cancelled && x.at <= end)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (!due) break
      this.t = due.at
      if (due.every === null) due.cancelled = true
      else due.at += due.every
      due.fn()
    }
    this.t = end
  }

  private add(fn: () => void, ms: number, every: number | null): number {
    const id = ++this.seq
    this.timers.push({ id, at: this.t + ms, fn, every, cancelled: false })
    return id
  }
}

export class FakeAudit implements Audit {
  readonly events: Array<Record<string, string | number | boolean>> = []

  event(fields: Record<string, string | number | boolean>): void {
    this.events.push(fields)
  }
}

export class FakeLogger implements Logger {
  readonly lines: string[] = []

  log(msg: string): void {
    this.lines.push(msg)
  }

  debug(msg: string): void {
    this.lines.push(msg)
  }
}

// A router wired to fakes. Call `start()` on it before driving messages. `chatLog` is optional: without it nothing is logged.
export function harness(opts: {
  groupId?: ChatId | null; ownerUserId?: string; chatLog?: ChatLogPort; addons?: AddonsPort; e2e?: E2e
  startWhenNoSession?: boolean; quotaRefusal?: () => Promise<string | null>; claudeModel?: string | null
  idleCloseMinutes?: number; home?: string
  // The Discord-shaped id profile (DISCORD_FAKE_CAPABILITIES, DISCORD_GUILD, DISCORD_OWNER).
  discord?: boolean
} = {}): {
  router: Router
  chat: FakeChat
  store: FakeStore
  platform: FakePlatform
  agent: FakeAgent
  clock: FakeClock
  audit: FakeAudit
  logger: FakeLogger
} {
  const chat = new FakeChat({ discord: opts.discord === true })
  const store = new FakeStore()
  const platform = new FakePlatform()
  const agent = new FakeAgent()
  const clock = new FakeClock()
  const audit = new FakeAudit()
  const logger = new FakeLogger()
  const ml: Pick<MlPort, 'transcribe' | 'close'> = { transcribe: async () => '', close: () => {} }
  const router = new Router({
    ownerId: opts.ownerUserId ?? OWNER,
    groupId: opts.groupId ?? null,
    secrets: ['SECRET-TOKEN'],
    home: opts.home ?? HOME,
    idleCloseMinutes: opts.idleCloseMinutes,
    socketPath: '/fake/router.sock',
    chat,
    store,
    platform,
    agent,
    ml,
    clock,
    audit,
    logger,
    chatLog: opts.chatLog,
    addons: opts.addons,
    e2e: opts.e2e,
    startWhenNoSession: opts.startWhenNoSession,
    quotaRefusal: opts.quotaRefusal,
    claudeModel: opts.claudeModel,
  })
  return { router, chat, store, platform, agent, clock, audit, logger }
}

// A text message from the owner (or another id, when `fromId` is given).
export function textFrom(text: string, over: Partial<Inbound> = {}): Inbound {
  return {
    kind: 'text',
    messageId: tgMsg(10),
    text,
    replyToId: null,
    replyToText: null,
    forwarded: false,
    from: 'owner',
    fromId: OWNER,
    // A DM with an empty id, as the fakes always had (the DM id is never compared).
    chat: { kind: 'dm', id: '' as ChatId, thread: null },
    ...over,
  }
}

// Lets queued promise work (router handlers are async) run to completion.
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
