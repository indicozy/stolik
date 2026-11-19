// `stolik setup` with fake prompts into a temp HOME under test/ (plan P3). Checks: the token goes to the env file
// with mode 600 and is never printed; config.json is merged and keeps unknown keys; Enter keeps saved values.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync, chmodSync, lstatSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeConfig, mergeEnvToken, readEnvToken, runSetup, TOKEN_RE, writeFileAtomic, type SetupDeps } from '../src/cli/setup.ts'
import { envFilePath } from '../src/config.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
// A made-up token in the BotFather shape; not a real bot.
const TOKEN = '123456789:AAHfakeTokenForTestsOnly_abcdefgh'

function withHome(fn: (home: string, paths: SetupDeps['paths']) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(HERE, '.tmp-setup-'))
  const paths = {
    envFile: join(home, '.config', 'stolik.env'),
    configFile: join(home, '.config', 'stolik', 'config.json'),
    pluginDir: '/opt/stolik/plugin',
    nodePath: '/usr/bin/node',
  }
  return fn(home, paths).finally(() => rmSync(home, { recursive: true, force: true }))
}

// Fake prompts: answers come from the queue, in the order the prompts are asked.
function fakeDeps(paths: SetupDeps['paths'], answers: string[]) {
  const out: string[] = []
  const asked: string[] = []
  const next = (q: string) => {
    asked.push(q)
    return Promise.resolve(answers.shift() ?? '')
  }
  const deps: SetupDeps = { ask: next, askSecret: next, out: (l) => out.push(l), paths }
  return { deps, out, asked }
}

test('token and owner: env file holds the token at mode 600, config holds ownerUserId and nodePath, the token is not printed', async () => {
  await withHome(async (home, paths) => {
    const { deps, out } = fakeDeps(paths, [TOKEN, '424242'])
    assert.equal(await runSetup(deps), 0)
    assert.equal(readFileSync(paths.envFile, 'utf8'), `STOLIK_TOKEN=${TOKEN}\nTG_CHAT=424242\n`)
    assert.equal(statSync(paths.envFile).mode & 0o777, 0o600)
    const cfg = JSON.parse(readFileSync(paths.configFile, 'utf8'))
    assert.deepEqual(cfg, { chat: { app: 'telegram', telegram: { ownerUserId: '424242' } }, nodePath: '/usr/bin/node' })
    const printed = out.join('\n')
    assert.equal(printed.includes(TOKEN), false, 'the token must never be printed')
    assert.match(printed, /\/plugin marketplace add \/opt\/stolik\/plugin/)
    assert.match(printed, /\/plugin install stolik@indicozy/)
    assert.match(printed, /\/bind/)
    assert.match(printed, /Manage topics/)
    assert.match(printed, /Delete messages/)
  })
})

test('config merge keeps unknown keys and the keys setup does not own', async () => {
  await withHome(async (_home, paths) => {
    mkdirSync(dirname(paths.configFile), { recursive: true })
    writeFileSync(
      paths.configFile,
      JSON.stringify({ presence: 'x11', cpuAffinity: '8-19', someFutureKey: { a: [1, 2] }, ownerUserId: '111' }),
    )
    // The owner '111' is saved, so setup does not ask again; --owner-id moves it to chat.telegram. The old key stays.
    const { deps } = fakeDeps(paths, [TOKEN])
    deps.options = { ownerId: '222' }
    assert.equal(await runSetup(deps), 0)
    assert.deepEqual(JSON.parse(readFileSync(paths.configFile, 'utf8')), {
      presence: 'x11',
      cpuAffinity: '8-19',
      someFutureKey: { a: [1, 2] },
      ownerUserId: '111',
      chat: { app: 'telegram', telegram: { ownerUserId: '222' } },
      nodePath: '/usr/bin/node',
    })
  })
})

test('env merge keeps the other lines (TG_CHAT, comments) and replaces only the token', async () => {
  await withHome(async (_home, paths) => {
    mkdirSync(dirname(paths.envFile), { recursive: true })
    writeFileSync(paths.envFile, '# old\nTG_CHAT=-100123\nSTOLIK_TOKEN=\n')
    chmodSync(paths.envFile, 0o644)
    const { deps } = fakeDeps(paths, [TOKEN, '7'])
    assert.equal(await runSetup(deps), 0)
    assert.equal(readFileSync(paths.envFile, 'utf8'), `# old\nTG_CHAT=-100123\nSTOLIK_TOKEN=${TOKEN}\n`)
    assert.equal(statSync(paths.envFile).mode & 0o777, 0o600, 'a loose existing file is tightened to 600')
  })
})

test('Enter keeps the saved token and owner id', async () => {
  await withHome(async (_home, paths) => {
    mkdirSync(dirname(paths.envFile), { recursive: true })
    writeFileSync(paths.envFile, `STOLIK_TOKEN=${TOKEN}\n`)
    mkdirSync(dirname(paths.configFile), { recursive: true })
    writeFileSync(paths.configFile, JSON.stringify({ ownerUserId: '555' }))
    const { deps, asked, out } = fakeDeps(paths, [''])
    assert.equal(await runSetup(deps), 0)
    assert.match(asked[0], /keeps the saved one/)
    assert.equal(asked.length, 1, 'a saved owner is not asked again')
    assert.ok(out.some((l) => /owner already paired \(id 555\)\. Run stolik setup --pair/.test(l)))
    assert.equal(readEnvToken(readFileSync(paths.envFile, 'utf8')), TOKEN)
    assert.equal(JSON.parse(readFileSync(paths.configFile, 'utf8')).ownerUserId, '555')
  })
})

test('bad input stops setup before anything is written', async () => {
  await withHome(async (_home, paths) => {
    const bad = fakeDeps(paths, ['not-a-token'])
    assert.equal(await runSetup(bad.deps), 1)
    assert.ok(bad.out.some((l) => /does not look like a bot token/.test(l)))
    assert.equal(existsSync(paths.envFile), false)

    const noToken = fakeDeps(paths, ['', ''])
    assert.equal(await runSetup(noToken.deps), 1, 'an empty token with nothing saved is an error')
    assert.equal(existsSync(paths.envFile), false)

    const badOwner = fakeDeps(paths, [TOKEN, 'me'])
    assert.equal(await runSetup(badOwner.deps), 1)
    assert.ok(badOwner.out.some((l) => /digits only/.test(l)))
    assert.equal(existsSync(paths.envFile), false, 'nothing is written when the owner id is bad')
    assert.equal(existsSync(paths.configFile), false)
  })
})

test('an unreadable existing config is not overwritten', async () => {
  await withHome(async (_home, paths) => {
    mkdirSync(dirname(paths.configFile), { recursive: true })
    writeFileSync(paths.configFile, '{ not json')
    const { deps, out } = fakeDeps(paths, [TOKEN, '1'])
    assert.equal(await runSetup(deps), 1)
    assert.ok(out.some((l) => /is not valid JSON/.test(l)))
    assert.equal(readFileSync(paths.configFile, 'utf8'), '{ not json')
  })
})

test('mergeEnvToken and readEnvToken: replace or append the token line, read it back, ignore comments', () => {
  assert.equal(mergeEnvToken('', TOKEN), `STOLIK_TOKEN=${TOKEN}\n`)
  assert.equal(mergeEnvToken('A=1\n\n\n', TOKEN), `A=1\nSTOLIK_TOKEN=${TOKEN}\n`)
  assert.equal(mergeEnvToken('export STOLIK_TOKEN=old\nB=2', TOKEN), `STOLIK_TOKEN=${TOKEN}\nB=2\n`)
  assert.equal(readEnvToken(`# STOLIK_TOKEN=commented\nSTOLIK_TOKEN="${TOKEN}"\n`), TOKEN)
  assert.equal(readEnvToken('STOLIK_TOKEN=\n'), null)
  assert.equal(readEnvToken('OTHER=1\n'), null)
})

test('mergeConfig: updates win, other keys stay; token pattern accepts BotFather shape only', () => {
  assert.deepEqual(mergeConfig({ a: 1, ownerUserId: '1' }, { ownerUserId: '2' }), { a: 1, ownerUserId: '2' })
  assert.equal(TOKEN_RE.test(TOKEN), true)
  assert.equal(TOKEN_RE.test('123:short'), false)
  assert.equal(TOKEN_RE.test('abc:AAHfakeTokenForTestsOnly_abcdefgh'), false)
})

test('STOLIK_ENV_FILE: setup writes the token to the override file and leaves the default file alone', async () => {
  await withHome(async (home, paths) => {
    const trial = join(home, 'trial', 'tg.env')
    const target = { ...paths, envFile: envFilePath({ STOLIK_ENV_FILE: trial }, home) }
    const { deps } = fakeDeps(target, [TOKEN, '424242'])
    assert.equal(await runSetup(deps), 0)
    assert.equal(readFileSync(trial, 'utf8'), `STOLIK_TOKEN=${TOKEN}\nTG_CHAT=424242\n`)
    assert.equal(statSync(trial).mode & 0o777, 0o600)
    assert.equal(existsSync(paths.envFile), false, 'the default env file is not written')
  })
})

test('TG_CHAT: a saved TG_CHAT is kept while the owner is unchanged; a new owner moves TG_CHAT to its id', async () => {
  await withHome(async (_home, paths) => {
    mkdirSync(dirname(paths.envFile), { recursive: true })
    writeFileSync(paths.envFile, `STOLIK_TOKEN=${TOKEN}\nTG_CHAT=-100555\n`)
    const kept = fakeDeps(paths, [''])
    assert.equal(await runSetup(kept.deps), 0)
    assert.equal(readFileSync(paths.envFile, 'utf8'), `STOLIK_TOKEN=${TOKEN}\nTG_CHAT=-100555\n`)
    const moved = fakeDeps(paths, [''])
    moved.deps.options = { ownerId: '999' }
    assert.equal(await runSetup(moved.deps), 0)
    assert.equal(readFileSync(paths.envFile, 'utf8'), `STOLIK_TOKEN=${TOKEN}\nTG_CHAT=999\n`)
    assert.equal(JSON.parse(readFileSync(paths.configFile, 'utf8')).chat.telegram.ownerUserId, '999')
  })
})

test('TG_CHAT: an empty TG_CHAT line is filled with the owner id', async () => {
  await withHome(async (_home, paths) => {
    mkdirSync(dirname(paths.envFile), { recursive: true })
    writeFileSync(paths.envFile, `STOLIK_TOKEN=${TOKEN}\nTG_CHAT=\n`)
    const { deps } = fakeDeps(paths, ['', '31337'])
    assert.equal(await runSetup(deps), 0)
    assert.equal(readFileSync(paths.envFile, 'utf8'), `STOLIK_TOKEN=${TOKEN}\nTG_CHAT=31337\n`)
  })
})

test('symlinked env file: setup writes through the link, which stays a symlink, and the target gets the new contents', async () => {
  await withHome(async (home, paths) => {
    const target = join(home, 'dotfiles', 'stolik.env')
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, 'TG_CHAT=-100777\n')
    mkdirSync(dirname(paths.envFile), { recursive: true })
    symlinkSync(target, paths.envFile)
    const { deps } = fakeDeps(paths, [TOKEN, '4242'])
    assert.equal(await runSetup(deps), 0)
    assert.equal(lstatSync(paths.envFile).isSymbolicLink(), true, 'the link is kept')
    assert.equal(readFileSync(target, 'utf8'), `TG_CHAT=-100777\nSTOLIK_TOKEN=${TOKEN}\n`)
    assert.equal(statSync(target).mode & 0o777, 0o600)
    assert.deepEqual(readdirSync(dirname(target)), ['stolik.env'], 'no temp file is left behind')
  })
})

test('writeFileAtomic: a dangling symlink is followed to its target, which is created', async () => {
  await withHome(async (home, paths) => {
    const target = join(home, 'real', 'config.json')
    mkdirSync(dirname(paths.configFile), { recursive: true })
    symlinkSync(target, paths.configFile)
    writeFileAtomic(paths.configFile, '{}\n', 0o644)
    assert.equal(lstatSync(paths.configFile).isSymbolicLink(), true)
    assert.equal(readFileSync(target, 'utf8'), '{}\n')
  })
})

test('writeFileAtomic: a failed write removes its temp file and leaves the target alone', async () => {
  await withHome(async (home) => {
    // A directory at the target path makes the final rename fail after the temp file is written.
    const blocked = join(home, 'blocked.env')
    mkdirSync(blocked, { recursive: true })
    assert.throws(() => writeFileAtomic(blocked, 'STOLIK_TOKEN=x\n', 0o600))
    assert.deepEqual(readdirSync(home).filter((f) => f.endsWith('.tmp')), [])
    assert.equal(statSync(blocked).isDirectory(), true)
  })
})
