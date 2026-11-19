// The live store: StorePort and DbStorePort over SQLite (`stolik.db` in the v3 state folder), via node:sqlite (no new
// dependency; Node 22.13+). The message map, lock flag, boot id, group id and topics are kept here too, so the router
// reads and writes one store. Files stay files for the chat log, attachments, notes inbox and audit log (store-files.ts).
// Each public method is one logical write; a method that writes several rows runs them in one transaction.
import { createRequire } from 'node:module'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { parseTopics, serializeTopics, type TopicRec, type TopicState } from '../brain/topics.ts'
import type { ModeName } from '../brain/modes.ts'
import type { UsageRecord } from '../brain/usage.ts'
import type { DbStorePort, LedgerRecord, RouterDecisionRecord, SessionRecord, StorePort, TraceRecord } from '../ports.ts'
import type { SessionKey } from '../router/state.ts'
import { routerLockHeld } from './instance-lock.ts'
import { StoreFiles, type StorePaths } from './store-files.ts'
import type { ChatId, MessageId, ThreadId } from '../brain/chat-types.ts'
import { legacyChatId, legacyMsgId, storedId } from './legacy-ids.ts'

export const DB_FILE = 'stolik.db'

// SQLite primary result codes (the low byte of an extended code, as node:sqlite reports it in `errcode`).
const SQLITE_READONLY = 8
const SQLITE_CORRUPT = 11
const SQLITE_FULL = 13
const SQLITE_NOTADB = 26

// Messages node:sqlite gives for the fatal conditions, for errors that carry no errcode.
const FATAL_MESSAGES = [/database disk image is malformed/, /database or disk is full/, /attempt to write a readonly database/]

// True for the store errors the router must stop on: a corrupt file, a full disk, a read-only database.
export function isFatalStoreError(err: unknown): boolean {
  const code = resultCode(err)
  if (code !== null) return code === SQLITE_CORRUPT || code === SQLITE_FULL || code === SQLITE_READONLY
  const text = err instanceof Error ? err.message : ''
  return FATAL_MESSAGES.some((re) => re.test(text))
}

function resultCode(err: unknown): number | null {
  const code = (err as { errcode?: unknown } | null | undefined)?.errcode
  return typeof code === 'number' ? code & 0xff : null
}

// A file SQLite cannot read (corrupt, or not a database at all): the store moves it aside and starts a fresh one.
function isCorruption(err: unknown): boolean {
  const code = resultCode(err)
  return code === SQLITE_CORRUPT || code === SQLITE_NOTADB
}

// The open refused: the file does not hold a schema this build can use. Nothing was written.
export class SchemaMismatchError extends Error {
  constructor(found: number, needed: number) {
    super(
      `stolik.db schema is v${found}, this build needs v${needed}. Restart the stolik service (it migrates on start) and retry.`,
    )
    this.name = 'SchemaMismatchError'
  }
}

// A folder the store owns is private: created 0700, and one that is group- or world-accessible is tightened.
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32' && (statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700)
}

// Keys of the `kv` table (StorePort's single values).
export const KV = {
  msgmap: 'msgmap',
  locked: 'locked',
  model: 'default-model',
  bootId: 'last-boot-id',
  homeId: 'home-id',
  liveButtons: 'live-buttons',
  mutes: 'folder-mutes',
  privacyReported: 'privacy-reported',
} as const

// One migration per schema version: migrations[i] takes the database from version i to i + 1. A destructive one drops
// or rewrites a table: the database is copied to `<file>.bak-v<from>` before it runs.
export type Migration = ((db: DatabaseSync) => void) & { destructive?: boolean }

// v0 -> v1: the first schema. A new file is version 0 (no meta table yet).
export const MIGRATION_V1: Migration = (db) => {
  db.exec(`
    CREATE TABLE meta (schema_version INTEGER NOT NULL);
    -- Reserved: no production writers yet (the live registry is in memory, src/brain/sessions.ts). The table and its
    -- methods stay so a persisted registry can land without a schema change; do not drop it.
    CREATE TABLE sessions (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project TEXT NOT NULL,
      cwd TEXT NOT NULL,
      pid INTEGER,
      has_channel INTEGER NOT NULL,
      connected INTEGER NOT NULL,
      spawned INTEGER NOT NULL,
      last_active INTEGER NOT NULL,
      backend_session_id TEXT
    );
    CREATE TABLE topics (
      thread_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      project TEXT,
      created_at INTEGER NOT NULL
    );
    -- Reserved: no production writers yet. Kept for the per-mode forum thread (DbStorePort.getModeThread); do not drop it.
    CREATE TABLE mode_threads (
      mode TEXT PRIMARY KEY,
      thread_id INTEGER NOT NULL
    );
    CREATE TABLE outbound_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      key TEXT NOT NULL,
      body_key TEXT NOT NULL,
      source TEXT NOT NULL,
      at INTEGER NOT NULL,
      message_ids TEXT NOT NULL
    );
    CREATE INDEX outbound_ledger_session ON outbound_ledger (session_key);
    CREATE TABLE addon_settings (
      addon TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (addon, key)
    );
    -- Reserved: no production writers yet. Kept for the router decision log (DbStorePort.appendRouterDecision); do not drop it.
    CREATE TABLE router_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      chosen TEXT,
      confidence REAL,
      outcome TEXT NOT NULL
    );
    CREATE TABLE usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      backend TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL
    );
  `)
}

// v1 -> v2: the single-value `kv` table (msgmap, lock, boot id, group id); topics take the brain's record shape (their
// order is the insertion order, kept by rowid); usage takes the mode-run records (src/brain/usage.ts). Nothing wrote the
// v1 topics or usage tables before this version, so they are rebuilt empty.
export const MIGRATION_V2: Migration = Object.assign((db: DatabaseSync) => {
  db.exec(`
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    DROP TABLE topics;
    CREATE TABLE topics (
      thread_id INTEGER NOT NULL UNIQUE,
      name TEXT NOT NULL,
      project TEXT NOT NULL,
      session_key TEXT,
      backend_session_id TEXT,
      state TEXT NOT NULL,
      ended_at INTEGER,
      delete_at INTEGER
    );
    DROP TABLE usage;
    CREATE TABLE usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      mode TEXT NOT NULL,
      cost_usd REAL NOT NULL,
      duration_ms INTEGER NOT NULL,
      outcome TEXT NOT NULL
    );
    CREATE INDEX usage_at ON usage (at);
  `)
}, { destructive: true })

// v2 -> v3: the trace map (design §Observability). Telegram message ids (in and out) to the trace id of their flow,
// kept 7 days by the router's sweep.
export const MIGRATION_V3: Migration = (db) => {
  db.exec(`
    CREATE TABLE trace_map (
      message_id INTEGER NOT NULL,
      dir TEXT NOT NULL,
      trace TEXT NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (message_id, dir, trace)
    );
    CREATE INDEX trace_map_at ON trace_map (at);
  `)
}

// v3 -> v4: session keys are `<pid>:<start>` (or `cwd:<folder>`, see brain/sessions.ts). A bare pid (`n:<pid>` here)
// cannot be told from a reused pid, so those rows are stale and are removed (a live session takes its place on register).
export const MIGRATION_V4: Migration = (db) => {
  db.exec(`DELETE FROM sessions WHERE key LIKE 'n:%';`)
}

// v4 -> v5: a topic belongs to a folder (its cwd, ticket 22). Rows from before are per-session (legacy): cwd is null.
export const MIGRATION_V5: Migration = (db) => {
  db.exec(`ALTER TABLE topics ADD COLUMN cwd TEXT;`)
}

// v5 -> v6: ids are strings on disk ("tg:<n>", "e2e:<n>", plan 23 §4.2). Numbers are converted with the legacy rules
// (src/adapters/legacy-ids.ts); an id that has no form now drops its row or entry. A JSON value that does not parse, or
// has another shape, is left as it is. Runs inside the runner's transaction, so no BEGIN here.
type Row = Record<string, SQLOutputValue>
function parseJson(text: string): { value: unknown } | null {
  try {
    return { value: JSON.parse(text) }
  } catch {
    return null
  }
}

export const MIGRATION_V6: Migration = Object.assign((db: DatabaseSync) => {
  // topics: the thread id is text now; rows keep their insertion order (rowid), columns as V2 + V5 left them.
  const topics = db.prepare('SELECT * FROM topics ORDER BY rowid').all() as Row[]
  db.exec(`
    CREATE TABLE topics_new (
      thread_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      project TEXT NOT NULL,
      session_key TEXT,
      backend_session_id TEXT,
      state TEXT NOT NULL,
      ended_at INTEGER,
      delete_at INTEGER,
      cwd TEXT
    );
  `)
  const insTopic = db.prepare(
    'INSERT INTO topics_new (thread_id, name, project, session_key, backend_session_id, state, ended_at, delete_at, cwd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  for (const r of topics) {
    const id = storedId(r.thread_id, legacyMsgId)
    if (id === null) continue
    insTopic.run(id, r.name, r.project, r.session_key, r.backend_session_id, r.state, r.ended_at, r.delete_at, r.cwd)
  }
  db.exec('DROP TABLE topics; ALTER TABLE topics_new RENAME TO topics;')

  // mode_threads: the thread id is text.
  const modes = db.prepare('SELECT mode, thread_id FROM mode_threads').all() as Row[]
  db.exec('CREATE TABLE mode_threads_new (mode TEXT PRIMARY KEY, thread_id TEXT NOT NULL);')
  const insMode = db.prepare('INSERT INTO mode_threads_new (mode, thread_id) VALUES (?, ?)')
  for (const r of modes) {
    const id = storedId(r.thread_id, legacyMsgId)
    if (id !== null) insMode.run(r.mode, id)
  }
  db.exec('DROP TABLE mode_threads; ALTER TABLE mode_threads_new RENAME TO mode_threads;')

  // trace_map: the message id is text; the index is recreated on the renamed table (index names are global).
  const traces = db.prepare('SELECT message_id, dir, trace, at FROM trace_map ORDER BY rowid').all() as Row[]
  db.exec(`
    CREATE TABLE trace_map_new (
      message_id TEXT NOT NULL,
      dir TEXT NOT NULL,
      trace TEXT NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (message_id, dir, trace)
    );
  `)
  const insTrace = db.prepare('INSERT INTO trace_map_new (message_id, dir, trace, at) VALUES (?, ?, ?, ?)')
  for (const r of traces) {
    const id = storedId(r.message_id, legacyMsgId)
    if (id !== null) insTrace.run(id, r.dir, r.trace, r.at)
  }
  db.exec('DROP TABLE trace_map; ALTER TABLE trace_map_new RENAME TO trace_map; CREATE INDEX trace_map_at ON trace_map (at);')

  // outbound_ledger: the message ids of each entry are a JSON array of strings now.
  const ledger = db.prepare('SELECT id, message_ids FROM outbound_ledger').all() as Row[]
  const updLedger = db.prepare('UPDATE outbound_ledger SET message_ids = ? WHERE id = ?')
  for (const r of ledger) {
    const parsed = parseJson(String(r.message_ids))
    if (!parsed || !Array.isArray(parsed.value)) continue
    const ids = parsed.value.map((x: unknown) => storedId(x, legacyMsgId)).filter((x): x is string => x !== null)
    updLedger.run(JSON.stringify(ids), r.id)
  }

  // kv. The group id becomes the home id: a chat id string.
  const getKv = db.prepare('SELECT value FROM kv WHERE key = ?')
  const setKv = db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
  const delKv = db.prepare('DELETE FROM kv WHERE key = ?')
  const kvText = (key: string): string | undefined => {
    const v = getKv.get(key)?.value
    return v === undefined || v === null ? undefined : String(v)
  }
  const group = kvText('group-id')
  if (group !== undefined) {
    delKv.run('group-id')
    const home = storedId(group, legacyChatId)
    if (home !== null) setKv.run(KV.homeId, home)
  }

  // msgmap: [[messageId, entry]]. The entry's thread is converted; entry.key is a session key and stays.
  const msgmap = kvText(KV.msgmap)
  const msgmapParsed = msgmap === undefined ? null : parseJson(msgmap)
  if (msgmapParsed && Array.isArray(msgmapParsed.value)) {
    const out: unknown[] = []
    for (const item of msgmapParsed.value as unknown[]) {
      if (!Array.isArray(item) || item.length !== 2) {
        out.push(item)
        continue
      }
      const [rawId, entry] = item as [unknown, unknown]
      const id = storedId(rawId, legacyMsgId)
      if (id === null) continue
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const e = { ...(entry as Record<string, unknown>) }
        if (e.thread !== undefined && e.thread !== null) {
          const thread = storedId(e.thread, legacyMsgId)
          if (thread === null) delete e.thread
          else e.thread = thread
        }
        out.push([id, e])
      } else {
        out.push([id, entry])
      }
    }
    setKv.run(KV.msgmap, JSON.stringify(out))
  }

  // live-buttons: [{messageId, dm}]. Items whose message id has no form now are dropped.
  const live = kvText(KV.liveButtons)
  const liveParsed = live === undefined ? null : parseJson(live)
  if (liveParsed && Array.isArray(liveParsed.value)) {
    const out: unknown[] = []
    for (const item of liveParsed.value as unknown[]) {
      if (!item || typeof item !== 'object' || !('messageId' in item)) {
        out.push(item)
        continue
      }
      const id = storedId((item as { messageId: unknown }).messageId, legacyMsgId)
      if (id !== null) out.push({ ...(item as Record<string, unknown>), messageId: id })
    }
    setKv.run(KV.liveButtons, JSON.stringify(out))
  }

  // The logs topic's thread id (addon setting of the router's own scope): a number as text becomes a thread id.
  const logs = db.prepare("SELECT value FROM addon_settings WHERE addon = '_router' AND key = 'logs-thread'").get()
  if (logs) {
    const thread = storedId(logs.value, legacyMsgId)
    if (thread === null) db.exec("DELETE FROM addon_settings WHERE addon = '_router' AND key = 'logs-thread'")
    else db.prepare("UPDATE addon_settings SET value = ? WHERE addon = '_router' AND key = 'logs-thread'").run(thread)
  }
}, { destructive: true })

export const MIGRATIONS: readonly Migration[] = [MIGRATION_V1, MIGRATION_V2, MIGRATION_V3, MIGRATION_V4, MIGRATION_V5, MIGRATION_V6]

// node:sqlite prints an ExperimentalWarning on the Node versions this runs on. It is expected and not actionable,
// so only that one message is dropped while the module loads; every other warning passes through.
type NodeSqlite = typeof import('node:sqlite')
let sqliteModule: NodeSqlite | null = null
function loadSqlite(): NodeSqlite {
  if (sqliteModule) return sqliteModule
  const emit = process.emitWarning
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message
    if (/SQLite is an experimental feature/.test(text)) return
    return (emit as (...a: unknown[]) => void)(warning, ...rest)
  }) as typeof process.emitWarning
  try {
    sqliteModule = createRequire(import.meta.url)('node:sqlite') as NodeSqlite
  } finally {
    process.emitWarning = emit
  }
  return sqliteModule
}

// Session keys are numbers (pids) or strings (`cwd:...`). Stored with a one-letter kind so the two cannot collide.
function encodeKey(k: SessionKey): string {
  return typeof k === 'number' ? `n:${k}` : `s:${k}`
}
function decodeKey(text: string): SessionKey {
  return text.startsWith('n:') ? Number(text.slice(2)) : text.slice(2)
}

const bool = (b: boolean): number => (b ? 1 : 0)

// Runs `fn` in one transaction: commits on success, rolls back and rethrows on any error.
function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The failed statement may already have ended the transaction; the original error is the one to report.
    }
    throw e
  }
}

function currentVersion(db: DatabaseSync): number {
  const found = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()
  if (!found) return 0
  const row = db.prepare('SELECT schema_version AS v FROM meta').get()
  return row ? Number(row.v) : 0
}

// The database's main file path, or null for an in-memory database.
function mainFile(db: DatabaseSync): string | null {
  const row = db.prepare('PRAGMA database_list').all().find((r) => r.name === 'main')
  const file = row ? String(row.file) : ''
  return file === '' ? null : file
}

// Copies the database to `<file>.bak-v<from>` before a destructive step (VACUUM INTO, so it is consistent and runs
// outside a transaction). An existing backup of that version is kept as it is.
function backupBefore(db: DatabaseSync, from: number): void {
  const file = mainFile(db)
  if (file === null || from === 0) return
  const bak = `${file}.bak-v${from}`
  if (existsSync(bak)) return
  db.prepare('VACUUM INTO ?').run(bak)
  chmodSync(bak, 0o600)
}

// Applies each pending migration in its own transaction. The version is read again inside that transaction, under the
// write lock, so a second process that migrated first makes this step a no-op. A failing migration leaves the version
// where it was.
export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): number {
  const latest = migrations.length
  const newer = (v: number) => new Error(`database schema version ${v} is newer than this build (${latest})`)
  let from = currentVersion(db)
  if (from > latest) throw newer(from)
  // A file this run creates from nothing has no data to keep, so its own first steps are not backed up.
  const existing = from > 0
  while (from < latest) {
    const step = from
    if (migrations[step].destructive && existing) backupBefore(db, step)
    tx(db, () => {
      const now = currentVersion(db)
      if (now > latest) throw newer(now)
      if (now !== step) return
      migrations[step](db)
      db.prepare('DELETE FROM meta').run()
      db.prepare('INSERT INTO meta (schema_version) VALUES (?)').run(step + 1)
    })
    from = currentVersion(db)
  }
  return latest
}

// Opens the database file and migrates it (creating its folder, private mode). Shared by SqliteStore and the migration.
// `migrate: false` never writes: no journal mode change, no migration, no chmod. A file at another schema version then
// throws SchemaMismatchError, and a missing file throws (it is not created). A file that fails quick_check, or that
// SQLite cannot read, throws a corruption error (errcode SQLITE_CORRUPT or SQLITE_NOTADB).
export function openDatabase(
  path: string,
  migrations: readonly Migration[] = MIGRATIONS,
  options: { migrate?: boolean } = {},
): DatabaseSync {
  const memory = path === ':memory:'
  const migrating = options.migrate ?? true
  if (!memory) ensurePrivateDir(dirname(path))
  if (!memory && !existsSync(path)) {
    if (!migrating) throw new Error(`${path} does not exist`)
    // Created here, private, before SQLite opens it: SQLite gives its -wal and -shm files the same mode.
    closeSync(openSync(path, 'a', 0o600))
  }
  const { DatabaseSync: Db } = loadSqlite()
  const db = new Db(path)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    if (!memory) {
      const report = db.prepare('PRAGMA quick_check').all().map((r) => String(Object.values(r)[0]))
      if (report.length !== 1 || report[0] !== 'ok') {
        throw Object.assign(new Error(`stolik.db failed quick_check: ${report.join('; ')}`), { errcode: SQLITE_CORRUPT })
      }
    }
    if (migrating) {
      if (!memory) db.exec('PRAGMA journal_mode = WAL')
      migrate(db, migrations)
      if (!memory) chmodSync(path, 0o600)
    } else {
      const found = currentVersion(db)
      if (found !== migrations.length) throw new SchemaMismatchError(found, migrations.length)
    }
    return db
  } catch (e) {
    db.close()
    throw e
  }
}

// One value of the `kv` table read from an existing file without writing to it. Null when there is no file, no kv table
// yet (schema below v2), or no such key. Used by the migration's dry run. Opening a WAL database read-only creates empty
// `-wal` and `-shm` files. Only those this call created are removed again once it is closed (a WAL only when empty), and
// nothing is removed while the router holds its lock.
export function readKvReadOnly(path: string, key: string): string | null {
  if (!existsSync(path)) return null
  return withReadOnlyDb(path, (db) => {
    try {
      const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key)
      return row ? String(row.value) : null
    } catch {
      return null
    }
  })
}

// Runs fn on a database opened read-only, then removes the WAL sidecars this call created (see readKvReadOnly).
function withReadOnlyDb<T>(path: string, fn: (db: DatabaseSync) => T): T {
  const sidecars = [`${path}-wal`, `${path}-shm`]
  const created = sidecars.filter((p) => !existsSync(p))
  const { DatabaseSync: Db } = loadSqlite()
  const db = new Db(path, { readOnly: true })
  try {
    return fn(db)
  } finally {
    db.close()
    if (!routerLockHeld(dirname(path))) {
      for (const p of created) {
        try {
          // The shm index is rebuilt from the WAL, so it can go; a WAL with content holds data and stays.
          if (existsSync(p) && (p.endsWith('-shm') || statSync(p).size === 0)) rmSync(p)
        } catch {
          // Left in place: harmless, and the next writable open removes it.
        }
      }
    }
  }
}

// `PRAGMA integrity_check` of a database file, read-only (doctor). 'ok' when sound; otherwise the first problem found.
// Throws when the file is missing or cannot be opened.
export function integrityCheck(path: string): string {
  if (!existsSync(path)) throw new Error(`no database at ${path}`)
  return withReadOnlyDb(path, (db) => {
    const row = db.prepare('PRAGMA integrity_check').get()
    return row ? String(Object.values(row)[0]) : 'no result'
  })
}

// Read-only queries on an existing database file, for the CLI (doctor, trace). Nothing is migrated or written, so a
// database the running router still needs stays as it is. Every query answers the empty value when the file or the
// table is missing (a database older than the query needs).
export class ReadOnlyStore {
  private readonly path: string

  constructor(path: string) {
    this.path = path
  }

  private query<T>(fallback: T, fn: (db: DatabaseSync) => T): T {
    if (!existsSync(this.path)) return fallback
    try {
      return withReadOnlyDb(this.path, fn)
    } catch {
      return fallback
    }
  }

  // The schema version the file holds, or null (no file, or no meta table yet).
  schemaVersion(): number | null {
    return this.query<number | null>(null, (db) => {
      const row = db.prepare('SELECT schema_version AS v FROM meta').get()
      return row ? Number(row.v) : null
    })
  }

  getAddonSetting(addon: string, key: string): string | null {
    return this.query(null, (db) => {
      const row = db.prepare('SELECT value FROM addon_settings WHERE addon = ? AND key = ?').get(addon, key)
      return row ? String(row.value) : null
    })
  }

  // The home id; a file still at V5 has the group id (a number) instead.
  readGroupId(): ChatId | null {
    return this.query(null, (db) => {
      const kvValue = (key: string) => db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value
      return (storedId(kvValue(KV.homeId), legacyChatId) ?? storedId(kvValue('group-id'), legacyChatId)) as ChatId | null
    })
  }

  tracesForMessage(messageId: MessageId): TraceRecord[] {
    return this.query([], (db) =>
      db
        .prepare('SELECT message_id, dir, trace, at FROM trace_map WHERE message_id = ? ORDER BY at, rowid')
        .all(messageId)
        .map((r) => ({ messageId: String(r.message_id) as MessageId, dir: String(r.dir) as 'in' | 'out', trace: String(r.trace), at: Number(r.at) })),
    )
  }
}

// Moves a damaged database and its -wal and -shm sidecars aside (`<file>.corrupt-<timestamp>`, same folder). Returns the
// new main file path.
function quarantine(path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let target = `${path}.corrupt-${stamp}`
  for (let n = 2; existsSync(target); n++) target = `${path}.corrupt-${stamp}-${n}`
  renameSync(path, target)
  for (const side of ['-wal', '-shm']) {
    if (existsSync(path + side)) renameSync(path + side, target + side)
  }
  return target
}

export type SqliteStoreOptions = { migrations?: readonly Migration[]; migrate?: boolean }

export class SqliteStore implements StorePort, DbStorePort {
  private readonly db: DatabaseSync
  private readonly files: StoreFiles
  // Notices produced while opening (a recovered corrupt database). Empty on a normal start.
  readonly startupNotices: string[] = []

  constructor(paths: StorePaths, options: SqliteStoreOptions = {}) {
    ensurePrivateDir(paths.stateDir)
    const path = join(paths.stateDir, DB_FILE)
    const migrations = options.migrations ?? MIGRATIONS
    const migrating = options.migrate ?? true
    try {
      this.db = openDatabase(path, migrations, { migrate: migrating })
    } catch (e) {
      // Only a writing open recovers, and never while the router runs on this folder (it would lose its database).
      if (!migrating || !isCorruption(e) || !existsSync(path) || routerLockHeld(paths.stateDir)) throw e
      const moved = quarantine(path)
      this.startupNotices.push(
        `stolik.db could not be read (${(e as Error).message}). It was moved aside to ${moved} and a new, empty database was started.`,
      )
      this.db = openDatabase(path, migrations, { migrate: true })
    }
    this.files = new StoreFiles(paths)
  }

  // The schema version the file is at (after open, the latest of this build).
  schemaVersion(): number {
    return currentVersion(this.db)
  }

  close(): void {
    this.db.close()
  }

  // ---------- single values (StorePort) ----------

  private kvGet(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key)
    return row ? String(row.value) : null
  }

  private kvSet(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }

  private kvDelete(key: string): void {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key)
  }

  readMsgMap(): string {
    return this.kvGet(KV.msgmap) ?? ''
  }

  writeMsgMap(json: string): void {
    this.kvSet(KV.msgmap, json)
  }

  isLocked(): boolean {
    return this.kvGet(KV.locked) === '1'
  }

  setLocked(on: boolean): void {
    if (on) this.kvSet(KV.locked, '1')
    else this.kvDelete(KV.locked)
  }

  defaultModel(): string | null {
    return this.kvGet(KV.model)?.trim() || null
  }

  setDefaultModel(model: string | null): void {
    if (model !== null) this.kvSet(KV.model, model)
    else this.kvDelete(KV.model)
  }

  readLastBootId(): string | null {
    return this.kvGet(KV.bootId)?.trim() || null
  }

  writeBootId(bootId: string): void {
    this.kvSet(KV.bootId, bootId)
  }

  readGroupId(): ChatId | null {
    return storedId(this.kvGet(KV.homeId), legacyChatId) as ChatId | null
  }

  writeGroupId(id: ChatId): void {
    this.kvSet(KV.homeId, id)
  }

  // ---------- topics (StorePort text in, table rows) ----------

  // Messages the bot sent with a keyboard (JSON text). Stored as a key-value entry (StorePort).
  readLiveButtons(): string {
    return this.kvGet(KV.liveButtons) ?? ''
  }

  writeLiveButtons(json: string): void {
    this.kvSet(KV.liveButtons, json)
  }

  readTopics(): string {
    const list = this.listTopics()
    return list.length === 0 ? '' : serializeTopics(list)
  }

  // Folder-topic mutes (spec 24): one JSON value in the kv table.
  readMutes(): string {
    return this.kvGet(KV.mutes) ?? ''
  }

  writeMutes(json: string): void {
    this.kvSet(KV.mutes, json)
  }

  readPrivacyReported(): string {
    return this.kvGet(KV.privacyReported) ?? ''
  }

  writePrivacyReported(text: string): void {
    this.kvSet(KV.privacyReported, text)
  }

  // Replaces every topic row in one transaction. Text that is not a topic list reads as an empty list (parseTopics).
  writeTopics(json: string): void {
    const recs = parseTopics(json)
    tx(this.db, () => {
      this.db.prepare('DELETE FROM topics').run()
      for (const t of recs) this.upsertTopic(t)
    })
  }

  // ---------- files (StorePort, kept as files) ----------

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

  // ---------- sessions ----------

  listSessions(): SessionRecord[] {
    const rows = this.db
      .prepare(
        'SELECT key, name, project, cwd, pid, has_channel, connected, spawned, last_active, backend_session_id FROM sessions ORDER BY rowid',
      )
      .all()
    return rows.map((r) => ({
      key: decodeKey(String(r.key)),
      name: String(r.name),
      project: String(r.project),
      cwd: String(r.cwd),
      pid: r.pid === null ? null : Number(r.pid),
      hasChannel: Number(r.has_channel) === 1,
      connected: Number(r.connected) === 1,
      spawned: Number(r.spawned) === 1,
      lastActive: Number(r.last_active),
      backendSessionId: r.backend_session_id === null ? null : String(r.backend_session_id),
    }))
  }

  upsertSession(s: SessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO sessions (key, name, project, cwd, pid, has_channel, connected, spawned, last_active, backend_session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET name = excluded.name, project = excluded.project, cwd = excluded.cwd,
           pid = excluded.pid, has_channel = excluded.has_channel, connected = excluded.connected,
           spawned = excluded.spawned, last_active = excluded.last_active, backend_session_id = excluded.backend_session_id`,
      )
      .run(
        encodeKey(s.key), s.name, s.project, s.cwd, s.pid, bool(s.hasChannel), bool(s.connected), bool(s.spawned),
        s.lastActive, s.backendSessionId,
      )
  }

  deleteSession(key: SessionKey): void {
    this.db.prepare('DELETE FROM sessions WHERE key = ?').run(encodeKey(key))
  }

  replaceSessions(list: readonly SessionRecord[]): void {
    tx(this.db, () => {
      this.db.prepare('DELETE FROM sessions').run()
      for (const s of list) this.upsertSession(s)
    })
  }

  // ---------- topics (rows) ----------

  listTopics(): TopicRec[] {
    return this.db
      .prepare('SELECT thread_id, name, project, cwd, session_key, backend_session_id, state, ended_at, delete_at FROM topics ORDER BY rowid')
      .all()
      .map((r) => ({
        threadId: String(r.thread_id) as ThreadId,
        name: String(r.name),
        project: String(r.project),
        cwd: r.cwd === null ? null : String(r.cwd),
        sessionKey: r.session_key === null ? null : decodeKey(String(r.session_key)),
        backendSessionId: r.backend_session_id === null ? null : String(r.backend_session_id),
        state: String(r.state) as TopicState,
        endedAt: r.ended_at === null ? null : Number(r.ended_at),
        deleteAt: r.delete_at === null ? null : Number(r.delete_at),
      }))
  }

  upsertTopic(t: TopicRec): void {
    this.db
      .prepare(
        `INSERT INTO topics (thread_id, name, project, cwd, session_key, backend_session_id, state, ended_at, delete_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET name = excluded.name, project = excluded.project, cwd = excluded.cwd,
           session_key = excluded.session_key, backend_session_id = excluded.backend_session_id, state = excluded.state,
           ended_at = excluded.ended_at, delete_at = excluded.delete_at`,
      )
      .run(
        t.threadId, t.name, t.project, t.cwd, t.sessionKey === null ? null : encodeKey(t.sessionKey), t.backendSessionId, t.state,
        t.endedAt, t.deleteAt,
      )
  }

  deleteThread(threadId: ThreadId): void {
    this.db.prepare('DELETE FROM topics WHERE thread_id = ?').run(threadId)
  }

  // ---------- modes, ledger, addon settings, decisions ----------

  getModeThread(mode: string): ThreadId | null {
    const row = this.db.prepare('SELECT thread_id FROM mode_threads WHERE mode = ?').get(mode)
    return row ? (String(row.thread_id) as ThreadId) : null
  }

  setModeThread(mode: string, threadId: ThreadId): void {
    this.db
      .prepare('INSERT INTO mode_threads (mode, thread_id) VALUES (?, ?) ON CONFLICT (mode) DO UPDATE SET thread_id = excluded.thread_id')
      .run(mode, threadId)
  }

  listLedger(sessionKey: SessionKey): LedgerRecord[] {
    return this.db
      .prepare('SELECT session_key, key, body_key, source, at, message_ids FROM outbound_ledger WHERE session_key = ? ORDER BY id')
      .all(encodeKey(sessionKey))
      .map((r) => ({
        sessionKey: decodeKey(String(r.session_key)),
        key: String(r.key),
        bodyKey: String(r.body_key),
        source: String(r.source),
        at: Number(r.at),
        messageIds: JSON.parse(String(r.message_ids)) as MessageId[],
      }))
  }

  appendLedger(entries: readonly LedgerRecord[]): void {
    tx(this.db, () => {
      const stmt = this.db.prepare(
        'INSERT INTO outbound_ledger (session_key, key, body_key, source, at, message_ids) VALUES (?, ?, ?, ?, ?, ?)',
      )
      for (const e of entries) {
        stmt.run(encodeKey(e.sessionKey), e.key, e.bodyKey, e.source, e.at, JSON.stringify(e.messageIds))
      }
    })
  }

  // Deletes the ledger rows stamped before `olderThanMs` (epoch ms); returns how many went.
  pruneOutboundLedger(olderThanMs: number): number {
    return Number(this.db.prepare('DELETE FROM outbound_ledger WHERE at < ?').run(olderThanMs).changes)
  }

  getAddonSetting(addon: string, key: string): string | null {
    const row = this.db.prepare('SELECT value FROM addon_settings WHERE addon = ? AND key = ?').get(addon, key)
    return row ? String(row.value) : null
  }

  setAddonSetting(addon: string, key: string, value: string): void {
    this.db
      .prepare('INSERT INTO addon_settings (addon, key, value) VALUES (?, ?, ?) ON CONFLICT (addon, key) DO UPDATE SET value = excluded.value')
      .run(addon, key, value)
  }

  // ---------- trace map ----------

  recordTrace(r: TraceRecord): void {
    this.db
      .prepare('INSERT OR IGNORE INTO trace_map (message_id, dir, trace, at) VALUES (?, ?, ?, ?)')
      .run(r.messageId, r.dir, r.trace, r.at)
  }

  tracesForMessage(messageId: MessageId): TraceRecord[] {
    return this.db
      .prepare('SELECT message_id, dir, trace, at FROM trace_map WHERE message_id = ? ORDER BY at, rowid')
      .all(messageId)
      .map((r) => ({ messageId: String(r.message_id) as MessageId, dir: String(r.dir) as 'in' | 'out', trace: String(r.trace), at: Number(r.at) }))
  }

  pruneTraces(beforeMs: number): void {
    this.db.prepare('DELETE FROM trace_map WHERE at < ?').run(beforeMs)
  }

  listRouterDecisions(limit: number): RouterDecisionRecord[] {
    return this.db
      .prepare('SELECT at, chosen, confidence, outcome FROM router_decisions ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map((r) => ({
        at: Number(r.at),
        chosen: r.chosen === null ? null : String(r.chosen),
        confidence: r.confidence === null ? null : Number(r.confidence),
        outcome: String(r.outcome),
      }))
  }

  appendRouterDecision(d: RouterDecisionRecord): void {
    this.db
      .prepare('INSERT INTO router_decisions (at, chosen, confidence, outcome) VALUES (?, ?, ?, ?)')
      .run(d.at, d.chosen, d.confidence, d.outcome)
  }

  // ---------- usage ----------

  addUsage(u: UsageRecord): void {
    this.db
      .prepare('INSERT INTO usage (at, mode, cost_usd, duration_ms, outcome) VALUES (?, ?, ?, ?, ?)')
      .run(u.ts, u.mode, u.costUsd, u.durationMs, u.outcome)
  }

  listUsage(sinceMs: number): UsageRecord[] {
    return this.db
      .prepare('SELECT at, mode, cost_usd, duration_ms, outcome FROM usage WHERE at >= ? ORDER BY id')
      .all(sinceMs)
      .map((r) => ({
        ts: Number(r.at),
        mode: String(r.mode) as ModeName,
        costUsd: Number(r.cost_usd),
        durationMs: Number(r.duration_ms),
        outcome: String(r.outcome) as UsageRecord['outcome'],
      }))
  }

  pruneUsage(beforeMs: number, keep: number): void {
    tx(this.db, () => {
      this.db.prepare('DELETE FROM usage WHERE at < ?').run(beforeMs)
      this.db.prepare('DELETE FROM usage WHERE id NOT IN (SELECT id FROM usage ORDER BY id DESC LIMIT ?)').run(keep)
    })
  }
}
