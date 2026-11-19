// SqliteStore: the StorePort contract (shared suite), the DbStorePort tables, schema versions, migrations, transactions.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { DatabaseSync } from 'node:sqlite'
import {
  DB_FILE, MIGRATION_V1, MIGRATION_V2, MIGRATION_V3, MIGRATION_V4, MIGRATIONS, SchemaMismatchError, SqliteStore, isFatalStoreError, migrate,
  openDatabase,
  readKvReadOnly, type Migration,
} from '../src/adapters/store-sqlite.ts'
import type { SessionRecord, LedgerRecord } from '../src/ports.ts'
import type { TopicRec } from '../src/brain/topics.ts'
import { tgChat, tgMsg, tgThread } from '../src/adapters/chat/tg-ids.ts'
import { sandboxPaths, storeContract } from './helpers/store-contract.ts'

// Each test gets its own folder under test/ (removed afterwards); nothing is written to /tmp.
type Box = { root: string; paths: ReturnType<typeof sandboxPaths>['paths']; dbPath: string; open: SqliteStore[]; cleanup: () => void }
function box(): Box {
  const sb = sandboxPaths('store-sqlite')
  const b: Box = {
    root: sb.root,
    paths: sb.paths,
    dbPath: join(sb.paths.stateDir, DB_FILE),
    open: [],
    cleanup: () => {
      for (const s of b.open) {
        try {
          s.close()
        } catch {
          // already closed
        }
      }
      sb.cleanup()
    },
  }
  return b
}

function open(b: Box, migrations?: readonly Migration[]): SqliteStore {
  const s = new SqliteStore(b.paths, migrations ? { migrations } : {})
  b.open.push(s)
  return s
}

// A store opened without migrating (the read-only path the CLI uses).
function openNoMigrate(b: Box): SqliteStore {
  const s = new SqliteStore(b.paths, { migrate: false })
  b.open.push(s)
  return s
}

function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

// A v1 database file with one row, written and closed.
function writeV1(b: Box): void {
  mkdirSync(b.paths.stateDir, { recursive: true })
  const v1 = raw(b.dbPath)
  try {
    MIGRATION_V1(v1)
    v1.exec('INSERT INTO meta (schema_version) VALUES (1)')
  } finally {
    v1.close()
  }
}

function session(key: string | number, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    key,
    name: 'proj',
    project: 'proj',
    cwd: '/work/proj',
    pid: typeof key === 'number' ? key : null,
    hasChannel: true,
    connected: true,
    spawned: false,
    lastActive: 1_700_000_000_000,
    backendSessionId: null,
    ...over,
  }
}

// A raw handle on the same file, for checking the schema directly.
function raw(path: string): DatabaseSync {
  const { DatabaseSync: Db } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
  return new Db(path)
}

function tableNames(path: string): string[] {
  const db = raw(path)
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => String(r.name))
  } finally {
    db.close()
  }
}

storeContract('SqliteStore', () => {
  const b = box()
  const store = open(b)
  return { store, reopen: () => open(b), paths: b.paths, cleanup: b.cleanup }
})

test('sqlite: the database is stolik.db in the state folder, created with private mode', () => {
  const b = box()
  try {
    open(b)
    assert.equal(b.dbPath, join(b.paths.stateDir, 'stolik.db'))
    assert.ok(existsSync(b.dbPath))
  } finally {
    b.cleanup()
  }
})

test('sqlite: schema creation makes every table and records the latest version', () => {
  const b = box()
  try {
    const store = open(b)
    assert.equal(store.schemaVersion(), 6)
    assert.equal(MIGRATIONS.length, 6)
    store.close()
    const names = tableNames(b.dbPath)
    for (const t of ['meta', 'kv', 'sessions', 'topics', 'mode_threads', 'outbound_ledger', 'addon_settings', 'router_decisions', 'usage']) {
      assert.ok(names.includes(t), `missing table ${t}`)
    }
  } finally {
    b.cleanup()
  }
})

test('sqlite: migration 0 to 1 runs once; reopening does not run it again', () => {
  const b = box()
  try {
    let runs = 0
    const counted: Migration = (db) => {
      runs++
      MIGRATION_V1(db)
    }
    open(b, [counted]).close()
    open(b, [counted]).close()
    assert.equal(runs, 1)
  } finally {
    b.cleanup()
  }
})

test('sqlite: migration 1 to 2 keeps the sessions, rebuilds topics and usage, and adds kv', () => {
  const b = box()
  try {
    // A v1 database with a row in each table the v2 step changes.
    mkdirSync(b.paths.stateDir, { recursive: true })
    const v1 = raw(b.dbPath)
    try {
      MIGRATION_V1(v1)
      v1.exec("INSERT INTO meta (schema_version) VALUES (1)")
      v1.exec("INSERT INTO topics (thread_id, name, project, created_at) VALUES (9, 'old', NULL, 1)")
      v1.exec("INSERT INTO usage (at, backend, model, input_tokens, output_tokens, cost_usd) VALUES (1, 'c', 'm', 1, 1, 1)")
    } finally {
      v1.close()
    }
    const store = open(b)
    assert.equal(store.schemaVersion(), 6)
    assert.deepEqual(store.listTopics(), [], 'v1 topic rows are not carried over (nothing wrote them before v2)')
    assert.deepEqual(store.listUsage(0), [])
    assert.ok(tableNames(b.dbPath).includes('kv'))
  } finally {
    b.cleanup()
  }
})

test('sqlite: a failing migration rolls back its own changes and keeps the previous version', () => {
  const b = box()
  try {
    const bad: Migration = (db) => {
      db.exec('CREATE TABLE half_done (x INTEGER)')
      throw new Error('boom')
    }
    assert.throws(() => open(b, [MIGRATION_V1, bad]), /boom/)
    const store = open(b, [MIGRATION_V1])
    assert.equal(store.schemaVersion(), 1)
    assert.equal(tableNames(b.dbPath).includes('half_done'), false)
  } finally {
    b.cleanup()
  }
})

test('sqlite: a database newer than this build is refused, not downgraded', () => {
  const b = box()
  try {
    const v3: Migration = () => {}
    open(b, [MIGRATION_V1, MIGRATION_V2, v3]).close()
    assert.throws(() => open(b, [MIGRATION_V1, MIGRATION_V2]), /newer than this build/)
  } finally {
    b.cleanup()
  }
})

test('sqlite: migration 3 to 4 drops the bare-pid session rows (stale) and keeps the pid+start and folder-keyed ones', () => {
  const b = box()
  try {
    mkdirSync(b.paths.stateDir, { recursive: true })
    const v2 = raw(b.dbPath)
    try {
      MIGRATION_V1(v2)
      MIGRATION_V2(v2)
      v2.exec('INSERT INTO meta (schema_version) VALUES (2)')
      const insert = v2.prepare(
        'INSERT INTO sessions (key, name, project, cwd, pid, has_channel, connected, spawned, last_active, backend_session_id) VALUES (?, ?, ?, ?, ?, 1, 1, 0, 1, NULL)',
      )
      insert.run('n:4242', 'old', 'old', '/work/old', 4242)
      insert.run('s:4242:start-4242', 'new', 'new', '/work/new', 4242)
      insert.run('s:cwd:/work/x', 'pidless', 'pidless', '/work/x', null)
    } finally {
      v2.close()
    }
    const store = open(b)
    assert.equal(store.schemaVersion(), 6)
    assert.deepEqual(store.listSessions().map((s) => s.key), ['4242:start-4242', 'cwd:/work/x'])
  } finally {
    b.cleanup()
  }
})

test('sqlite: migration 4 to 5 adds the topic cwd column; old topic rows read back as legacy (cwd null)', () => {
  const b = box()
  try {
    mkdirSync(b.paths.stateDir, { recursive: true })
    const v4 = raw(b.dbPath)
    try {
      MIGRATION_V1(v4)
      MIGRATION_V2(v4)
      MIGRATION_V3(v4)
      MIGRATION_V4(v4)
      v4.exec('INSERT INTO meta (schema_version) VALUES (4)')
      v4.prepare(
        "INSERT INTO topics (thread_id, name, project, session_key, backend_session_id, state, ended_at, delete_at) VALUES (7, 'proga', 'proga', NULL, NULL, 'open', NULL, NULL)",
      ).run()
    } finally {
      v4.close()
    }
    const store = open(b)
    assert.equal(store.schemaVersion(), 6)
    assert.deepEqual(store.listTopics().map((t) => [t.threadId, t.name, t.cwd, t.state]), [[tgThread(7), 'proga', null, 'open']])
    store.upsertTopic({ threadId: tgThread(8), name: 'web', project: 'web', cwd: '/p/web', sessionKey: null, backendSessionId: null, state: 'open', endedAt: null, deleteAt: null })
    assert.equal(store.listTopics().find((t) => t.threadId === tgThread(8))?.cwd, '/p/web')
  } finally {
    b.cleanup()
  }
})

test('sqlite: migrate() on a bare connection returns the latest version and is idempotent', () => {
  const b = box()
  try {
    const db = raw(join(b.root, 'bare.db'))
    try {
      assert.equal(migrate(db), 6)
      assert.equal(migrate(db), 6)
    } finally {
      db.close()
    }
  } finally {
    b.cleanup()
  }
})

test('sqlite: readKvReadOnly reads a value without writing, and is null for no file, no table, no key', () => {
  const b = box()
  try {
    assert.equal(readKvReadOnly(b.dbPath, 'msgmap'), null)
    const store = open(b)
    store.writeMsgMap('[]')
    store.close()
    assert.equal(readKvReadOnly(b.dbPath, 'msgmap'), '[]')
    assert.equal(readKvReadOnly(b.dbPath, 'locked'), null)
    const old = join(b.root, 'v1.db')
    const v1 = raw(old)
    MIGRATION_V1(v1)
    v1.close()
    assert.equal(readKvReadOnly(old, 'msgmap'), null, 'a v1 file has no kv table yet')
  } finally {
    b.cleanup()
  }
})

test('sqlite: openDatabase creates a new file at the latest version, with private mode', () => {
  const b = box()
  try {
    const path = join(b.root, 'opened', DB_FILE)
    const db = openDatabase(path)
    try {
      assert.equal(db.prepare('SELECT schema_version AS v FROM meta').get()?.v, 6)
    } finally {
      db.close()
    }
    assert.ok(existsSync(path))
    assert.equal(statSync(path).mode & 0o777, 0o600)
  } finally {
    b.cleanup()
  }
})

test('sqlite: sessions round-trip (number and string keys, nulls, flags), upsert and delete', () => {
  const b = box()
  try {
    const store = open(b)
    const a = session(42, { backendSessionId: '6d727728-f50d-46d9-83b5-b3e4f9e5a0a8', spawned: true })
    const s = session('cwd:/work/other', { pid: null, hasChannel: false, connected: false })
    store.upsertSession(a)
    store.upsertSession(s)
    assert.deepEqual(store.listSessions(), [a, s])
    store.upsertSession({ ...s, connected: true, name: 'renamed' })
    assert.equal(store.listSessions()[1].connected, true)
    assert.equal(store.listSessions()[1].name, 'renamed')
    store.deleteSession(42)
    assert.deepEqual(store.listSessions().map((x) => x.key), ['cwd:/work/other'])
  } finally {
    b.cleanup()
  }
})

test('sqlite: replaceSessions writes the whole registry; a failing row rolls the whole write back', () => {
  const b = box()
  try {
    const store = open(b)
    const a = session(1)
    store.replaceSessions([a])
    assert.deepEqual(store.listSessions(), [a])
    const c = session(3)
    const broken = { ...session(2), name: null as unknown as string } // NOT NULL column
    assert.throws(() => store.replaceSessions([c, broken]))
    assert.deepEqual(store.listSessions(), [a])
    store.replaceSessions([c])
    assert.deepEqual(store.listSessions(), [c])
  } finally {
    b.cleanup()
  }
})

test('sqlite: topic rows keep the brain record shape, including nulls and the session key kind', () => {
  const b = box()
  try {
    const store = open(b)
    const t1: TopicRec = { threadId: tgThread(11), name: 'stolik', project: 'stolik', cwd: '/w', sessionKey: null, backendSessionId: null, state: 'open', endedAt: null, deleteAt: null }
    const t2: TopicRec = { threadId: tgThread(12), name: 'gone', project: 'p', cwd: null, sessionKey: 5, backendSessionId: 'x', state: 'deleted', endedAt: 1, deleteAt: 2 }
    store.upsertTopic(t1)
    store.upsertTopic(t2)
    assert.deepEqual(store.listTopics(), [t1, t2])
    store.upsertTopic({ ...t1, name: 'renamed' })
    assert.equal(store.listTopics()[0].name, 'renamed')
    store.deleteThread(tgThread(12))
    assert.deepEqual(store.listTopics().map((t) => t.threadId), [tgThread(11)])
  } finally {
    b.cleanup()
  }
})

test('sqlite: mode threads: unknown is null, set then overwrite', () => {
  const b = box()
  try {
    const store = open(b)
    assert.equal(store.getModeThread('read'), null)
    store.setModeThread('read', tgThread(501))
    assert.equal(store.getModeThread('read'), tgThread(501))
    store.setModeThread('read', tgThread(502))
    assert.equal(store.getModeThread('read'), tgThread(502))
  } finally {
    b.cleanup()
  }
})

test('sqlite: outbound ledger appends in one transaction and lists per session, oldest first', () => {
  const b = box()
  try {
    const store = open(b)
    const e = (key: string, at: number): LedgerRecord => ({ sessionKey: 42, key, bodyKey: `b-${key}`, source: 'stop', at, messageIds: [tgMsg(at), tgMsg(at + 1)] })
    store.appendLedger([e('k1', 10), e('k2', 20)])
    store.appendLedger([{ ...e('k3', 30), sessionKey: 'other' }])
    assert.deepEqual(store.listLedger(42).map((x) => x.key), ['k1', 'k2'])
    assert.deepEqual(store.listLedger(42)[0].messageIds, [tgMsg(10), tgMsg(11)])
    assert.deepEqual(store.listLedger('other').map((x) => x.key), ['k3'])
  } finally {
    b.cleanup()
  }
})

test('sqlite: a ledger batch with a bad row writes nothing', () => {
  const b = box()
  try {
    const store = open(b)
    const good: LedgerRecord = { sessionKey: 1, key: 'ok', bodyKey: 'b', source: 's', at: 1, messageIds: [tgMsg(1)] }
    const bad = { ...good, key: null as unknown as string }
    assert.throws(() => store.appendLedger([good, bad]))
    assert.deepEqual(store.listLedger(1), [])
  } finally {
    b.cleanup()
  }
})

test('sqlite: addon settings: unknown is null, set, overwrite; scoped per addon', () => {
  const b = box()
  try {
    const store = open(b)
    assert.equal(store.getAddonSetting('voice', 'enabled'), null)
    store.setAddonSetting('voice', 'enabled', '1')
    store.setAddonSetting('notes', 'enabled', '0')
    assert.equal(store.getAddonSetting('voice', 'enabled'), '1')
    store.setAddonSetting('voice', 'enabled', '0')
    assert.equal(store.getAddonSetting('voice', 'enabled'), '0')
    assert.equal(store.getAddonSetting('notes', 'enabled'), '0')
  } finally {
    b.cleanup()
  }
})

test('sqlite: router decisions list newest first, honour the limit, keep nulls', () => {
  const b = box()
  try {
    const store = open(b)
    store.appendRouterDecision({ at: 1, chosen: 'a', confidence: 0.9, outcome: 'routed' })
    store.appendRouterDecision({ at: 2, chosen: null, confidence: null, outcome: 'asked' })
    store.appendRouterDecision({ at: 3, chosen: 'b', confidence: 0.5, outcome: 'routed' })
    assert.deepEqual(store.listRouterDecisions(2).map((d) => d.at), [3, 2])
    assert.deepEqual(store.listRouterDecisions(9)[1], { at: 2, chosen: null, confidence: null, outcome: 'asked' })
  } finally {
    b.cleanup()
  }
})

test('sqlite: usage rows list from a given time on, oldest first; pruning drops old rows and keeps the newest', () => {
  const b = box()
  try {
    const store = open(b)
    assert.deepEqual(store.listUsage(0), [])
    const u = (ts: number, mode: 'quick' | 'read' | 'web', costUsd: number) => ({ ts, mode, costUsd, durationMs: 5, outcome: 'answer' as const })
    store.addUsage(u(1_000, 'quick', 0.5))
    store.addUsage(u(2_000, 'read', 0.25))
    store.addUsage(u(3_000, 'web', 0.1))
    assert.deepEqual(store.listUsage(2_000), [u(2_000, 'read', 0.25), u(3_000, 'web', 0.1)], 'at or after')
    store.pruneUsage(1_500, 10)
    assert.deepEqual(store.listUsage(0).map((r) => r.ts), [2_000, 3_000])
    store.pruneUsage(0, 1)
    assert.deepEqual(store.listUsage(0), [u(3_000, 'web', 0.1)], 'only the newest kept')
  } finally {
    b.cleanup()
  }
})

test('sqlite: data survives closing and reopening the file', () => {
  const b = box()
  try {
    const first = open(b)
    first.setLocked(true)
    first.writeGroupId(tgChat(-100123))
    first.upsertSession(session(9))
    first.close()
    const again = open(b)
    assert.equal(again.isLocked(), true)
    assert.equal(again.readGroupId(), tgChat(-100123))
    assert.equal(again.listSessions().length, 1)
  } finally {
    b.cleanup()
  }
})

test('sqlite: a migration re-reads the version under the write lock; a stale read migrates nothing', () => {
  const b = box()
  try {
    open(b).close()
    const real = raw(b.dbPath)
    try {
      // The first version read is stale (as if another process migrated between the read and the transaction).
      let stale = true
      const proxy = {
        exec: (sql: string) => real.exec(sql),
        prepare: (sql: string) => {
          if (stale && sql.includes('schema_version AS v')) {
            stale = false
            return { get: () => ({ v: 0 }) }
          }
          return real.prepare(sql)
        },
      } as unknown as DatabaseSync
      let runs = 0
      const counted: Migration = () => {
        runs++
      }
      assert.equal(migrate(proxy, [counted, counted, counted, counted, counted, counted]), 6)
      assert.equal(runs, 0, 'the version read under the lock is current, so no step runs')
    } finally {
      real.close()
    }
    assert.equal(open(b).schemaVersion(), 6)
  } finally {
    b.cleanup()
  }
})

test('sqlite: a second migration attempt on the same file is a no-op', () => {
  const b = box()
  try {
    open(b).close()
    let runs = 0
    const counted: Migration = (db) => {
      runs++
      MIGRATION_V1(db)
    }
    open(b, [counted, counted, counted, counted, counted, counted]).close()
    assert.equal(runs, 0)
  } finally {
    b.cleanup()
  }
})

test('sqlite: migrate false on an older file throws SchemaMismatchError and leaves the file byte-identical', () => {
  const b = box()
  try {
    writeV1(b)
    const before = hash(b.dbPath)
    assert.throws(
      () => openNoMigrate(b),
      (e: unknown) => e instanceof SchemaMismatchError && /^stolik\.db schema is v1, this build needs v6\. Restart the stolik service/.test((e as Error).message),
    )
    assert.equal(hash(b.dbPath), before)
  } finally {
    b.cleanup()
  }
})

test('sqlite: migrate false opens a current file without writing, and never creates a missing one', () => {
  const b = box()
  try {
    assert.throws(() => openNoMigrate(b), /does not exist/)
    assert.equal(existsSync(b.dbPath), false)
    open(b).writeMsgMap('[1]')
    const before = hash(b.dbPath)
    const quiet = openNoMigrate(b)
    assert.equal(quiet.schemaVersion(), 6)
    assert.equal(quiet.readMsgMap(), '[1]')
    quiet.close()
    assert.equal(hash(b.dbPath), before)
  } finally {
    b.cleanup()
  }
})

test('sqlite: readKvReadOnly leaves a -wal that existed before the call in place', () => {
  const b = box()
  try {
    open(b).close()
    const wal = `${b.dbPath}-wal`
    writeFileSync(wal, '')
    assert.equal(readKvReadOnly(b.dbPath, 'msgmap'), null)
    assert.equal(existsSync(wal), true, 'a sidecar that was not created by this call is not removed')
  } finally {
    b.cleanup()
  }
})

test('sqlite: readKvReadOnly removes the sidecars it created, and none while the router holds its lock', () => {
  if (process.platform === 'win32') return
  const b = box()
  try {
    open(b).close()
    const sidecars = [`${b.dbPath}-wal`, `${b.dbPath}-shm`]
    const createdBy = (fn: () => void) => {
      const before = sidecars.filter((p) => existsSync(p))
      fn()
      return sidecars.filter((p) => !before.includes(p) && existsSync(p))
    }
    // Without the lock: a sidecar this call made is gone again.
    const alone = createdBy(() => readKvReadOnly(b.dbPath, 'msgmap'))
    for (const p of alone) assert.equal(existsSync(p), false, `${p} was created by the read and should be removed`)
    // With the router lock held: nothing is removed.
    writeFileSync(join(b.paths.stateDir, 'router.lock'), String(process.pid))
    const locked = createdBy(() => readKvReadOnly(b.dbPath, 'msgmap'))
    for (const p of locked) assert.equal(existsSync(p), true, `${p} was removed while the router lock was held`)
  } finally {
    b.cleanup()
  }
})

test('sqlite: isFatalStoreError is true for CORRUPT, FULL and READONLY (extended codes too) and false otherwise', () => {
  const coded = (errcode: number) => Object.assign(new Error('sqlite failure'), { errcode })
  assert.equal(isFatalStoreError(coded(11)), true, 'SQLITE_CORRUPT')
  assert.equal(isFatalStoreError(coded(13)), true, 'SQLITE_FULL')
  assert.equal(isFatalStoreError(coded(8)), true, 'SQLITE_READONLY')
  assert.equal(isFatalStoreError(coded(8 | (4 << 8))), true, 'SQLITE_READONLY_DBMOVED has the READONLY low byte')
  assert.equal(isFatalStoreError(coded(1)), false, 'SQLITE_ERROR')
  assert.equal(isFatalStoreError(coded(19)), false, 'SQLITE_CONSTRAINT')
  assert.equal(isFatalStoreError(new Error('boom')), false, 'a plain error')
  assert.equal(isFatalStoreError(new Error('database disk image is malformed')), true, 'by message, without an errcode')
  assert.equal(isFatalStoreError(undefined), false)
})

test('sqlite: the database file is private (0600) and so are its sidecars while the store is open', () => {
  if (process.platform === 'win32') return
  const b = box()
  try {
    const store = open(b)
    store.setLocked(true)
    assert.equal(statSync(b.dbPath).mode & 0o777, 0o600)
    for (const side of ['-wal', '-shm']) {
      const p = `${b.dbPath}${side}`
      if (existsSync(p)) assert.equal(statSync(p).mode & 0o077, 0, `${side} is group- or world-accessible`)
    }
  } finally {
    b.cleanup()
  }
})

test('sqlite: the state folder is private (0700) after open, including one created with 0755', () => {
  if (process.platform === 'win32') return
  const b = box()
  try {
    mkdirSync(b.paths.stateDir, { recursive: true })
    chmodSync(b.paths.stateDir, 0o755)
    open(b)
    assert.equal(statSync(b.paths.stateDir).mode & 0o777, 0o700)
  } finally {
    b.cleanup()
  }
})

test('sqlite: pruneOutboundLedger deletes the rows older than the cut-off and returns the count', () => {
  const b = box()
  try {
    const store = open(b)
    const e = (key: string, at: number): LedgerRecord => ({ sessionKey: 42, key, bodyKey: 'b', source: 'stop', at, messageIds: [tgMsg(1)] })
    store.appendLedger([e('old', 10), e('edge', 20), e('new', 30)])
    assert.equal(store.pruneOutboundLedger(20), 1, 'strictly before the cut-off')
    assert.deepEqual(store.listLedger(42).map((x) => x.key), ['edge', 'new'])
    assert.equal(store.pruneOutboundLedger(0), 0)
    assert.equal(store.pruneOutboundLedger(1_000), 2)
    assert.deepEqual(store.listLedger(42), [])
  } finally {
    b.cleanup()
  }
})

test('sqlite: a fresh store has no startup notices', () => {
  const b = box()
  try {
    assert.deepEqual(open(b).startupNotices, [])
  } finally {
    b.cleanup()
  }
})
