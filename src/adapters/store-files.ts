// The file parts of the store, shared by JsonStore and SqliteStore: the notes inbox, the notes attachments and the
// Telegram inbox folder. These stay files in v3 (they are read by the owner and the read mode).
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

export type StorePaths = { stateDir: string; inboxDir: string; notesDir: string }

export class StoreFiles {
  private readonly attachDir: string
  private readonly notesInbox: string
  private readonly inboxDir: string

  constructor(paths: StorePaths) {
    this.inboxDir = paths.inboxDir
    this.attachDir = join(paths.notesDir, 'attachments')
    this.notesInbox = join(paths.notesDir, 'inbox.md')
    // The inbox folder exists from the start (the router used to create it at start-up).
    mkdirSync(this.inboxDir, { recursive: true, mode: 0o700 })
  }

  // Creates the notes folder and file with private modes. A blank line separates the entry from the one before.
  appendNote(entry: string): void {
    mkdirSync(dirname(this.notesInbox), { recursive: true, mode: 0o700 })
    const sep = existsSync(this.notesInbox) && statSync(this.notesInbox).size > 0 ? '\n' : ''
    appendFileSync(this.notesInbox, sep + entry, { mode: 0o600 })
  }

  attachmentPath(fileName: string): string {
    mkdirSync(this.attachDir, { recursive: true, mode: 0o700 })
    return join(this.attachDir, fileName)
  }

  attachmentExists(fileName: string): boolean {
    return existsSync(join(this.attachDir, fileName))
  }

  // Copies `src` into the attachments folder. When the name is taken, `_2`, `_3`, ... is added before the extension.
  async saveAttachment(src: string, fileName: string): Promise<string> {
    mkdirSync(this.attachDir, { recursive: true, mode: 0o700 })
    const ext = extname(fileName)
    const stem = basename(fileName, ext)
    let name = fileName
    for (let n = 2; existsSync(join(this.attachDir, name)); n++) name = `${stem}_${n}${ext}`
    const dest = join(this.attachDir, name)
    await copyFile(src, dest)
    return dest
  }

  inboxPath(fileName: string): string {
    return join(this.inboxDir, fileName)
  }
}
