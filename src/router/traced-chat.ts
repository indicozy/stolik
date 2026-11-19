// Decorator over ChatPort (design §Observability). Every message the router sends is mapped to the trace id of the
// flow that sent it, and a Telegram HTTP error (4xx or 5xx) on a send or an edit is logged as a warning, which reaches
// the Logs topic. The trace is read when the call is made, not when the queue runs it. Everything else passes through.
import type { TraceRecord } from '../ports.ts'
import { chatErrorOf, type Capabilities, type Priority, type ReactKind, type SendTarget, type ChatPort, type ChatId, type MessageId, type ThreadId } from '../brain/chat-types.ts'
import type { PermKeyboard } from '../brain/chat-types.ts'
import type { Rows } from './state.ts'
import { currentTrace } from '../brain/observe.ts'
import { emit, errMsg } from './log.ts'

// Where the trace map is kept (the store; see DbStorePort.recordTrace and tracesForMessage).
export type TraceSink = {
  recordTrace(r: TraceRecord): void
  tracesForMessage(messageId: MessageId): TraceRecord[]
  pruneTraces(beforeMs: number): void
}

type SendOpts = { replyTo?: MessageId; perm?: PermKeyboard; rows?: Rows; silent?: boolean; priority?: Priority; quiet?: boolean; format?: 'markdown' } & SendTarget

// The HTTP status the chat platform gave an API error (ChatError.status), or undefined for anything else (network
// errors, aborts, ...).
export function httpStatusOf(e: unknown): number | undefined {
  return chatErrorOf(e)?.status
}

// The platform's own words for an API error (ChatError.description), shortened and kept to one line.
function descriptionOf(e: unknown): string {
  const ce = chatErrorOf(e)
  const text = ce?.description !== undefined ? ce.description : errMsg(e)
  return text.replace(/\s+/g, ' ').slice(0, 200)
}

export class TracedChat implements ChatPort {
  readonly capabilities: Capabilities
  private readonly inner: ChatPort
  private readonly sink: TraceSink | null
  private readonly now: () => number

  constructor(inner: ChatPort, sink: TraceSink | null, now: () => number = () => Date.now()) {
    this.inner = inner
    this.capabilities = inner.capabilities
    this.sink = sink
    this.now = now
  }

  // A message id the router sent under `trace`, mapped for `stolik trace` and /trace.
  private noteOut(messageId: MessageId, trace: string | undefined): void {
    if (!trace || !this.sink) return
    try {
      this.sink.recordTrace({ messageId, dir: 'out', trace, at: this.now() })
    } catch (e) {
      emit('warn', 'trace', `trace map write failed: ${errMsg(e)}`, {}, trace)
    }
  }

  // A Telegram HTTP error on a send or an edit is a warning. A quiet send (the Logs topic's own) is not reported.
  private reportFailure(what: string, e: unknown, trace: string | undefined, quiet = false): void {
    const status = httpStatusOf(e)
    if (status === undefined || quiet) return
    emit('warn', 'telegram', `${what} failed: HTTP ${status}: ${descriptionOf(e)}`, { status }, trace)
  }

  sendText(text: string, opts: SendOpts = {}): Promise<MessageId> {
    const trace = currentTrace()
    return this.inner.sendText(text, opts).then(
      (id) => {
        this.noteOut(id, trace)
        return id
      },
      (e: unknown) => {
        this.reportFailure('send', e, trace, opts.quiet)
        throw e
      },
    )
  }

  sendChunks(texts: readonly string[], opts: { silent?: boolean; priority?: Priority; format?: 'markdown' } & SendTarget = {}): Promise<MessageId[]> {
    const trace = currentTrace()
    return this.inner.sendChunks(texts, opts).then(
      (ids) => {
        for (const id of ids) this.noteOut(id, trace)
        return ids
      },
      (e: unknown) => {
        // A ChunkSendError carries the error that stopped the group (the one with the HTTP status) and the chunks sent.
        this.reportFailure('send', (e as { reason?: unknown } | null)?.reason ?? e, trace)
        throw e
      },
    )
  }

  sendFile(path: string, asPhoto: boolean, target?: SendTarget & { silent?: boolean }): Promise<MessageId> {
    const trace = currentTrace()
    return this.inner.sendFile(path, asPhoto, target).then(
      (id) => {
        this.noteOut(id, trace)
        return id
      },
      (e: unknown) => {
        this.reportFailure('file send', e, trace)
        throw e
      },
    )
  }

  editText(messageId: MessageId, text: string, perm: PermKeyboard | null): Promise<void> {
    const trace = currentTrace()
    return this.inner.editText(messageId, text, perm).catch((e: unknown) => {
      this.reportFailure('edit', e, trace)
      throw e
    })
  }

  editRows(messageId: MessageId, text: string, rows: Rows): Promise<void> {
    const trace = currentTrace()
    return this.inner.editRows(messageId, text, rows).catch((e: unknown) => {
      this.reportFailure('edit', e, trace)
      throw e
    })
  }

  // Topic management is not a message send: its failures are the caller's to report (the Logs topic must not feed back).
  createThread(name: string): Promise<ThreadId> {
    return this.inner.createThread(name)
  }

  setHome(groupId: ChatId | null): void {
    this.inner.setHome(groupId)
  }

  homeLink(): string | null {
    return this.inner.homeLink?.() ?? null
  }

  renameThread(threadId: ThreadId, name: string): Promise<void> {
    return this.inner.renameThread(threadId, name)
  }

  closeThread(threadId: ThreadId): Promise<void> {
    return this.inner.closeThread(threadId)
  }

  reopenThread(threadId: ThreadId): Promise<void> {
    return this.inner.reopenThread(threadId)
  }

  deleteThread(threadId: ThreadId): Promise<void> {
    return this.inner.deleteThread(threadId)
  }

  ackButton(id: string, text?: string): Promise<void> {
    return this.inner.ackButton(id, text)
  }

  react(messageId: MessageId, kind: ReactKind): Promise<void> {
    return this.inner.react(messageId, kind)
  }

  setCommands(list: ReadonlyArray<{ command: string; description: string }>): void {
    this.inner.setCommands?.(list)
  }

  typing(target?: SendTarget): Promise<void> {
    return this.inner.typing(target)
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
}
