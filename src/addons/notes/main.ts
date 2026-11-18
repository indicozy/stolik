// Notes addon (plan 2.12): a Node program the bot starts. It speaks NDJSON on stdin and stdout (src/addons-host/protocol.ts):
// one request per line {id, op, payload}, one reply per line {id, result} or {id, error}. It answers the "prefix" op for
// the words note, заметка and запиши. Logs go to stderr only.
import { createInterface } from 'node:readline'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { savePrefixNote, type NoteFiles } from './handle.ts'

const notesDir = process.env.TG_BRIDGE_NOTES_DIR || join(homedir(), 'Documents', 'notes')
const inbox = join(notesDir, 'inbox.md')

const files: NoteFiles = {
  notesDir,
  now: () => new Date(),
  exists: (p) => existsSync(p),
  copy: async (src, dest) => copyFileSync(src, dest),
  mkdirp: (dir) => mkdirSync(dir, { recursive: true, mode: 0o700 }),
  appendEntry: (entry) => {
    mkdirSync(notesDir, { recursive: true, mode: 0o700 })
    const sep = existsSync(inbox) && statSync(inbox).size > 0 ? '\n' : ''
    appendFileSync(inbox, sep + entry, { mode: 0o600 })
  },
}

function write(msg: object): void {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let req: { id?: unknown; op?: unknown; payload?: unknown }
  try {
    req = JSON.parse(line)
  } catch {
    return
  }
  const id = typeof req.id === 'number' ? req.id : null
  if (id === null) return
  if (req.op !== 'prefix') return write({ id, error: `notes does not handle ${String(req.op)}` })
  const payload = (req.payload ?? {}) as Record<string, unknown>
  savePrefixNote(payload, files)
    .then((reply) => write({ id, result: { reply } }))
    .catch((e: unknown) => write({ id, error: e instanceof Error ? e.message : String(e) }))
})
