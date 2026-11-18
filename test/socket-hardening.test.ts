// Router socket hardening (findings 13-18, 21): the line framing caps, the reply cap, the lock and the in-flight prompt,
// and the key-based desk match. Routers run with fake ports (test/helpers/fakes.ts).
import './helpers/isolate.ts'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, rmSync } from 'node:fs'
import { ANSWERED_AT_DESK_TEXT, callKey } from '../src/brain/posttool.ts'
import { LineConn, MAX_LINE_CHARS } from '../src/adapters/channel/ipc.ts'
import { markerPath, pendingDir } from '../src/adapters/hooks/pending-marker.ts'
import { capReply, toolKey } from '../src/router/handlers/socket.ts'
import { FakeConn, FakeChat, flush, harness } from './helpers/fakes.ts'

// A socket stand-in: a writable/readable EventEmitter with destroy(), which is all LineConn uses.
class FakeSocket extends EventEmitter {
  destroyed = false
  written: string[] = []
  setEncoding(_enc: string): void {}
  write(s: string): boolean {
    this.written.push(s)
    return true
  }
  destroy(): void {
    this.destroyed = true
  }
  data(s: string): void {
    this.emit('data', s)
  }
}

const asSocket = (s: FakeSocket) => s as unknown as import('node:net').Socket

test('LineConn: complete lines dispatch in order, split and joined chunks included', () => {
  const sock = new FakeSocket()
  const conn = new LineConn(asSocket(sock))
  const got: unknown[] = []
  conn.onMessage((m) => got.push(m))
  sock.data('{"a":1}\n{"b"')
  sock.data(':2}\n\n{"c":3}')
  sock.data('\n')
  assert.deepEqual(got, [{ a: 1 }, { b: 2 }, { c: 3 }])
})

test('LineConn: an unparsable line is dropped and reported, and the next line still arrives', () => {
  const sock = new FakeSocket()
  const drops: string[] = []
  const conn = new LineConn(asSocket(sock), { onDrop: (r) => drops.push(r) })
  const got: unknown[] = []
  conn.onMessage((m) => got.push(m))
  sock.data('not json\n{"ok":true}\n')
  assert.deepEqual(got, [{ ok: true }])
  assert.equal(drops.length, 1)
  assert.match(drops[0], /unparsable/)
  assert.equal(sock.destroyed, false)
})

test('LineConn: a line over the cap closes the socket and nothing after it is read', () => {
  const sock = new FakeSocket()
  const drops: string[] = []
  const conn = new LineConn(asSocket(sock), { maxLine: 50, onDrop: (r) => drops.push(r) })
  const got: unknown[] = []
  conn.onMessage((m) => got.push(m))
  sock.data('x'.repeat(51)) // no newline yet: the buffer alone is over the cap
  assert.equal(sock.destroyed, true)
  assert.equal(drops.length, 1)
  sock.data('\n{"late":1}\n')
  assert.deepEqual(got, [])
})

test('LineConn: a complete line over the cap in one chunk is refused too', () => {
  const sock = new FakeSocket()
  const conn = new LineConn(asSocket(sock), { maxLine: 20 })
  const got: unknown[] = []
  conn.onMessage((m) => got.push(m))
  sock.data(`{"t":"${'y'.repeat(40)}"}\n`)
  assert.deepEqual(got, [])
  assert.equal(sock.destroyed, true)
})

test('LineConn: a long line arriving in many chunks is scanned from its previous offset, and parses once complete', () => {
  const sock = new FakeSocket()
  const conn = new LineConn(asSocket(sock))
  const got: any[] = []
  conn.onMessage((m) => got.push(m))
  const line = JSON.stringify({ big: 'z'.repeat(200_000) })
  for (let i = 0; i < line.length; i += 1000) sock.data(line.slice(i, i + 1000))
  assert.equal(got.length, 0)
  sock.data('\n')
  assert.equal(got.length, 1)
  assert.equal(got[0].big.length, 200_000)
  assert.equal(sock.destroyed, false)
})

test('LineConn: the default cap is one million characters', () => {
  assert.equal(MAX_LINE_CHARS, 1_000_000)
})

test('capReply: a reply up to 64 KB is sent as it is; a longer one is cut with a notice', () => {
  const short = 'a'.repeat(64_000)
  assert.equal(capReply(short), short)
  const cut = capReply('b'.repeat(70_000))
  assert.ok(cut.startsWith('b'.repeat(64_000)))
  assert.ok(!cut.includes('b'.repeat(64_001)))
  assert.match(cut, /cut: the reply was longer than 64 KB/)
})

test('toolKey: a well-formed hash and head are the key; a missing or malformed one is null', () => {
  const k = callKey({ command: 'ls' })
  assert.deepEqual(toolKey({ input_hash: k.hash, input_head: k.head }), k)
  assert.equal(toolKey({ input_head: k.head }), null)
  assert.equal(toolKey({ input_hash: 'not-hex', input_head: k.head }), null)
  assert.equal(toolKey({ input_hash: k.hash, input_head: 'h'.repeat(5000) }), null)
})

// ---- router handlers -------------------------------------------------------

const PID = 4242
const PROJ = '/home/u/proj'
const roots: string[] = []
afterEach(() => {
  rmSync(pendingDir(), { recursive: true, force: true })
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

async function withSession() {
  const h = harness()
  await h.router.start()
  h.platform.dirs.add(PROJ)
  const conn = new FakeConn()
  h.agent.receive(conn, { t: 'register', claudePid: PID, cwd: PROJ })
  await flush()
  h.platform.away = true
  return { ...h, conn }
}

const perm = (requestId = 'abcde', command = 'ls') => ({
  t: 'permission_request',
  request_id: requestId,
  tool_name: 'Bash',
  description: 'run',
  input_preview: JSON.stringify({ command }),
})

test('lock: a locked router relays no permission prompt and writes no marker (the terminal dialog is the only one)', async () => {
  const h = await withSession()
  h.router.locked = true
  h.agent.receive(h.conn, perm())
  await flush()
  assert.equal(h.chat.sent.filter((s) => s.opts?.perm).length, 0)
  assert.equal(existsSync(markerPath(PID)), false)
  assert.equal(h.router.pending.size, 0)
})

test('lock: after unlock the next prompt is relayed again', async () => {
  const h = await withSession()
  h.router.locked = true
  h.agent.receive(h.conn, perm('abcde'))
  await flush()
  h.router.locked = false
  h.agent.receive(h.conn, perm('fghjk'))
  await flush()
  assert.equal(h.chat.sent.filter((s) => s.opts?.perm).length, 1)
  assert.equal(existsSync(markerPath(PID)), true)
})

// A telegram whose sendText waits until the test releases it, so a PostToolUse can arrive while the send is in flight.
function deferSends(chat: FakeChat): { release: () => void } {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  const real = chat.sendText.bind(chat)
  chat.sendText = async (text: string, opts?: any) => {
    await gate
    return real(text, opts)
  }
  return { release }
}

test('in flight: a PostToolUse during the send marks the marker first, and the buttons are answered once the send returns', async () => {
  const h = await withSession()
  const gate = deferSends(h.chat)
  h.agent.receive(h.conn, perm('abcde', 'ls'))
  await flush()
  assert.equal(existsSync(markerPath(PID)), true, 'the marker is written before the send returns')
  const k = callKey({ command: 'ls' })
  h.agent.receive(new FakeConn(), { t: 'hook', event: 'PostToolUse', claudePid: PID, cwd: PROJ, payload: { session_id: 's1', tool_name: 'Bash', input_hash: k.hash, input_head: k.head } })
  await flush()
  assert.equal(existsSync(markerPath(PID)), false)
  gate.release()
  await flush()
  const sent = h.chat.sent.find((s) => s.opts?.perm?.requestId === 'abcde')
  assert.ok(sent)
  const edit = h.chat.edits.find((e) => e.messageId === sent.id)
  assert.ok(edit, 'the prompt is edited to say it was answered at the desk')
  assert.match(edit.text, new RegExp(ANSWERED_AT_DESK_TEXT))
  assert.equal(h.router.pending.size, 0)
})

test('in flight: a failed send leaves no pending entry and no marker', async () => {
  const h = await withSession()
  h.chat.sendText = async () => {
    throw new Error('telegram down')
  }
  h.agent.receive(h.conn, perm())
  await flush()
  assert.equal(h.router.pending.size, 0)
  assert.equal(existsSync(markerPath(PID)), false)
})

test('desk match: a PostToolUse with a key for a different call leaves the prompt alone', async () => {
  const h = await withSession()
  h.agent.receive(h.conn, perm('abcde', 'ls -la && rm -rf /'))
  await flush()
  const k = callKey({ command: 'ls -la' })
  h.agent.receive(new FakeConn(), { t: 'hook', event: 'PostToolUse', claudePid: PID, cwd: PROJ, payload: { session_id: 's1', tool_name: 'Bash', input_hash: k.hash, input_head: k.head } })
  await flush()
  assert.equal(h.chat.edits.length, 0)
  assert.equal(h.router.pending.size, 1)
})

test('desk match: a large call matches by its key, with no input in the payload', async () => {
  const h = await withSession()
  const big = { content: 'w'.repeat(200_000) }
  // The channel's preview is cut at its cap; the router compares the head, which the hook also sent.
  h.agent.receive(h.conn, { t: 'permission_request', request_id: 'abcde', tool_name: 'Write', description: 'write', input_preview: JSON.stringify(big).slice(0, 3500) })
  await flush()
  const k = callKey(big)
  h.agent.receive(new FakeConn(), { t: 'hook', event: 'PostToolUse', claudePid: PID, cwd: PROJ, payload: { session_id: 's1', tool_name: 'Write', input_hash: k.hash, input_head: k.head } })
  await flush()
  assert.equal(h.router.pending.size, 0)
  assert.equal(h.chat.edits.length, 1)
})

test('desk match: a PostToolUse without a key (old or malformed hook) does nothing', async () => {
  const h = await withSession()
  h.agent.receive(h.conn, perm())
  await flush()
  h.agent.receive(new FakeConn(), { t: 'hook', event: 'PostToolUse', claudePid: PID, cwd: PROJ, payload: { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' } } })
  await flush()
  assert.equal(h.chat.edits.length, 0)
  assert.equal(h.router.pending.size, 1)
})
