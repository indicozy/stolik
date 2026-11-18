import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_QUEUED,
  MAX_RETRIES_AFTER_429,
  MAX_RETRIES_TRANSIENT,
  OutboundQueue,
  OutboundQueues,
  RATE_CAPACITY,
  RATE_PER_MINUTE,
  TokenBucket,
  isTransientError,
  retryAfterMsOf,
} from '../src/brain/outbound-queue.ts'
import { ChatError } from '../src/brain/chat-types.ts'
import { FakeQueueClock, settle } from './helpers/queue-clock.ts'

// A task that records its label when it runs and resolves at once.
function recorder(log: string[], label: string) {
  return async () => {
    log.push(label)
    return label
  }
}

// What the adapter gives the queue for a 429 (see toChatError in src/adapters/chat/telegram.ts).
const tg429 = (retryAfter: number) => new ChatError('rate-limited', 'Too Many Requests', { status: 429, retryAfterMs: retryAfter * 1000 })

test('constants: 15 per minute refill, burst of 5: at most 20 sends in any first minute', () => {
  assert.equal(RATE_PER_MINUTE, 15)
  assert.equal(RATE_CAPACITY, 5)
  assert.equal(RATE_CAPACITY + RATE_PER_MINUTE, 20)
  assert.equal(MAX_RETRIES_AFTER_429, 5)
})

test('token bucket: a full bucket allows a burst, then reports the wait for the next token', () => {
  const clock = new FakeQueueClock()
  const b = new TokenBucket(clock)
  for (let i = 0; i < 5; i++) assert.equal(b.take(), 0)
  // One token takes 60000 / 15 = 4000 ms.
  assert.equal(b.take(), 4000)
  assert.equal(b.take(), 4000, 'a refused take takes nothing')
})

test('token bucket: refills at 15 per minute and never above capacity', () => {
  const clock = new FakeQueueClock()
  const b = new TokenBucket(clock)
  for (let i = 0; i < 5; i++) b.take()
  clock.t += 60_000 // 18 tokens back, capped at 5
  for (let i = 0; i < 5; i++) assert.equal(b.take(), 0)
  assert.ok(b.take() > 0)
})

test('rate: over a minute a drained queue sends the burst plus 15', async () => {
  const clock = new FakeQueueClock()
  const q = new OutboundQueue(clock)
  const log: string[] = []
  for (let i = 0; i < 40; i++) void q.submit(recorder(log, `m${i}`))
  await clock.advance(0)
  assert.equal(log.length, 5, 'the burst of 5 leaves at t=0')
  await clock.advance(59_999)
  assert.equal(log.length, 19, 'refills come every 4000 ms: 14 of them by 59.999 s')
  await clock.advance(1)
  assert.equal(log.length, 20, 'burst of 5 plus 15 refills: 20 in the first minute')
  await clock.advance(4_000)
  assert.equal(log.length, 21, 'the next token arrives 4000 ms after the last refill')
})

test('bursts: five sends leave back to back with no waiting', async () => {
  const clock = new FakeQueueClock()
  const q = new OutboundQueue(clock)
  const log: string[] = []
  for (let i = 0; i < 5; i++) void q.submit(recorder(log, `b${i}`))
  await clock.advance(0)
  assert.deepEqual(log, ['b0', 'b1', 'b2', 'b3', 'b4'])
  assert.equal(q.pending, 0)
})

test('ordering: FIFO within a class', async () => {
  const clock = new FakeQueueClock()
  const q = new OutboundQueue(clock)
  const log: string[] = []
  for (const l of ['a', 'b', 'c', 'd']) void q.submit(recorder(log, l))
  await clock.advance(20_000)
  assert.deepEqual(log, ['a', 'b', 'c', 'd'])
})

test('priority: an urgent task jumps every queued normal task', async () => {
  const clock = new FakeQueueClock()
  const q = new OutboundQueue(clock)
  const log: string[] = []
  void q.submit(recorder(log, 'n1')) // in flight at once
  void q.submit(recorder(log, 'n2'))
  void q.submit(recorder(log, 'n3'))
  void q.submit(recorder(log, 'u1'), { priority: 'urgent' })
  void q.submit(recorder(log, 'u2'), { priority: 'urgent' })
  await clock.advance(0)
  assert.deepEqual(log, ['n1', 'u1', 'u2', 'n2', 'n3'])
})

test('chunks: a group stays together and in order, behind earlier groups of its class', async () => {
  const clock = new FakeQueueClock()
  const q = new OutboundQueue(clock)
  const log: string[] = []
  void q.submit(recorder(log, 'x'))
  q.submitGroup([recorder(log, 'a1'), recorder(log, 'a2'), recorder(log, 'a3')])
  q.submitGroup([recorder(log, 'b1'), recorder(log, 'b2')])
  await clock.advance(10_000)
  assert.deepEqual(log, ['x', 'a1', 'a2', 'a3', 'b1', 'b2'])
})

test('chunks: an urgent message pre-empts a started group between its chunks; the group then resumes in order', async () => {
  const clock = new FakeQueueClock()
  const q = new OutboundQueue(clock)
  const log: string[] = []
  q.submitGroup([recorder(log, 'a1'), recorder(log, 'a2'), recorder(log, 'a3')])
  q.submitGroup([recorder(log, 'b1'), recorder(log, 'b2')])
  void q.submit(recorder(log, 'u'), { priority: 'urgent' })
  await clock.advance(10_000)
  assert.deepEqual(log, ['a1', 'u', 'a2', 'a3', 'b1', 'b2'])
})

test('chunks: normal groups are served round-robin per session, so one session cannot starve the others', async () => {
  const clock = new FakeQueueClock()
  const q = new OutboundQueue(clock)
  const log: string[] = []
  void q.submit(recorder(log, 'x')) // in flight at once
  void q.submit(recorder(log, 'a1'), { session: 'a' })
  void q.submit(recorder(log, 'a2'), { session: 'a' })
  void q.submit(recorder(log, 'a3'), { session: 'a' })
  void q.submit(recorder(log, 'b1'), { session: 'b' })
  await clock.advance(20_000)
  assert.deepEqual(log, ['x', 'a1', 'b1', 'a2', 'a3'])
})

test('queue length: a normal send past MAX_QUEUED is refused at once; an urgent one is still accepted', async () => {
  const clock = new FakeQueueClock()
  const q = new OutboundQueue(clock)
  void q.submit(() => new Promise<void>(() => {})) // never finishes: everything else waits
  for (let i = 0; i < MAX_QUEUED; i++) void q.submit(async () => undefined).catch(() => {})
  await assert.rejects(q.submit(async () => undefined), /full/)
  const log: string[] = []
  void q.submit(recorder(log, 'u'), { priority: 'urgent' }).catch(() => {})
  assert.equal(q.pending, MAX_QUEUED + 2)
})

test('chunks: an urgent message that arrives before a group starts still goes first', async () => {
  const clock = new FakeQueueClock()
  const q = new OutboundQueue(clock)
  const log: string[] = []
  void q.submit(recorder(log, 'u'), { priority: 'urgent' })
  q.submitGroup([recorder(log, 'a1'), recorder(log, 'a2')])
  await clock.advance(10_000)
  assert.deepEqual(log, ['u', 'a1', 'a2'])
})

test('chunks: the group promises resolve in order with their own results', async () => {
  const clock = new FakeQueueClock()
  const q = new OutboundQueue(clock)
  const ps = q.submitGroup([async () => 1, async () => 2, async () => 3])
  await clock.advance(0)
  assert.deepEqual(await Promise.all(ps), [1, 2, 3])
  assert.deepEqual(q.submitGroup([]), [])
})

test('droppable: typing is dropped while the queue is behind, and runs when idle', async () => {
  const clock = new FakeQueueClock()
  const q = new OutboundQueue(clock)
  const log: string[] = []
  void q.submit(recorder(log, 'msg'))
  const t = await q.submit(recorder(log, 'typing'), { droppable: true })
  assert.equal(t, undefined)
  await clock.advance(0)
  assert.deepEqual(log, ['msg'])
  await q.submit(recorder(log, 'typing2'), { droppable: true })
  assert.deepEqual(log, ['msg', 'typing2'])
})

test('droppable: a typing hint waiting for a token is dropped, not queued', async () => {
  const clock = new FakeQueueClock()
  const q = new OutboundQueue(clock)
  const log: string[] = []
  for (let i = 0; i < 5; i++) await q.submit(recorder(log, `b${i}`))
  const r = await q.submit(recorder(log, 'typing'), { droppable: true })
  assert.equal(r, undefined)
  assert.equal(log.length, 5)
})

test('429: the queue pauses retry_after seconds and the failed task retries first', async () => {
  const clock = new FakeQueueClock()
  const q = new OutboundQueue(clock)
  const log: string[] = []
  let fail = true
  const flaky = async () => {
    log.push(`a@${clock.now() - 1_000_000}`)
    if (fail) {
      fail = false
      throw tg429(5)
    }
    return 'a'
  }
  const pa = q.submit(flaky)
  void q.submit(recorder(log, 'n'))
  await clock.advance(4_999)
  assert.deepEqual(log, ['a@0'], 'nothing is sent during the pause')
  assert.ok(q.paused)
  await clock.advance(1)
  assert.equal(await pa, 'a')
  assert.deepEqual(log, ['a@0', 'a@5000', 'n'])
  assert.equal(q.paused, false)
})

test('429: an urgent task queued during the pause still goes after the retried task', async () => {
  const clock = new FakeQueueClock()
  const q = new OutboundQueue(clock)
  const log: string[] = []
  let fail = true
  void q.submit(async () => {
    log.push('a')
    if (fail) {
      fail = false
      throw tg429(2)
    }
  })
  await clock.advance(0)
  void q.submit(recorder(log, 'u'), { priority: 'urgent' })
  await clock.advance(2_000)
  assert.deepEqual(log, ['a', 'u', 'a'], 'after the pause, urgent goes before the retried normal task')
})

test('429: gives up after MAX_RETRIES_AFTER_429 retries and rejects with the error', async () => {
  const clock = new FakeQueueClock()
  const q = new OutboundQueue(clock)
  let runs = 0
  const p = q.submit(async () => {
    runs++
    throw tg429(1)
  })
  const caught = p.catch((e: unknown) => e)
  await clock.advance(20_000)
  assert.deepEqual(await caught, tg429(1))
  assert.equal(runs, MAX_RETRIES_AFTER_429 + 1)
})

test('errors other than a 429 fail that task only; the next one still runs', async () => {
  const clock = new FakeQueueClock()
  const q = new OutboundQueue(clock)
  const log: string[] = []
  const bad = q.submit(async () => {
    throw new Error('boom')
  })
  void q.submit(recorder(log, 'next'))
  await assert.rejects(bad, /boom/)
  await clock.advance(0)
  assert.deepEqual(log, ['next'])
})

test('retryAfterMsOf: reads the pause of a rate-limited ChatError only', () => {
  assert.equal(retryAfterMsOf(tg429(7)), 7000)
  assert.equal(retryAfterMsOf(tg429(0)), 0)
  assert.equal(retryAfterMsOf(new ChatError('other', 'x', { status: 400 })), null)
  assert.equal(retryAfterMsOf(new ChatError('other', 'x', { status: 429 })), null)
  assert.equal(retryAfterMsOf(new Error('x')), null)
  assert.equal(retryAfterMsOf(null), null)
})

test('per chat: one queue per chat id, with separate buckets', async () => {
  const clock = new FakeQueueClock()
  const queues = new OutboundQueues(clock)
  const group = queues.forChat('-100')
  const dm = queues.forChat('111')
  assert.equal(queues.forChat('-100'), group, 'same chat, same queue')
  assert.notEqual(group, dm)
  const log: string[] = []
  await dm.submit(recorder(log, 'dm'))
  assert.deepEqual(log, ['dm'])
})

test('429: the pause is bot-wide: a 429 on the group also holds the DM queue, which then goes on', async () => {
  const clock = new FakeQueueClock()
  const queues = new OutboundQueues(clock)
  const group = queues.forChat('-100')
  const dm = queues.forChat('111')
  let fail = true
  void group.submit(async () => {
    if (fail) {
      fail = false
      throw tg429(30)
    }
  }).catch(() => {})
  await clock.advance(0)
  assert.ok(group.paused)
  assert.ok(dm.paused, 'Telegram flood waits are bot-wide')
  const log: string[] = []
  const p = dm.submit(recorder(log, 'dm'))
  await clock.advance(29_999)
  assert.deepEqual(log, [])
  await clock.advance(1)
  await p
  assert.deepEqual(log, ['dm'])
})

test('lanes: a stuck upload in the file lane does not hold the text lane', async () => {
  const clock = new FakeQueueClock()
  const queues = new OutboundQueues(clock)
  const text = queues.forChat('a')
  const files = queues.forChat('a', 'files')
  assert.notEqual(text, files)
  void files.submit(() => new Promise<void>(() => {}))
  const log: string[] = []
  void text.submit(recorder(log, 't1'))
  await clock.advance(0)
  assert.deepEqual(log, ['t1'])
})

test('lanes: the file lane shares the chat\'s token bucket with the text lane', async () => {
  const clock = new FakeQueueClock()
  const queues = new OutboundQueues(clock)
  const text = queues.forChat('a')
  const log: string[] = []
  // The text lane spends the chat's whole burst (5 tokens).
  for (let i = 0; i < 5; i++) void text.submit(recorder(log, `t${i}`))
  await clock.advance(0)
  assert.equal(log.length, 5)
  const fileLog: string[] = []
  void queues.forChat('a', 'files').submit(recorder(fileLog, 'f'))
  await clock.advance(3_999)
  assert.deepEqual(fileLog, [], 'no token yet')
  await clock.advance(1)
  assert.deepEqual(fileLog, ['f'])
})

test('per chat: a burst on one chat does not spend the other chat\'s tokens', async () => {
  const clock = new FakeQueueClock()
  const queues = new OutboundQueues(clock)
  const log: string[] = []
  for (let i = 0; i < 5; i++) void queues.forChat('a').submit(recorder(log, `a${i}`))
  await clock.advance(0)
  void queues.forChat('b').submit(recorder(log, 'b0'))
  await clock.advance(0)
  assert.equal(log.at(-1), 'b0')
  await settle()
})

test('transient errors (5xx, network) are retried with a backoff; a 4xx is not retried', async () => {
  const clock = new FakeQueueClock()
  const q = new OutboundQueue(clock)
  let runs = 0
  const flaky = async () => {
    runs++
    if (runs < 3) throw new ChatError('other', 'fetch failed', { transient: true })
    return 'ok'
  }
  const p = q.submit(flaky)
  await clock.advance(7_000)
  assert.equal(await p, 'ok')
  assert.equal(runs, 3, 'two transient failures, then success')

  let bad = 0
  const tooLong = new ChatError('other', 'Bad Request: message is too long', { status: 400, description: 'Bad Request: message is too long' })
  const refused = q.submit(async () => {
    bad++
    throw tooLong
  }).catch((e: unknown) => e)
  await clock.advance(30_000)
  assert.equal(bad, 1, 'a 400 is refused once')
  assert.equal(await refused, tooLong)
})

test('transient errors: gives up after MAX_RETRIES_TRANSIENT retries and rejects', async () => {
  const clock = new FakeQueueClock()
  const q = new OutboundQueue(clock)
  let runs = 0
  const caught = q.submit(async () => {
    runs++
    throw new ChatError('other', '502', { status: 502, transient: true })
  }).catch((e: unknown) => e)
  await clock.advance(60_000)
  assert.ok(await caught instanceof Error)
  assert.equal(runs, MAX_RETRIES_TRANSIENT + 1)
})

test('isTransientError: a ChatError marked transient is retried; other errors and plain errors are not', () => {
  assert.equal(isTransientError(new ChatError('other', 'x', { status: 500, transient: true })), true)
  assert.equal(isTransientError(new ChatError('other', 'x', { status: 400 })), false)
  assert.equal(isTransientError(tg429(1)), false, '429 has its own rule')
  assert.equal(isTransientError(new Error('boom')), false)
  assert.equal(isTransientError(null), false)
})

test('stop: urgent work still runs until the deadline; normal work is rejected; new work is refused', async () => {
  const clock = new FakeQueueClock()
  const q = new OutboundQueue(clock)
  const log: string[] = []
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const inFlight = q.submit(async () => {
    await gate
    log.push('n1')
  })
  const queuedNormal = q.submit(recorder(log, 'n2')).catch((e: unknown) => e)
  void q.submit(recorder(log, 'u'), { priority: 'urgent' })
  const stopped = q.stop({ deadlineMs: 10_000 })
  release()
  await stopped
  await inFlight
  assert.deepEqual(log, ['n1', 'u'])
  assert.match(String(await queuedNormal), /stopped/)
  await assert.rejects(q.submit(recorder(log, 'late')), /shutting down/)
  assert.equal(q.pending, 0)
})

test('stop: urgent work past the deadline is rejected too', async () => {
  const clock = new FakeQueueClock()
  const q = new OutboundQueue(clock)
  const log: string[] = []
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const inFlight = q.submit(() => gate)
  const urgent = q.submit(recorder(log, 'u'), { priority: 'urgent' }).catch((e: unknown) => e)
  // A deadline already passed: nothing queued is flushed.
  const stopped = q.stop({ deadlineMs: -1 })
  release()
  await stopped
  await inFlight
  assert.deepEqual(log, [])
  assert.match(String(await urgent), /stopped/)
})
