// The notes addon (plan 2.12): the prefix handler, the manifest, and the router side (the addon answers "note" when it
// is enabled; the core saves the note when it is not). Temp files, if any, live under test/ (ignored by git).
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseManifest } from '../src/addons-host/manifest.ts'
import { NOTE_EMPTY_REPLY, NOTE_SAVED_REPLY, savePrefixNote, type NoteFiles } from '../src/addons/notes/handle.ts'
import { tgChat, tgMsg, tgThread } from '../src/adapters/chat/tg-ids.ts'
import { FakeConn, HOME, flush, harness, textFrom } from './helpers/fakes.ts'
import type { AddonInfo, AddonsPort } from '../src/ports.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const when = new Date(2026, 10, 9, 14, 3, 12)

// In-memory file operations for the handler.
function memFiles(existing: string[] = []) {
  const have = new Set(existing)
  const entries: string[] = []
  const copies: Array<[string, string]> = []
  const files: NoteFiles = {
    notesDir: '/notes',
    now: () => when,
    exists: (p) => have.has(p),
    copy: async (src, dest) => {
      copies.push([src, dest])
      have.add(dest)
    },
    mkdirp: () => {},
    appendEntry: (e) => entries.push(e),
  }
  return { files, entries, copies }
}

test('savePrefixNote: a text note is appended in the inbox format and confirmed', async () => {
  const { files, entries } = memFiles()
  assert.equal(await savePrefixNote({ text: 'buy milk' }, files), NOTE_SAVED_REPLY)
  assert.deepEqual(entries, ['## 2026-11-09 14:03\n\nbuy milk\n'])
})

test('savePrefixNote: nothing after the word, and no file, is refused', async () => {
  const { files, entries } = memFiles()
  assert.equal(await savePrefixNote({ text: '' }, files), NOTE_EMPTY_REPLY)
  assert.equal(entries.length, 0)
})

test('savePrefixNote: a photo is copied to attachments and linked as an image, labelled photo', async () => {
  const { files, entries, copies } = memFiles()
  assert.equal(await savePrefixNote({ text: 'see this', filePath: '/inbox/42/42_photo.jpg', kind: 'photo' }, files), NOTE_SAVED_REPLY)
  assert.deepEqual(copies, [['/inbox/42/42_photo.jpg', '/notes/attachments/20261109-140312_photo.jpg']])
  assert.equal(entries[0], '## 2026-11-09 14:03\n\nsee this\n![photo](attachments/20261109-140312_photo.jpg)\n')
})

test('savePrefixNote: a document keeps its name (the message id is dropped) and is linked as a file', async () => {
  const { files, entries } = memFiles()
  await savePrefixNote({ text: '', filePath: '/inbox/7/7_report.pdf', kind: 'document' }, files)
  assert.equal(entries[0], '## 2026-11-09 14:03\n\n[report.pdf](attachments/20261109-140312_report.pdf)\n')
})

test('savePrefixNote: a voice note keeps its transcript and the voice file', async () => {
  const { files, entries, copies } = memFiles()
  await savePrefixNote({ text: 'call mum', filePath: '/inbox/9/9_voice.oga', kind: 'voice' }, files)
  assert.equal(copies[0][1], '/notes/attachments/20261109-140312_voice.oga')
  assert.equal(entries[0], '## 2026-11-09 14:03\n\ncall mum\n[voice.oga](attachments/20261109-140312_voice.oga)\n')
})

test('savePrefixNote: a name already taken gets the message id, and then a counter', async () => {
  const { files, copies } = memFiles(['/notes/attachments/20261109-140312_photo.jpg'])
  await savePrefixNote({ text: 'again', filePath: '/inbox/42/42_photo.jpg', kind: 'photo' }, files)
  assert.equal(copies[0][1], '/notes/attachments/20261109-140312_42_photo.jpg')
  const again = memFiles(['/notes/attachments/20261109-140312_photo.jpg', '/notes/attachments/20261109-140312_42_photo.jpg'])
  await savePrefixNote({ text: 'third', filePath: '/inbox/42/42_photo.jpg', kind: 'photo' }, again.files)
  assert.equal(again.copies[0][1], '/notes/attachments/20261109-140312_42_photo_2.jpg')
})

test('savePrefixNote: a failed write is reported, not thrown', async () => {
  const { files } = memFiles()
  files.appendEntry = () => {
    throw new Error('disk full')
  }
  assert.equal(await savePrefixNote({ text: 'x' }, files), 'note not saved: disk full')
})

test('the addon folder is self-contained: its sources import only their own files and node built-ins', () => {
  const dir = join(HERE, '..', 'src', 'addons', 'notes')
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
    const src = readFileSync(join(dir, f), 'utf8')
    for (const m of src.matchAll(/from '([^']+)'/g)) {
      const spec = m[1]
      assert.ok(spec.startsWith('./') || spec.startsWith('node:'), `${f} imports ${spec}`)
    }
  }
})

test('the manifest is valid, claims the three words, and asks only for message text and files', () => {
  const raw = JSON.parse(readFileSync(join(HERE, '..', 'src', 'addons', 'notes', 'tg-bridge-addon.json'), 'utf8'))
  const m = parseManifest(raw)
  assert.equal(m.name, 'notes')
  assert.deepEqual(m.provides, [{ point: 'prefix', words: ['note', 'заметка', 'запиши'] }])
  assert.deepEqual([...m.access].sort(), ['message.files', 'message.text'])
  assert.deepEqual(m.command, ['node', 'main.js'])
})

// An addons port that answers prefix words the way the host does: asks for the file only when it claims the word.
class FakeAddons implements AddonsPort {
  readonly calls: Array<{ text: string; file: Record<string, unknown> | null }> = []
  readonly reply: string | null
  constructor(reply: string | null) {
    this.reply = reply
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  list(): AddonInfo[] {
    return []
  }
  async setEnabled(): Promise<string | null> {
    return null
  }
  async general(text: string, _messageId?: number, file?: () => Promise<Record<string, unknown> | null>): Promise<string | null> {
    if (this.reply === null) return null
    const f = file ? await file() : null
    this.calls.push({ text, file: f })
    return this.reply
  }
}

test('router: with the notes addon enabled, "note:" goes to the addon and its reply is sent to General', async () => {
  const addons = new FakeAddons('📝 saved')
  const h = harness({ groupId: tgChat(-1001234567890), addons })
  await h.router.start()
  await h.chat.inbound(textFrom('note: buy milk', { chat: { kind: 'home', id: tgChat(-1001234567890), thread: null } }))
  assert.deepEqual(addons.calls, [{ text: 'note: buy milk', file: null }])
  assert.deepEqual(h.store.notes, [], 'the core did not save it')
  const reply = h.chat.sent.find((s) => s.text === '📝 saved')
  assert.ok(reply)
  assert.equal(reply.opts?.thread, undefined, 'General')
})

test('router: a photo note downloads the file first, and hands its local path to the addon', async () => {
  const addons = new FakeAddons('📝 saved')
  const h = harness({ addons })
  await h.router.start()
  const downloads: Array<[string, string]> = []
  h.chat.download = async (fileRef: string, dest: string) => {
    downloads.push([fileRef, dest])
  }
  await h.chat.inbound(textFrom('note: the sign', { kind: 'photo', fileRef: 'F1', messageId: tgMsg(42) }))
  assert.equal(downloads.length, 1)
  assert.equal(downloads[0][0], 'F1')
  assert.match(downloads[0][1], /42\/42_photo\.jpg$/)
  assert.equal(addons.calls[0].file?.filePath, downloads[0][1])
  assert.equal(addons.calls[0].file?.kind, 'photo')
})

test('router: with no notes addon, "note:" is saved by the core (the fallback)', async () => {
  const h = harness()
  await h.router.start()
  await h.chat.inbound(textFrom('note: buy milk'))
  assert.equal(h.store.notes.length, 1)
  assert.match(h.store.notes[0], /buy milk/)
  assert.ok(h.chat.sent.some((s) => s.text === '📝 saved'))
})

test('router: when no addon claims the word, the core saves a photo note itself, with one download', async () => {
  const addons = new FakeAddons(null)
  const h = harness({ addons })
  await h.router.start()
  const downloads: string[] = []
  h.chat.download = async (_fileId: string, dest: string) => {
    downloads.push(dest)
  }
  await h.chat.inbound(textFrom('note: x', { kind: 'photo', fileRef: 'F1', messageId: tgMsg(42) }))
  assert.equal(downloads.length, 1, 'downloaded once, by the core')
  assert.equal(h.store.notes.length, 1)
  assert.match(h.store.notes[0], /x/)
})

test('router: a note in a session topic is not parsed (no addon, no save)', async () => {
  const addons = new FakeAddons('📝 saved')
  const h = harness({ groupId: tgChat(-1001234567890), addons })
  await h.router.start()
  h.platform.dirs.add(`${HOME}/proj`)
  const conn = new FakeConn()
  h.agent.receive(conn, { t: 'register', claudePid: 4242, cwd: `${HOME}/proj` })
  await flush()
  await h.chat.inbound(textFrom('note: keep this', { chat: { kind: 'home', id: tgChat(-1001234567890), thread: tgThread(100) } }))
  assert.deepEqual(addons.calls, [])
  assert.deepEqual(h.store.notes, [])
})
