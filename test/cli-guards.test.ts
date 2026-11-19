// The stolik CLI (src/cli/stolik.ts): it never migrates the store, and it keeps its files private.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { applyPrivateUmask, openCliStore } from '../src/cli/stolik.ts'
import { DB_FILE, MIGRATION_V1, openDatabase } from '../src/adapters/store-sqlite.ts'
import { removeDir, tmpDir } from './helpers/addon-fakes.ts'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'stolik.ts')

function schemaVersion(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return Number((db.prepare('SELECT schema_version AS v FROM meta').get() as { v: number }).v)
  } finally {
    db.close()
  }
}

test('the CLI does not migrate: a database at an old schema is refused and stays at that version', async () => {
  const root = tmpDir('cli-nomig')
  try {
    const stateDir = join(root, 'state')
    mkdirSync(stateDir, { recursive: true })
    const dbPath = join(stateDir, DB_FILE)
    openDatabase(dbPath, [MIGRATION_V1]).close()
    assert.equal(schemaVersion(dbPath), 1)
    const paths = { stateDir, inboxDir: join(root, 'inbox'), notesDir: join(root, 'notes') }
    await assert.rejects(openCliStore(paths), (e: unknown) => (e as Error).name === 'SchemaMismatchError')
    assert.equal(schemaVersion(dbPath), 1, 'the CLI left the schema alone')
  } finally {
    removeDir(root)
  }
})

test('applyPrivateUmask sets the owner-only mask the CLI runs under', () => {
  const before = process.umask(0o022)
  try {
    applyPrivateUmask()
    assert.equal(process.umask(0o022), 0o077)
  } finally {
    process.umask(before)
  }
})

test('a config file that does not load: the CLI prints the message to stderr and exits 1, with no stack trace', () => {
  const root = tmpDir('cli-badcfg')
  try {
    const cfgDir = join(process.env.XDG_CONFIG_HOME ?? '', 'stolik')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(join(cfgDir, 'config.json'), '{ "stateDir": 42, ')
    const r = spawnSync(process.execPath, ['--experimental-strip-types', CLI, 'service', 'status'], { encoding: 'utf8' })
    assert.equal(r.status, 1, r.stderr)
    assert.ok(r.stderr.trim().length > 0)
    assert.doesNotMatch(r.stderr, /\n\s+at /)
  } finally {
    removeDir(root)
  }
})
