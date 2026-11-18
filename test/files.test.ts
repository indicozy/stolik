import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FilesChatLog, readTail } from '../src/adapters/files.ts'
import type { Inbound } from '../src/brain/chat-types.ts'
import { newChatLine, parseJsonl } from '../src/brain/chatlog.ts'
import { mediaBody } from '../src/router/deliver.ts'
import type { Router } from '../src/router/core.ts'

// Temp folders live inside test/ (gitignored as test/.tmp-*), never in /tmp or the real notes folder.
function tempRoot(): string {
  return mkdtempSync(join(import.meta.dirname, '.tmp-chatlog-'))
}

const at = (y: number, mo: number, d: number, h: number, mi: number, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime()

test('append: one JSONL line in the monthly file and one Markdown line in the daily file', () => {
  const root = tempRoot()
  try {
    const log = new FilesChatLog(root)
    log.append(newChatLine({ ts: at(2026, 11, 9, 14, 3, 12), dir: 'in', kind: 'text', text: 'hi' }))
    log.append(newChatLine({ ts: at(2026, 11, 9, 14, 4, 0), dir: 'out', kind: 'response', text: 'hello' }))

    const jsonl = readFileSync(join(root, 'log', '2026-11.jsonl'), 'utf8').trim().split('\n')
    assert.equal(jsonl.length, 2)
    assert.equal(JSON.parse(jsonl[0]).text, 'hi')
    const md = readFileSync(join(root, '2026-11-09.md'), 'utf8')
    assert.equal(md, '# 2026-11-09\n\n- 14:03:12 **in** hi\n- 14:04:00 **out** (response) hello\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('midnight and month end: the lines go to the day and month they belong to', () => {
  const root = tempRoot()
  try {
    const log = new FilesChatLog(root)
    // A fake clock stepping over midnight on the last day of the month.
    log.append(newChatLine({ ts: at(2026, 11, 30, 23, 59, 59), dir: 'in', kind: 'text', text: 'late' }))
    log.append(newChatLine({ ts: at(2026, 12, 1, 0, 0, 1), dir: 'in', kind: 'text', text: 'early' }))

    assert.equal(readFileSync(join(root, 'log', '2026-11.jsonl'), 'utf8').trim().split('\n').length, 1)
    assert.equal(readFileSync(join(root, 'log', '2026-12.jsonl'), 'utf8').trim().split('\n').length, 1)
    assert.equal(readFileSync(join(root, '2026-11-30.md'), 'utf8'), '# 2026-11-30\n\n- 23:59:59 **in** late\n')
    assert.equal(readFileSync(join(root, '2026-12-01.md'), 'utf8'), '# 2026-12-01\n\n- 00:00:01 **in** early\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a new instance on a day already logged does not repeat the heading', () => {
  const root = tempRoot()
  try {
    new FilesChatLog(root).append(newChatLine({ ts: at(2026, 11, 9, 9, 0, 0), dir: 'in', kind: 'text', text: 'one' }))
    new FilesChatLog(root).append(newChatLine({ ts: at(2026, 11, 9, 9, 1, 0), dir: 'in', kind: 'text', text: 'two' }))
    assert.equal(readFileSync(join(root, '2026-11-09.md'), 'utf8'), '# 2026-11-09\n\n- 09:00:00 **in** one\n- 09:01:00 **in** two\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('attachmentPath: a reserved file under attachments/<day>/, and a new name for a second file in the same second', () => {
  const root = tempRoot()
  try {
    const log = new FilesChatLog(root)
    const ts = at(2026, 11, 9, 14, 3, 12)
    const a = log.attachmentPath('photo.jpg', ts)
    assert.ok(a)
    assert.equal(a.rel, 'attachments/2026-11-09/140312-photo.jpg')
    assert.equal(a.path, join(root, a.rel))
    assert.ok(existsSync(a.path), 'the name is claimed on the disk')
    const b = log.attachmentPath('photo.jpg', ts)
    assert.equal(b?.rel, 'attachments/2026-11-09/140312-2-photo.jpg')
    writeFileSync(b.path, 'x')
    assert.equal(readFileSync(b.path, 'utf8'), 'x')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('failures are reported, not thrown: an unwritable root', () => {
  const root = tempRoot()
  try {
    // The log root is a file, so no folder can be made under it.
    const blocker = join(root, 'not-a-folder')
    writeFileSync(blocker, '')
    const errors: string[] = []
    const log = new FilesChatLog(blocker, (m) => errors.push(m))
    assert.doesNotThrow(() => log.append(newChatLine({ ts: at(2026, 11, 9, 9, 0, 0), dir: 'in', kind: 'text', text: 'x' })))
    assert.equal(log.attachmentPath('a.pdf', at(2026, 11, 9, 9, 0, 0)), null)
    assert.equal(log.recentExchanges({ type: 'session', name: 's' }, 3).length, 0)
    assert.equal(errors.length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('recentExchanges: the last lines of one target across the month files, oldest first', () => {
  const root = tempRoot()
  try {
    const log = new FilesChatLog(root)
    const line = (y: number, mo: number, d: number, name: string, text: string) =>
      newChatLine({ ts: at(y, mo, d, 12, 0, 0), dir: 'in', kind: 'text', text, target: { type: 'session', name } })
    log.append(line(2026, 10, 31, 'proj', 'october'))
    log.append(line(2026, 11, 1, 'other', 'elsewhere'))
    log.append(line(2026, 11, 2, 'proj', 'one'))
    log.append(line(2026, 11, 3, 'proj', 'two'))
    assert.deepEqual(log.recentExchanges({ type: 'session', name: 'proj' }, 2).map((l) => l.text), ['one', 'two'])
    assert.deepEqual(log.recentExchanges({ type: 'session', name: 'proj' }, 5).map((l) => l.text), ['october', 'one', 'two'])
    assert.deepEqual(log.recentExchanges({ type: 'session', name: 'none' }, 5), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Every file under a folder, relative to it.
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    return e.isDirectory() ? filesUnder(p) : [p]
  })
}

test('a failing download leaves no file behind (the reserved attachment is removed)', async () => {
  const root = tempRoot()
  try {
    const router = {
      chat: {
        download: async () => {
          throw new Error('network down')
        },
        sendText: async () => 1,
      },
      chatLog: new FilesChatLog(root),
      clock: { now: () => at(2026, 11, 9, 14, 0, 0), date: () => new Date(at(2026, 11, 9, 14, 0, 0)) },
      secrets: [],
      chatTrace: new Map(),
      groupId: null,
      store: { inboxPath: (f: string) => join(root, 'inbox', f) },
      logger: { log: () => {} },
    } as unknown as Router
    const m = { kind: 'photo', messageId: 7, text: '', replyToId: null, forwarded: false, from: 'owner', fromId: '1', fileRef: 'F', fileSize: 100, chat: { kind: 'dm', id: '', thread: null } } as Inbound
    const body = await mediaBody(router, m, '', {})
    assert.equal(body, null, 'the message is not delivered')
    assert.deepEqual(filesUnder(join(root, 'attachments')), [], 'no empty placeholder is left')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readTail: reads only the end of a file; a cut first line is dropped, the whole lines stay', () => {
  const root = tempRoot()
  try {
    const path = join(root, 'big.jsonl')
    const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ n: i, pad: 'p'.repeat(20) }))
    writeFileSync(path, lines.join('\n') + '\n')
    const tail = readTail(path, 300)
    assert.ok(tail.length <= 300, 'bounded by the byte limit')
    const got = tail.trim().split('\n')
    assert.equal(got[got.length - 1], lines[49], 'the last record is there')
    assert.ok(lines.includes(got[0]), 'the first line read is a whole one')
    assert.equal(readTail(path, 1e9), lines.join('\n') + '\n', 'a bound above the size reads the whole file')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a torn record (a crash mid-write) does not eat the next appended line', () => {
  const root = tempRoot()
  try {
    const log = new FilesChatLog(root)
    log.append(newChatLine({ ts: at(2026, 11, 9, 14, 0, 0), dir: 'in', kind: 'text', text: 'one' }))
    const file = join(root, 'log', '2026-11.jsonl')
    appendFileSync(file, '{"ts":"2026-11-09T14:0')
    log.append(newChatLine({ ts: at(2026, 11, 9, 14, 5, 0), dir: 'in', kind: 'text', text: 'three' }))
    assert.deepEqual(parseJsonl(readFileSync(file, 'utf8')).map((l) => l.text), ['one', 'three'])
    assert.equal(readFileSync(file, 'utf8').split('\n').filter((l) => l !== '').length, 3, 'the torn record stays on its own line')
    assert.ok(statSync(file).size > 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
