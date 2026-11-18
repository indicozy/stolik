// Chat connector step 0e, batch 1 (the gate and the unpaired start): the Telegram sender gate with pairing on and off,
// PairingControl's confirm and failure paths, the setup self-poll (a 409 ends it), the pairing-only router start and the
// doctor's "not paired yet" line. Updates go through grammY's own handleUpdate; the Bot API is a transformer, so no network.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GrammyError } from 'grammy'
import { Telegram } from '../src/adapters/chat/telegram.ts'
import { PairingControl } from '../src/router/pairing-control.ts'
import { pollOwnPairing } from '../src/adapters/chat/telegram-setup.ts'
import { PAIR_TTL_MS, pairingPath, startPairing } from '../src/brain/pairing.ts'
import { checkOwner } from '../src/cli/doctor.ts'
import { harness } from './helpers/fakes.ts'
import type { ButtonPress, Inbound } from '../src/brain/chat-types.ts'

const OWNER = '111'
const STRANGER = 777
const OTHER_OWNER = '222'
const GROUP = -1001
const CODE = '246810'
const BOT = { id: 999, is_bot: true, first_name: 'bot', username: 'bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false }

function tmpState(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'tgb-0e-gate-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// An adapter with the Bot API answered by a transformer (every call is recorded in `sent`).
function gate(owner: string | null) {
  const sent: Array<{ method: string; payload: Record<string, unknown> }> = []
  const transformer = async (_prev: unknown, method: string, payload: Record<string, unknown>) => {
    sent.push({ method, payload })
    if (method === 'sendMessage') return { message_id: 1, date: 1, chat: { id: Number(payload.chat_id), type: 'private' }, text: payload.text }
    return true
  }
  const tg = new Telegram('123:TEST', owner ?? '', [], owner, null, { botInfo: BOT as never, transformer })
  const inbound: Inbound[] = []
  const buttons: ButtonPress[] = []
  tg.onInbound(async (m) => { inbound.push(m) })
  tg.onButton(async (c) => { buttons.push(c) })
  const feed = (u: object) => (tg as unknown as { bot: { handleUpdate(u: unknown): Promise<void> } }).bot.handleUpdate(u)
  return { tg, sent, inbound, buttons, feed }
}

let updateId = 1
const from = (id: number) => ({ id, is_bot: false, first_name: id === STRANGER ? 'stranger' : 'owner' })
const dm = (id: number, extra: Record<string, unknown>) => ({
  update_id: updateId++,
  message: { message_id: updateId, date: 1, chat: { id, type: 'private', first_name: 'x' }, from: from(id), ...extra },
})
const text = (id: number, t: string) => dm(id, { text: t })
const photo = (id: number) => dm(id, { photo: [{ file_id: 'f', file_unique_id: 'u', width: 10, height: 10 }] })
const groupText = (id: number, t: string) => ({
  update_id: updateId++,
  message: { message_id: updateId, date: 1, chat: { id: GROUP, type: 'supergroup', title: 'g', is_forum: true }, from: from(id), text: t },
})
const tap = (id: number) => ({
  update_id: updateId++,
  callback_query: { id: `cb${updateId}`, from: from(id), chat_instance: 'ci', data: 'x', message: { message_id: 5, date: 1, chat: { id, type: 'private', first_name: 'x' }, text: 'menu' } },
})

// ---------- 1. the sender gate ----------

test('gate, owner set, no pairing: a stranger`s DM text, photo, group message and button tap reach nothing and get no reply', async () => {
  const g = gate(OWNER)
  await g.feed(text(STRANGER, 'hello'))
  await g.feed(photo(STRANGER))
  await g.feed(groupText(STRANGER, 'hi all'))
  await g.feed(tap(STRANGER))
  assert.equal(g.inbound.length, 0)
  assert.equal(g.buttons.length, 0)
  assert.deepEqual(g.sent, [])
})

test('gate, owner set, no pairing: the owner`s text and tap pass', async () => {
  const g = gate(OWNER)
  await g.feed(text(Number(OWNER), 'hi'))
  await g.feed(tap(Number(OWNER)))
  assert.equal(g.inbound.length, 1)
  assert.equal(g.buttons.length, 1)
  assert.deepEqual(g.sent, [])
})

// A pairing on: the real PairingControl hook on a temp state folder with a known code.
function paired(owner: string | null) {
  const st = tmpState()
  startPairing(st.dir, 'telegram', Date.now(), CODE)
  const applied: string[] = []
  const g = gate(owner)
  const control = new PairingControl(st.dir, (u) => {
    applied.push(u)
    g.tg.setOwnerUserId(u)
  })
  g.tg.setPairing(control.hook())
  return { ...g, control, applied, dir: st.dir, cleanup: st.cleanup }
}

test('gate, pairing on: a wrong code from a stranger gets no reply and no Inbound; the attempt is counted', async () => {
  const p = paired(OWNER)
  try {
    await p.feed(text(STRANGER, '000001'))
    await p.feed(text(STRANGER, 'hello'))
    assert.equal(p.inbound.length, 0)
    assert.deepEqual(p.sent, [])
    assert.ok(existsSync(pairingPath(p.dir)), 'the pairing is still open')
    assert.deepEqual(p.applied, [])
  } finally {
    p.cleanup()
  }
})

test('gate, pairing on: the right code gets "Paired." once, calls paired(), and is never an Inbound', async () => {
  const p = paired(null)
  try {
    await p.feed(text(STRANGER, CODE))
    assert.equal(p.inbound.length, 0)
    const replies = p.sent.filter((s) => s.method === 'sendMessage')
    assert.equal(replies.length, 1)
    assert.equal(replies[0].payload.text, 'Paired.')
    assert.equal(String(replies[0].payload.chat_id), String(STRANGER))
    const r = await p.control.wait()
    assert.equal(r.ok, true)
    assert.equal(r.ok && r.candidate.userId, String(STRANGER))
    assert.equal(existsSync(pairingPath(p.dir)), false, 'the file is gone after the match')
    // The same code again: the pairing is closed, so no second reply and no Inbound.
    await p.feed(text(STRANGER, CODE))
    assert.equal(p.sent.filter((s) => s.method === 'sendMessage').length, 1)
    assert.equal(p.inbound.length, 0)
  } finally {
    p.cleanup()
  }
})

test('gate, pairing on: the owner`s messages pass; a stranger`s photo, group text and tap do not', async () => {
  const p = paired(OWNER)
  try {
    await p.feed(text(Number(OWNER), 'hi'))
    await p.feed(tap(Number(OWNER)))
    await p.feed(photo(STRANGER))
    await p.feed(groupText(STRANGER, CODE))
    await p.feed(tap(STRANGER))
    assert.equal(p.inbound.length, 1)
    assert.equal(p.buttons.length, 1)
    assert.deepEqual(p.sent, [], 'a code in a group is not an attempt, and nothing is answered')
    assert.ok(existsSync(pairingPath(p.dir)))
  } finally {
    p.cleanup()
  }
})

test('gate, pairing on, owner set to another id: the old owner is dropped and the new one passes; the confirmed pairing does too', async () => {
  const p = paired(OWNER)
  try {
    p.tg.setOwnerUserId(OTHER_OWNER)
    await p.feed(text(Number(OWNER), 'hi'))
    assert.equal(p.inbound.length, 0, 'the old owner is dropped')
    await p.feed(text(Number(OTHER_OWNER), 'hi'))
    assert.equal(p.inbound.length, 1, 'the new owner passes')
    // A pairing confirmed by the owner makes the stranger the owner, in the adapter too.
    await p.feed(text(STRANGER, CODE))
    assert.equal((await p.control.wait()).ok, true)
    assert.equal(p.control.confirm(String(STRANGER), true).ok, true)
    assert.deepEqual(p.applied, [String(STRANGER)])
    await p.feed(text(STRANGER, 'now mine'))
    assert.equal(p.inbound.length, 2)
  } finally {
    p.cleanup()
  }
})

test('gate, owner null: nothing passes without pairing, not even the id that was the owner', async () => {
  const g = gate(null)
  await g.feed(text(Number(OWNER), 'hi'))
  await g.feed(text(STRANGER, 'hi'))
  await g.feed(tap(STRANGER))
  assert.equal(g.inbound.length, 0)
  assert.equal(g.buttons.length, 0)
  assert.deepEqual(g.sent, [])
})

test('gate, owner null with pairing on: only the code passes, and it is the first thing the sender gets back', async () => {
  const p = paired(null)
  try {
    await p.feed(text(Number(OWNER), 'hi'))
    await p.feed(text(STRANGER, '000002'))
    assert.equal(p.inbound.length, 0)
    assert.deepEqual(p.sent, [])
    await p.feed(text(STRANGER, CODE))
    assert.equal(p.sent.filter((s) => s.method === 'sendMessage').length, 1)
    assert.equal(p.inbound.length, 0)
  } finally {
    p.cleanup()
  }
})

// ---------- 2. PairingControl ----------

test('PairingControl: confirm with another user id is refused and changes nothing; the right id still confirms', async () => {
  const st = tmpState()
  try {
    startPairing(st.dir, 'telegram', Date.now(), CODE)
    const applied: string[] = []
    const c = new PairingControl(st.dir, (u) => applied.push(u))
    const waiting = c.wait()
    assert.equal(c.hook().attempt(CODE), 'paired')
    c.hook().paired({ userId: String(STRANGER), name: 'stranger', username: null })
    assert.equal((await waiting).ok, true)
    const refused = c.confirm('999', true)
    assert.equal(refused.ok, false)
    assert.deepEqual(applied, [])
    assert.deepEqual(c.confirm(String(STRANGER), true), { ok: true })
    assert.deepEqual(applied, [String(STRANGER)])
  } finally {
    st.cleanup()
  }
})

test('PairingControl: confirm(no) does not change the owner, and the candidate is then gone', async () => {
  const st = tmpState()
  try {
    startPairing(st.dir, 'telegram', Date.now(), CODE)
    const applied: string[] = []
    const c = new PairingControl(st.dir, (u) => applied.push(u))
    const waiting = c.wait()
    c.hook().attempt(CODE)
    c.hook().paired({ userId: String(STRANGER), name: 'stranger', username: null })
    await waiting
    assert.deepEqual(c.confirm(String(STRANGER), false), { ok: true })
    assert.deepEqual(applied, [])
    assert.equal(c.confirm(String(STRANGER), true).ok, false, 'the no took the candidate away')
    assert.deepEqual(applied, [])
  } finally {
    st.cleanup()
  }
})

test('PairingControl: an expired code settles the waiting pair request with the error', async () => {
  const st = tmpState()
  try {
    let now = 1_000
    startPairing(st.dir, 'telegram', now, CODE)
    const c = new PairingControl(st.dir, () => {}, () => now)
    const waiting = c.wait()
    now = 1_000 + PAIR_TTL_MS
    assert.equal(c.hook().attempt(CODE), 'expired')
    const r = await waiting
    assert.equal(r.ok, false)
    assert.match(r.ok ? '' : r.error, /expired/)
    assert.equal(existsSync(pairingPath(st.dir)), false)
  } finally {
    st.cleanup()
  }
})

test('PairingControl: the fifth wrong code locks it and settles the waiting pair request with the error', async () => {
  const st = tmpState()
  try {
    startPairing(st.dir, 'telegram', Date.now(), CODE)
    const c = new PairingControl(st.dir, () => {})
    const waiting = c.wait()
    const h = c.hook()
    for (let i = 1; i <= 4; i++) assert.equal(h.attempt('000001'), 'wrong')
    assert.equal(h.attempt('000001'), 'locked')
    const r = await waiting
    assert.equal(r.ok, false)
    assert.match(r.ok ? '' : r.error, /locked/)
    assert.equal(h.attempt(CODE), 'closed', 'the right code no longer pairs a locked pairing')
  } finally {
    st.cleanup()
  }
})

// ---------- 4. setup's self-poll ----------

test('setup self-poll: a 409 from getUpdates ends with a clear message after one call, no retry loop', async () => {
  const st = tmpState()
  try {
    startPairing(st.dir, 'telegram', Date.now(), CODE)
    let calls = 0
    const api = {
      getUpdates: async () => {
        calls++
        throw new GrammyError('Conflict', { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' }, 'getUpdates', {})
      },
      sendMessage: async () => ({}),
    }
    const r = await pollOwnPairing('123:TEST', st.dir, api as never)
    assert.equal(r.ok, false)
    assert.match(r.ok ? '' : r.error, /another process polls this bot/)
    assert.equal(calls, 1)
  } finally {
    st.cleanup()
  }
})

test('setup self-poll: the owner`s code in a private text pairs; the reply goes to the sender', async () => {
  const st = tmpState()
  try {
    startPairing(st.dir, 'telegram', Date.now(), CODE)
    const replies: unknown[] = []
    const api = {
      getUpdates: async () => [
        { update_id: 10, message: { message_id: 1, date: 1, chat: { id: STRANGER, type: 'private' }, from: { id: STRANGER, is_bot: false, first_name: 'Ann', last_name: 'Lee', username: 'ann' }, text: CODE } },
      ],
      sendMessage: async (chat: number, text: string) => replies.push([chat, text]),
    }
    const r = await pollOwnPairing('123:TEST', st.dir, api as never)
    assert.deepEqual(r, { ok: true, candidate: { userId: String(STRANGER), name: 'Ann Lee', username: 'ann' } })
    assert.deepEqual(replies, [[STRANGER, 'Paired.']])
  } finally {
    st.cleanup()
  }
})

// ---------- 3. the pairing-only router start, and doctor ----------

test('pairing-only router start: no owner, so nothing is sent to a chat; one log line says why', async () => {
  const h = harness({ ownerUserId: '' })
  ;(h.store as unknown as { startupNotices: string[] }).startupNotices = ['The database was damaged and was moved aside to tg-bridge.db.bad.']
  await h.router.start()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(h.router.paired, false)
  assert.deepEqual(h.chat.texts(), [], 'no notice, no boot announcement, no built-ins offer')
  assert.ok(h.logger.lines.some((l) => /not paired yet/.test(l)))
})

test('paired router start: the same notice is sent to the owner', async () => {
  const h = harness()
  ;(h.store as unknown as { startupNotices: string[] }).startupNotices = ['The database was damaged and was moved aside to tg-bridge.db.bad.']
  await h.router.start()
  assert.equal(h.router.paired, true)
  assert.equal(h.chat.texts().filter((t) => t.includes('moved aside')).length, 1)
  assert.ok(!h.logger.lines.some((l) => /not paired yet/.test(l)))
})

test('doctor: an unpaired install reports "not paired yet: run tg-bridge setup" as a warning; a paired one adds no line', () => {
  assert.deepEqual(checkOwner({ ownerPaired: () => false }), [{ id: 'owner', title: 'owner', status: 'warn', detail: 'not paired yet: run tg-bridge setup' }])
  assert.deepEqual(checkOwner({ ownerPaired: () => true }), [])
  assert.deepEqual(checkOwner({}), [], 'absent: not checked')
})
