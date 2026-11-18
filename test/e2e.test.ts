// E2E driver (docs/e2e.md): the gate, the synthetic inbound and tap handling on the router socket, the ring buffer of sent
// messages, and the Telegram adapter's driver behaviour (recording, synthetic reply ids, driver files, driver taps).
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FakeConn, HOME, OWNER, flush, harness, textFrom } from './helpers/fakes.ts'
import { ISOLATED_ROOT } from './helpers/isolate.ts'
import { E2e, SYNTHETIC_ID_BASE, SentRing, e2eEnabled, e2eMsg, isSyntheticMessageId } from '../src/router/e2e.ts'
import { tgChat, tgMsg, tgNum, tgThread } from '../src/adapters/chat/tg-ids.ts'
import { Telegram } from '../src/adapters/chat/telegram.ts'

const PROJ = `${HOME}/proj`

// The last reply the router sent on a connection.
function lastReply(conn: FakeConn): Record<string, unknown> {
  const r = conn.sent[conn.sent.length - 1] as Record<string, unknown> | undefined
  assert.ok(r, 'a reply was sent')
  return r
}

// ---------- the gate ----------

test('the driver is on only for TG_BRIDGE_E2E=1 exactly', () => {
  assert.equal(e2eEnabled({ TG_BRIDGE_E2E: '1' }), true)
  for (const v of [undefined, '', '0', 'true', 'yes', ' 1']) {
    assert.equal(e2eEnabled(v === undefined ? {} : { TG_BRIDGE_E2E: v }), false, `TG_BRIDGE_E2E=${JSON.stringify(v)}`)
  }
})

test('without the driver, every e2e message is refused with an error and nothing is injected', async () => {
  const h = harness()
  await h.router.start()
  h.platform.dirs.add(PROJ)
  const conn = new FakeConn()
  h.agent.receive(conn, { t: 'register', claudePid: 4242, cwd: PROJ })
  for (const msg of [{ op: 'sent' }, { op: 'inbound', text: 'hello' }, { op: 'callback', messageId: 1, data: 'x' }]) {
    const c = new FakeConn()
    h.agent.receive(c, { t: 'e2e', reqId: 'r1', ...msg })
    const r = lastReply(c)
    assert.equal(r.t, 'e2e_result')
    assert.equal(r.ok, false)
    assert.match(String(r.error), /TG_BRIDGE_E2E=1/)
    assert.equal(r.reqId, 'r1')
  }
  assert.deepEqual(h.agent.sent, [], 'no message reached the session')
  assert.deepEqual(h.chat.sent, [])
  assert.deepEqual(h.chat.answers, [])
})

// ---------- injected inbound and taps, with the driver on ----------

async function driven(groupId: number | null = null) {
  const e2e = new E2e()
  const h = harness({ e2e, groupId: groupId === null ? null : tgChat(groupId) })
  await h.router.start()
  h.platform.dirs.add(PROJ)
  const conn = new FakeConn()
  h.agent.receive(conn, { t: 'register', claudePid: 4242, cwd: PROJ })
  return { ...h, e2e, conn }
}

test('an injected text message goes through the owner path to the one live session, with a synthetic negative id', async () => {
  const { agent, chat, e2e } = await driven()
  const c = new FakeConn()
  agent.receive(c, { t: 'e2e', op: 'inbound', text: 'hello from the driver', reqId: 'q' })
  const r = lastReply(c)
  assert.equal(r.ok, true)
  assert.ok(isSyntheticMessageId(r.messageId as number))
  assert.ok((r.messageId as number) <= -SYNTHETIC_ID_BASE)
  await flush()
  assert.equal(agent.sent.length, 1)
  assert.equal(agent.sent[0].content, 'hello from the driver')
  assert.equal(agent.sent[0].meta.message_id, String(r.messageId))
  // The confirmation is a reply to the synthetic message: the fake records the reply id, the real adapter drops it (below).
  assert.ok(chat.sent.some((s) => s.opts?.replyTo === e2eMsg(-(r.messageId as number) - SYNTHETIC_ID_BASE)))
  assert.ok(e2e.nextMessageId() < (r.messageId as number), 'later synthetic ids keep counting down')
})

test('a forwarded injected message is data: a /command in it runs nothing, and it is never delivered without a choice', async () => {
  const { agent, chat } = await driven()
  const c = new FakeConn()
  agent.receive(c, { t: 'e2e', op: 'inbound', text: '/debug on', forwarded: true, reqId: 'f' })
  assert.equal(lastReply(c).ok, true)
  await flush()
  assert.equal(chat.sent.some((s) => /Debug logging on/.test(s.text)), false, 'the command did not run')
  assert.equal(agent.sent.length, 0, 'no session received it: a forwarded message gets buttons')
  assert.ok(chat.sent.some((s) => (s.opts?.rows?.length ?? 0) > 0), 'the owner is asked where it goes')
})

test('the sent buffer is outbound only: an injected message is not recorded in it', async () => {
  const { agent, e2e } = await driven()
  const c = new FakeConn()
  agent.receive(c, { t: 'e2e', op: 'inbound', text: 'x' })
  await flush()
  assert.equal(agent.sent.length, 1)
  assert.equal(e2e.ring.size, 0)
  assert.equal(lastReply(c).ok, true)
})

test('a message with a topic in group mode names the topic by its thread id; an unknown topic name is refused', async () => {
  const { agent, chat, conn } = await driven(-1001234)
  conn.sent.length = 0
  const c = new FakeConn()
  agent.receive(c, { t: 'e2e', op: 'inbound', text: 'to a topic', topic: 555 })
  const ok = lastReply(c)
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.chat, { kind: 'home', id: tgChat(-1001234), thread: tgThread(555) })
  await flush()
  // No session has that topic, so the topic handler says so (the same answer a real topic message gets).
  assert.ok(chat.sent.some((s) => s.text === 'This topic has no folder. Start a session in General with "new <project>:".'))
  const bad = new FakeConn()
  agent.receive(bad, { t: 'e2e', op: 'inbound', text: 'x', topic: 'nosuch' })
  assert.equal(lastReply(bad).ok, false)
  assert.match(String(lastReply(bad).error), /no open topic for nosuch/)
})

test('a voice file must exist, be absolute and have an audio extension; a valid one is registered as a driver file', async () => {
  const h = await driven()
  const { agent, e2e } = h
  const dir = mkdtempSync(join(ISOLATED_ROOT, 'e2e-voice-'))
  try {
    const wav = join(dir, 'note.wav')
    writeFileSync(wav, 'RIFF')
    const txt = join(dir, 'note.txt')
    writeFileSync(txt, 'no')
    // The fake platform answers fileInfo from its own map (the router's platform port), so the files are listed there.
    for (const p of [wav, txt]) h.platform.files.set(p, { isFile: true, size: 4 })
    const send = (body: Record<string, unknown>) => {
      const c = new FakeConn()
      agent.receive(c, { t: 'e2e', op: 'inbound', ...body })
      return lastReply(c)
    }
    assert.match(String(send({ voice: 'relative.wav' }).error), /must be absolute/)
    assert.match(String(send({ voice: join(dir, 'missing.wav') }).error), /no such file/)
    assert.match(String(send({ voice: txt }).error), /must be \.ogg/)
    const ok = send({ voice: wav })
    assert.equal(ok.ok, true)
    const fileIds = [...e2e.files.entries()]
    assert.deepEqual(fileIds.map(([, p]) => p), [wav])
    assert.match(fileIds[0][0], /^e2e-file:/)
    assert.match(String(send({ voice: wav, photo: wav }).error), /one file/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sent returns the last n recorded messages, oldest first, with their buttons', async () => {
  const { agent, e2e } = await driven()
  for (let i = 1; i <= 3; i++) {
    e2e.ring.record({ messageId: 900 + i, chat: { kind: 'dm', id: OWNER, thread: null }, text: `m${i}`, buttons: [] })
  }
  const c = new FakeConn()
  agent.receive(c, { t: 'e2e', op: 'sent', n: 2 })
  const r = lastReply(c)
  assert.equal(r.ok, true)
  assert.deepEqual((r.sent as Array<{ text: string }>).map((s) => s.text), ['m2', 'm3'])
})

test('a tap by button text or 0-based index resolves the callback data and reaches the callback handler', async () => {
  const { agent, chat, e2e } = await driven()
  e2e.ring.record({
    messageId: 700,
    chat: { kind: 'dm', id: OWNER, thread: null },
    text: 'Pick one',
    buttons: [[{ text: 'Alpha', data: 'junk-a' }, { text: 'Beta', data: 'junk-b' }]],
  })
  const byText = new FakeConn()
  agent.receive(byText, { t: 'e2e', op: 'callback', messageId: 700, button: 'beta' })
  assert.equal(lastReply(byText).ok, true)
  assert.equal(lastReply(byText).data, 'junk-b')
  const byIndex = new FakeConn()
  agent.receive(byIndex, { t: 'e2e', op: 'callback', messageId: 700, button: '0' })
  assert.equal(lastReply(byIndex).data, 'junk-a')
  await flush()
  // Unparseable data is answered with a plain callback answer, so the tap reached the handler.
  assert.equal(chat.answers.length, 2)
  assert.match(chat.answers[0].id, /^e2e-cb-/)
  const bad = new FakeConn()
  agent.receive(bad, { t: 'e2e', op: 'callback', messageId: 700, button: 'gamma' })
  assert.match(String(lastReply(bad).error), /no button "gamma"/)
  const unknown = new FakeConn()
  agent.receive(unknown, { t: 'e2e', op: 'callback', messageId: 1, button: '0' })
  assert.match(String(lastReply(unknown).error), /not in the sent buffer/)
})

// ---------- the ring buffer ----------

const entry = (id: number, text = `m${id}`) => ({ messageId: id, chat: { kind: 'dm' as const, id: OWNER, thread: null }, text, buttons: [] })

test('SentRing keeps only the newest capacity entries, oldest first', () => {
  const ring = new SentRing(3)
  for (let i = 1; i <= 5; i++) ring.record(entry(i))
  assert.equal(ring.size, 3)
  assert.deepEqual(ring.last(10).map((e) => e.messageId), [3, 4, 5])
  assert.deepEqual(ring.last(2).map((e) => e.messageId), [4, 5])
  assert.equal(ring.find(1), undefined, 'evicted')
  assert.equal(ring.find(4)?.text, 'm4')
})

test('SentRing: last() without a usable count gives 20; results are copies, so callers cannot change the buffer', () => {
  const ring = new SentRing()
  ring.record({ ...entry(1), buttons: [[{ text: 'Go', data: 'd' }]] })
  const out = ring.last()
  assert.equal(out.length, 1)
  out[0].text = 'changed'
  out[0].buttons[0][0].data = 'changed'
  assert.equal(ring.find(1)?.text, 'm1')
  assert.equal(ring.find(1)?.buttons[0][0].data, 'd')
  assert.equal(ring.last(0).length, 1)
  assert.equal(ring.last(Number.NaN).length, 1)
})

test('SentRing.update changes a recorded text or keyboard after an edit, and ignores unknown ids', () => {
  const ring = new SentRing()
  ring.record({ ...entry(5), buttons: [[{ text: 'Old', data: 'o' }]] })
  ring.update(5, { text: 'new text' })
  assert.equal(ring.find(5)?.text, 'new text')
  assert.equal(ring.find(5)?.buttons[0][0].text, 'Old', 'buttons unchanged when not given')
  ring.update(5, { buttons: [] })
  assert.deepEqual(ring.find(5)?.buttons, [])
  ring.update(999, { text: 'x' })
  assert.equal(ring.size, 1)
})

test('E2e hands out distinct negative message ids, and records file and callback ids', () => {
  const e2e = new E2e()
  const a = e2e.nextMessageId()
  const b = e2e.nextMessageId()
  assert.ok(a < 0 && b < a, 'negative and distinct')
  assert.ok(a <= -SYNTHETIC_ID_BASE)
  assert.equal(e2e.files.size, 0)
  const f = e2e.nextFileId('/x/a.ogg')
  assert.equal(e2e.files.get(f), '/x/a.ogg')
  assert.match(e2e.nextCallbackId(), /^e2e-cb-/)
})

// ---------- the Telegram adapter with the driver on (the Bot API is replaced by a recorder) ----------

type Call = { method: string; args: unknown[] }

function adapter(e2e: E2e | null) {
  const tg = new Telegram('123:TEST', '-1001', [], OWNER, e2e)
  const calls: Call[] = []
  let nextId = 77
  const record = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args })
    return { message_id: nextId++ }
  }
  const api = {
    sendMessage: record('sendMessage'),
    sendDocument: record('sendDocument'),
    sendPhoto: record('sendPhoto'),
    editMessageText: record('editMessageText'),
    setMessageReaction: record('setMessageReaction'),
    answerCallbackQuery: record('answerCallbackQuery'),
  }
  // Uploads go through their own client (Telegram.uploads); the test stubs it the same way.
  ;(tg as unknown as { bot: { api: Record<string, unknown> }; uploads: unknown }).bot.api = api
  ;(tg as unknown as { uploads: unknown }).uploads = api
  tg.setHome(tgChat(-1001))
  return { tg, calls }
}

test('a reply to a synthetic message is sent without a reply link; a real message id keeps its reply link', async () => {
  const { tg, calls } = adapter(new E2e())
  await tg.sendText('to synthetic', { replyTo: e2eMsg(5) })
  await tg.sendText('to real', { replyTo: tgMsg(42) })
  const [synthetic, real] = calls.filter((c) => c.method === 'sendMessage').map((c) => c.args[2] as Record<string, unknown>)
  assert.equal(synthetic.reply_parameters, undefined)
  assert.deepEqual(real.reply_parameters, { message_id: 42, allow_sending_without_reply: true })
})

test('the driver records each send with its chat, thread, text and keyboard; edits update the record', async () => {
  const e2e = new E2e()
  const { tg } = adapter(e2e)
  const id = await tg.sendText('Pick', { thread: tgThread(9), rows: [[{ text: 'Yes', data: 'y' }]] })
  assert.deepEqual(e2e.ring.find(tgNum(id)), {
    messageId: tgNum(id),
    chat: { kind: 'home', id: tgChat(-1001), thread: tgThread(9) },
    text: 'Pick',
    buttons: [[{ text: 'Yes', data: 'y' }]],
  })
  await tg.editRows(id, 'Picked', [])
  assert.equal(e2e.ring.find(tgNum(id))?.text, 'Picked')
  assert.deepEqual(e2e.ring.find(tgNum(id))?.buttons, [])
})

test('with the driver off, nothing is recorded and the adapter behaves as before', async () => {
  const { tg, calls } = adapter(null)
  await tg.sendText('plain', { replyTo: tgMsg(42) })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'sendMessage')
})

test('driver taps and synthetic reactions never reach the Bot API; a driver file is copied to the destination', async () => {
  const e2e = new E2e()
  const { tg, calls } = adapter(e2e)
  await tg.ackButton('e2e-cb-3', 'x')
  await tg.react(e2eMsg(1), '👀')
  await tg.editText(e2eMsg(1), 'edit', null)
  assert.deepEqual(calls, [], 'no call for any of them')
  const dir = mkdtempSync(join(ISOLATED_ROOT, 'e2e-dl-'))
  try {
    const src = join(dir, 'src.ogg')
    writeFileSync(src, 'OggS-bytes')
    const id = e2e.nextFileId(src)
    const dest = join(dir, 'inbox', 'voice.ogg')
    await tg.download(id, dest, 1024)
    assert.equal(readFileSync(dest, 'utf8'), 'OggS-bytes')
    await assert.rejects(tg.download('e2e-file:999', join(dir, 'x'), 1024), /unknown driver file/)
    await assert.rejects(tg.download(id, join(dir, 'big'), 3), /too large/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a sent file is recorded with its name', async () => {
  const e2e = new E2e()
  const { tg } = adapter(e2e)
  const dir = mkdtempSync(join(ISOLATED_ROOT, 'e2e-file-'))
  try {
    const f = join(dir, 'report.txt')
    writeFileSync(f, 'x')
    mkdirSync(join(dir, 'sub'))
    const id = await tg.sendFile(f, false, { thread: tgThread(4) })
    assert.equal(e2e.ring.find(tgNum(id))?.text, '(file: report.txt)')
    assert.equal(e2e.ring.find(tgNum(id))?.chat.thread, tgThread(4))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- the CLI's pure helpers (scripts/e2e.ts) ----------

test('e2e CLI: arguments split into the command, positionals and flags; a value flag without a value is an error', async () => {
  const { parseArgs } = await import('../scripts/e2e.ts')
  const p = parseArgs(['send', 'hello', 'there', '--topic', 'proj', '--reply', '-1000000002', '--json'])
  assert.equal(p.cmd, 'send')
  assert.deepEqual(p.positional, ['hello', 'there'])
  assert.deepEqual(p.flags, { topic: 'proj', reply: '-1000000002', json: true })
  assert.throws(() => parseArgs(['send', 'x', '--topic']), /--topic needs a value/)
  assert.throws(() => parseArgs(['send', 'x', '--topic', '--json']), /--topic needs a value/)
})

test('e2e CLI: a send carries text only (plus forwarded when asked); a file command carries only its file', async () => {
  const { injectBody } = await import('../scripts/e2e.ts')
  assert.deepEqual(injectBody('send', 'hi', { topic: 'proj', from: 'indicozy' }), { op: 'inbound', topic: 'proj', reply: undefined, from: 'indicozy', text: 'hi' })
  const fwd = injectBody('send', '/usage', { forwarded: true })
  assert.equal(fwd.forwarded, true)
  assert.equal(fwd.document, undefined, 'a send never carries a file')
  assert.equal(injectBody('send', 'hi', {}).forwarded, undefined)
  assert.equal(injectBody('voice', '/abs/n.ogg', {}).voice, '/abs/n.ogg')
  assert.equal(injectBody('photo', '/abs/p.png', {}).photo, '/abs/p.png')
  assert.equal(injectBody('file', '/abs/f.pdf', {}).document, '/abs/f.pdf')
  assert.equal(injectBody('send', 'hi', {}).document, undefined)
})

test('e2e CLI wait: only messages sent after the wait started can match', async () => {
  const { waitFor } = await import('../scripts/e2e.ts')
  const sent = (id: number, text: string) => ({ messageId: id, chat: { kind: 'dm', id: OWNER, thread: null }, text, buttons: [] })
  // The buffer already holds a match; it must not satisfy the wait. A later one does.
  const polls = [
    [sent(1, 'old ok')],
    [sent(1, 'old ok')],
    [sent(1, 'old ok'), sent(2, 'not it')],
    [sent(1, 'old ok'), sent(2, 'not it'), sent(3, 'the answer is OK')],
  ]
  let i = 0
  const hit = await waitFor(/ok/i, 60_000, async () => polls[Math.min(i++, polls.length - 1)], async () => {})
  assert.equal(hit?.messageId, 3)
  const none = await waitFor(/never/, 2_000, async () => [sent(9, 'nope')], async () => {})
  assert.equal(none, null)
})

test('senderLabel: a plain username is kept; anything else falls back to e2e', async () => {
  const { senderLabel } = await import('../src/router/handlers/e2e.ts')
  assert.equal(senderLabel('indicozy'), 'indicozy')
  assert.equal(senderLabel(undefined), 'e2e')
  assert.equal(senderLabel('a b'), 'e2e')
  assert.equal(senderLabel('x'.repeat(33)), 'e2e')
  assert.equal(senderLabel(''), 'e2e')
})
