// Notes inbox format (design §4.13): the entry text, the timestamps and the attachment file names. Pure: no I/O.
// The notes addon (main.ts) writes it. The core imports it too (src/router/notes.ts for the fallback, and the file-name
// helpers below for its own attachments), so this folder is the one definition. Nothing here imports outside this folder:
// the addon is installed as a folder (tg-bridge addon add), and must run from there alone.
import { basename } from 'node:path'

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])
export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  return dot >= 0 && IMAGE_EXT.has(path.slice(dot).toLowerCase())
}

// Makes an inbound file name safe to use as a single path component.
export function sanitizeFileName(name: string): string {
  const cleaned = basename(name).replace(/[<>\[\]\r\n;"]/g, '_').replace(/^\.+/, '_')
  return cleaned.length > 0 ? cleaned.slice(0, 200) : 'file'
}

// `path` is relative to the notes folder, e.g. attachments/20261109-140312_photo.jpg.
export type NoteAttachment = { path: string; label: string; image: boolean }

const pad = (n: number) => String(n).padStart(2, '0')

// Local time as "YYYY-MM-DD HH:MM", the heading of an entry.
export function localStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// Local time as "YYYYMMDD-HHMMSS", used in attachment file names.
export function fileStamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

// File name of a saved attachment: "<YYYYMMDD-HHMMSS>_<safe name>".
export function attachmentFileName(d: Date, name: string): string {
  return `${fileStamp(d)}_${sanitizeFileName(name)}`
}

// One inbox entry, ending in a newline: the heading, a blank line, the text (if any), then one line per
// attachment. The caller puts a blank line before the entry when the file is not empty.
export function formatNoteEntry(d: Date, text: string, attachments: readonly NoteAttachment[]): string {
  const lines: string[] = []
  if (text) lines.push(text)
  for (const a of attachments) lines.push(a.image ? `![${a.label}](${a.path})` : `[${a.label}](${a.path})`)
  return `## ${localStamp(d)}\n\n${lines.join('\n')}\n`
}
