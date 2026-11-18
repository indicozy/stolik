// Per-session outbound ledger: what the router already sent in the current turn, so that a retried reply, a
// Stop-hook forward or a tg-notify of the same text is not sent twice. Pure: the Telegram calls are passed in
// as `deliver`, so this module is unit-tested without the network.
import { createHash } from 'node:crypto'
import type { SessionKey } from '../brain/sessions.ts'
import type { MessageId } from '../brain/chat-types.ts'
import type { LedgerRecord, StorePort } from '../ports.ts'

// After a Stop, retries of the turn's messages are still deduplicated for this long; then the ledger forgets.
export const OUTBOUND_GRACE_MS = 60_000

export type OutboundSource = 'reply' | 'notify' | 'hook'
export type Kind = 'response' | 'requested' | 'proactive'

// One Telegram message to send: a text chunk, or a file. `optional` parts (auto-attached images) are given up
// on failure instead of failing the whole message.
// A text part with `chunks` is one group of chunks sent together (value is its first chunk). A partly sent group keeps
// only its unsent chunks in `chunks`, so a retry sends the rest.
export type Part = { kind: 'text' | 'file'; value: string; photo?: boolean; optional?: boolean; chunks?: string[] }

export type OutboundResult = { ok: boolean; messageIds: MessageId[]; deduped: boolean; error?: string }

export type OutboundKeys = { key: string; bodyKey: string }

type PartState = { part: Part; done: boolean }

type Entry = {
  key: string
  bodyKey: string
  source: OutboundSource
  parts: PartState[]
  running: Promise<OutboundResult> | null
  messageIds: MessageId[]
  // Set for an entry read back from the store: the first `restored` parts of the message were sent before the restart.
  restored: number
  // When the entry was last fully delivered (epoch ms), or null.
  doneAt: number | null
}

// The store side of the ledger (the outbound_ledger rows of one session).
export type LedgerSink = Pick<StorePort, 'listLedger' | 'appendLedger'>

// Rows older than this are pruned from the store; a restart within it still finds the turn's sends.
export const LEDGER_KEEP_MS = 2 * 24 * 60 * 60_000
export const LEDGER_PRUNE_MS = 6 * 60 * 60_000

// Written by clear() (a new turn). Only the rows after the last mark are read back, so an old turn's text is not deduped.
const TURN_MARK = 'turn'

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

// A message identical to one that finished successfully is a duplicate (not sent again) only within this window: a
// retry of a reply comes back within the reply timeout (120 s, docs/design-v3.md 4.5). Later, the same text is a new message.
export const DUPLICATE_WINDOW_MS = 120_000

// Keys for one message. Text is normalised (line endings, surrounding whitespace); files are compared as a sorted
// list. `key` covers the kind too; `bodyKey` is the text and files alone, to match the same body across kinds.
export function outboundKeys(kind: Kind, text: string, files: readonly string[]): OutboundKeys {
  const norm = text.replace(/\r\n?/g, '\n').trim()
  const sorted = [...files].sort()
  return { key: digest([kind, norm, sorted]), bodyKey: digest([norm, sorted]) }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export class OutboundLedger {
  private entries = new Map<string, Entry>()
  // Set by markStop: the ledger forgets its entries at this time (see OUTBOUND_GRACE_MS).
  private graceUntil: number | null = null
  // The store the rows go to, once attach() ran.
  private sink: LedgerSink | null = null
  private persistKey: SessionKey | null = null
  private onError: (msg: string) => void = () => {}

  // Persists this ledger in `sink` for the session `sessionKey`. The rows of the current turn are read back (those
  // after the last turn mark), so a retry after a router restart joins or reuses what was already sent. Once per ledger.
  attach(sink: LedgerSink, sessionKey: SessionKey, onError: (msg: string) => void = () => {}): void {
    if (this.sink) return
    this.sink = sink
    this.persistKey = sessionKey
    this.onError = onError
    try {
      const rows = sink.listLedger(sessionKey)
      let from = 0
      rows.forEach((r, i) => {
        if (r.source === TURN_MARK) from = i + 1
      })
      for (const r of rows.slice(from)) {
        let e = this.entries.get(r.key)
        if (!e) {
          e = { key: r.key, bodyKey: r.bodyKey, source: r.source as OutboundSource, parts: [], running: null, messageIds: [], restored: 0, doneAt: null }
          this.entries.set(e.key, e)
        }
        e.messageIds.push(...r.messageIds)
        e.restored++
      }
    } catch (e) {
      onError(`outbound ledger read failed: ${errText(e)}`)
    }
  }

  // Drops the finished entries once the grace after a Stop has run out. Running sends are kept, so their retries
  // still join them.
  private prune(now: number): void {
    if (this.graceUntil === null || now < this.graceUntil) return
    this.graceUntil = null
    for (const [k, e] of this.entries) if (!e.running) this.entries.delete(k)
  }

  // Sends the parts of one message, or joins the send already running for the same key, or resumes a partly
  // failed one (only its unsent parts go out). `deliver` sends one part and returns its Telegram message id;
  // a throw leaves that part unsent for a retry (or gives it up when the part is optional). `index` is the part's
  // position in the message as first sent; a retry's `parts` are equal in content but not the stored objects.
  send(opts: {
    keys: OutboundKeys
    source: OutboundSource
    parts: Part[]
    now: number
    deliver: (part: Part, index: number) => Promise<MessageId>
  }): Promise<OutboundResult> {
    this.prune(opts.now)
    let e = this.entries.get(opts.keys.key)
    if (!e) {
      e = {
        key: opts.keys.key,
        bodyKey: opts.keys.bodyKey,
        source: opts.source,
        parts: opts.parts.map((part) => ({ part, done: false })),
        running: null,
        messageIds: [],
        restored: 0,
        doneAt: null,
      }
      this.entries.set(e.key, e)
    } else if (e.doneAt !== null && e.parts.every((p) => p.done) && !e.running && opts.now - e.doneAt > DUPLICATE_WINDOW_MS) {
      // Delivered long ago: the same text now is a new message.
      e = {
        key: opts.keys.key,
        bodyKey: opts.keys.bodyKey,
        source: opts.source,
        parts: opts.parts.map((part) => ({ part, done: false })),
        running: null,
        messageIds: [],
        restored: 0,
        doneAt: null,
      }
      this.entries.set(e.key, e)
    } else if (e.restored > 0) {
      // Read back from the store: the parts it covers were sent (parts go out in order, so they are the first ones).
      const sent = e.restored
      e.parts = opts.parts.map((part, i) => ({ part, done: i < sent }))
      e.restored = 0
    }
    const entry = e
    if (entry.running) return entry.running.then((r) => ({ ...r, deduped: true }))
    if (entry.parts.every((p) => p.done)) {
      return Promise.resolve({ ok: true, messageIds: [...entry.messageIds], deduped: true })
    }
    entry.running = this.run(entry, opts.deliver, opts.now)
      .then((r) => {
        if (r.ok) entry.doneAt = opts.now
        return r
      })
      .finally(() => {
        entry.running = null
      })
    return entry.running
  }

  // One store row per part outcome, written as the part finishes (a failed part writes none).
  private async run(entry: Entry, deliver: (part: Part, index: number) => Promise<MessageId>, now: number): Promise<OutboundResult> {
    for (let i = 0; i < entry.parts.length; i++) {
      const ps = entry.parts[i]
      if (ps.done) continue
      try {
        const id = await deliver(ps.part, i)
        ps.done = true
        entry.messageIds.push(id)
        this.persist(entry, [id], now)
      } catch (e) {
        // A part that stopped part-way (a chunk group) reports the chunks that did go out: they are recorded too.
        const sent = (e as { sentIds?: unknown } | null)?.sentIds
        if (Array.isArray(sent)) for (const id of sent) if (typeof id === 'string') entry.messageIds.push(id as MessageId)
        if (ps.part.optional) {
          ps.done = true
          this.persist(entry, [], now)
          continue
        }
        return { ok: false, messageIds: [...entry.messageIds], deduped: false, error: errText(e) }
      }
    }
    return { ok: true, messageIds: [...entry.messageIds], deduped: false }
  }

  private persist(entry: Entry, messageIds: MessageId[], at: number): void {
    this.write({ key: entry.key, bodyKey: entry.bodyKey, source: entry.source, at, messageIds })
  }

  // Appends one row to the store. A failed write is reported and the send goes on (the send itself is not affected).
  private write(row: { key: string; bodyKey: string; source: string; at: number; messageIds: MessageId[] }): void {
    if (!this.sink || this.persistKey === null) return
    try {
      const rec: LedgerRecord = { sessionKey: this.persistKey, ...row }
      this.sink.appendLedger([rec])
    } catch (e) {
      this.onError(`outbound ledger write failed: ${errText(e)}`)
    }
  }

  // True when a reply-tool send this turn delivered at least one message. Used by the Stop forward.
  repliedThisTurn(now: number): boolean {
    this.prune(now)
    for (const e of this.entries.values()) if (e.source === 'reply' && e.messageIds.length > 0) return true
    return false
  }

  // True when the same text and files were already delivered this turn from `source`.
  hasSentBody(bodyKey: string, now: number, source: OutboundSource): boolean {
    this.prune(now)
    for (const e of this.entries.values()) {
      if (e.bodyKey === bodyKey && e.source === source && e.messageIds.length > 0) return true
    }
    return false
  }

  // markStop: keep the entries for OUTBOUND_GRACE_MS more, so late retries of this turn are still deduplicated.
  armGrace(now: number): void {
    this.graceUntil = now + OUTBOUND_GRACE_MS
  }

  // markPrompt: a new turn. Finished entries go; running sends stay so their retries still join them. The store gets a
  // turn mark (the time is the wall clock; only the order of the rows matters to the read-back).
  clear(): void {
    this.graceUntil = null
    for (const [k, e] of this.entries) if (!e.running) this.entries.delete(k)
    this.write({ key: '', bodyKey: '', source: TURN_MARK, at: Date.now(), messageIds: [] })
  }
}

const pruning = new WeakSet<object>()

// Prunes the store's ledger rows older than LEDGER_KEEP_MS: once now, then every LEDGER_PRUNE_MS (unref'd timer).
// Only the first call per store does anything.
export function startLedgerPrune(store: { pruneOutboundLedger(olderThanMs: number): number }, now: () => number, onError: (msg: string) => void = () => {}): void {
  if (pruning.has(store)) return
  pruning.add(store)
  const run = (): void => {
    try {
      store.pruneOutboundLedger(now() - LEDGER_KEEP_MS)
    } catch (e) {
      onError(`outbound ledger prune failed: ${errText(e)}`)
    }
  }
  run()
  setInterval(run, LEDGER_PRUNE_MS).unref()
}
