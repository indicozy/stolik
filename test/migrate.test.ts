// scripts/migrate-to-v3.ts (plan R1): fixture old state dirs under test/.tmp-*. Expected database rows and audit file,
// idempotency, dry run writes nothing, conflicts, and a read-only old dir that must stay untouched.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, lstatSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MigrationError, applyPrivateUmask, convertMsgMap, executePlan, formatPlan, planMigration, routerRunningReason, type Options,
} from '../scripts/migrate-to-v3.ts'
import { OLD_STATE_DIR, STATE_DIR } from '../src/config.ts'
import { DB_FILE, SqliteStore, readKvReadOnly } from '../src/adapters/store-sqlite.ts'
import { removeDir, tmpDir } from './helpers/addon-fakes.ts'
import { ISOLATED_ROOT } from './helpers/isolate.ts'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'migrate-to-v3.ts')

// Old msgmap: an entry with a numeric-string id (converted), two invalid ones (dropped), and a repeated id (last wins).
const OLD_MSGMAP = JSON.stringify([
  [3, { key: 758632, name: 'stolik', cwd: '/home/u/p/stolik' }],
  [4, { key: 541878, name: 'proga', cwd: '/home/u/p/proga' }],
  ['5', { key: 541878, name: 'proga#2', cwd: '/home/u/p/proga' }],
  [6, { key: 'x-1', name: 's', cwd: '/c' }],
  [7, { name: 'no key' }],
  ['zz', { key: 1, name: 'n', cwd: '/d' }],
  [3, { key: 758632, name: 'stolik-again', cwd: '/home/u/p/stolik' }],
])
const EXPECTED_MSGMAP = [
  ['tg:4', { key: 541878, name: 'proga', cwd: '/home/u/p/proga' }],
  ['tg:5', { key: 541878, name: 'proga#2', cwd: '/home/u/p/proga' }],
  ['tg:6', { key: 'x-1', name: 's', cwd: '/c' }],
  ['tg:3', { key: 758632, name: 'stolik-again', cwd: '/home/u/p/stolik' }],
]
const BOOT = '4b1db4c4-d6b1-45cc-bb3d-a36dfb3dcc5d'
const OLD_AUDIT = '{"ts":"2026-11-01T21:19:30.737Z","event":"register","session":"stolik"}\n{"ts":"2026-11-13T23:14:07.162Z","event":"inbound","session":"proga","kind":"text","length":42,"forwarded":false}\n'

function makeOld(root: string): string {
  const old = join(root, 'old')
  mkdirSync(join(old, 'classifier'), { recursive: true })
  writeFileSync(join(old, 'msgmap.json'), OLD_MSGMAP)
  writeFileSync(join(old, 'last-boot-id'), `${BOOT}\n`)
  writeFileSync(join(old, 'audit.log'), OLD_AUDIT)
  return old
}

function opts(from: string, to: string, extra: Partial<Options> = {}): Options {
  return { from, to, dryRun: false, force: false, ...extra }
}

// Every file under a dir: path, mode, size, mtime, content. Used to prove a dir did not change.
function snapshot(dir: string): string {
  const out: string[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      const st = lstatSync(p)
      if (st.isDirectory()) {
        out.push(`D ${p} ${(st.mode & 0o777).toString(8)}`)
        walk(p)
      } else {
        out.push(`F ${p} ${(st.mode & 0o777).toString(8)} ${st.size} ${st.mtimeMs} ${readFileSync(p).toString('base64')}`)
      }
    }
  }
  walk(dir)
  return out.join('\n')
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, ['--experimental-strip-types', SCRIPT, ...args], { encoding: 'utf8' })
}

// The v3 values the migration writes, read the way the router reads them (no write access needed).
function dbMsgMap(to: string): string | null {
  return readKvReadOnly(join(to, DB_FILE), 'msgmap')
}

test('convertMsgMap: v3 shape kept, numeric-string ids converted, invalid entries dropped, repeated id last', async () => {
  const c = convertMsgMap(OLD_MSGMAP)
  assert.equal(c.entries, EXPECTED_MSGMAP.length)
  assert.equal(c.converted, 1)
  assert.equal(c.dropped, 2)
  assert.deepEqual(JSON.parse(c.json), EXPECTED_MSGMAP)
})

test('convertMsgMap: a file that is not a JSON array is an error, not an empty migration', async () => {
  assert.throws(() => convertMsgMap('{"a":1}'), MigrationError)
  assert.throws(() => convertMsgMap('not json'), MigrationError)
})

test('migration writes the msgmap and boot id rows into stolik.db, and the audit log as a file', async () => {
  const root = tmpDir('migrate-fresh')
  try {
    const old = makeOld(root)
    const to = join(root, 'v3')
    const plan = await planMigration(opts(old, to))
    assert.deepEqual(plan.items.map((f) => [f.name, f.op]), [['msgmap', 'write'], ['last-boot-id', 'write'], ['audit.log', 'write']])
    executePlan(plan)
    assert.deepEqual(JSON.parse(dbMsgMap(to) ?? 'null'), EXPECTED_MSGMAP)
    assert.equal(readKvReadOnly(join(to, DB_FILE), 'last-boot-id'), BOOT)
    assert.equal(readFileSync(join(to, 'audit.log'), 'utf8'), OLD_AUDIT)
    assert.equal(statSync(join(to, 'audit.log')).mode & 0o777, 0o600)
    // The store reads the migrated values as the router would.
    const store = new SqliteStore({ stateDir: to, inboxDir: join(root, 'inbox'), notesDir: join(root, 'notes') })
    try {
      assert.equal(store.readLastBootId(), BOOT)
      assert.equal(store.readMsgMap(), dbMsgMap(to))
    } finally {
      store.close()
    }
    assert.equal(readdirSync(to).some((n) => n.endsWith('.migrate-tmp')), false)
  } finally {
    removeDir(root)
  }
})

test('migration is idempotent: a second run finds everything up to date and writes nothing new', async () => {
  const root = tmpDir('migrate-idem')
  try {
    const old = makeOld(root)
    const to = join(root, 'v3')
    executePlan(await planMigration(opts(old, to)))
    const before = snapshot(to)
    const plan = await planMigration(opts(old, to))
    assert.deepEqual(plan.items.map((f) => f.op), ['unchanged', 'unchanged', 'unchanged'])
    executePlan(plan)
    assert.equal(snapshot(to), before)
  } finally {
    removeDir(root)
  }
})

test('dry run prints the plan and writes nothing (the target and the database are not even created)', async () => {
  const root = tmpDir('migrate-dry')
  try {
    const old = makeOld(root)
    const to = join(root, 'v3')
    const r = runCli(['--from', old, '--to', to, '--dry-run'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /msgmap \(db\)\s+write\s+4 entries \(1 ids converted, 2 invalid dropped\)/)
    assert.match(r.stdout, /last-boot-id \(db\)\s+write/)
    assert.match(r.stdout, /audit\.log\s+write\s+2 lines/)
    assert.match(r.stdout, /dry run: nothing written\./)
    assert.equal(existsSync(to), false)
  } finally {
    removeDir(root)
  }
})

test('the default target is the v3 state folder, never the old one', async () => {
  // helpers/isolate.ts points XDG_STATE_HOME and HOME at a temp folder, so STATE_DIR is never the owner's real folder.
  assert.equal(STATE_DIR, join(ISOLATED_ROOT, 'state', 'stolik'))
  assert.notEqual(STATE_DIR, OLD_STATE_DIR)
  const root = tmpDir('migrate-default')
  try {
    const old = makeOld(root)
    const plan = await planMigration(opts(old, STATE_DIR))
    assert.equal(plan.to, STATE_DIR)
    assert.equal(plan.items.find((i) => i.kv === 'msgmap')?.op, 'write')
  } finally {
    removeDir(root)
  }
})

test('an existing v3 value that differs is a conflict: nothing is written; --force overwrites it', async () => {
  const root = tmpDir('migrate-conflict')
  try {
    const old = makeOld(root)
    const to = join(root, 'v3')
    const seeded = new SqliteStore({ stateDir: to, inboxDir: join(root, 'inbox'), notesDir: join(root, 'notes') })
    seeded.writeMsgMap('[[99,{"key":1,"name":"new-v3","cwd":"/x"}]]')
    seeded.close()
    const plan = await planMigration(opts(old, to))
    assert.equal(plan.items.find((i) => i.name === 'msgmap')?.op, 'conflict')
    const r = runCli(['--from', old, '--to', to])
    assert.equal(r.status, 3)
    assert.match(r.stderr, /Re-run with --force/)
    assert.equal(readKvReadOnly(join(to, DB_FILE), 'last-boot-id'), null, 'no other value written either')
    assert.equal(existsSync(join(to, 'audit.log')), false, 'no file written either')
    assert.equal(dbMsgMap(to), '[[99,{"key":1,"name":"new-v3","cwd":"/x"}]]')

    executePlan(await planMigration(opts(old, to, { force: true })))
    assert.deepEqual(JSON.parse(dbMsgMap(to) ?? 'null'), EXPECTED_MSGMAP)
  } finally {
    removeDir(root)
  }
})

test('audit.log: a v3 copy that starts with the old log (grown by new lines) is kept, not a conflict', async () => {
  const root = tmpDir('migrate-audit')
  try {
    const old = makeOld(root)
    const to = join(root, 'v3')
    mkdirSync(to)
    const grown = OLD_AUDIT + '{"ts":"2026-11-14T09:00:00.000Z","event":"away","source":"telegram"}\n'
    writeFileSync(join(to, 'audit.log'), grown)
    const plan = await planMigration(opts(old, to))
    assert.equal(plan.items.find((i) => i.name === 'audit.log')?.op, 'unchanged')
    executePlan(plan)
    assert.equal(readFileSync(join(to, 'audit.log'), 'utf8'), grown)
  } finally {
    removeDir(root)
  }
})

test('targets that are the old dir, inside it, or the live old dir are refused', async () => {
  const root = tmpDir('migrate-refuse')
  try {
    const old = makeOld(root)
    await assert.rejects(() => planMigration(opts(old, old)), MigrationError)
    await assert.rejects(() => planMigration(opts(old, join(old, 'sub'))), MigrationError)
    await assert.rejects(() => planMigration(opts(old, OLD_STATE_DIR)), MigrationError)
    await assert.rejects(() => planMigration(opts(old, join(OLD_STATE_DIR, 'v3'))), MigrationError)
  } finally {
    removeDir(root)
  }
})

test('a missing old dir is an error, and the CLI exits 1 without writing', async () => {
  const root = tmpDir('migrate-missing')
  try {
    const to = join(root, 'v3')
    await assert.rejects(() => planMigration(opts(join(root, 'nope'), to)), MigrationError)
    const r = runCli(['--from', join(root, 'nope'), '--to', to])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /old state dir not found/)
    assert.equal(existsSync(to), false)
  } finally {
    removeDir(root)
  }
})

test('no write ever happens under the old dir: a read-only old dir is migrated without error and stays byte-identical', async () => {
  const root = tmpDir('migrate-ro')
  const old = makeOld(root)
  const to = join(root, 'v3')
  // Read-only for everything under it, so any write into the old dir would fail (the test user is not root).
  const lock = (d: string, dirMode: number, fileMode: number) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) lock(p, dirMode, fileMode)
      else chmodSync(p, fileMode)
    }
    chmodSync(d, dirMode)
  }
  try {
    lock(old, 0o555, 0o444)
    const before = snapshot(old)
    executePlan(await planMigration(opts(old, to)))
    const dry = runCli(['--from', old, '--to', join(root, 'v3-dry'), '--dry-run'])
    assert.equal(dry.status, 0, dry.stderr)
    assert.equal(snapshot(old), before, 'old dir unchanged')
    assert.equal(existsSync(join(root, 'v3-dry')), false)
    assert.equal(readFileSync(join(to, 'audit.log'), 'utf8'), OLD_AUDIT)
  } finally {
    lock(old, 0o755, 0o644)
    removeDir(root)
  }
})

test('formatPlan names every item and the notes, and says when nothing is written', async () => {
  const root = tmpDir('migrate-format')
  try {
    const old = makeOld(root)
    const lines = formatPlan(await planMigration(opts(old, join(root, 'v3'))), true)
    assert.ok(lines.some((l) => /classifier\/ .* obsolete/.test(l)))
    assert.ok(lines.some((l) => /no session registry/.test(l)))
    assert.equal(lines.at(-1), 'dry run: nothing written.')
  } finally {
    removeDir(root)
  }
})

test('a router holding the lock in the target folder: the migration refuses, exits 1, and writes nothing', () => {
  const root = tmpDir('migrate-lock')
  try {
    const old = makeOld(root)
    const to = join(root, 'v3')
    mkdirSync(to, { recursive: true })
    // The test process is alive, so its pid stands for a running router.
    writeFileSync(join(to, 'router.lock'), `${process.pid}\n`)
    const r = runCli(['--from', old, '--to', to])
    assert.equal(r.status, 1, r.stderr)
    assert.match(r.stderr, /holds the lock/)
    assert.equal(existsSync(join(to, DB_FILE)), false)
    assert.equal(existsSync(join(to, 'audit.log')), false)
    assert.equal(readFileSync(join(to, 'router.lock'), 'utf8'), `${process.pid}\n`)
  } finally {
    removeDir(root)
  }
})

test('routerRunningReason: an answering socket refuses; with no listener and no live lock the migration may run', async () => {
  const root = tmpDir('migrate-sock')
  try {
    const sock = join(root, 's.sock')
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(sock, () => resolve()))
    try {
      assert.match((await routerRunningReason(root, sock)) ?? '', /answers on the socket/)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    assert.equal(await routerRunningReason(root, sock), null)
  } finally {
    removeDir(root)
  }
})

test('the database is re-checked inside the write transaction: a row that changed after planning stops the run, nothing committed', async () => {
  const root = tmpDir('migrate-recheck')
  try {
    const old = makeOld(root)
    const to = join(root, 'v3')
    const plan = await planMigration(opts(old, to))
    assert.deepEqual(plan.items.map((f) => f.op), ['write', 'write', 'write'])
    // Another writer sets the msgmap after the plan was made.
    const other = '[[99,{"key":1,"name":"other","cwd":"/x"}]]'
    const seeded = new SqliteStore({ stateDir: to, inboxDir: join(root, 'inbox'), notesDir: join(root, 'notes') })
    seeded.writeMsgMap(other)
    seeded.close()
    assert.throws(() => executePlan(plan), MigrationError)
    assert.equal(dbMsgMap(to), other)
    assert.equal(readKvReadOnly(join(to, DB_FILE), 'last-boot-id'), null, 'the other row was not committed either')
    assert.equal(existsSync(join(to, 'audit.log')), false, 'no file written either')
  } finally {
    removeDir(root)
  }
})

test('audit.log is streamed: a several-thousand-line log is counted, copied byte for byte, and compared again as unchanged', async () => {
  const root = tmpDir('migrate-big')
  try {
    const old = makeOld(root)
    const big = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ ts: '2026-11-14T00:00:00.000Z', event: 'inbound', n: i }) + '\n').join('')
    writeFileSync(join(old, 'audit.log'), big)
    const to = join(root, 'v3')
    const plan = await planMigration(opts(old, to))
    assert.equal(plan.items.find((i) => i.name === 'audit.log')?.summary, '5000 lines, copied as it is')
    executePlan(plan)
    assert.equal(readFileSync(join(to, 'audit.log'), 'utf8'), big)
    assert.equal((await planMigration(opts(old, to))).items.find((i) => i.name === 'audit.log')?.op, 'unchanged')
  } finally {
    removeDir(root)
  }
})

test('applyPrivateUmask sets the owner-only mask the migration runs under', () => {
  const before = process.umask(0o022)
  try {
    applyPrivateUmask()
    assert.equal(process.umask(0o022), 0o077)
  } finally {
    process.umask(before)
  }
})
