// The notes addon's prefix handler (design §4.13): "note:" in General saves the text, and a photo or file, to the notes
// inbox. Pure apart from the injected file operations, so the tests run it without a disk.
import { basename, extname, join } from 'node:path'
import { attachmentFileName, formatNoteEntry, isImagePath, type NoteAttachment } from './format.ts'

export const NOTE_SAVED_REPLY = '📝 saved'
export const NOTE_EMPTY_REPLY = 'Nothing to save after "note".'

// The file operations the handler needs. main.ts gives the real ones.
export type NoteFiles = {
  // The notes folder (the inbox file and the attachments folder live in it).
  notesDir: string
  now: () => Date
  exists: (path: string) => boolean
  copy: (src: string, dest: string) => Promise<void>
  mkdirp: (dir: string) => void
  // Appends one entry to the inbox, with a blank line before it when the file is not empty.
  appendEntry: (entry: string) => void
}

// What the router sends with a prefix call: the text after "note", and the local path of a file in the message (the
// router downloads it first; `kind` is the Telegram kind: text, photo, voice, document, ...).
export type NotePayload = { text?: unknown; filePath?: unknown; kind?: unknown }

// Adds `_n` before the extension until the name is free (the same rule as the store's saveAttachment).
function freeName(exists: (p: string) => boolean, dir: string, name: string): string {
  const ext = extname(name)
  const stem = basename(name, ext)
  let out = name
  for (let n = 2; exists(join(dir, out)); n++) out = `${stem}_${n}${ext}`
  return out
}

// The reply for a "note" prefix: saved (with its file), empty, or the reason it was not saved.
export async function savePrefixNote(payload: NotePayload, files: NoteFiles): Promise<string> {
  const text = typeof payload.text === 'string' ? payload.text.trim() : ''
  const src = typeof payload.filePath === 'string' && payload.filePath !== '' ? payload.filePath : null
  if (text === '' && src === null) return NOTE_EMPTY_REPLY
  try {
    const now = files.now()
    const attachments: NoteAttachment[] = []
    if (src !== null) attachments.push(await copyAttachment(src, payload.kind === 'photo', now, files))
    files.appendEntry(formatNoteEntry(now, text, attachments))
    return NOTE_SAVED_REPLY
  } catch (e) {
    return `note not saved: ${e instanceof Error ? e.message : String(e)}`
  }
}

// Copies the file into the attachments folder. The router names inbox files "<message id>_<name>"; the id is dropped
// from the name the owner sees, and kept in the file name only when the plain name is taken (as before).
async function copyAttachment(src: string, isPhoto: boolean, now: Date, files: NoteFiles): Promise<NoteAttachment> {
  const raw = basename(src)
  const name = isPhoto ? 'photo.jpg' : raw.replace(/^\d+_/, '') || 'file'
  const dir = join(files.notesDir, 'attachments')
  files.mkdirp(dir)
  let file = attachmentFileName(now, name)
  if (files.exists(join(dir, file))) file = attachmentFileName(now, raw)
  file = freeName(files.exists, dir, file)
  await files.copy(src, join(dir, file))
  return {
    path: `attachments/${file}`,
    label: isPhoto ? 'photo' : name,
    image: isPhoto || isImagePath(name),
  }
}
