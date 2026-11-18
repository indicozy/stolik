import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QueuedChat } from '../src/adapters/chat/queued.ts'
import { OutboundQueues } from '../src/brain/outbound-queue.ts'
import { ChatError, type MessageId } from '../src/brain/chat-types.ts'
import { CUT_MARKER, cutToFit, measureOf, splitToFit, type Fit } from '../src/brain/chat-layout.ts'
import { contentLength, rowsToComponents, toChatError } from '../src/adapters/chat/discord-map.ts'
import { FakeChat, DISCORD_GUILD } from './helpers/fakes.ts'
import { DISCORD_CAPABILITIES } from '../src/adapters/chat/discord-map.ts'
import { FakeQueueClock } from './helpers/queue-clock.ts'

// The limits audit (research/23): every outgoing text fits the app's maxChars after the app's escaping, edits are cut to
// fit, the file cap comes from the app, Discord's error codes map to kinds, and invalid buttons are ChatErrors.

const REPLY_TO = 'dc:100000000000000002:1000000000000000005' as MessageId
const menu = (n: number) => Array.from({ length: n }, (_, i) => [{ text: `Session ${i}`, data: `rt:s:${i}` }])
const MARKDOWN_HEAVY = '*_~`|#>[]()- 1. '

function setup(discord: boolean) {
  // The Discord profile is the adapter's own capabilities (with text.measure), so the fake counts what Discord counts.
  const inner = new FakeChat({ discord, ...(discord ? { capabilities: DISCORD_CAPABILITIES } : {}) })
  const logs: string[] = []
  const chat = new QueuedChat(inner, discord ? '' : '-1001', new OutboundQueues(new FakeQueueClock(), inner.capabilities.rate), (m) => logs.push(m))
  if (discord) chat.setHome(DISCORD_GUILD)
  return { inner, chat, logs }
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setImmediate(r))
}

const plainFit: Fit = { max: 2000, format: 'plain', measure: contentLength }
const mdFit: Fit = { max: 2000, format: 'markdown', measure: contentLength }

test('splitToFit: pieces measured after escaping all fit, and no text is lost', () => {
  const text = MARKDOWN_HEAVY.repeat(400) // every character is a Markdown character, so escaping roughly doubles it
  const parts = splitToFit(text, 1904, plainFit)
  assert.ok(parts.length > 1)
  for (const p of parts) assert.ok(contentLength(p, 'plain') <= 2000, `piece measures ${contentLength(p, 'plain')}`)
  assert.equal(parts.join(''), text)
})

test('splitToFit: without a measure the raw length is the limit', () => {
  const parts = splitToFit('a'.repeat(4500), 3904, { max: 4096, format: 'plain' })
  assert.deepEqual(parts.map((p) => p.length), [3904, 596])
  assert.equal(measureOf('abc', { max: 10, format: 'plain' }), 3)
})

test('cutToFit: an edit over the limit keeps its tail behind the cut marker and never splits a surrogate pair', () => {
  const text = 'x'.repeat(3000) + '😀 STATUS: done'
  const out = cutToFit(text, plainFit)
  assert.ok(out.length <= 2000)
  assert.ok(out.startsWith(CUT_MARKER))
  assert.ok(out.endsWith('STATUS: done'))
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out))
  assert.equal(cutToFit('short', plainFit), 'short')
})

test('Discord: a long plain reply goes out as pieces that each fit 2000 after escaping', async () => {
  const { inner, chat } = setup(true)
  const text = MARKDOWN_HEAVY.repeat(300)
  await chat.sendText(text, {})
  await until(() => inner.sent.length > 1)
  assert.ok(inner.sent.length > 1)
  for (const s of inner.sent) assert.ok(contentLength(s.text, 'plain') <= 2000)
  assert.equal(inner.sent.map((s) => s.text).join(''), text)
})

test('Discord: a markdown reply split inside a code fence keeps every piece with closed fences', async () => {
  const { inner, chat } = setup(true)
  const body = Array.from({ length: 200 }, (_, i) => `line ${i} ${'y'.repeat(20)}`).join('\n')
  await chat.sendText('```ts\n' + body + '\n```', { format: 'markdown' })
  await until(() => inner.sent.length > 1)
  assert.ok(inner.sent.length > 1)
  for (const s of inner.sent) {
    assert.ok(s.text.length <= 2000)
    assert.equal((s.text.match(/```/g) ?? []).length % 2, 0, 'fence closed in every piece')
  }
})

test('Discord: sendChunks re-splits an over-long chunk, keeps order, replyTo on the first and rows on the last', async () => {
  const { inner, chat } = setup(true)
  await chat.sendChunks(['a'.repeat(2500), 'tail'], { replyTo: REPLY_TO, rows: menu(2) })
  await until(() => inner.sent.length >= 3)
  assert.equal(inner.sent.length, 3)
  assert.ok(inner.sent.every((s) => s.text.length <= 2000))
  assert.equal(inner.sent[0]!.opts?.replyTo, REPLY_TO)
  assert.equal(inner.sent[1]!.opts?.replyTo, undefined)
  assert.equal(inner.sent[1]!.opts?.rows, undefined)
  assert.equal(inner.sent[2]!.text, 'tail')
  assert.deepEqual(inner.sent[2]!.opts?.rows, menu(2))
})

test('Discord: an edit over the limit is cut and logged, not sent too long', async () => {
  const { inner, chat, logs } = setup(true)
  const id = (await chat.sendText('hello', {})) as MessageId
  await chat.editText(id, 'x'.repeat(3000) + ' status', null)
  assert.equal(inner.edits.length, 1)
  assert.ok(inner.edits[0]!.text.length <= 2000)
  assert.ok(inner.edits[0]!.text.endsWith(' status'))
  assert.ok(logs.some((l) => /cut to the Discord limit/.test(l)))
})

test('Discord: rows dropped by the layout are said in the text, not dropped silently', async () => {
  const { inner, chat, logs } = setup(true)
  const id = (await chat.sendText('hello', {})) as MessageId
  await chat.editRows(id, 'pick', Array.from({ length: 6 }, (_, i) => [{ text: `a${i}`, data: `x${i}` }, { text: 'b', data: `y${i}` }]))
  assert.match(inner.edits[0]!.text, /1 button row not shown: Discord allows 5/)
  assert.ok(logs.some((l) => /past the limit/.test(l)))
})

test('Telegram: a 4000-character text is one message, unchanged', async () => {
  const { inner, chat } = setup(false)
  await chat.sendText('y'.repeat(4000), {})
  assert.equal(inner.sent.length, 1)
  assert.equal(inner.sent[0]!.text.length, 4000)
})

test('Discord error codes map to the right kinds (table)', () => {
  const cases: Array<[number, string]> = [
    [160006, 'quota'],
    [30046, 'quota'],
    [50007, 'access-lost'],
    [50278, 'access-lost'],
    [50006, 'other'],
  ]
  for (const [code, kind] of cases) {
    const e = toChatError(Object.assign(new Error(`api ${code}`), { code, status: 400 }))
    assert.equal(e.kind, kind, `code ${code}`)
    assert.equal(e.description, `api ${code}`)
    assert.equal(e.transient, false)
  }
})

test('invalid Discord buttons throw a ChatError (reported by the failed-reply notice), not a plain Error', () => {
  assert.throws(() => rowsToComponents([[{ text: '', data: 'a' }]]), (e: unknown) => e instanceof ChatError && e.kind === 'other')
  assert.throws(() => rowsToComponents([[{ text: 'a', data: 'd' }, { text: 'b', data: 'd' }]]), (e: unknown) => e instanceof ChatError)
  assert.throws(() => rowsToComponents([[{ text: 'a', data: 'x'.repeat(101) }]]), (e: unknown) => e instanceof ChatError)
})
