// `stolik migrate` (src/cli/migrate.ts): copies the old tg-bridge env file, config dir and state dir into the stolik
// locations. Every test uses its own temp home, never the owner's.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planMigration, runMigration, REFUSED_MESSAGE } from '../src/cli/migrate.ts'

// Runs fn with a fresh temp home, removed afterwards.
async function withHome(fn: (home: string) => Promise<void> | void): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'stolik-migrate-'))
  try {
    await fn(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function put(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

function run(home: string, env: NodeJS.ProcessEnv, isOldRunning: () => Promise<boolean> = async () => false) {
  const logs: string[] = []
  return runMigration({ home, env, isOldRunning, log: (s) => logs.push(s) }).then((r) => ({ ...r, logs }))
}

test('empty plan when there are no old files: nothing copied, nothing logged', async () => {
  await withHome(async (home) => {
    assert.deepEqual(planMigration({ home, env: {} }), [])
    const r = await run(home, {}, async () => {
      throw new Error('isOldRunning must not be asked when the plan is empty')
    })
    assert.deepEqual(r.copied, [])
    assert.equal(r.refused, undefined)
    assert.deepEqual(r.logs, [])
  })
})

test('env file: TG_BRIDGE_ keys become STOLIK_, mode 0600, old file unchanged', async () => {
  await withHome(async (home) => {
    const old = join(home, '.config', 'tg-bridge.env')
    const oldText = 'TG_BRIDGE_TOKEN=x\n# a comment\nexport TG_BRIDGE_CHAT=42\nOTHER=TG_BRIDGE_Z\n'
    put(old, oldText)
    const r = await run(home, {})
    const to = join(home, '.config', 'stolik.env')
    assert.equal(readFileSync(to, 'utf8'), 'STOLIK_TOKEN=x\n# a comment\nexport STOLIK_CHAT=42\nOTHER=TG_BRIDGE_Z\n')
    assert.equal(statSync(to).mode & 0o777, 0o600)
    assert.equal(readFileSync(old, 'utf8'), oldText)
    assert.deepEqual(r.copied.map((s) => s.what), ['env file'])
    assert.ok(r.logs.includes(`copied env file: ${old} -> ${to}`))
  })
})

test('an existing new env file is neither planned nor overwritten', async () => {
  await withHome(async (home) => {
    put(join(home, '.config', 'tg-bridge.env'), 'TG_BRIDGE_TOKEN=old\n')
    const newEnv = join(home, '.config', 'stolik.env')
    put(newEnv, 'STOLIK_TOKEN=new\n')
    assert.equal(planMigration({ home, env: {} }).some((s) => s.what === 'env file'), false)
    await run(home, {})
    assert.equal(readFileSync(newEnv, 'utf8'), 'STOLIK_TOKEN=new\n')
  })
})

test('state dir: copied, tg-bridge.db and -wal renamed in the copy, old dir unchanged', async () => {
  await withHome(async (home) => {
    const oldDir = join(home, '.local', 'state', 'tg-bridge-v3')
    const newDir = join(home, '.local', 'state', 'stolik')
    put(join(oldDir, 'tg-bridge.db'), 'db-bytes')
    put(join(oldDir, 'tg-bridge.db-wal'), 'wal-bytes')
    put(join(oldDir, 'audit.log'), 'line\n')
    put(join(oldDir, 'tg-bridge-notes.txt'), 'keep')
    const r = await run(home, {})
    assert.equal(readFileSync(join(newDir, 'stolik.db'), 'utf8'), 'db-bytes')
    assert.equal(readFileSync(join(newDir, 'stolik.db-wal'), 'utf8'), 'wal-bytes')
    assert.equal(readFileSync(join(newDir, 'audit.log'), 'utf8'), 'line\n')
    assert.equal(readFileSync(join(newDir, 'tg-bridge-notes.txt'), 'utf8'), 'keep')
    assert.equal(existsSync(join(newDir, 'tg-bridge.db')), false)
    assert.equal(existsSync(join(newDir, 'tg-bridge.db-wal')), false)
    assert.equal(readFileSync(join(oldDir, 'tg-bridge.db'), 'utf8'), 'db-bytes')
    assert.equal(readFileSync(join(oldDir, 'tg-bridge.db-wal'), 'utf8'), 'wal-bytes')
    assert.ok(r.copied.some((s) => s.what === 'state dir'))
  })
})

test('config.json: stateDir and other tg-bridge names become stolik, old file unchanged', async () => {
  await withHome(async (home) => {
    const oldCfg = join(home, '.config', 'tg-bridge', 'config.json')
    const oldText = JSON.stringify(
      {
        stateDir: '~/.local/state/tg-bridge-v3',
        socketPath: '~/run/tg-bridge.sock',
        logRoot: '~/Documents/tg-bridge/log',
        groupId: -100123,
        chat: { app: 'telegram', telegram: { homeId: 'tg:-100123' } },
      },
      null,
      2,
    ) + '\n'
    put(oldCfg, oldText)
    await run(home, {})
    const newCfg = join(home, '.config', 'stolik', 'config.json')
    assert.deepEqual(JSON.parse(readFileSync(newCfg, 'utf8')), {
      stateDir: '~/.local/state/stolik',
      socketPath: '~/run/stolik.sock',
      logRoot: '~/Documents/stolik/log',
      groupId: -100123,
      chat: { app: 'telegram', telegram: { homeId: 'tg:-100123' } },
    })
    assert.equal(readFileSync(oldCfg, 'utf8'), oldText)
  })
})

test('config.json that does not parse is copied unchanged, with a warning', async () => {
  await withHome(async (home) => {
    const oldCfg = join(home, '.config', 'tg-bridge', 'config.json')
    put(oldCfg, '{ not json, tg-bridge')
    const r = await run(home, {})
    assert.equal(readFileSync(join(home, '.config', 'stolik', 'config.json'), 'utf8'), '{ not json, tg-bridge')
    assert.ok(r.logs.some((l) => l.startsWith('warning:') && l.includes('config.json')))
  })
})

test('refused while the old service runs: nothing copied', async () => {
  await withHome(async (home) => {
    put(join(home, '.config', 'tg-bridge.env'), 'TG_BRIDGE_TOKEN=x\n')
    put(join(home, '.config', 'tg-bridge', 'config.json'), '{}')
    put(join(home, '.local', 'state', 'tg-bridge-v3', 'tg-bridge.db'), 'db')
    const r = await run(home, {}, async () => true)
    assert.equal(r.refused, REFUSED_MESSAGE)
    assert.match(r.refused ?? '', /systemctl --user disable --now tg-bridge/)
    assert.deepEqual(r.copied, [])
    assert.deepEqual(r.logs, [])
    assert.equal(existsSync(join(home, '.config', 'stolik.env')), false)
    assert.equal(existsSync(join(home, '.config', 'stolik')), false)
    assert.equal(existsSync(join(home, '.local', 'state', 'stolik')), false)
  })
})

test('XDG_STATE_HOME and XDG_CONFIG_HOME are honoured for the old and the new locations', async () => {
  await withHome(async (home) => {
    const xdgState = join(home, 'xs')
    const xdgConfig = join(home, 'xc')
    const env = { XDG_STATE_HOME: xdgState, XDG_CONFIG_HOME: xdgConfig }
    put(join(xdgState, 'tg-bridge-v3', 'tg-bridge.db'), 'db')
    put(join(xdgConfig, 'tg-bridge', 'config.json'), JSON.stringify({ stateDir: '~/x/tg-bridge-v3' }))
    // The defaults under home are not used when the XDG folders are set.
    put(join(home, '.local', 'state', 'tg-bridge-v3', 'tg-bridge.db'), 'wrong')
    const plan = planMigration({ home, env })
    assert.deepEqual(
      plan.map((s) => [s.what, s.from, s.to]),
      [
        ['config dir', join(xdgConfig, 'tg-bridge'), join(xdgConfig, 'stolik')],
        ['state dir', join(xdgState, 'tg-bridge-v3'), join(xdgState, 'stolik')],
      ],
    )
    const r = await run(home, env)
    assert.equal(readFileSync(join(xdgState, 'stolik', 'stolik.db'), 'utf8'), 'db')
    assert.equal(readFileSync(join(xdgConfig, 'stolik', 'config.json'), 'utf8'), JSON.stringify({ stateDir: '~/x/stolik' }, null, 2))
    assert.equal(existsSync(join(home, '.local', 'state', 'stolik')), false)
    assert.equal(r.copied.length, 2)
  })
})
