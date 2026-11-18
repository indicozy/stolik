// The outbound ledger in the store (outbound_ledger rows): a send is recorded, a fresh ledger (a simulated restart)
// finds it, the turn mark keeps old turns out, and the prune drops rows older than two days.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OutboundLedger, outboundKeys, startLedgerPrune, LEDGER_KEEP_MS, type Part } from '../src/router/outbound.ts'
import type { LedgerRecord } from '../src/ports.ts'
import { harness } from './helpers/fakes.ts'
import { sendForSession } from '../src/router/send.ts'

const T0 = Date.UTC(2026, 10, 14, 12)

// A fake store with the store's method names. The rows survive a new OutboundLedger, as the SQLite rows do.
class FakeDb {
  rows: LedgerRecord[] = []
  failWrites = false
  listLedger(sessionKey: number | string): LedgerRecord[] {
    return this.rows.filter((r) => r.sessionKey === sessionKey)
  }
  appendLedger(entries: readonly LedgerRecord[]): void {
    if (this.failWrites) throw new Error('disk full')
    this.rows.push(...entries.map((e) => ({ ...e, messageIds: [...e.messageIds] })))
  }
  pruneOutboundLedger(olderThanMs: number): number {
    const before = this.rows.length
    this.rows = this.rows.filter((r) => r.at >= olderThanMs)
    return before - this.rows.length
  }
}

const text = (value: string): Part => ({ kind: 'text', value })
const file = (value: string): Part => ({ kind: 'file', value })

// A delivery that gives the next message id each time and records what it sent.
function chat() {
  const sent: string[] = []
  let id = 100
  return {
    sent,
    deliver: async (part: Part): Promise<number> => {
      sent.push(part.value)
      return ++id
    },
  }
}

test('a send is recorded in the store, and a fresh ledger finds it after a restart', async () => {
  const db = new FakeDb()
  const tg = chat()
  const keys = outboundKeys('response', 'hello', [])
  const first = new OutboundLedger()
  first.attach(db, 42)
  const res = await first.send({ keys, source: 'reply', parts: [text('hello')], now: T0, deliver: tg.deliver })
  assert.equal(res.ok, true)
  assert.equal(db.rows.length, 1)
  assert.deepEqual(db.rows[0].messageIds, [101])

  // Restart: a new ledger on the same rows.
  const after = new OutboundLedger()
  after.attach(db, 42)
  assert.equal(after.repliedThisTurn(T0 + 1), true, 'the reply is known to the Stop forward')
  const again = await after.send({ keys, source: 'reply', parts: [text('hello')], now: T0 + 1, deliver: tg.deliver })
  assert.equal(again.deduped, true)
  assert.deepEqual(again.messageIds, [101])
  assert.deepEqual(tg.sent, ['hello'], 'nothing is sent a second time')
})

test('a retry after a restart of a partly sent message sends only the failed part', async () => {
  const db = new FakeDb()
  const keys = outboundKeys('response', 'done', ['/x/r.pdf'])
  const parts = [text('done'), file('/x/r.pdf')]
  const first = new OutboundLedger()
  first.attach(db, 42)
  const failing = async (part: Part): Promise<number> => {
    if (part.kind === 'file') throw new Error('upload failed')
    return 7
  }
  const failed = await first.send({ keys, source: 'reply', parts, now: T0, deliver: failing })
  assert.equal(failed.ok, false)
  assert.equal(db.rows.length, 1, 'only the sent part has a row')

  const tg = chat()
  const after = new OutboundLedger()
  after.attach(db, 42)
  const retry = await after.send({ keys, source: 'reply', parts: [text('done'), file('/x/r.pdf')], now: T0 + 1, deliver: tg.deliver })
  assert.equal(retry.ok, true)
  assert.deepEqual(tg.sent, ['/x/r.pdf'], 'the text is not sent again')
  assert.deepEqual(retry.messageIds, [7, 101])
})

test('a new turn after a restart does not dedupe the same text from the old turn', async () => {
  const db = new FakeDb()
  const keys = outboundKeys('response', 'ok', [])
  const first = new OutboundLedger()
  first.attach(db, 42)
  await first.send({ keys, source: 'reply', parts: [text('ok')], now: T0, deliver: chat().deliver })
  first.clear() // markPrompt: the turn mark goes to the store
  const tg = chat()
  const after = new OutboundLedger()
  after.attach(db, 42)
  assert.equal(after.repliedThisTurn(T0 + 1), false, 'the old turn is not read back')
  const res = await after.send({ keys, source: 'reply', parts: [text('ok')], now: T0 + 2, deliver: tg.deliver })
  assert.equal(res.deduped, false)
  assert.deepEqual(tg.sent, ['ok'])
})

test('rows of other sessions are not read back', async () => {
  const db = new FakeDb()
  const first = new OutboundLedger()
  first.attach(db, 42)
  await first.send({ keys: outboundKeys('response', 'x', []), source: 'reply', parts: [text('x')], now: T0, deliver: chat().deliver })
  const other = new OutboundLedger()
  other.attach(db, 'other')
  assert.equal(other.repliedThisTurn(T0), false)
})

test('a failed store write does not fail the send, and is reported', async () => {
  const db = new FakeDb()
  db.failWrites = true
  const reported: string[] = []
  const ledger = new OutboundLedger()
  ledger.attach(db, 42, (m) => reported.push(m))
  const tg = chat()
  const res = await ledger.send({ keys: outboundKeys('response', 'y', []), source: 'reply', parts: [text('y')], now: T0, deliver: tg.deliver })
  assert.equal(res.ok, true)
  assert.deepEqual(tg.sent, ['y'])
  assert.ok(reported.some((m) => /write failed/.test(m)))
})

test('the prune keeps two days of rows: it runs at start with the cutoff, once per store', () => {
  const db = new FakeDb()
  db.rows = [
    { sessionKey: 1, key: 'old', bodyKey: 'b', source: 'reply', at: T0 - LEDGER_KEEP_MS - 1, messageIds: [1] },
    { sessionKey: 1, key: 'new', bodyKey: 'b', source: 'reply', at: T0 - 1000, messageIds: [2] },
  ]
  const cutoffs: number[] = []
  const spy = { pruneOutboundLedger: (ms: number) => (cutoffs.push(ms), db.pruneOutboundLedger(ms)) }
  startLedgerPrune(spy, () => T0)
  startLedgerPrune(spy, () => T0)
  assert.deepEqual(cutoffs, [T0 - LEDGER_KEEP_MS], 'one run at start, with the two-day cutoff')
  assert.deepEqual(db.rows.map((r) => r.key), ['new'])
  assert.equal(LEDGER_KEEP_MS, 2 * 24 * 60 * 60_000)
})

test('a session claimed after a restart sees the reply sent before it, through the router, before any send', async () => {
  const { router, store } = harness()
  const now = router.clock.now()
  const first = router.registry.registerChannel({ pid: 42, start: 'start-42' }, '/w/proj', now)
  await sendForSession(router, first, 'hello', 'response', [], 'reply')
  assert.equal(store.listLedger(first.key).length, 1, 'the send is persisted')

  // Restart: the in-memory registry is gone, the store keeps its rows. The session is claimed again and nothing is sent.
  router.registry.remove(first.key)
  const after = router.registry.registerChannel({ pid: 42, start: 'start-42' }, '/w/proj', now + 1)
  assert.notEqual(after, first)
  assert.equal(after.outbound.repliedThisTurn(now + 1), true, 'the Stop forward sees the reply from before the restart')
  assert.equal(after.outbound.hasSentBody(outboundKeys('response', 'hello', []).bodyKey, now + 1, 'reply'), true, 'a requested dedupe sees it too')
})

test('the router prunes ledger rows older than two days when it starts', async () => {
  const { router, store } = harness()
  const now = router.clock.now()
  store.appendLedger([
    { sessionKey: 42, key: 'stale', bodyKey: 'b', source: 'reply', at: now - LEDGER_KEEP_MS - 1, messageIds: [1] },
    { sessionKey: 42, key: 'fresh', bodyKey: 'b', source: 'reply', at: now - 1000, messageIds: [2] },
  ])
  await router.start()
  assert.deepEqual(store.listLedger(42).map((r) => r.key), ['fresh'])
})
