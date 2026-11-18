// Outbound rate-limit queue (plan 2.6, design 4.5). Pure: no grammY, no timers of its own. Time comes from an
// injected clock, so tests drive it with a fake clock.
//
// Model. One queue per chat and lane (text, files). Work runs one task at a time (serial).
//   - Two priority classes: 'urgent' (permission approvals, AskUserQuestion, plan approvals) and 'normal'.
//   - A message's chunks are a group. A group's tasks run back to back and in order. Urgent work may pre-empt a
//     normal group between its chunks: the group resumes right after the urgent task (chunk order is kept).
//     An urgent group is not interleaved with another urgent group.
//   - Inside a class, the queued groups are served round-robin per session key, so one busy session cannot starve
//     the others. The normal class holds at most MAX_QUEUED tasks; a send past that is refused at once.
//   - A token bucket gates dispatch (RATE_CAPACITY burst, RATE_PER_MINUTE refills), so any 60 s window holds at
//     most RATE_CAPACITY + RATE_PER_MINUTE sends (20 with the defaults, Telegram's group limit).
//   - A pause (429 retry_after, or a transient failure backoff) holds the queue. A 429 pause is shared by every
//     queue of the bot (OutboundQueues), because Telegram's flood wait is bot-wide.
//   - A failed task stays at the head and is retried (429 up to MAX_RETRIES_AFTER_429 times, transient errors up to
//     MAX_RETRIES_TRANSIENT times with a capped backoff). Other errors fail that task only.
//   - stop({deadlineMs}) is the shutdown path: urgent tasks still run until the deadline, everything else is rejected.

import { ChatError, type Capabilities, type MessageId, type Priority } from './chat-types.ts'

// Telegram allows about 20 messages a minute per group (research 05). Burst plus refill is kept at 20.
export const RATE_PER_MINUTE = 15
export const RATE_WINDOW_MS = 60_000
// Burst allowance: how many sends can leave back to back when the bucket is full.
export const RATE_CAPACITY = 5
// Attempts for one task that keeps getting 429 before it is failed.
export const MAX_RETRIES_AFTER_429 = 5
// Attempts for one task that keeps failing with a network error or a 5xx before it is failed.
export const MAX_RETRIES_TRANSIENT = 3
export const TRANSIENT_BACKOFF_MS = [2_000, 5_000, 15_000] as const
// Normal tasks waiting in one queue. Past this, a send is refused (the caller reports it).
export const MAX_QUEUED = 200

// The subset of the router's Clock the queue needs.
export interface QueueClock {
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

// A pause that several queues honour (the bot-wide flood wait). `until` is epoch ms.
export type PauseState = { until: number }

// The pause (ms) a rate-limited error asks for, or null when the error is not a rate limit with a retry_after.
export function retryAfterMsOf(err: unknown): number | null {
  return err instanceof ChatError && err.kind === 'rate-limited' && err.retryAfterMs !== undefined ? err.retryAfterMs : null
}

// True for failures that may succeed on a later try (ChatError.transient: a 5xx, a network error, a timeout). A 4xx is
// never transient: the same request would be refused again.
export function isTransientError(err: unknown): boolean {
  return err instanceof ChatError && err.transient
}

// Token bucket with fractional tokens. Starts full.
export class TokenBucket {
  private tokens: number
  private last: number

  private readonly clock: Pick<QueueClock, 'now'>
  private readonly capacity: number
  private readonly perMinute: number

  constructor(clock: Pick<QueueClock, 'now'>, capacity: number = RATE_CAPACITY, perMinute: number = RATE_PER_MINUTE) {
    this.clock = clock
    this.capacity = capacity
    this.perMinute = perMinute
    this.tokens = capacity
    this.last = clock.now()
  }

  private refill(): void {
    const now = this.clock.now()
    const added = ((now - this.last) * this.perMinute) / RATE_WINDOW_MS
    this.tokens = Math.min(this.capacity, this.tokens + added)
    this.last = now
  }

  // Takes one token and returns 0, or returns the milliseconds until one is available (nothing is taken).
  take(): number {
    this.refill()
    if (this.tokens >= 1 - 1e-9) {
      this.tokens -= 1
      return 0
    }
    return Math.ceil(((1 - this.tokens) * RATE_WINDOW_MS) / this.perMinute)
  }
}

type Task = {
  run: () => Promise<unknown>
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  droppable: boolean
  // 429 retries and transient retries used so far.
  attempts: number
  transient: number
}

// The tasks of one message (one task for a plain send). Dispatched in order.
type Group = { tasks: Task[]; session: string }

// The groups of one priority class: the open group (started, more tasks to come) and the queued groups per session,
// served round-robin.
class Lane {
  open: Group | null = null
  private order: string[] = []
  private bySession = new Map<string, Group[]>()
  // Tasks in queued (not open) groups.
  queued = 0

  push(g: Group): void {
    const arr = this.bySession.get(g.session)
    if (arr) arr.push(g)
    else {
      this.bySession.set(g.session, [g])
      this.order.push(g.session)
    }
    this.queued += g.tasks.length
  }

  // The next queued group, round-robin over sessions. Removes it from the queue.
  takeNext(): Group | null {
    while (this.order.length > 0) {
      const key = this.order.shift() as string
      const arr = this.bySession.get(key)
      if (!arr || arr.length === 0) {
        this.bySession.delete(key)
        continue
      }
      const g = arr.shift() as Group
      if (arr.length > 0) this.order.push(key)
      else this.bySession.delete(key)
      this.queued -= g.tasks.length
      return g
    }
    return null
  }
}

export type SubmitOpts = { priority?: Priority; droppable?: boolean; session?: string }

// A serial, rate-limited, two-class queue. `submit` returns the task's result; a droppable task resolves to undefined
// without running when the queue is behind (busy, has waiting work, or is paused) or when no token is free.
export class OutboundQueue {
  private readonly clock: QueueClock
  private readonly bucket: TokenBucket
  private readonly shared: PauseState
  private readonly lanes: Record<Priority, Lane> = { urgent: new Lane(), normal: new Lane() }
  private busy = false
  // The group of the task in flight (set while busy).
  private inFlightGroup: Group | null = null
  private stopping = false
  // A transient-failure pause of this queue only (the 429 pause is shared, see `shared`).
  private localUntil = 0
  private timer: unknown = undefined

  constructor(
    clock: QueueClock,
    opts: { capacity?: number; perMinute?: number; bucket?: TokenBucket; pause?: PauseState } = {},
  ) {
    this.clock = clock
    this.bucket = opts.bucket ?? new TokenBucket(clock, opts.capacity, opts.perMinute)
    this.shared = opts.pause ?? { until: 0 }
  }

  // Number of tasks not yet finished (queued plus the one in flight).
  get pending(): number {
    // The open groups hold their unfinished tasks (the one in flight included); a task in flight outside an open group
    // is counted on its own.
    const inOpen = this.openTasks()
    const loose = this.busy && !(this.inFlightGroup && this.inFlightGroup === this.lanes.urgent.open) && !(this.inFlightGroup && this.inFlightGroup === this.lanes.normal.open)
    return this.lanes.urgent.queued + this.lanes.normal.queued + inOpen + (loose ? 1 : 0)
  }

  // Whether the queue is paused (a 429 on any queue of the bot, or this queue's transient backoff).
  get paused(): boolean {
    return Math.max(this.shared.until, this.localUntil) > this.clock.now()
  }

  submit<T>(run: () => Promise<T>, opts: SubmitOpts = {}): Promise<T> {
    const priority = opts.priority ?? 'normal'
    const droppable = opts.droppable ?? false
    const session = opts.session ?? ''
    if (this.stopping) return Promise.reject(new Error('outbound queue is shutting down'))
    if (droppable && (this.pending > 0 || this.paused)) return Promise.resolve(undefined as T)
    if (priority === 'normal' && this.lanes.normal.queued >= MAX_QUEUED) {
      return Promise.reject(new Error('outbound queue is full'))
    }
    return new Promise<T>((resolve, reject) => {
      this.lanes[priority].push({ tasks: [this.task(run, resolve as (v: unknown) => void, reject, droppable)], session })
      this.pump()
    })
  }

  // Queues the tasks of one message as a group: dispatched back to back, in order. Returns one promise per task.
  submitGroup<T>(runs: Array<() => Promise<T>>, opts: { priority?: Priority; session?: string } = {}): Promise<T>[] {
    if (runs.length === 0) return []
    const priority = opts.priority ?? 'normal'
    const session = opts.session ?? ''
    if (this.stopping) return runs.map(() => Promise.reject(new Error('outbound queue is shutting down')))
    const parts = runs.map((run) => {
      let res!: (v: unknown) => void
      let rej!: (e: unknown) => void
      const p = new Promise<T>((a, b) => {
        res = a as (v: unknown) => void
        rej = b
      })
      return { p, task: this.task(run, res, rej, false) }
    })
    this.lanes[priority].push({ tasks: parts.map((x) => x.task), session })
    this.pump()
    return parts.map((x) => x.p)
  }

  private task(
    run: () => Promise<unknown>,
    resolve: (v: unknown) => void,
    reject: (e: unknown) => void,
    droppable: boolean,
  ): Task {
    return { run, resolve, reject, droppable, attempts: 0, transient: 0 }
  }

  private openTasks(): number {
    return (this.lanes.urgent.open?.tasks.length ?? 0) + (this.lanes.normal.open?.tasks.length ?? 0)
  }

  private schedule(ms: number): void {
    if (this.timer !== undefined) this.clock.clearTimer(this.timer)
    this.timer = this.clock.setTimer(
      () => {
        this.timer = undefined
        this.pump()
      },
      Math.max(1, ms),
    )
  }

  // The group to serve next, and its lane. Order: the urgent open group, the next urgent group, the normal open group,
  // the next normal group. The open group of a class is always served before a new group of that class.
  private next(): { lane: Lane; group: Group } | null {
    const u = this.lanes.urgent
    if (u.open && u.open.tasks.length > 0) return { lane: u, group: u.open }
    const un = u.takeNext()
    if (un) return { lane: u, group: un }
    const n = this.lanes.normal
    if (n.open && n.open.tasks.length > 0) return { lane: n, group: n.open }
    const nn = n.takeNext()
    if (nn) return { lane: n, group: nn }
    return null
  }

  // Makes a group the open group of its lane while it still has tasks to run.
  private openIfMore(lane: Lane, group: Group): void {
    if (group.tasks.length > 0) lane.open = group
    else if (lane.open === group) lane.open = null
  }

  // The head task of a group has finished for good (success or failure): it leaves the group.
  private finishHead(lane: Lane, group: Group): void {
    group.tasks.shift()
    if (group.tasks.length === 0 && lane.open === group) lane.open = null
  }

  private pump(): void {
    if (this.busy || this.stopping) return
    const now = this.clock.now()
    if (this.paused) {
      this.schedule(Math.max(this.shared.until, this.localUntil) - now)
      return
    }
    const pick = this.next()
    if (!pick) return
    const { lane, group } = pick
    const task = group.tasks[0] as Task
    const wait = this.bucket.take()
    if (wait > 0) {
      // Not sent: the group goes back to where it was (open again, or at the head of its session).
      this.keepPicked(lane, group)
      if (task.droppable) {
        this.finishHead(lane, group)
        task.resolve(undefined)
        this.pump()
        return
      }
      this.schedule(wait)
      return
    }
    this.busy = true
    this.inFlightGroup = group
    this.openIfMore(lane, group)
    task.run().then(
      (v) => {
        this.busy = false
        this.finishHead(lane, group)
        task.resolve(v)
        this.pump()
      },
      (err: unknown) => {
        this.busy = false
        const ra = retryAfterMsOf(err)
        if (ra !== null && task.attempts < MAX_RETRIES_AFTER_429 && !this.stopping) {
          // Stay at the head: the retry goes first in its group, after the pause.
          task.attempts++
          this.shared.until = Math.max(this.shared.until, this.clock.now() + ra)
          this.keepPicked(lane, group)
        } else if (isTransientError(err) && task.transient < MAX_RETRIES_TRANSIENT && !this.stopping) {
          const backoff = TRANSIENT_BACKOFF_MS[task.transient] ?? TRANSIENT_BACKOFF_MS[TRANSIENT_BACKOFF_MS.length - 1]
          task.transient++
          this.localUntil = Math.max(this.localUntil, this.clock.now() + backoff)
          this.keepPicked(lane, group)
        } else {
          this.finishHead(lane, group)
          task.reject(err)
        }
        this.pump()
      },
    )
  }

  // Puts a picked group back as the open group of its lane (it is served first again).
  private keepPicked(lane: Lane, group: Group): void {
    if (group.tasks.length > 0) lane.open = group
  }

  // Shutdown. Refuses new work, cancels the timer, and waits for the task in flight. Urgent tasks still run, ignoring
  // the rate limit, until the deadline (`deadlineMs` from now); the rest is rejected.
  async stop(opts: { deadlineMs: number }): Promise<void> {
    this.stopping = true
    if (this.timer !== undefined) this.clock.clearTimer(this.timer)
    this.timer = undefined
    const deadline = this.clock.now() + opts.deadlineMs
    while (this.busy) await new Promise((r) => setImmediate(r))
    for (;;) {
      if (this.clock.now() >= deadline) break
      const u = this.lanes.urgent
      let group = u.open && u.open.tasks.length > 0 ? u.open : null
      let lane: Lane = u
      if (!group) group = u.takeNext()
      if (!group) break
      const task = group.tasks[0] as Task
      try {
        const v = await task.run()
        this.finishHead(lane, group)
        task.resolve(v)
      } catch (e) {
        this.finishHead(lane, group)
        task.reject(e)
      }
      this.keepPicked(lane, group)
    }
    const shutdown = () => new Error('outbound queue stopped before the message was sent')
    for (const lane of [this.lanes.urgent, this.lanes.normal]) {
      const open = lane.open
      lane.open = null
      for (const t of open?.tasks ?? []) t.reject(shutdown())
      open?.tasks.splice(0)
      for (let g = lane.takeNext(); g; g = lane.takeNext()) for (const t of g.tasks) t.reject(shutdown())
    }
  }

}

// The queues of one bot: one per chat and lane. Every queue of the bot shares one 429 pause. The text and file lanes of
// a chat share that chat's token bucket, so uploads still count against the same limit.
export class OutboundQueues {
  private readonly queues = new Map<string, OutboundQueue>()
  private readonly buckets = new Map<string, TokenBucket>()
  private readonly pause: PauseState = { until: 0 }
  private readonly clock: QueueClock
  private readonly rate: Pick<Capabilities['rate'], 'burst' | 'perChatPerMin'>

  // `rate` is the chat's (Capabilities.rate of the adapter); the defaults are the Telegram values.
  constructor(clock: QueueClock, rate: Pick<Capabilities['rate'], 'burst' | 'perChatPerMin'> = { burst: RATE_CAPACITY, perChatPerMin: RATE_PER_MINUTE }) {
    this.clock = clock
    this.rate = rate
  }

  // The queue for a chat's lane ('text' for messages and edits, 'files' for uploads).
  forChat(chatId: string, lane: 'text' | 'files' = 'text'): OutboundQueue {
    const key = `${chatId}|${lane}`
    let q = this.queues.get(key)
    if (!q) {
      let bucket = this.buckets.get(chatId)
      if (!bucket) {
        bucket = new TokenBucket(this.clock, this.rate.burst, this.rate.perChatPerMin)
        this.buckets.set(chatId, bucket)
      }
      q = new OutboundQueue(this.clock, { bucket, pause: this.pause })
      this.queues.set(key, q)
    }
    return q
  }

  // Tasks waiting in each chat's queue, by chat id (for /debug), both lanes added up. Empty chats are included.
  depths(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [key, q] of this.queues) {
      const chat = key.slice(0, key.lastIndexOf('|'))
      out[chat] = (out[chat] ?? 0) + q.pending
    }
    return out
  }

  // Shutdown of every queue (see OutboundQueue.stop); budgetMs is a duration from now.
  async drain(budgetMs: number): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.stop({ deadlineMs: budgetMs })))
  }
}

// A chunk group that stopped part-way. `sentIds` are the chunks that did go out, in order (a retry sends the rest).
export class ChunkSendError extends Error {
  readonly sentIds: MessageId[]
  // The error that stopped the group (for example a Telegram API error with its HTTP status).
  readonly reason: unknown

  constructor(cause: unknown, sentIds: MessageId[]) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'ChunkSendError'
    this.sentIds = sentIds
    this.reason = cause
  }
}
