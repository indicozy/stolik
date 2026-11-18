import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GrammyError } from 'grammy'
import { ChatError, chatErrorOf, type Capabilities } from '../src/brain/chat-types.ts'
import { ChunkSendError } from '../src/brain/outbound-queue.ts'
import { TELEGRAM_CAPABILITIES, toChatError } from '../src/adapters/chat/telegram.ts'
import { OutboundQueues } from '../src/brain/outbound-queue.ts'
import { FakeQueueClock, settle } from './helpers/queue-clock.ts'

// A grammY API error as the library raises it: the message carries the description, as grammY builds it.
function apiError(code: number, description: string): GrammyError {
  return new GrammyError(`Call to sendMessage failed! (${code}: ${description})`, { ok: false, error_code: code, description }, 'sendMessage', {})
}

// Each row: an error as the adapter receives it, and the ChatError it must become. These are the matches the brain and
// the router made on grammY's shapes before the boundary existed (src/adapters/chat/queued.ts, src/brain/topics.ts,
// src/router/logs-topic.ts, src/brain/outbound-queue.ts).
test('toChatError: grammY-shaped errors map to the kind the old checks gave them', () => {
  const rows: Array<[string, unknown, string]> = [
    // access-lost: the description (queued.ts ACCESS_LOST_RE)
    ['chat not found', apiError(400, 'Bad Request: chat not found'), 'access-lost'],
    ['bot was kicked', apiError(403, 'Forbidden: bot was kicked from the supergroup chat'), 'access-lost'],
    ['bot is not a member', apiError(403, 'Forbidden: bot is not a member of the supergroup chat'), 'access-lost'],
    ['not enough rights', apiError(400, 'Bad Request: not enough rights to send text messages'), 'access-lost'],
    ['have no rights', apiError(403, 'Forbidden: bot has no rights to send messages'), 'access-lost'],
    ['bot was blocked', apiError(403, 'Forbidden: bot was blocked by the user'), 'access-lost'],
    ['CHAT_WRITE_FORBIDDEN', apiError(403, 'Forbidden: CHAT_WRITE_FORBIDDEN'), 'access-lost'],
    ['forbidden (any)', apiError(403, 'Forbidden: something else'), 'access-lost'],
    ['access read from the description only, not the text', { error_code: 403, description: 'Forbidden: bot was kicked' }, 'access-lost'],
    // thread-closed: the error text (brain topics.ts THREAD_GONE_RE, logs-topic.ts THREAD_GONE_RE)
    ['message thread not found', apiError(400, 'Bad Request: message thread not found'), 'thread-closed'],
    ['TOPIC_ID_INVALID', apiError(400, 'Bad Request: TOPIC_ID_INVALID'), 'thread-closed'],
    ['topic not found', apiError(400, 'Bad Request: topic not found'), 'thread-closed'],
    ['topic_deleted (logs topic)', apiError(400, 'Bad Request: topic_deleted'), 'thread-closed'],
    ['thread text in a plain Error', new Error('Call to sendMessage failed! (400: Bad Request: message thread not found)'), 'thread-closed'],
    // not-modified: the error text (brain topics.ts NOT_MODIFIED_RE)
    ['TOPIC_NOT_MODIFIED', apiError(400, 'Bad Request: TOPIC_NOT_MODIFIED'), 'not-modified'],
    ['topic is not modified', apiError(400, 'Bad Request: topic is not modified'), 'not-modified'],
    // rate-limited: 429 with a retry_after (outbound-queue.ts retryAfterOf)
    ['429 with retry_after 7', { error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } }, 'rate-limited'],
    ['429 with retry_after 0', { error_code: 429, parameters: { retry_after: 0 } }, 'rate-limited'],
    // other: everything else
    ['400 message is too long', apiError(400, 'Bad Request: message is too long'), 'other'],
    ['429 without retry_after', { error_code: 429, description: 'Too Many Requests' }, 'other'],
    ['500 internal', apiError(500, 'Internal Server Error'), 'other'],
    ['plain Error', new Error('boom'), 'other'],
    ['chat not found in a plain Error text only', new Error('chat not found'), 'other'],
    ['a string', 'message thread not found', 'thread-closed'],
  ]
  for (const [name, input, kind] of rows) {
    assert.equal(toChatError(input).kind, kind, name)
  }
})

test('toChatError: rate limit carries the pause in ms and the status', () => {
  const e = toChatError({ error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } })
  assert.equal(e.kind, 'rate-limited')
  assert.equal(e.retryAfterMs, 7000)
  assert.equal(e.status, 429)
  assert.equal(e.transient, false, '429 has its own rule, not the transient one')
  assert.equal(toChatError({ error_code: 429, parameters: { retry_after: -1 } }).retryAfterMs, undefined)
})

test('toChatError: transient for 5xx, grammY HttpError, abort and timeout, and network codes; never for 4xx', () => {
  assert.equal(toChatError(apiError(500, 'x')).transient, true)
  assert.equal(toChatError({ error_code: 503 }).transient, true)
  assert.equal(toChatError(apiError(400, 'Bad Request: message is too long')).transient, false)
  assert.equal(toChatError(Object.assign(new Error('fetch failed'), { name: 'HttpError' })).transient, true)
  assert.equal(toChatError(Object.assign(new Error('x'), { name: 'AbortError' })).transient, true)
  assert.equal(toChatError(Object.assign(new Error('x'), { name: 'TimeoutError' })).transient, true)
  assert.equal(toChatError(Object.assign(new Error('x'), { code: 'ECONNRESET' })).transient, true)
  assert.equal(toChatError(new Error('boom')).transient, false)
})

test('toChatError: keeps the description, the status and the original error; a ChatError passes through', () => {
  const original = apiError(400, 'Bad Request: chat not found')
  const e = toChatError(original)
  assert.equal(e.description, 'Bad Request: chat not found')
  assert.equal(e.status, 400)
  assert.equal(e.cause, original)
  assert.equal(e.message, original.message)
  const own = new ChatError('other', 'x')
  assert.equal(toChatError(own), own)
})

test('ChatError: the kind and fields are set; transient defaults to false', () => {
  const e = new ChatError('rate-limited', 'slow down', { status: 429, retryAfterMs: 2000 })
  assert.ok(e instanceof Error)
  assert.equal(e.name, 'ChatError')
  assert.equal(e.kind, 'rate-limited')
  assert.equal(e.retryAfterMs, 2000)
  assert.equal(e.transient, false)
})

// The queue obeys the rate it is given, not a constant: a profile of one send a second.
test('queue: obeys the rate it is given (burst 1, 60 a minute: one send a second)', async () => {
  const clock = new FakeQueueClock()
  const rate: Pick<Capabilities['rate'], 'burst' | 'perChatPerMin'> = { burst: 1, perChatPerMin: 60 }
  const queue = new OutboundQueues(clock, rate).forChat('-100')
  const log: string[] = []
  const send = (label: string) => () => {
    log.push(label)
    return Promise.resolve(label)
  }
  const a = queue.submit(send('a'))
  const b = queue.submit(send('b'))
  const c = queue.submit(send('c'))
  await settle()
  assert.deepEqual(log, ['a'], 'the bucket starts with one token')
  await clock.advance(999)
  assert.deepEqual(log, ['a'])
  await clock.advance(1)
  assert.deepEqual(log, ['a', 'b'])
  await clock.advance(1000)
  assert.deepEqual(log, ['a', 'b', 'c'])
  await Promise.all([a, b, c])
})

test('queue: the Telegram capabilities give 5 sends back to back, then 15 a minute', async () => {
  const clock = new FakeQueueClock()
  const queue = new OutboundQueues(clock, TELEGRAM_CAPABILITIES.rate).forChat('-100')
  const log: string[] = []
  const tasks = Array.from({ length: 6 }, (_, i) =>
    queue.submit(() => {
      log.push(String(i))
      return Promise.resolve(i)
    }),
  )
  await settle()
  assert.equal(log.length, 5, 'the burst of 5 leaves at once')
  await clock.advance(4000)
  assert.equal(log.length, 6, 'then one more every 4 s (15 a minute)')
  await Promise.all(tasks)
})

test('Telegram capabilities: the values the adapter has always used', () => {
  assert.equal(TELEGRAM_CAPABILITIES.platform, 'tg')
  assert.equal(TELEGRAM_CAPABILITIES.text.maxChars, 4096)
  assert.equal(TELEGRAM_CAPABILITIES.text.format, 'html')
  assert.deepEqual(TELEGRAM_CAPABILITIES.threads, { kind: 'forum-topic', maxNameChars: 128, rename: true, close: true, delete: true })
  assert.equal(TELEGRAM_CAPABILITIES.buttons.kind === 'inline' && TELEGRAM_CAPABILITIES.buttons.payloadBytes, 64)
  assert.deepEqual(TELEGRAM_CAPABILITIES.rate, { perChatPerMin: 15, burst: 5, scope: 'chat', sharedPause: true })
  assert.deepEqual(TELEGRAM_CAPABILITIES.files, { inbound: true, outbound: true, maxUploadBytes: 50 * 1024 * 1024, maxDownloadBytes: 20 * 1024 * 1024, image: true })
})

test('chatErrorOf: a ChatError is itself; a ChunkSendError gives the ChatError that stopped it; anything else is null', () => {
  const own = new ChatError('thread-closed', 'gone')
  assert.equal(chatErrorOf(own), own)
  assert.equal(chatErrorOf(new ChunkSendError(own, [])), own, 'the reason of a chunk group error')
  assert.equal(chatErrorOf(new ChunkSendError(new Error('boom'), [])), null, 'a wrapped plain Error is not a ChatError')
  assert.equal(chatErrorOf(new Error('boom')), null)
  assert.equal(chatErrorOf('thread-closed'), null)
  assert.equal(chatErrorOf(undefined), null)
  assert.equal(chatErrorOf(null), null)
  assert.equal(chatErrorOf({ reason: 'x' }), null, 'a reason that is not a ChatError')
})
