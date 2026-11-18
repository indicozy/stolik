// Router side of the addon requests (plan 2.8, 2.11): sends with buttons, the quota gate and the once-a-day alert, the
// usage log, /usage, and the button route. Uses the router's fakes (test/helpers/fakes.ts).
import './helpers/isolate.ts'
import { tgMsg, tgThread } from '../src/adapters/chat/tg-ids.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AddonBridge, onBridgeCallback, parseBridgeCallback } from '../src/router/addon-bridge.ts'
import { TELEGRAM_CAPABILITIES } from '../src/adapters/chat/telegram.ts'
import { SqliteStore } from '../src/adapters/store-sqlite.ts'
import type { QuotaStatus } from '../src/brain/usage.ts'
import { newChatLine, type ChatLine } from '../src/brain/chatlog.ts'
import type { ChatLogPort } from '../src/ports.ts'
import { HOME, harness } from './helpers/fakes.ts'

// A bridge over a fresh database (usage rows and the alert day), with a fixed clock (2026-11-14 15:00 local) and a settable quota.
function bridgeFor(over: { quota?: QuotaStatus | null; weeklyLimitPct?: number; chatLog?: ChatLogPort; readChat?: (from: string, days: number) => ChatLine[] } = {}) {
  const h = harness({ chatLog: over.chatLog })
  const dir = mkdtempSync(join(tmpdir(), 'bridge-'))
  let quota: QuotaStatus | null = 'quota' in over ? (over.quota as QuotaStatus | null) : { weeklyUsedPct: 37, aheadBy: -48 }
  const now = new Date(2026, 10, 14, 15, 0).getTime()
  const db = new SqliteStore({ stateDir: join(dir, 'state'), inboxDir: join(dir, 'inbox'), notesDir: join(dir, 'notes') })
  const bridge = new AddonBridge({
    db,
    weeklyLimitPct: over.weeklyLimitPct ?? 99,
    quota: async () => quota,
    now: () => now,
    readChat: over.readChat,
  })
  bridge.attach(h.router)
  return {
    ...h,
    bridge,
    db,
    setQuota: (q: QuotaStatus | null) => {
      quota = q
    },
    dir,
    cleanup: () => {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('send: text goes to the home chat as a reply, buttons get an ax:<token> on the last part', async () => {
  const b = bridgeFor()
  try {
    const r = await b.bridge.request('modes', 'send', { text: 'answer', replyTo: 'tg:4', rows: [[{ text: 'Continue', data: 'c:abcd0123' }]] })
    assert.deepEqual(r, { messageIds: ['tg:1'] })
    const sent = b.chat.sent[0]
    assert.equal(sent.text, 'answer')
    assert.equal(sent.opts.replyTo, tgMsg(4))
    const [[btn]] = sent.opts.rows as Array<Array<{ text: string; data: string }>>
    assert.equal(btn.text, 'Continue')
    const token = parseBridgeCallback(btn.data)?.token
    assert.ok(token, 'the wire data is ax:<token>')
    assert.deepEqual(b.router.addonButtons.resolve(token), { addon: 'modes', data: 'c:abcd0123' })
  } finally {
    b.cleanup()
  }
})

test('send: an addon answer is logged to the chat log (kind addon) and audited as an outbound message (with the addon name)', async () => {
  const lines: ChatLine[] = []
  const chatLog: ChatLogPort = { append: (l) => void lines.push(l), attachmentPath: () => null, recentExchanges: () => [] }
  const b = bridgeFor({ chatLog })
  try {
    await b.bridge.request('modes', 'send', { text: 'answer text' })
    assert.equal(lines.length, 1)
    assert.equal(lines[0].dir, 'out')
    assert.equal(lines[0].kind, 'addon')
    assert.equal(lines[0].text, 'answer text')
    assert.equal(lines[0].target, null)
    assert.equal(lines[0].tg_message_id, tgMsg(1))
    assert.ok(b.audit.events.some((e) => e.event === 'outbound' && e.kind === 'addon' && e.session === 'modes'), 'an outbound audit event')
  } finally {
    b.cleanup()
  }
})

test('send: over-long button data is refused, and an empty text is refused', async () => {
  const b = bridgeFor()
  try {
    await assert.rejects(() => b.bridge.request('modes', 'send', { text: 'x', rows: [[{ text: 'a', data: 'x'.repeat(257) }]] }), /too long \(max 256\)/)
    await assert.rejects(() => b.bridge.request('modes', 'send', { text: 'x', rows: [[{ text: 'a', data: '' }]] }), /needs text and data/)
    await assert.rejects(() => b.bridge.request('modes', 'send', { text: '  ' }), /nothing to send/)
    await assert.rejects(() => b.bridge.request('modes', 'send', { text: 'x', rows: 'nope' }), /list of button rows/)
    assert.equal(b.chat.sent.length, 0)
  } finally {
    b.cleanup()
  }
})

test('send: text is chunked to Telegram\'s limit, and the buttons go on the last chunk only', async () => {
  const b = bridgeFor()
  try {
    await b.bridge.request('modes', 'send', { text: 'word '.repeat(1200), rows: [[{ text: 'Go', data: 'u:abcd0123' }]] })
    assert.ok(b.chat.sent.length >= 2)
    assert.equal(b.chat.sent[0].opts?.rows, undefined)
    assert.ok(b.chat.sent.at(-1)?.opts?.rows)
  } finally {
    b.cleanup()
  }
})

test('the quota gate: 98.9 runs, 99.0 is refused; the alert goes out once a day when ahead', async () => {
  const b = bridgeFor({ quota: { weeklyUsedPct: 98.9, aheadBy: 2 } })
  try {
    assert.deepEqual(await b.bridge.request('modes', 'quota', {}), { refuse: false, usedPct: 98.9, pacePct: 97 })
    b.setQuota({ weeklyUsedPct: 99, aheadBy: 2 })
    const refused = (await b.bridge.request('modes', 'quota', {})) as { refuse: boolean; reason?: string }
    assert.equal(refused.refuse, true)
    assert.match(String(refused.reason), /99%/)
    const alerts = b.chat.sent.filter((s) => /ahead of the pace/.test(s.text))
    assert.equal(alerts.length, 1, 'one alert for the day')
    await b.bridge.request('modes', 'quota', {})
    assert.equal(b.chat.sent.filter((s) => /ahead of the pace/.test(s.text)).length, 1, 'not again today')
  } finally {
    b.cleanup()
  }
})

test('the quota gate refuses when the quota is unknown', async () => {
  const b = bridgeFor({ quota: null })
  try {
    const r = (await b.bridge.request('modes', 'quota', {})) as { refuse: boolean; reason?: string }
    assert.equal(r.refuse, true)
    assert.match(String(r.reason), /could not be read/)
  } finally {
    b.cleanup()
  }
})

test('usage: a run is recorded to the usage file and shows in /usage', async () => {
  const b = bridgeFor()
  try {
    assert.deepEqual(await b.bridge.request('modes', 'usage', { mode: 'read', costUsd: 0.04, durationMs: 12000, outcome: 'answer' }), { ok: true })
    await assert.rejects(() => b.bridge.request('modes', 'usage', { mode: 'shell', costUsd: 1, durationMs: 1, outcome: 'answer' }), /bad usage record/)
    assert.equal(b.db.listUsage(0).length, 1)
    const text = await b.bridge.report()
    assert.match(text, /Today: 1 mode runs, \$0\.04\. By mode: read 1 \(\$0\.04\)/)
    assert.match(text, /Weekly quota: 37% used, on or under the pace/)
    // A new bridge over the same database keeps the record.
    const again = new AddonBridge({ db: b.db, weeklyLimitPct: 99, quota: async () => null, now: () => new Date(2026, 10, 14, 15, 0).getTime() })
    again.attach(b.router)
    assert.match(await again.report(), /Today: 1 mode runs/)
  } finally {
    b.cleanup()
  }
})

test('folders: the master project first, then the other trusted folders', async () => {
  const b = bridgeFor()
  try {
    const master = `${HOME}/Documents/projects/master`
    const other = `${HOME}/Documents/projects/other`
    b.agent.trusted.add(other)
    b.agent.trusted.add(master)
    b.platform.dirs.add(master)
    b.platform.dirs.add(other)
    const r = (await b.bridge.request('modes', 'folders', {})) as { folders: Array<{ name: string }> }
    assert.deepEqual(r.folders.map((f) => f.name), ['master', 'other'])
  } finally {
    b.cleanup()
  }
})

test('spawn: a folder that is not startable, or not trusted, is refused without starting anything', async () => {
  const b = bridgeFor()
  try {
    const r = await b.bridge.request('modes', 'spawn', { dir: '/nowhere', prompt: 'p', messageId: 'tg:3' })
    assert.deepEqual(r, { ok: false, error: 'bad request' })
    const other = `${HOME}/Documents/projects/other`
    b.platform.dirs.add(other)
    b.agent.trusted.add(other)
    const trusted = await b.bridge.request('modes', 'spawn', { dir: other, prompt: 'p', messageId: 'tg:3' })
    assert.deepEqual(trusted, { ok: true })
    assert.equal(b.agent.startedSessions.length, 1)
  } finally {
    b.cleanup()
  }
})

test('a button tap from an addon is recognised: ax:<10 base62 characters>', () => {
  assert.deepEqual(parseBridgeCallback('ax:Ab3dE5fG7h'), { token: 'Ab3dE5fG7h' })
  assert.equal(parseBridgeCallback('ax:modes:c:abcd0123'), null)
  assert.equal(parseBridgeCallback('ax:Ab3dE5fG7'), null)
  assert.equal(parseBridgeCallback('ax:Ab3dE5fG7h9'), null)
  assert.equal(parseBridgeCallback('ax:Ab3-E5fG7h'), null)
  assert.equal(parseBridgeCallback('ad:modes:on'), null)
})

// The chat app's buttons capability, with the Telegram values unless a test overrides some.
function withButtons(b: ReturnType<typeof bridgeFor>, buttons: unknown): void {
  ;(b.chat as unknown as { capabilities: { buttons: unknown } }).capabilities = { ...TELEGRAM_CAPABILITIES, buttons }
}

test('send: labels are cut to the chat app\'s labelChars, long rows are split (order kept), single-button rows share a row, extra rows are dropped and logged', async () => {
  const b = bridgeFor()
  try {
    withButtons(b, { kind: 'inline', payloadBytes: 13, maxRows: 2, maxPerRow: 2, labelChars: 5, toast: true, editable: true })
    const rows = [
      [{ text: 'abcdefgh', data: 'a' }, { text: 'bb', data: 'b' }, { text: 'cc', data: 'c' }],
      [{ text: 'dd', data: 'd' }],
      [{ text: 'ee', data: 'e' }],
    ]
    await b.bridge.request('modes', 'send', { text: 'x', rows })
    const sent = (b.chat.sent[0].opts.rows as Array<Array<{ text: string; data: string }>>)
    // Split: [a b] [c] [dd] [ee]. Four rows is over maxRows 2, so the single-button rows share: [c dd], and [ee] is past the limit.
    assert.deepEqual(sent.map((r) => r.map((x) => x.text)), [['abcde', 'bb'], ['cc', 'dd']])
    assert.deepEqual(sent.map((r) => r.map((x) => b.router.addonButtons.resolve(parseBridgeCallback(x.data)!.token)?.data)), [['a', 'b'], ['c', 'd']])
    assert.ok(b.logger.lines.some((l) => /1 button row\(s\) past the limit of 2/.test(l)))
  } finally {
    b.cleanup()
  }
})

test('send: a chat app with no buttons gets the text alone, and the addon is told once', async () => {
  const b = bridgeFor()
  try {
    withButtons(b, { kind: 'none' })
    await b.bridge.request('modes', 'send', { text: 'one', rows: [[{ text: 'Go', data: 'u:abcd0123' }]] })
    await b.bridge.request('modes', 'send', { text: 'two', rows: [[{ text: 'Go', data: 'u:abcd0123' }]] })
    assert.equal(b.chat.sent[0].opts.rows, undefined)
    assert.equal(b.chat.sent[1].opts.rows, undefined)
    assert.equal(b.logger.lines.filter((l) => /no buttons/.test(l)).length, 1)
  } finally {
    b.cleanup()
  }
})

test('send: Telegram\'s values keep a keyboard as it was, only the data is a token', async () => {
  const b = bridgeFor()
  try {
    const rows = [[{ text: 'Continue', data: 'c:abcd0123' }, { text: 'Stop', data: 's:abcd0123' }], [{ text: 'Back', data: 'b:x' }]]
    await b.bridge.request('modes', 'send', { text: 'x', rows })
    const sent = b.chat.sent[0].opts.rows as Array<Array<{ text: string; data: string }>>
    assert.deepEqual(sent.map((r) => r.map((x) => x.text)), [['Continue', 'Stop'], ['Back']])
    assert.deepEqual(sent.map((r) => r.map((x) => b.router.addonButtons.resolve(parseBridgeCallback(x.data)!.token)?.data)), [['c:abcd0123', 's:abcd0123'], ['b:x']])
    assert.equal(b.logger.lines.length, 0)
  } finally {
    b.cleanup()
  }
})

test('a tap on an unknown or expired button answers "This button has expired." and the addon is not called', async () => {
  const b = bridgeFor()
  try {
    const calls: unknown[] = []
    ;(b.router as unknown as { addons: unknown }).addons = { callback: async (...a: unknown[]) => (calls.push(a), { toast: 'ran' }) }
    const cb = { pressId: 'q1', data: 'ax:Ab3dE5fG7h', message: null, from: 'tg:1' as never }
    await onBridgeCallback(b.router, cb, 'Ab3dE5fG7h')
    assert.deepEqual(b.chat.answers.at(-1), { id: 'q1', text: 'This button has expired.' })
    assert.deepEqual(calls, [])
  } finally {
    b.cleanup()
  }
})

test('spawn: the session\'s first message is stamped with the calling addon\'s name, not a fixed one', async () => {
  const b = bridgeFor()
  try {
    const other = `${HOME}/Documents/projects/other`
    b.platform.dirs.add(other)
    b.agent.trusted.add(other)
    assert.deepEqual(await b.bridge.request('notes', 'spawn', { dir: other, prompt: 'build it', messageId: 'tg:3' }), { ok: true })
    assert.equal(b.router.spawns.get(other)?.items[0]?.m.from, 'notes')
    assert.deepEqual(await b.bridge.request('modes', 'spawn', { dir: other, prompt: 'again', messageId: 'tg:4' }), { ok: true })
    assert.equal(b.router.spawns.get(other)?.items[1]?.m.from, 'modes')
  } finally {
    b.cleanup()
  }
})

test('quotaRefusal: null when a run may go on, a reason at the limit, and a reason when the quota cannot be read', async () => {
  const b = bridgeFor({ quota: { weeklyUsedPct: 40, aheadBy: -5 } })
  try {
    assert.equal(await b.bridge.quotaRefusal(), null)
    b.setQuota(null)
    assert.match(String(await b.bridge.quotaRefusal()), /could not be read/)
    b.setQuota({ weeklyUsedPct: 99, aheadBy: 1 })
    assert.match(String(await b.bridge.quotaRefusal()), /99%/)
    // A reading that throws refuses too (fail closed), and the reason says why.
    const thrown = new AddonBridge({
      db: b.db,
      weeklyLimitPct: 99,
      quota: async () => {
        throw new Error('boom')
      },
      now: () => new Date(2026, 10, 14, 15, 0).getTime(),
    })
    thrown.attach(b.router)
    assert.match(String(await thrown.quotaRefusal()), /could not be read \(boom\)/)
  } finally {
    b.cleanup()
  }
})

test('an unknown request op is refused', async () => {
  const b = bridgeFor()
  try {
    await assert.rejects(() => b.bridge.request('modes', 'shell', {}), /unknown request shell/)
  } finally {
    b.cleanup()
  }
})


test('protocol 2: an id sent as a number is refused at every op that reads one, with the same error', async () => {
  const b = bridgeFor()
  const refused = (e: Error) => e.message === 'ids are strings in protocol 2'
  try {
    await assert.rejects(() => b.bridge.request('modes', 'send', { text: 'x', replyTo: 4 }), refused)
    await assert.rejects(() => b.bridge.request('modes', 'spawn', { dir: '/x', prompt: 'p', messageId: 3 }), refused)
    for (const op of ['release', 'drop', 'held']) {
      await assert.rejects(() => b.bridge.request('cost-guard', op, { messageId: 5 }), refused, op)
    }
  } finally {
    b.cleanup()
  }
})

test('protocol 2: an id the addon sends must be a non-empty string of at most 200 characters', async () => {
  const b = bridgeFor()
  try {
    await assert.rejects(() => b.bridge.request('modes', 'send', { text: 'x', replyTo: '' }), /a message id is a string of 1 to 200 characters/)
    await assert.rejects(() => b.bridge.request('modes', 'spawn', { dir: '/x', prompt: 'p', messageId: 'x'.repeat(201) }), /a message id is a string/)
    await assert.rejects(() => b.bridge.request('modes', 'send', { text: 'x', replyTo: { id: 'tg:1' } }), /a message id is a string/)
  } finally {
    b.cleanup()
  }
})

test('protocol 2: the chat-log lines an addon reads carry no chat-app id fields', async () => {
  const line = newChatLine({ ts: Date.UTC(2026, 10, 14, 12), dir: 'in', kind: 'text', text: 'hi', topic_id: tgThread(5), tg_message_id: tgMsg(9) })
  const b = bridgeFor({ readChat: () => [line] })
  try {
    const r = (await b.bridge.request('digest', 'chatlog', { from: '2026-11-14', days: 1 })) as { lines: Array<Record<string, unknown>> }
    assert.equal(r.lines.length, 1)
    assert.equal(r.lines[0].text, 'hi')
    assert.equal('topic_id' in r.lines[0], false)
    assert.equal('tg_message_id' in r.lines[0], false)
  } finally {
    b.cleanup()
  }
})
