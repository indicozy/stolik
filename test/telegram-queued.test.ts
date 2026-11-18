import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QueuedChat } from '../src/adapters/chat/queued.ts'
import { ChunkSendError, OutboundQueues } from '../src/brain/outbound-queue.ts'
import { FakeChat } from './helpers/fakes.ts'
import { FakeQueueClock } from './helpers/queue-clock.ts'
import { ChatError } from '../src/brain/chat-types.ts'
import { tgMsg } from '../src/adapters/chat/tg-ids.ts'

const CHAT = '-1001'

// A fake inner port whose first sendText fails with a 429.
class Flaky429 extends FakeChat {
  fails = 1
  override async sendText(text: string, opts?: Parameters<FakeChat['sendText']>[1]): Promise<number> {
    if (this.fails > 0) {
      this.fails--
      throw new ChatError('rate-limited', 'Too Many Requests', { status: 429, retryAfterMs: 3000 })
    }
    return super.sendText(text, opts)
  }
}

function setup(inner: FakeChat = new FakeChat()) {
  const clock = new FakeQueueClock()
  const tg = new QueuedChat(inner, CHAT, new OutboundQueues(clock))
  return { clock, tg, inner }
}

test('sendText goes through the queue and returns the inner message id', async () => {
  const { tg, inner } = setup()
  const id = await tg.sendText('hello')
  assert.equal(id, tgMsg(1))
  assert.equal(inner.sent[0]?.text, 'hello')
})

test('priority is consumed by the decorator and not passed to the inner port', async () => {
  const { tg, inner } = setup()
  await tg.sendText('approve?', { priority: 'urgent', silent: true })
  assert.deepEqual(inner.sent[0]?.opts, { silent: true })
})

test('urgent sends jump queued normal sends', async () => {
  const { tg, inner } = setup()
  void tg.sendText('n1')
  void tg.sendText('n2')
  void tg.sendText('u1', { priority: 'urgent' })
  await tg.sendText('n3')
  assert.deepEqual(
    inner.sent.map((s) => s.text),
    ['n1', 'u1', 'n2', 'n3'],
  )
})

test('a 429 from the inner port pauses the chat and the send retries', async () => {
  const inner = new Flaky429()
  const { clock, tg } = setup(inner)
  const p = tg.sendText('retry me')
  await clock.advance(3_000)
  assert.equal(await p, tgMsg(1))
  assert.equal(inner.sent[0]?.text, 'retry me')
})

test('ackButton bypasses the queue, even while the chat is paused; a reaction is a droppable hint and is dropped then', async () => {
  const inner = new Flaky429()
  const { clock, tg } = setup(inner)
  void tg.sendText('blocked').catch(() => {})
  await clock.advance(0)
  await tg.ackButton('cb1', 'ok')
  await tg.react(7, '👀')
  assert.deepEqual(inner.reactions, [], 'the reaction waited for nothing: it was dropped while paused')
  assert.equal(inner.sent.length, 0, 'the paused send has not left yet')
})

test('typing is dropped while a send is queued', async () => {
  const inner = new FakeChat()
  const { tg } = setup(inner)
  void tg.sendText('busy')
  await tg.typing()
  assert.equal(inner.sent.length, 1)
})

test('edits and file sends are queued and delegated', async () => {
  const inner = new FakeChat()
  const { tg } = setup(inner)
  await tg.editText(5, 'edited', null)
  await tg.editRows(6, 'rows', [])
  assert.equal(await tg.sendFile('/tmp/x.txt', false), tgMsg(1))
  assert.deepEqual(
    inner.edits.map((e) => e.messageId),
    [5, 6],
  )
})

// A fake inner port whose sendText fails once, for the text `failOn`.
class FailText extends FakeChat {
  failOn: string | null = null
  override async sendText(text: string, opts?: Parameters<FakeChat['sendText']>[1]): Promise<number> {
    if (text === this.failOn) {
      this.failOn = null
      throw new Error('chunk refused')
    }
    return super.sendText(text, opts)
  }
}

test('sendChunks: the chunks go out in order as one group; an urgent send goes between chunks, a normal one after the group', async () => {
  const { tg, inner } = setup()
  const chunks = tg.sendChunks(['c1', 'c2', 'c3'], { silent: true })
  const urgent = tg.sendText('urgent', { priority: 'urgent' })
  const after = tg.sendText('after')
  assert.equal((await chunks).length, 3)
  await Promise.all([urgent, after])
  assert.deepEqual(inner.sent.map((s) => s.text), ['c1', 'urgent', 'c2', 'c3', 'after'])
  assert.deepEqual(inner.sent[0]?.opts, { silent: true }, 'the options reach each chunk')
})

test('sendChunks: a chunk that fails stops the group; the error lists the chunks already sent', async () => {
  const inner = new FailText()
  inner.failOn = 'c2'
  const { tg } = setup(inner)
  await assert.rejects(tg.sendChunks(['c1', 'c2', 'c3']), (e: unknown) => e instanceof ChunkSendError && e.sentIds.length === 1)
  assert.deepEqual(inner.sent.map((s) => s.text), ['c1'], 'c3 is not sent after the failure')
})
