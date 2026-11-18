// The trace map and the read-only view of the store (src/adapters/store-sqlite.ts), the integrity check the doctor runs,
// and the per-chat queue depths for /debug.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DB_FILE, MIGRATION_V1, MIGRATION_V2, MIGRATIONS, ReadOnlyStore, SqliteStore, integrityCheck, openDatabase } from '../src/adapters/store-sqlite.ts'
import { OutboundQueues } from '../src/brain/outbound-queue.ts'
import { ISOLATED_ROOT } from './helpers/isolate.ts'
import { tgChat, tgMsg } from '../src/adapters/chat/tg-ids.ts'

function fresh(label: string): { dir: string; path: string } {
  const dir = join(ISOLATED_ROOT, `store-${label}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return { dir, path: join(dir, DB_FILE) }
}

const open = (dir: string) => new SqliteStore({ stateDir: dir, inboxDir: join(dir, 'inbox'), notesDir: join(dir, 'notes') })

test('trace map: records for in and out, ordered by time; a repeat is ignored', () => {
  const { dir } = fresh('map')
  const s = open(dir)
  try {
    assert.equal(s.schemaVersion(), 6)
    s.recordTrace({ messageId: tgMsg(10), dir: 'in', trace: 'a1b2c3d4', at: 100 })
    s.recordTrace({ messageId: tgMsg(10), dir: 'out', trace: 'a1b2c3d4', at: 200 })
    s.recordTrace({ messageId: tgMsg(10), dir: 'in', trace: 'a1b2c3d4', at: 300 })
    s.recordTrace({ messageId: tgMsg(11), dir: 'in', trace: 'ffffffff', at: 150 })
    assert.deepEqual(s.tracesForMessage(tgMsg(10)), [
      { messageId: tgMsg(10), dir: 'in', trace: 'a1b2c3d4', at: 100 },
      { messageId: tgMsg(10), dir: 'out', trace: 'a1b2c3d4', at: 200 },
    ])
    assert.deepEqual(s.tracesForMessage(tgMsg(999)), [])
  } finally {
    s.close()
  }
})

test('trace map: pruning drops the records before the cut and keeps the rest', () => {
  const { dir } = fresh('prune')
  const s = open(dir)
  try {
    s.recordTrace({ messageId: tgMsg(1), dir: 'in', trace: 'aaaaaaaa', at: 100 })
    s.recordTrace({ messageId: tgMsg(2), dir: 'in', trace: 'bbbbbbbb', at: 500 })
    s.pruneTraces(300)
    assert.deepEqual(s.tracesForMessage(tgMsg(1)), [])
    assert.equal(s.tracesForMessage(tgMsg(2)).length, 1)
  } finally {
    s.close()
  }
})

test('read-only view: reads settings, the group and the trace map without migrating or writing', () => {
  const { dir, path } = fresh('ro')
  // A version 2 database (no trace map yet), as the running v2 router leaves it.
  const db = openDatabase(path, [MIGRATION_V1, MIGRATION_V2])
  db.exec("INSERT INTO kv (key, value) VALUES ('group-id', '-100555')")
  db.exec("INSERT INTO addon_settings (addon, key, value) VALUES ('digest', 'enabled', '1')")
  db.close()
  const ro = new ReadOnlyStore(path)
  assert.equal(ro.readGroupId(), tgChat(-100555))
  assert.equal(ro.getAddonSetting('digest', 'enabled'), '1')
  assert.equal(ro.getAddonSetting('digest', 'nope'), null)
  assert.deepEqual(ro.tracesForMessage(tgMsg(5)), [], 'no trace table yet: empty, not an error')
  assert.equal(ro.schemaVersion(), 2, 'the read-only view reports the version the file holds')
  // The file is still version 2: the read-only view did not migrate it.
  const check = openDatabase(path, [MIGRATION_V1, MIGRATION_V2])
  assert.equal(Number((check.prepare('SELECT schema_version AS v FROM meta').get() as { v: number }).v), 2)
  check.close()
  // The real store migrates it when it opens (the router does that, not the CLI).
  const s = open(dir)
  s.recordTrace({ messageId: tgMsg(5), dir: 'in', trace: 'cafe0005', at: 1 })
  s.close()
  assert.equal(ro.tracesForMessage(tgMsg(5))[0]?.trace, 'cafe0005')
})

test('read-only view: a missing file answers the empty values', () => {
  const ro = new ReadOnlyStore(join(ISOLATED_ROOT, 'no-such-dir', 'x.db'))
  assert.equal(ro.readGroupId(), null)
  assert.equal(ro.getAddonSetting('a', 'b'), null)
  assert.deepEqual(ro.tracesForMessage(tgMsg(1)), [])
})

test('read-only view: a group id of zero or junk is no group, as in the store', () => {
  const { path } = fresh('ro-zero')
  const db = openDatabase(path, [MIGRATION_V1, MIGRATION_V2])
  db.exec("INSERT INTO kv (key, value) VALUES ('group-id', 'junk')")
  db.close()
  assert.equal(new ReadOnlyStore(path).readGroupId(), null)
})

test('integrity check: a sound database says ok; a missing file throws', () => {
  const { dir, path } = fresh('integrity')
  const s = open(dir)
  s.close()
  assert.equal(integrityCheck(path), 'ok')
  assert.equal(existsSync(path), true)
  assert.throws(() => integrityCheck(join(dir, 'missing.db')), /no database/)
  assert.equal(MIGRATIONS.length, 6)
})

test('queue depths: the pending tasks of each chat, empty chats included', () => {
  const queues = new OutboundQueues({ now: () => 0, setTimer: () => 0, clearTimer: () => {} } as never)
  queues.forChat(tgChat(-100))
  assert.deepEqual(queues.depths(), { [tgChat(-100)]: 0 })
})
