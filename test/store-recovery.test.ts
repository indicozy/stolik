// SqliteStore recovery: a damaged database is moved aside and replaced, a destructive migration keeps a backup, and the
// router lock blocks any move. Each test runs in its own folder under test/ (removed afterwards).
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync, writeSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { DB_FILE, MIGRATION_V1, SqliteStore } from '../src/adapters/store-sqlite.ts'
import { sandboxPaths } from './helpers/store-contract.ts'

function raw(path: string): DatabaseSync {
  const { DatabaseSync: Db } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
  return new Db(path)
}

// A healthy database with one kv row, closed.
function healthyDb(paths: ReturnType<typeof sandboxPaths>['paths']): void {
  const store = new SqliteStore(paths)
  store.writeMsgMap('[7]')
  store.close()
}

// Overwrites bytes in the first page's b-tree header so SQLite reports the file as malformed.
function damage(dbPath: string): void {
  const fd = openSync(dbPath, 'r+')
  try {
    writeSync(fd, Buffer.alloc(16, 0xff), 0, 16, 100)
  } finally {
    closeSync(fd)
  }
}

test('recovery: a garbage file at the database path is moved aside, a fresh database opens, and a notice names the moved file', () => {
  const box = sandboxPaths('store-recovery-garbage')
  try {
    mkdirSync(box.paths.stateDir, { recursive: true })
    const dbPath = join(box.paths.stateDir, DB_FILE)
    writeFileSync(dbPath, 'this is not a database '.repeat(50))
    const store = new SqliteStore(box.paths)
    try {
      assert.equal(store.schemaVersion(), 6)
      assert.equal(store.startupNotices.length, 1)
      const moved = readdirSync(box.paths.stateDir).find((f) => /^stolik\.db\.corrupt-/.test(f))
      assert.ok(moved, 'the damaged file is kept under stolik.db.corrupt-<timestamp>')
      assert.ok(store.startupNotices[0].includes(join(box.paths.stateDir, moved)), 'the notice names the moved file')
      assert.equal(readFileSync(join(box.paths.stateDir, moved), 'utf8'), 'this is not a database '.repeat(50))
      store.writeMsgMap('[1]')
      assert.equal(store.readMsgMap(), '[1]')
    } finally {
      store.close()
    }
  } finally {
    box.cleanup()
  }
})

test('recovery: a database that fails quick_check is moved aside; a stale -wal does not reach the fresh database', () => {
  const box = sandboxPaths('store-recovery-quick')
  try {
    mkdirSync(box.paths.stateDir, { recursive: true })
    const dbPath = join(box.paths.stateDir, DB_FILE)
    healthyDb(box.paths)
    damage(dbPath)
    writeFileSync(`${dbPath}-wal`, 'stale wal')
    const store = new SqliteStore(box.paths)
    try {
      assert.equal(store.startupNotices.length, 1)
      const moved = readdirSync(box.paths.stateDir).find((f) => /^stolik\.db\.corrupt-/.test(f) && !/-(wal|shm)$/.test(f))
      assert.ok(moved, 'the damaged database is kept aside')
      assert.equal(store.readMsgMap(), '', 'the fresh database starts empty')
    } finally {
      store.close()
    }
  } finally {
    box.cleanup()
  }
})

test('recovery: a healthy database is not moved and records no notice', () => {
  const box = sandboxPaths('store-recovery-healthy')
  try {
    mkdirSync(box.paths.stateDir, { recursive: true })
    healthyDb(box.paths)
    const store = new SqliteStore(box.paths)
    try {
      assert.deepEqual(store.startupNotices, [])
      assert.equal(store.readMsgMap(), '[7]')
      assert.equal(readdirSync(box.paths.stateDir).some((f) => f.includes('.corrupt-')), false)
    } finally {
      store.close()
    }
  } finally {
    box.cleanup()
  }
})

test('recovery: migrate false never moves a damaged database; the file stays as it was', () => {
  const box = sandboxPaths('store-recovery-nomigrate')
  try {
    mkdirSync(box.paths.stateDir, { recursive: true })
    const dbPath = join(box.paths.stateDir, DB_FILE)
    writeFileSync(dbPath, 'not a database at all '.repeat(40))
    assert.throws(() => new SqliteStore(box.paths, { migrate: false }))
    assert.equal(readFileSync(dbPath, 'utf8'), 'not a database at all '.repeat(40))
    assert.equal(readdirSync(box.paths.stateDir).some((f) => f.includes('.corrupt-')), false)
  } finally {
    box.cleanup()
  }
})

test('recovery: a live router lock blocks the move; the open error is thrown', () => {
  const box = sandboxPaths('store-recovery-locked')
  try {
    mkdirSync(box.paths.stateDir, { recursive: true })
    const dbPath = join(box.paths.stateDir, DB_FILE)
    writeFileSync(dbPath, 'garbage '.repeat(100))
    writeFileSync(join(box.paths.stateDir, 'router.lock'), String(process.pid))
    assert.throws(() => new SqliteStore(box.paths))
    assert.equal(existsSync(dbPath), true, 'the file is not moved while the router runs')
  } finally {
    box.cleanup()
  }
})

test('backup: a destructive migration copies the database to stolik.db.bak-v<from> first', () => {
  const box = sandboxPaths('store-recovery-bak')
  try {
    mkdirSync(box.paths.stateDir, { recursive: true })
    const dbPath = join(box.paths.stateDir, DB_FILE)
    const v1 = raw(dbPath)
    try {
      MIGRATION_V1(v1)
      v1.exec('INSERT INTO meta (schema_version) VALUES (1)')
      v1.exec("INSERT INTO usage (at, backend, model, input_tokens, output_tokens, cost_usd) VALUES (5, 'c', 'm', 1, 1, 1)")
    } finally {
      v1.close()
    }
    const store = new SqliteStore(box.paths)
    store.close()
    const bak = `${dbPath}.bak-v1`
    assert.equal(existsSync(bak), true)
    assert.equal(statSync(bak).mode & 0o777, 0o600)
    const old = raw(bak)
    try {
      assert.equal(old.prepare('SELECT schema_version AS v FROM meta').get()?.v, 1)
      assert.equal(old.prepare('SELECT count(*) AS n FROM usage').get()?.n, 1, 'the backup keeps the rows the step drops')
    } finally {
      old.close()
    }
  } finally {
    box.cleanup()
  }
})

test('backup: an existing backup of that version is kept as it is', () => {
  const box = sandboxPaths('store-recovery-bak-kept')
  try {
    mkdirSync(box.paths.stateDir, { recursive: true })
    const dbPath = join(box.paths.stateDir, DB_FILE)
    const v1 = raw(dbPath)
    try {
      MIGRATION_V1(v1)
      v1.exec('INSERT INTO meta (schema_version) VALUES (1)')
    } finally {
      v1.close()
    }
    writeFileSync(`${dbPath}.bak-v1`, 'earlier backup')
    new SqliteStore(box.paths).close()
    assert.equal(readFileSync(`${dbPath}.bak-v1`, 'utf8'), 'earlier backup')
  } finally {
    box.cleanup()
  }
})

test('backup: a new database and a non-destructive step leave no backup file', () => {
  const box = sandboxPaths('store-recovery-no-bak')
  try {
    new SqliteStore(box.paths).close()
    assert.equal(readdirSync(box.paths.stateDir).some((f) => f.includes('.bak-')), false)
  } finally {
    box.cleanup()
  }
})
