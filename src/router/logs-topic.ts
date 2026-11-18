// The "🛠 Logs" forum topic (design §Observability): warnings and errors from the router, rate-limited and deduplicated
// (src/brain/observe.ts AlertGate). It lives in the bound group. In DM mode (no group) only Telegram send errors are
// posted, to the owner's private chat, with a stricter limit. The topic id is kept in the store; when Telegram says the
// thread is gone (deleted), a new topic is made and the failed line is sent there.
import type { ChatId, ChatPort, ThreadId } from '../brain/chat-types.ts'
import { isThreadGone } from '../brain/topics.ts'
import { AlertGate, type Level } from '../brain/observe.ts'
import { emit, errMsg, type LogRecord } from './log.ts'

export const LOGS_TOPIC_NAME = '🛠 Logs'
export const GROUP_PER_MINUTE = 10
export const DM_PER_MINUTE = 3
export const DEDUPE_MS = 5 * 60_000
const ROLLUP_MS = 60_000
const QUEUE_MAX = 50
const LINE_MAX = 800

export type LogsThreadStore = { get(): ThreadId | null; set(threadId: ThreadId): void }
export type LogsClock = { setTimer(fn: () => void, ms: number): unknown; clearTimer(handle: unknown): void }

export type LogsTopicOptions = {
  chat: ChatPort
  store: LogsThreadStore
  // Config `logsTopic`. False: nothing is posted.
  enabled: boolean
  // The bound group id, or null in DM mode (read at each report).
  groupId: () => ChatId | null
  clock: LogsClock
  now?: () => number
}

// One line for the topic: icon, component, message, repeats, and the trace id at the end.
export function topicLine(r: { level: Level; component: string; msg: string; trace?: string }, repeats: number): string {
  const icon = r.level === 'error' ? '❌' : '⚠️'
  const similar = repeats > 0 ? ` (+${repeats} similar in the last 5 min)` : ''
  const trace = r.trace ? ` · trace ${r.trace}` : ''
  const msg = r.msg.length > LINE_MAX ? r.msg.slice(0, LINE_MAX - 1) + '…' : r.msg
  return `${icon} ${r.component}: ${msg}${similar}${trace}`
}

type Item = { text: string; dm: boolean }

export class LogsTopic {
  private readonly opts: LogsTopicOptions
  private readonly gate = new AlertGate(GROUP_PER_MINUTE, DEDUPE_MS)
  private readonly dmGate = new AlertGate(DM_PER_MINUTE, DEDUPE_MS)
  private readonly queue: Item[] = []
  private draining = false
  private rollup: { dm: boolean; handle: unknown } | null = null

  constructor(opts: LogsTopicOptions) {
    this.opts = opts
  }

  // The sink the router installs (log.ts configureLog). Synchronous: queues the line and returns.
  report(r: LogRecord): void {
    if (!this.opts.enabled) return
    const dm = this.opts.groupId() === null
    // DM mode posts send errors only.
    if (dm && r.component !== 'telegram') return
    const gate = dm ? this.dmGate : this.gate
    const now = (this.opts.now ?? Date.now)()
    const d = gate.offer(`${r.level}|${r.component}|${r.msg}`, now)
    if (d.action === 'duplicate') return
    if (d.action === 'rate-limited') {
      this.scheduleRollup(dm)
      return
    }
    this.enqueue({ text: topicLine(r, d.repeats), dm })
  }

  // Makes the topic when the group is bound and none is stored (start-up, after /bind). A failure is logged, not thrown.
  async ensure(): Promise<void> {
    if (!this.opts.enabled || this.opts.groupId() === null) return
    if (this.opts.store.get() !== null) return
    try {
      await this.createThread()
    } catch (e) {
      emit('error', 'logs', `Logs topic not created: ${errMsg(e)}`)
    }
  }

  private enqueue(item: Item): void {
    if (this.queue.length >= QUEUE_MAX) this.queue.shift()
    this.queue.push(item)
    void this.drain()
  }

  private scheduleRollup(dm: boolean): void {
    if (this.rollup) return
    const handle = this.opts.clock.setTimer(() => {
      this.rollup = null
      const n = (dm ? this.dmGate : this.gate).takeRateDropped()
      if (n > 0) this.enqueue({ text: `… ${n} more warnings and errors suppressed in the last minute (see the journal)`, dm })
    }, ROLLUP_MS)
    this.rollup = { dm, handle }
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      for (let item = this.queue.shift(); item !== undefined; item = this.queue.shift()) {
        try {
          await this.sendItem(item, false)
        } catch (e) {
          // Not posted to the topic (component "logs" never reaches the sink): the journal and the file have it.
          emit('error', 'logs', `Logs topic send failed: ${errMsg(e)}`)
        }
      }
    } finally {
      this.draining = false
    }
  }

  private async sendItem(item: Item, retried: boolean): Promise<void> {
    if (item.dm) {
      // Always silent (level silent). This port is outside the router's mute wrapper, so `silent` is set here.
      await this.opts.chat.sendText(item.text, { dm: true, quiet: true, silent: true })
      return
    }
    const thread = await this.threadId()
    try {
      await this.opts.chat.sendText(item.text, { thread, quiet: true, silent: true })
    } catch (e) {
      if (retried || !isThreadGone(e)) throw e
      // The topic was deleted: make a new one and send the line there.
      await this.createThread()
      return this.sendItem(item, true)
    }
  }

  private async threadId(): Promise<ThreadId> {
    const stored = this.opts.store.get()
    if (stored !== null) return stored
    return this.createThread()
  }

  private async createThread(): Promise<ThreadId> {
    const id = await this.opts.chat.createThread(LOGS_TOPIC_NAME)
    this.opts.store.set(id)
    return id
  }
}
