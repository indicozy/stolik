import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DUPLICATE_WINDOW_MS, OutboundLedger, OUTBOUND_GRACE_MS, outboundKeys, type Part } from '../src/router/outbound.ts'
import { ChunkSendError } from '../src/brain/outbound-queue.ts'
import { tgMsg } from '../src/adapters/chat/tg-ids.ts'

const T0 = 1_000_000_000_000

// A fake Telegram: each call returns the next message id; `fail` names part values that throw on their next send.
function fakeTelegram(fail: Set<string> = new Set()) {
  const calls: string[] = []
  let next = 100
  const deliver = async (part: Part) => {
    calls.push(part.value)
    if (fail.has(part.value)) {
      fail.delete(part.value)
      throw new Error(`400 Bad Request: ${part.value}`)
    }
    return tgMsg(next++)
  }
  return { calls, deliver }
}

function text(value: string): Part {
  return { kind: 'text', value }
}
function file(value: string, optional = false): Part {
  return { kind: 'file', value, photo: true, optional }
}

test('outboundKeys: kind, text and files all change the key; line endings and edges do not', () => {
  const a = outboundKeys('response', 'done', ['/x/a.png'])
  assert.equal(outboundKeys('response', '  done\r\n', ['/x/a.png']).key, a.key)
  assert.notEqual(outboundKeys('requested', 'done', ['/x/a.png']).key, a.key)
  assert.notEqual(outboundKeys('response', 'done!', ['/x/a.png']).key, a.key)
  assert.notEqual(outboundKeys('response', 'done', []).key, a.key)
  // The body key ignores the kind, so the same body can be matched across kinds.
  assert.equal(outboundKeys('requested', 'done', ['/x/a.png']).bodyKey, a.bodyKey)
  // File order does not matter.
  assert.equal(outboundKeys('response', 'd', ['/a', '/b']).key, outboundKeys('response', 'd', ['/b', '/a']).key)
})

test('retry during an in-flight send joins it: each part is sent once', async () => {
  const ledger = new OutboundLedger()
  const tg = fakeTelegram()
  const keys = outboundKeys('response', 'hello', ['/x/app.apk'])
  const parts = [text('hello'), file('/x/app.apk')]
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const slow = async (part: Part) => {
    await gate
    return tg.deliver(part)
  }
  const first = ledger.send({ keys, source: 'reply', parts, now: T0, deliver: slow })
  const retry = ledger.send({ keys, source: 'reply', parts, now: T0 + 10, deliver: tg.deliver })
  release()
  const [a, b] = await Promise.all([first, retry])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(b.deduped, true)
  assert.deepEqual(tg.calls, ['hello', '/x/app.apk'])
})

test('retry after a successful send is deduplicated', async () => {
  const ledger = new OutboundLedger()
  const tg = fakeTelegram()
  const keys = outboundKeys('response', 'hello', [])
  const first = await ledger.send({ keys, source: 'reply', parts: [text('hello')], now: T0, deliver: tg.deliver })
  const again = await ledger.send({ keys, source: 'reply', parts: [text('hello')], now: T0 + 5_000, deliver: tg.deliver })
  assert.equal(first.deduped, false)
  assert.equal(again.ok, true)
  assert.equal(again.deduped, true)
  assert.deepEqual(again.messageIds, first.messageIds)
  assert.deepEqual(tg.calls, ['hello'])
})

test('different text sends again', async () => {
  const ledger = new OutboundLedger()
  const tg = fakeTelegram()
  await ledger.send({ keys: outboundKeys('response', 'one', []), source: 'reply', parts: [text('one')], now: T0, deliver: tg.deliver })
  const two = await ledger.send({ keys: outboundKeys('response', 'two', []), source: 'reply', parts: [text('two')], now: T0, deliver: tg.deliver })
  assert.equal(two.deduped, false)
  assert.deepEqual(tg.calls, ['one', 'two'])
})

test('a new turn (clear) resets the ledger: the same text sends again', async () => {
  const ledger = new OutboundLedger()
  const tg = fakeTelegram()
  const keys = outboundKeys('response', 'ok', [])
  await ledger.send({ keys, source: 'reply', parts: [text('ok')], now: T0, deliver: tg.deliver })
  assert.equal(ledger.repliedThisTurn(T0), true)
  ledger.clear()
  assert.equal(ledger.repliedThisTurn(T0), false)
  const next = await ledger.send({ keys, source: 'reply', parts: [text('ok')], now: T0 + 1, deliver: tg.deliver })
  assert.equal(next.deduped, false)
  assert.deepEqual(tg.calls, ['ok', 'ok'])
})

test('Stop forward is skipped after a reply this turn, not after a message from another source', async () => {
  const ledger = new OutboundLedger()
  const tg = fakeTelegram()
  await ledger.send({ keys: outboundKeys('requested', 'pinged', []), source: 'notify', parts: [text('pinged')], now: T0, deliver: tg.deliver })
  assert.equal(ledger.repliedThisTurn(T0), false)
  await ledger.send({ keys: outboundKeys('response', 'answer', []), source: 'reply', parts: [text('answer')], now: T0, deliver: tg.deliver })
  assert.equal(ledger.repliedThisTurn(T0), true)
})

test('tg-notify of a body already sent by reply this turn is detected; other bodies are not', async () => {
  const ledger = new OutboundLedger()
  const tg = fakeTelegram()
  await ledger.send({ keys: outboundKeys('response', 'done. see  \n', ['/x/r.pdf']), source: 'reply', parts: [text('done. see'), file('/x/r.pdf')], now: T0, deliver: tg.deliver })
  assert.equal(ledger.hasSentBody(outboundKeys('requested', 'done. see', ['/x/r.pdf']).bodyKey, T0, 'reply'), true)
  assert.equal(ledger.hasSentBody(outboundKeys('requested', 'other', []).bodyKey, T0, 'reply'), false)
  assert.equal(ledger.hasSentBody(outboundKeys('requested', 'done. see', ['/x/r.pdf']).bodyKey, T0, 'notify'), false)
})

test('partial failure: the text is not re-sent, only the failed file is', async () => {
  const ledger = new OutboundLedger()
  const tg = fakeTelegram(new Set(['/x/shot.png']))
  const keys = outboundKeys('response', 'see attached', ['/x/shot.png', '/x/log.txt'])
  const parts = [text('see attached'), file('/x/shot.png'), file('/x/log.txt')]
  const failed = await ledger.send({ keys, source: 'reply', parts, now: T0, deliver: tg.deliver })
  assert.equal(failed.ok, false)
  assert.match(failed.error ?? '', /400 Bad Request/)
  assert.equal(failed.messageIds.length, 1, 'the text went out')
  assert.equal(ledger.repliedThisTurn(T0), true, 'a partly sent reply still counts as replied')

  const retry = await ledger.send({ keys, source: 'reply', parts, now: T0 + 1, deliver: tg.deliver })
  assert.equal(retry.ok, true)
  assert.deepEqual(tg.calls, ['see attached', '/x/shot.png', '/x/shot.png', '/x/log.txt'])
  assert.equal(retry.messageIds.length, 3)
})

test('an optional part that fails is given up without failing the message', async () => {
  const ledger = new OutboundLedger()
  const tg = fakeTelegram(new Set(['/x/auto.png']))
  const keys = outboundKeys('response', 'ok', [])
  const res = await ledger.send({ keys, source: 'hook', parts: [text('ok'), file('/x/auto.png', true)], now: T0, deliver: tg.deliver })
  assert.equal(res.ok, true)
  assert.equal(res.messageIds.length, 1)
  const again = await ledger.send({ keys, source: 'hook', parts: [text('ok'), file('/x/auto.png', true)], now: T0, deliver: tg.deliver })
  assert.equal(again.deduped, true)
  assert.deepEqual(tg.calls, ['ok', '/x/auto.png'])
})

test('after a Stop the ledger is forgotten once the grace period is over', async () => {
  const ledger = new OutboundLedger()
  const tg = fakeTelegram()
  const keys = outboundKeys('response', 'late', [])
  await ledger.send({ keys, source: 'reply', parts: [text('late')], now: T0, deliver: tg.deliver })
  ledger.armGrace(T0)
  assert.equal((await ledger.send({ keys, source: 'reply', parts: [text('late')], now: T0 + OUTBOUND_GRACE_MS - 1, deliver: tg.deliver })).deduped, true)
  assert.equal(ledger.repliedThisTurn(T0 + OUTBOUND_GRACE_MS), false)
  const after = await ledger.send({ keys, source: 'reply', parts: [text('late')], now: T0 + OUTBOUND_GRACE_MS, deliver: tg.deliver })
  assert.equal(after.deduped, false)
  assert.deepEqual(tg.calls, ['late', 'late'])
})

// Review finding 22: a chunk group that stopped part-way keeps the chunks that went out in the message ids.
test('a chunk group that stopped part-way: the chunks that did go out are in the message ids', async () => {
  const ledger = new OutboundLedger()
  const r = await ledger.send({
    keys: outboundKeys('response', 'a long answer', []),
    source: 'reply',
    parts: [{ kind: 'text', value: 'a', chunks: ['a', 'b', 'c'] }],
    now: T0,
    deliver: async () => {
      throw new ChunkSendError(new Error('refused'), [tgMsg(11), tgMsg(12)])
    },
  })
  assert.equal(r.ok, false)
  assert.deepEqual(r.messageIds, [tgMsg(11), tgMsg(12)])
  assert.equal(ledger.hasSentBody(outboundKeys('response', 'a long answer', []).bodyKey, T0, 'reply'), true, 'counts as sent for the Stop forward')
})

// Review finding 22: an identical message is a duplicate only within the reply window (a retry); after it, it is a new
// message. A duplicate is reported as not sent (deduped), never as delivered again.
test('an identical message is a duplicate within the reply window only; later the same text is sent again', async () => {
  const ledger = new OutboundLedger()
  let next = 100
  const deliver = async () => tgMsg(next++)
  const keys = outboundKeys('response', 'Done.', [])
  const parts = (): Part[] => [{ kind: 'text', value: 'Done.' }]
  const first = await ledger.send({ keys, source: 'reply', parts: parts(), now: T0, deliver })
  assert.deepEqual(first.messageIds, [tgMsg(100)])
  const retry = await ledger.send({ keys, source: 'reply', parts: parts(), now: T0 + 2_000, deliver })
  assert.equal(retry.deduped, true, 'the retry within the window is a duplicate')
  const later = await ledger.send({ keys, source: 'reply', parts: parts(), now: T0 + DUPLICATE_WINDOW_MS + 1, deliver })
  assert.equal(later.deduped, false)
  assert.deepEqual(later.messageIds, [tgMsg(101)])
})
