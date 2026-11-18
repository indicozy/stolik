// StorePort over the files the router has always kept: msgmap.json (written atomically), the lock flag, the last boot
// id, the notes inbox and attachments, and the Telegram inbox folder. Same paths and file modes as before (plan S8).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { INBOX_DIR, NOTES_DIR, STATE_DIR } from '../config.ts'
import type { ChatId } from '../brain/chat-types.ts'
import type { LedgerRecord, StorePort } from '../ports.ts'
import type { SessionKey } from '../router/state.ts'
import { StoreFiles, type StorePaths } from './store-files.ts'
import { ensurePrivateDir } from './store-sqlite.ts'
import { legacyChatId, storedId } from './legacy-ids.ts'

export type JsonStorePaths = StorePaths

export const DEFAULT_JSON_PATHS: JsonStorePaths = { stateDir: STATE_DIR, inboxDir: INBOX_DIR, notesDir: NOTES_DIR }

// Missing or unreadable file: '' (the callers treat an empty file the same as no file).
function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

export class JsonStore implements StorePort {
  private readonly stateDir: string
  private readonly files: StoreFiles
  private readonly msgmapPath: string
  private readonly lockPath: string
  private readonly modelPath: string
  private readonly bootIdPath: string
  private readonly groupIdPath: string
  private readonly topicsPath: string
  private readonly mutesPath: string
  private readonly privacyPath: string
  // Files need no conversion at open, so nothing is ever noted here.
  readonly startupNotices: string[] = []
  // The outbound ledger is kept in memory only: it dedupes within this process, and a restart starts it empty.
  private ledger: LedgerRecord[] = []

  constructor(paths: JsonStorePaths = DEFAULT_JSON_PATHS) {
    this.stateDir = paths.stateDir
    this.msgmapPath = join(paths.stateDir, 'msgmap.json')
    this.lockPath = join(paths.stateDir, 'locked')
    this.modelPath = join(paths.stateDir, 'default-model')
    this.bootIdPath = join(paths.stateDir, 'last-boot-id')
    this.groupIdPath = join(paths.stateDir, 'group-id')
    this.topicsPath = join(paths.stateDir, 'topics.json')
    this.mutesPath = join(paths.stateDir, 'mutes.json')
    this.privacyPath = join(paths.stateDir, 'privacy-reported.json')
    // The state folder exists from the start (the router used to create it at start-up).
    ensurePrivateDir(this.stateDir)
    this.files = new StoreFiles(paths)
  }

  readMsgMap(): string {
    return readText(this.msgmapPath)
  }

  // Written to a temp file and renamed, so a crash mid-write leaves the previous map in place.
  writeMsgMap(json: string): void {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    const tmp = this.msgmapPath + '.tmp'
    writeFileSync(tmp, json, { mode: 0o600 })
    renameSync(tmp, this.msgmapPath)
  }

  isLocked(): boolean {
    return existsSync(this.lockPath)
  }

  setLocked(on: boolean): void {
    if (on) writeFileSync(this.lockPath, '', { mode: 0o600 })
    else rmSync(this.lockPath, { force: true })
  }

  defaultModel(): string | null {
    return readText(this.modelPath).trim() || null
  }

  setDefaultModel(model: string | null): void {
    if (model !== null) {
      mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
      writeFileSync(this.modelPath, `${model}\n`, { mode: 0o600 })
    } else {
      rmSync(this.modelPath, { force: true })
    }
  }

  readLastBootId(): string | null {
    return readText(this.bootIdPath).trim() || null
  }

  writeBootId(bootId: string): void {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    writeFileSync(this.bootIdPath, `${bootId}\n`, { mode: 0o600 })
  }

  readGroupId(): ChatId | null {
    return storedId(readText(this.groupIdPath).trim(), legacyChatId) as ChatId | null
  }

  writeGroupId(id: ChatId): void {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    writeFileSync(this.groupIdPath, `${id}\n`, { mode: 0o600 })
  }

  readTopics(): string {
    return readText(this.topicsPath)
  }

  // Not kept by the file store: stale keyboards are only stripped by the SQLite store (StorePort, optional).

  // Same atomic write as the message map.
  writeTopics(json: string): void {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    const tmp = this.topicsPath + '.tmp'
    writeFileSync(tmp, json, { mode: 0o600 })
    renameSync(tmp, this.topicsPath)
  }

  readMutes(): string {
    return readText(this.mutesPath)
  }

  readPrivacyReported(): string {
    return readText(this.privacyPath)
  }

  writePrivacyReported(text: string): void {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    writeFileSync(this.privacyPath, text, { mode: 0o600 })
  }

  writeMutes(json: string): void {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    writeFileSync(this.mutesPath, json, { mode: 0o600 })
  }

  appendNote(entry: string): void {
    this.files.appendNote(entry)
  }

  attachmentPath(fileName: string): string {
    return this.files.attachmentPath(fileName)
  }

  attachmentExists(fileName: string): boolean {
    return this.files.attachmentExists(fileName)
  }

  saveAttachment(src: string, fileName: string): Promise<string> {
    return this.files.saveAttachment(src, fileName)
  }

  inboxPath(fileName: string): string {
    return this.files.inboxPath(fileName)
  }

  listLedger(sessionKey: SessionKey): LedgerRecord[] {
    return this.ledger.filter((r) => r.sessionKey === sessionKey).map((r) => ({ ...r, messageIds: [...r.messageIds] }))
  }

  appendLedger(entries: readonly LedgerRecord[]): void {
    this.ledger.push(...entries.map((r) => ({ ...r, messageIds: [...r.messageIds] })))
  }

  pruneOutboundLedger(olderThanMs: number): number {
    const before = this.ledger.length
    this.ledger = this.ledger.filter((r) => r.at >= olderThanMs)
    return before - this.ledger.length
  }
}
