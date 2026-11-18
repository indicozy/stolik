// MIGRATION_V6 (string ids on disk), the legacy id rule, and the loaders that still read bare numbers.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { DatabaseSync } from 'node:sqlite'
import { DB_FILE, MIGRATIONS, SqliteStore, openDatabase } from '../src/adapters/store-sqlite.ts'
import { JsonStore } from '../src/adapters/store-json.ts'
import { legacyChatId, legacyMsgId, storedId } from '../src/adapters/legacy-ids.ts'
import { loadMsgMap } from '../src/brain/msgmap.ts'
import { parseTopics, serializeTopics, type TopicRec } from '../src/brain/topics.ts'
import { ThreadMap } from '../src/brain/modes.ts'
import type { ChatId, MessageId, ThreadId } from '../src/brain/chat-types.ts'
import { sandboxPaths } from './helpers/store-contract.ts'

const E2E = 1_000_000_000_000_000
const SID = '1ad1ce43-2b77-4566-a349-25c65eaa004d'

function raw(path: string): DatabaseSync {
  const { DatabaseSync: Db } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
  return new Db(path)
}

test('legacy id rule: chat, message and thread numbers become the string ids', () => {
  assert.equal(legacyChatId(-1001234567890), 'tg:-1001234567890')
  assert.equal(legacyChatId(-E2E - 7), 'e2e:7')
  assert.equal(legacyChatId(-E2E), 'e2e:0')
  assert.equal(legacyChatId(0), null)
  assert.equal(legacyChatId(1.5), null)
  assert.equal(legacyMsgId(84), 'tg:84')
  assert.equal(legacyMsgId(-E2E - 3), 'e2e:3')
  assert.equal(legacyMsgId(-1000000001), null, 'a pre-0c-1 e2e leftover has no id now')
  assert.equal(legacyMsgId(0), null)
  assert.equal(legacyMsgId(Number.NaN), null)
})

test('storedId: strings in the new form are kept, numeric text and numbers take the rule, anything else is null', () => {
  assert.equal(storedId('tg:5', legacyMsgId), 'tg:5')
  assert.equal(storedId('e2e:9', legacyMsgId), 'e2e:9')
  assert.equal(storedId('junk', legacyMsgId), null)
  assert.equal(storedId(' 84 ', legacyMsgId), 'tg:84')
  assert.equal(storedId(84, legacyMsgId), 'tg:84')
  assert.equal(storedId(undefined, legacyMsgId), null)
  assert.equal(storedId(true, legacyMsgId), null)
})

test('loaders: the msgmap reads numbers and strings, and writes strings', () => {
  const map = loadMsgMap(JSON.stringify([
    [84, { key: 1, name: 'a', cwd: '/c', thread: 101 }],
    ['tg:85', { key: 2, name: 'b', cwd: '/d', thread: 'tg:102' }],
    [-1000000001, { key: 3, name: 'c', cwd: '/e' }],
  ]))
  assert.equal(map.get('tg:84' as MessageId)?.thread, 'tg:101')
  assert.equal(map.get('tg:85' as MessageId)?.thread, 'tg:102')
  assert.equal(map.size(), 2, 'the leftover id is dropped')
  assert.deepEqual(JSON.parse(map.serialize()).map((p: [string, unknown]) => p[0]), ['tg:84', 'tg:85'])
})

test('loaders: topics read a number or a string thread id, and write strings', () => {
  const base = { name: 'n', project: 'p', cwd: null, sessionKey: null, backendSessionId: null, state: 'open', endedAt: null, deleteAt: null }
  const json = JSON.stringify([
    { ...base, threadId: 101 },
    { ...base, threadId: 'tg:102' },
    { ...base, threadId: -1000000001 },
  ])
  assert.deepEqual(parseTopics(json).map((t) => t.threadId), ['tg:101', 'tg:102'])
  const recs = parseTopics(json)
  assert.equal(JSON.parse(serializeTopics(recs))[0].threadId, 'tg:101')
})

test('loaders: the modes thread file reads numbers and strings, and skips a bad id', () => {
  const entry = { key: 'abcd0123', mode: 'read', sessionId: SID, question: 'q', answer: 'a', partial: false, ts: 1 }
  const loaded = ThreadMap.fromJSON(JSON.stringify([[84, entry], ['tg:85', entry], ['x', entry]]))
  assert.equal(loaded.size, 2)
  assert.ok(loaded.get('tg:84' as MessageId))
  assert.ok(loaded.get('tg:85' as MessageId))
  const saved = JSON.parse(loaded.toJSON())
  assert.deepEqual(saved.map((p: [string]) => p[0]), ['tg:84', 'tg:85'])
})

test('loaders: the group id file reads a bare number (before V6) or a string', () => {
  const box = sandboxPaths('store-json-v6')
  try {
    mkdirSync(box.paths.stateDir, { recursive: true })
    const file = join(box.paths.stateDir, 'group-id')
    const store = new JsonStore(box.paths)
    writeFileSync(file, '-1001234567890\n')
    assert.equal(store.readGroupId(), 'tg:-1001234567890')
    writeFileSync(file, 'tg:-1001234567890\n')
    assert.equal(store.readGroupId(), 'tg:-1001234567890')
    store.writeGroupId('tg:-100777' as ChatId)
    assert.equal(readFileSync(file, 'utf8'), 'tg:-100777\n')
  } finally {
    box.cleanup()
  }
})

// A V5 database with rows that mirror the live shapes: numbers for every id, one bad id per table, one broken JSON value.
function buildV5(path: string): void {
  const db = openDatabase(path, MIGRATIONS.slice(0, 5))
  try {
    const insTopic = db.prepare(
      'INSERT INTO topics (thread_id, name, project, session_key, backend_session_id, state, ended_at, delete_at, cwd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    insTopic.run(101, 'a', 'p', null, null, 'open', null, null, '/p/a')
    insTopic.run(200, 'b', 'p', 'n:541878', null, 'open', null, null, null)
    insTopic.run(-1000000001, 'bad', 'p', null, null, 'open', null, null, '/p/bad')
    insTopic.run(7, 'closed', 'p', null, null, 'closed', 1000, null, '/p/c')
    insTopic.run(-E2E - 5, 'e2e', 'p', null, null, 'open', null, null, '/p/e')
    insTopic.run(300, 'last', 'p', null, null, 'open', null, null, '/p/l')
    db.prepare('INSERT INTO mode_threads (mode, thread_id) VALUES (?, ?)').run('build', 84)
    db.prepare('INSERT INTO mode_threads (mode, thread_id) VALUES (?, ?)').run('dead', -1000000001)
    const ins = db.prepare('INSERT INTO trace_map (message_id, dir, trace, at) VALUES (?, ?, ?, ?)')
    ins.run(84, 'in', 'tr1', 10)
    ins.run(-E2E - 3, 'out', 'tr2', 20)
    ins.run(-1000000001, 'in', 'tr3', 30)
    const led = db.prepare('INSERT INTO outbound_ledger (session_key, key, body_key, source, at, message_ids) VALUES (?, ?, ?, ?, ?, ?)')
    led.run('n:541878', 'k1', 'b1', 'src', 1, '[]')
    led.run('n:541878', 'k2', 'b2', 'src', 2, JSON.stringify([84, -E2E - 3, -1000000001]))
    led.run('s:broken', 'k3', 'b3', 'src', 3, '[oops')
    const kv = db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)')
    kv.run('group-id', '-1001234567890')
    kv.run('msgmap', JSON.stringify([
      [84, { key: 541878, name: 'proga', cwd: '/p', thread: 101 }],
      [-E2E - 2, { key: 'x-1', name: 's', cwd: '/c', thread: -1000000001 }],
      [-1000000001, { key: 1, name: 'n', cwd: '/d' }],
    ]))
    kv.run('live-buttons', JSON.stringify([{ messageId: 84, dm: false }, { messageId: -1000000001, dm: true }, { messageId: -E2E - 1, dm: true }]))
    kv.run('folder-mutes', '["/p/a"]')
    kv.run('some-json', '{not json')
    db.prepare('INSERT INTO addon_settings (addon, key, value) VALUES (?, ?, ?)').run('_router', 'logs-thread', '84')
  } finally {
    db.close()
  }
}

test('MIGRATION_V6: converts every id, drops the unusable ones, and keeps order and other columns', () => {
  const box = sandboxPaths('store-v6')
  try {
    mkdirSync(box.paths.stateDir, { recursive: true })
    const path = join(box.paths.stateDir, DB_FILE)
    buildV5(path)
    const store = new SqliteStore(box.paths)
    try {
      assert.equal(store.schemaVersion(), 6)
      const topics = store.listTopics()
      assert.deepEqual(topics.map((t) => t.threadId), ['tg:101', 'tg:200', 'tg:7', `e2e:5`, 'tg:300'])
      assert.equal(topics[0].cwd, '/p/a')
      assert.equal(topics[1].cwd, null)
      assert.equal(topics[2].cwd, '/p/c')
      assert.equal(topics[2].state, 'closed')
      assert.equal(topics[2].endedAt, 1000)
      assert.equal(topics[1].sessionKey, 541878)
      assert.equal(store.getModeThread('build'), 'tg:84')
      assert.equal(store.getModeThread('dead'), null)
      assert.equal(store.readGroupId(), 'tg:-1001234567890')
      const msgmap = JSON.parse(store.readMsgMap())
      assert.deepEqual(msgmap, [
        ['tg:84', { key: 541878, name: 'proga', cwd: '/p', thread: 'tg:101' }],
        ['e2e:2', { key: 'x-1', name: 's', cwd: '/c' }],
      ])
      assert.deepEqual(JSON.parse(store.readLiveButtons()), [{ messageId: 'tg:84', dm: false }, { messageId: 'e2e:1', dm: true }])
      assert.equal(store.readMutes(), '["/p/a"]')
      assert.equal(store.getAddonSetting('_router', 'logs-thread'), 'tg:84')
      const led = store.listLedger(541878 as never)
      assert.deepEqual(led.map((e) => e.messageIds), [[], ['tg:84', 'e2e:3']])
      const traces = store.tracesForMessage('e2e:3' as MessageId)
      assert.deepEqual(traces.map((t) => [t.messageId, t.trace]), [['e2e:3', 'tr2']])
      assert.equal(store.tracesForMessage('tg:84' as MessageId)[0].trace, 'tr1')
      // Round trips with string ids.
      store.writeGroupId('tg:-100777' as ChatId)
      assert.equal(store.readGroupId(), 'tg:-100777')
      store.recordTrace({ messageId: 'tg:9' as MessageId, dir: 'in', trace: 'tr9', at: 5 })
      assert.equal(store.tracesForMessage('tg:9' as MessageId)[0].messageId, 'tg:9')
    } finally {
      store.close()
    }

    const db = raw(path)
    try {
      const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'trace_map_at'").all()
      assert.equal(names.length, 1)
      const keys = db.prepare("SELECT key FROM kv WHERE key IN ('group-id', 'home-id') ORDER BY key").all().map((r) => r.key)
      assert.deepEqual(keys, ['home-id'])
      assert.equal(db.prepare("SELECT value FROM kv WHERE key = 'some-json'").get()?.value, '{not json')
      assert.equal(db.prepare("SELECT message_ids FROM outbound_ledger WHERE key = 'k3'").get()?.message_ids, '[oops')
      assert.equal(db.prepare("SELECT value FROM kv WHERE key = 'home-id'").get()?.value, 'tg:-100777')
    } finally {
      db.close()
    }

    // The pre-migration file is kept, still at V5.
    const bak = `${path}.bak-v5`
    assert.ok(existsSync(bak))
    const old = raw(bak)
    try {
      assert.equal(old.prepare('SELECT schema_version AS v FROM meta').get()?.v, 5)
    } finally {
      old.close()
    }

    // A second open is a no-op; a V6 file is refused by the V5 build.
    openDatabase(path).close()
    assert.throws(() => openDatabase(path, MIGRATIONS.slice(0, 5)), /newer than this build/)
  } finally {
    box.cleanup()
  }
})
