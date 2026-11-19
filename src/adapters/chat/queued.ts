// Decorator over ChatPort (plan 2.6, design 4.5). Sends, edits and the typing action go through the chat's
// OutboundQueue (rate limit, priority, 429 pause). Uploads (sendFile) go through the chat's file lane: a separate queue
// that shares the chat's token bucket, so a slow upload does not hold the text lane. Button answers are not queued:
// they are fast acknowledgements and must not wait behind a send (a 429 on them is left to the caller). Reactions are
// queued as droppable hints: they honour the bot-wide pause and are dropped rather than waiting.
// Inbound handlers and the lifecycle (start, stop, download) pass straight through.
// A refusal of a send to the bound group for good (403: the bot was removed or lost its rights) is reported once
// through onAccessError; the router then sends its output to the DM until the rights return.
// This is also the chat boundary for the app's limits: every send and edit gets its button rows laid out for the app
// (chat-layout.ts), and a text over the app's maxChars goes out as chunks. A reply to the owner that fails for good gets
// one plain notice in the same chat.

import { chatErrorOf, type Capabilities, type PermKeyboard, type Priority, type ReactKind, type SendTarget, type ChatPort, type ChatId, type MessageId, type ThreadId } from '../../brain/chat-types.ts'
import type { Rows } from '../../router/state.ts'
import { ChunkSendError, type OutboundQueue, type OutboundQueues } from '../../brain/outbound-queue.ts'
import { TEXT_MARGIN, cutToFit, layoutButtonRows, measureOf, splitToFit, type Fit } from '../../brain/chat-layout.ts'
import { reopenFences } from '../../markdown.ts'

type SendOpts = { replyTo?: MessageId; perm?: PermKeyboard; rows?: Rows; silent?: boolean; priority?: Priority; quiet?: boolean; session?: string; format?: 'markdown' } & SendTarget

export class QueuedChat implements ChatPort {
  readonly capabilities: Capabilities
  private readonly inner: ChatPort
  private chatId: string
  private readonly queues: OutboundQueues
  // The bound supergroup (null: DM mode). One queue per chat: the group's limit is shared by all its topics.
  private groupId: ChatId | null = null
  private accessCb: ((reason: string) => void) | null = null
  private readonly log: (msg: string) => void

  constructor(inner: ChatPort, chatId: string, queues: OutboundQueues, log: (msg: string) => void = () => {}) {
    this.inner = inner
    this.capabilities = inner.capabilities
    this.chatId = chatId
    this.queues = queues
    this.log = log
  }

  // The rows as this chat app shows them, and how many it had to drop. A chat without inline buttons gets its rows unchanged.
  private layoutRows(rows: Rows): { rows: Rows; dropped: number } {
    const caps = this.capabilities.buttons
    if (caps.kind !== 'inline') return { rows, dropped: 0 }
    const laid = layoutButtonRows(rows, caps)
    if (laid.dropped > 0) this.log(`${laid.dropped} button row(s) past the limit of ${caps.maxRows} were not sent`)
    return { rows: laid.rows, dropped: laid.dropped }
  }

  // What the app counts for this chat's text: maxChars, measured after the app's own escaping (text.measure).
  private fitOf(format?: 'plain' | 'markdown'): Fit {
    const t = this.capabilities.text
    return { max: t.maxChars, format: format === 'markdown' ? 'markdown' : 'plain', ...(t.measure ? { measure: t.measure } : {}) }
  }

  // The texts and rows as the app takes them. Rows are laid out, and a row the app cannot show is said in the text (one
  // line at the end), never dropped silently. A text the app would not take whole is split into pieces that each fit;
  // a Markdown piece keeps its code fences closed (reopenFences). Texts that fit are passed through unchanged.
  private expand(texts: readonly string[], format: 'markdown' | undefined, rows: Rows | undefined): { texts: string[]; rows: Rows | undefined } {
    let laidRows: Rows | undefined
    const src = [...texts]
    if (rows) {
      const laid = this.layoutRows(rows)
      laidRows = laid.rows
      if (laid.dropped > 0) {
        const caps = this.capabilities.buttons
        const note = `(${laid.dropped} button row${laid.dropped === 1 ? '' : 's'} not shown: ${this.capabilities.displayName} allows ${caps.kind === 'inline' ? caps.maxRows : 0}.)`
        if (src.length === 0) src.push(note)
        else src[src.length - 1] = `${src[src.length - 1]}\n\n${note}`
      }
    }
    const fit = this.fitOf(format)
    const out: string[] = []
    for (const t of src) {
      if (measureOf(t, fit) <= fit.max) {
        out.push(t)
        continue
      }
      const parts = splitToFit(t, fit.max - TEXT_MARGIN, fit)
      const reopened = format === 'markdown' ? reopenFences(parts) : parts
      // A reopened fence adds characters: a piece that now measures over is split again.
      for (const p of reopened) out.push(...(measureOf(p, fit) <= fit.max ? [p] : splitToFit(p, fit.max - TEXT_MARGIN, fit)))
    }
    return { texts: out, rows: laidRows }
  }

  // A reply to the owner's message that failed for good (a ChatError, after the queue's own retries): one plain notice
  // in the same chat. One attempt, and the notice has no replyTo, so its own failure is not reported again.
  private noteReplyFailure(target: SendTarget, replyTo: MessageId | undefined, e: unknown): void {
    if (replyTo === undefined) return
    const ce = chatErrorOf(e instanceof ChunkSendError ? e.reason : e)
    if (!ce) return
    const reason = (ce.description ?? ce.message).replace(/\s+/g, ' ').slice(0, 200)
    const dest: SendTarget = {
      ...(target.dm !== undefined ? { dm: target.dm } : {}),
      ...(target.thread !== undefined ? { thread: target.thread } : {}),
    }
    const text = `That reply could not be sent: ${reason}.`
    this.queue(dest).submit(() => this.inner.sendText(text, dest), { priority: 'urgent' }).catch(() => {})
  }

  // The owner's DM chat, once the owner pairs (see app.ts).
  setDmChat(chatId: string): void {
    this.chatId = chatId
  }

  // The chat a send with these options lands in: the DM when asked for or when no group is bound, else the group.
  private chatOf(target: SendTarget = {}): string {
    return target.dm || this.groupId === null ? this.chatId : this.groupId
  }

  private queue(target: SendTarget = {}, lane: 'text' | 'files' = 'text'): OutboundQueue {
    return this.queues.forChat(this.chatOf(target), lane)
  }

  // Runs one call through its chat's queue. A refusal from the bound group for good is reported to onAccessError.
  // `message` is set for an edit or a reaction: the message it acts on (see noteFailure).
  private run<T>(
    target: SendTarget,
    fn: () => Promise<T>,
    opts: { priority?: Priority; lane?: 'text' | 'files'; droppable?: boolean; session?: string; message?: MessageId } = {},
  ): Promise<T> {
    return this.queue(target, opts.lane).submit(fn, { priority: opts.priority ?? 'normal', droppable: opts.droppable, session: opts.session }).catch((e: unknown) => {
      this.noteFailure(target, e, opts.message)
      throw e
    })
  }

  // Only a refusal from the home chat says the bot lost the group. A failed DM to the owner (Discord 50007, Telegram "bot
  // was blocked by the user") is logged by its caller and changes nothing. An edit or a reaction counts only when the
  // adapter knows its message is in the home: a message it does not know (an old one, after a restart) may be a DM.
  private noteFailure(target: SendTarget, e: unknown, message?: MessageId): void {
    if (target.dm || this.groupId === null) return
    if (message !== undefined && this.isDm(message) !== false) return
    const ce = chatErrorOf(e)
    if (ce?.kind === 'access-lost') this.accessCb?.(ce.description ?? ce.message)
  }

  sendText(text: string, opts: SendOpts = {}): Promise<MessageId> {
    const { priority, session, rows: rawRows, ...rest } = opts
    const e = this.expand([text], opts.format, rawRows)
    if (e.texts.length > 1) {
      // One id back, as for a single message: the first chunk's. The target carries no replyTo or rows (sendPieces places them).
      const { replyTo: _replyTo, ...target } = rest
      return this.sendPieces(e.texts, { target, priority, session, replyTo: opts.replyTo, rows: e.rows }).then((ids) => ids[0])
    }
    const laid = e.rows ? { ...rest, rows: e.rows } : rest
    return this.run(rest, () => this.inner.sendText(e.texts[0] ?? text, laid), { priority, session }).catch((err: unknown) => {
      this.noteReplyFailure(rest, opts.replyTo, err)
      throw err
    })
  }

  // The texts in order, as one queue entry (see sendPieces). Texts over the app's limit are split (a safety net: the
  // router already fits its texts). Rows go on the last piece.
  async sendChunks(texts: readonly string[], opts: { silent?: boolean; priority?: Priority; replyTo?: MessageId; rows?: Rows; session?: string; format?: 'markdown' } & SendTarget = {}): Promise<MessageId[]> {
    const { priority, session, replyTo, rows: rawRows, ...common } = opts
    const e = this.expand(texts, opts.format, rawRows)
    return this.sendPieces(e.texts, { target: common, priority, session, replyTo, rows: e.rows })
  }

  // One queue entry for the whole group: nothing else in this chat's queue goes out between the chunks, except an urgent
  // message (see outbound-queue.ts). Once one chunk fails, the rest are not sent; the error says which ones were.
  // The first piece answers replyTo; the last carries the rows. The pieces are already laid out (see expand).
  private async sendPieces(
    texts: readonly string[],
    o: { target: SendTarget & { silent?: boolean; format?: 'markdown' }; priority?: Priority; session?: string; replyTo?: MessageId; rows?: Rows },
  ): Promise<MessageId[]> {
    const { target: common, priority, session, replyTo, rows } = o
    const target: SendTarget = common
    const last = texts.length - 1
    let failed = false
    const runs = texts.map((text, i) => async (): Promise<MessageId> => {
      if (failed) throw new Error('not sent: an earlier chunk failed')
      try {
        return await this.inner.sendText(text, {
          ...common,
          ...(i === 0 && replyTo !== undefined ? { replyTo } : {}),
          ...(i === last && rows ? { rows } : {}),
        })
      } catch (e) {
        failed = true
        this.noteFailure(target, e)
        throw e
      }
    })
    const settled = await Promise.allSettled(this.queue(target).submitGroup(runs, { priority: priority ?? 'normal', session }))
    const sentIds: MessageId[] = []
    for (const r of settled) {
      if (r.status === 'fulfilled') sentIds.push(r.value)
      else {
        this.noteReplyFailure(target, replyTo, r.reason)
        throw new ChunkSendError(r.reason, sentIds)
      }
    }
    return sentIds
  }

  sendFile(path: string, asPhoto: boolean, target?: SendTarget & { silent?: boolean }): Promise<MessageId> {
    return this.run(target ?? {}, () => this.inner.sendFile(path, asPhoto, target), { lane: 'files', session: target?.session })
  }

  setHome(groupId: ChatId | null): void {
    this.groupId = groupId
    this.inner.setHome(groupId)
  }

  homeLink(): string | null {
    return this.inner.homeLink?.() ?? null
  }

  onAccessError(fn: (reason: string) => void): void {
    this.accessCb = fn
  }

  onLiveButtons(fn: Parameters<NonNullable<ChatPort['onLiveButtons']>>[0]): void {
    this.inner.onLiveButtons?.(fn)
  }

  // Topic management is a group send in Telegram's accounting, so it goes through the group's queue.
  createThread(name: string): Promise<ThreadId> {
    return this.run({}, () => this.inner.createThread(name))
  }

  renameThread(threadId: ThreadId, name: string): Promise<void> {
    return this.run({}, () => this.inner.renameThread(threadId, name))
  }

  closeThread(threadId: ThreadId): Promise<void> {
    return this.run({}, () => this.inner.closeThread(threadId))
  }

  reopenThread(threadId: ThreadId): Promise<void> {
    return this.run({}, () => this.inner.reopenThread(threadId))
  }

  // Edits go to the chat the message was sent to (the adapter remembers it).
  isDm(messageId: MessageId): boolean | undefined {
    return this.inner.isDm?.(messageId)
  }

  private editTarget(messageId: MessageId, fallback?: SendTarget): SendTarget {
    return (this.isDm(messageId) ?? fallback?.dm ?? false) ? { dm: true } : {}
  }

  // An edit over the app's limit is cut to fit, keeping the tail (see cutToFit), and logged. Rows dropped by the layout
  // are said in the text, as for a send.
  private fitEdit(text: string): string {
    const body = cutToFit(text, this.fitOf())
    if (body !== text) this.log(`edit of ${text.length} characters cut to the ${this.capabilities.displayName} limit of ${this.capabilities.text.maxChars}`)
    return body
  }

  editText(messageId: MessageId, text: string, perm: PermKeyboard | null, priority?: Priority): Promise<void> {
    const body = this.fitEdit(text)
    return this.run(this.editTarget(messageId), () => this.inner.editText(messageId, body, perm, priority), { priority, message: messageId })
  }

  editRows(messageId: MessageId, text: string, rows: Rows, priority?: Priority): Promise<void> {
    const laid = this.layoutRows(rows)
    const caps = this.capabilities.buttons
    const withNote = laid.dropped > 0
      ? `${text}\n\n(${laid.dropped} button row${laid.dropped === 1 ? '' : 's'} not shown: ${this.capabilities.displayName} allows ${caps.kind === 'inline' ? caps.maxRows : 0}.)`
      : text
    const body = this.fitEdit(withNote)
    return this.run(this.editTarget(messageId), () => this.inner.editRows(messageId, body, laid.rows, priority), { priority, message: messageId })
  }

  clearButtons(messageId: MessageId, target?: SendTarget): Promise<void> {
    return this.run(this.editTarget(messageId, target), () => this.inner.clearButtons?.(messageId, target) ?? Promise.resolve(), { message: messageId })
  }

  // Typing is a hint: dropped when the chat's queue is behind.
  typing(target?: SendTarget): Promise<void> {
    return this.run(target ?? {}, () => this.inner.typing(target), { droppable: true })
  }

  // Not queued (see the header comment).
  ackButton(id: string, text?: string): Promise<void> {
    return this.inner.ackButton(id, text)
  }

  // Queued as a droppable hint (see the header comment). The chat is the one the message is in.
  react(messageId: MessageId, kind: ReactKind): Promise<void> {
    return this.run(this.editTarget(messageId), () => this.inner.react(messageId, kind), { droppable: true, message: messageId })
  }

  setCommands(list: ReadonlyArray<{ command: string; description: string }>): void {
    this.inner.setCommands?.(list)
  }

  download(fileRef: string, dest: string, maxBytes: number): Promise<void> {
    return this.inner.download(fileRef, dest, maxBytes)
  }

  onInbound(fn: Parameters<ChatPort['onInbound']>[0]): void {
    this.inner.onInbound(fn)
  }

  onButton(fn: Parameters<ChatPort['onButton']>[0]): void {
    this.inner.onButton(fn)
  }

  onChatEvent(fn: Parameters<ChatPort['onChatEvent']>[0]): void {
    this.inner.onChatEvent(fn)
  }

  onStarted(fn: () => void): void {
    this.inner.onStarted(fn)
  }

  compareMessages(a: MessageId, b: MessageId): number {
    return this.inner.compareMessages(a, b)
  }

  start(): void {
    this.inner.start()
  }

  stop(): Promise<void> {
    return this.inner.stop()
  }

  // Shutdown of the outbound side: urgent sends still go out for budgetMs, the rest is refused (OutboundQueue.stop).
  // Shutdown ordering (which goes first) is decided by the caller (Router.stop).
  drain(budgetMs: number): Promise<void> {
    return this.queues.drain(budgetMs)
  }
}
