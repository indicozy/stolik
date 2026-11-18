import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QueuedChat } from '../src/adapters/chat/queued.ts'
import { OutboundQueues } from '../src/brain/outbound-queue.ts'
import { ChatError, type MessageId } from '../src/brain/chat-types.ts'
import { FakeChat, DISCORD_GUILD } from './helpers/fakes.ts'
import { tgMsg } from '../src/adapters/chat/tg-ids.ts'
import { FakeQueueClock } from './helpers/queue-clock.ts'

// The chat boundary (QueuedChat) on both profiles: rows laid out for the app, long texts chunked, and the notice when a
// reply to the owner fails for good. The Telegram profile is the default FakeChat; the Discord one is FakeChat({ discord }).

const REPLY_TO = 'dc:100000000000000002:1000000000000000005' as MessageId
const menu = (n: number) => Array.from({ length: n }, (_, i) => [{ text: `Session ${i}`, data: `rt:s:${i}` }])

function setup(discord: boolean) {
  const inner = new FakeChat({ discord })
  const logs: string[] = []
  const chat = new QueuedChat(inner, discord ? '' : '-1001', new OutboundQueues(new FakeQueueClock(), inner.capabilities.rate), (m) => logs.push(m))
  if (discord) chat.setHome(DISCORD_GUILD)
  return { inner, chat, logs }
}

// The queue runs its sends on its own timers; wait for the condition, bounded.
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setImmediate(r))
}

test('Discord: a ten-row menu reaches the app as two rows of five, and the drop is logged when it does not fit', async () => {
  const { inner, chat, logs } = setup(true)
  await chat.sendText('pick a session', { rows: menu(10) })
  const rows = inner.sent[0].opts?.rows as Array<Array<{ text: string }>>
  assert.deepEqual(rows.map((r) => r.length), [5, 5])
  assert.equal(logs.length, 0)
  await chat.sendText('pick again', { rows: Array.from({ length: 6 }, (_, i) => [{ text: `a${i}`, data: `x${i}` }, { text: 'b', data: `y${i}` }]) })
  const second = inner.sent[1].opts?.rows as unknown[]
  assert.equal(second.length, 5)
  assert.ok(logs.some((l) => /1 button row\(s\) past the limit of 5/.test(l)))
})

test('Telegram: the same ten-row menu goes out unchanged', async () => {
  const { inner, chat, logs } = setup(false)
  await chat.sendText('pick a session', { rows: menu(10) })
  assert.deepEqual(inner.sent[0].opts?.rows, menu(10))
  assert.equal(logs.length, 0)
})

test('Discord: a text over 2000 characters goes out in chunks: replyTo on the first, rows on the last', async () => {
  const { inner, chat } = setup(true)
  const text = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(8)}`).join('\n')
  assert.ok(text.length > 2000)
  const id = await chat.sendText(text, { replyTo: REPLY_TO, rows: menu(2) })
  assert.equal(typeof id, 'string')
  assert.ok(inner.sent.length >= 2)
  for (const s of inner.sent) assert.ok(s.text.length <= 2000, `chunk of ${s.text.length} characters`)
  assert.equal(inner.sent[0].opts?.replyTo, REPLY_TO)
  assert.equal(inner.sent.slice(1).every((s) => s.opts?.replyTo === undefined), true)
  const last = inner.sent[inner.sent.length - 1]
  assert.equal((last.opts?.rows as unknown[]).length, 2)
  assert.equal(inner.sent.slice(0, -1).every((s) => s.opts?.rows === undefined), true)
  assert.equal(inner.sent.map((s) => s.text).join('\n'), text)
})

test('Telegram: a text under 4096 characters is one message; a longer one is chunked', async () => {
  const { inner, chat } = setup(false)
  await chat.sendText('y'.repeat(3000))
  assert.equal(inner.sent.length, 1)
  assert.equal(inner.chunkCalls.length, 0)
  await chat.sendText('z'.repeat(4500))
  assert.equal(inner.sent.length, 3)
  assert.ok(inner.sent.slice(1).every((s) => s.text.length <= 4096))
})

test('a reply to the owner that fails for good gets one plain notice in the same chat', async () => {
  const { inner, chat } = setup(true)
  inner.fail('too-long')
  await assert.rejects(chat.sendText('the reply', { replyTo: REPLY_TO }))
  await until(() => inner.sent.some((s) => s.text.startsWith('That reply')))
  const notices = inner.sent.filter((s) => s.text.startsWith('That reply'))
  assert.equal(notices.length, 1)
  assert.equal(notices[0].text, 'That reply could not be sent: fake telegram: too-long.')
  assert.equal(notices[0].opts?.replyTo, undefined)
})

test('a failed send with no replyTo gets no notice', async () => {
  const { inner, chat } = setup(true)
  inner.fail('too-long')
  await assert.rejects(chat.sendText('not a reply'))
  await new Promise((r) => setImmediate(r))
  assert.equal(inner.sent.some((s) => s.text.startsWith('That reply')), false)
})

test('a chunk that fails for good stops the rest, the owner gets one notice, and the notice is tried once', async () => {
  const { inner, chat } = setup(true)
  const original = inner.sendText.bind(inner)
  let chunkCalls = 0
  let noticeTries = 0
  inner.sendText = async (text, opts) => {
    if (text.startsWith('That reply')) {
      noticeTries++
      throw new ChatError('other', 'notice refused')
    }
    if (++chunkCalls === 2) throw new ChatError('other', 'chunk refused')
    return original(text, opts)
  }
  // 3000 characters: two chunks. The second is refused, so nothing after it is tried.
  await assert.rejects(chat.sendText('l\n'.repeat(1500), { replyTo: REPLY_TO }))
  await until(() => noticeTries > 0)
  await new Promise((r) => setImmediate(r))
  assert.equal(chunkCalls, 2)
  assert.equal(noticeTries, 1)
})

test('an edit with rows is laid out for the app too', async () => {
  const { inner, chat } = setup(true)
  const id = await chat.sendText('menu')
  await chat.editRows(id, 'menu again', menu(10))
  const edited = inner.rowEdits[inner.rowEdits.length - 1]
  assert.deepEqual(edited.rows.map((r) => r.length), [5, 5])
})

// A refusal that says the bot lost the group reaches onAccessError only when the target is the group. A failed DM to the
// owner (Discord 50007, Telegram "bot was blocked by the user") says nothing about the group and is only logged.
// The group is bound here, so that a send without `dm` counts as a home send.
const groupSetup = (discord: boolean) => {
  const s = setup(discord)
  s.chat.setHome(discord ? DISCORD_GUILD : '-1001')
  return s
}

for (const discord of [false, true]) {
  const name = discord ? 'Discord' : 'Telegram'

  test(`${name}: an access-lost refusal of a DM send does not report losing the group`, async () => {
    const { inner, chat } = groupSetup(discord)
    const lost: string[] = []
    chat.onAccessError((reason) => lost.push(reason))
    inner.fail('access-lost')
    await assert.rejects(chat.sendText('to the owner', { dm: true }), (e: unknown) => e instanceof ChatError && e.kind === 'access-lost')
    assert.deepEqual(lost, [])
  })

  test(`${name}: an access-lost refusal of a home send still reports losing the group`, async () => {
    const { inner, chat } = groupSetup(discord)
    const lost: string[] = []
    chat.onAccessError((reason) => lost.push(reason))
    inner.fail('access-lost')
    await assert.rejects(chat.sendText('to the group'), (e: unknown) => e instanceof ChatError && e.kind === 'access-lost')
    assert.equal(lost.length, 1)
  })

  test(`${name}: an access-lost refusal of an edit or reaction on a DM message does not report losing the group`, async () => {
    const { inner, chat } = groupSetup(discord)
    const lost: string[] = []
    chat.onAccessError((reason) => lost.push(reason))
    const id = await chat.sendText('owner notice', { dm: true })
    inner.fail('access-lost')
    await assert.rejects(chat.editText(id, 'edited', null), (e: unknown) => e instanceof ChatError && e.kind === 'access-lost')
    inner.fail('access-lost')
    await assert.rejects(chat.react(id, 'seen'), (e: unknown) => e instanceof ChatError && e.kind === 'access-lost')
    assert.deepEqual(lost, [])
  })
}

// An edit or a reaction reports a lost group only on a message the adapter knows as a home message: one it does not know
// (after a restart, or evicted from its memory) may be a DM.
for (const discord of [false, true]) {
  const name = discord ? 'Discord' : 'Telegram'

  test(`${name}: an access-lost refusal of an edit on a message the adapter does not know does not report losing the group`, async () => {
    const { inner, chat } = groupSetup(discord)
    const lost: string[] = []
    chat.onAccessError((reason) => lost.push(reason))
    const unknown = discord ? ('dc:100000000000000002:1000000000000000099' as MessageId) : tgMsg(99)
    inner.fail('access-lost')
    await assert.rejects(chat.editText(unknown, 'edited', null), (e: unknown) => e instanceof ChatError && e.kind === 'access-lost')
    assert.deepEqual(lost, [])
  })

  test(`${name}: an access-lost refusal of an edit on a known home message still reports losing the group`, async () => {
    const { inner, chat } = groupSetup(discord)
    const lost: string[] = []
    chat.onAccessError((reason) => lost.push(reason))
    const id = await chat.sendText('group notice')
    inner.fail('access-lost')
    await assert.rejects(chat.editText(id, 'edited', null), (e: unknown) => e instanceof ChatError && e.kind === 'access-lost')
    assert.equal(lost.length, 1)
  })
}
