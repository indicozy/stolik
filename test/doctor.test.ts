// `stolik doctor` checks (src/cli/doctor.ts): each check against fake inputs, the composed run, and the argument handling.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  checkAddons, checkClaude, checkConfig, checkDatabase, checkDisk, checkEnvFile, checkHookSelfTest, checkInstanceLock, checkMl, checkNode,
  checkPath, checkSchema, checkSocket, checkSystemd, checkUnitPaths, parseNodeVersion, runChecks, runDoctorCommand, freeAt,
  type DoctorDeps,
} from '../src/cli/doctor.ts'
import { ISOLATED_ROOT } from './helpers/isolate.ts'
import { tgChat } from '../src/adapters/chat/tg-ids.ts'
import { checkTelegram, type DoctorApi } from '../src/adapters/chat/telegram-doctor.ts'

const GIB = 1024 ** 3

function fakeDeps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  const exec = new Set(['/usr/bin/tmux', '/home/u/.local/bin/claude'])
  return {
    home: '/home/u',
    nodeVersion: 'v24.5.0',
    pathValue: '/usr/bin:/home/u/.local/bin',
    isExecutable: (f) => exec.has(f),
    claudeVersion: async () => '2.1.0 (Claude Code)',
    socketPath: '/run/user/1000/stolik.sock',
    dirWritable: () => true,
    envFileMode: () => 0o600,
    envFile: '/home/u/.config/stolik.env',
    envSettings: () => null,
    machineConfig: () => ({ ok: true, cfg: { groupId: null, logRoot: '/home/u/notes', stateDir: null } as never }),
    serviceUnits: () => [],
    repoDir: '/repo',
    addonDirs: [],
    addonEnabled: () => false,
    freeBytes: () => 10 * GIB,
    stateDir: '/home/u/.local/state/stolik',
    logRoot: '/home/u/notes/telegram',
    dbPath: '/home/u/.local/state/stolik/stolik.db',
    integrityCheck: () => 'ok',
    mlPython: '/repo/ml/.venv/bin/python',
    gpuPresent: () => true,
    cudaCount: async () => 1,
    gpu: { cudaVisibleDevices: '1', cudaDeviceOrder: 'PCI_BUS_ID' },
    ...over,
  }
}

test('node: 22.13 and newer pass; older fails and says why', () => {
  assert.deepEqual(parseNodeVersion('v24.5.0'), [24, 5, 0])
  assert.equal(checkNode('v22.13.0').status, 'ok')
  assert.equal(checkNode('v24.5.0').status, 'ok')
  assert.equal(checkNode('v22.12.9').status, 'fail')
  assert.equal(checkNode('v20.11.0').status, 'fail')
  assert.match(checkNode('v20.11.0').detail, /older than v22\.13/)
})

test('PATH: claude and tmux resolve on the PATH the router uses; each missing one fails', () => {
  const ok = checkPath(fakeDeps())
  assert.deepEqual(ok.map((c) => c.status), ['ok', 'ok'])
  assert.equal(ok[1].detail, '/usr/bin/tmux')
  const none = checkPath(fakeDeps({ pathValue: '/nowhere' }))
  assert.deepEqual(none.map((c) => c.status), ['fail', 'fail'])
})

test('unit PATH: the router unit of this checkout must find claude and tmux; unrelated units are ignored', () => {
  const routerUnit = '[Service]\nExecStart=/usr/bin/node /repo/dist/router/main.js\nEnvironment=PATH=/usr/bin:/home/u/.local/bin\n'
  const bad = '[Service]\nExecStart=/usr/bin/node /repo/dist/router/main.js\nEnvironment=PATH=/usr/bin\n'
  const other = '[Service]\nExecStart=/usr/bin/node /other/dist/router/main.js\nEnvironment=PATH=/nowhere\n'
  const ok = checkUnitPaths(fakeDeps({ serviceUnits: () => [{ name: 'stolik.service', text: routerUnit }, { name: 'x.service', text: other }] }))
  assert.equal(ok.length, 1)
  assert.equal(ok[0].status, 'ok')
  const fail = checkUnitPaths(fakeDeps({ serviceUnits: () => [{ name: 'v3.service', text: bad }] }))
  assert.equal(fail[0].status, 'fail')
  assert.match(fail[0].detail, /claude not found on the unit's PATH/)
  const none = checkUnitPaths(fakeDeps({ serviceUnits: () => [{ name: 'x.service', text: other }] }))
  assert.equal(none[0].status, 'ok')
  assert.match(none[0].detail, /nothing to compare/)
  // systemd's %h is the user's home: a unit PATH with ~/.local/bin (as the v3 unit writes it) finds claude there.
  const specUnit = '[Service]\nExecStart=/usr/bin/node /repo/dist/router/main.js\nEnvironment="PATH=/usr/bin:%h/.local/bin"\n'
  const spec = checkUnitPaths(fakeDeps({ home: '/home/u', serviceUnits: () => [{ name: 'v3.service', text: specUnit }] }))
  assert.equal(spec[0].status, 'ok')
  const noPath = checkUnitPaths(fakeDeps({ serviceUnits: () => [{ name: 'v3.service', text: '[Service]\nExecStart=/usr/bin/node /repo/dist/router/main.js\n' }] }))
  assert.equal(noPath[0].status, 'warn')
})

test('claude --version: runs or fails', async () => {
  assert.equal((await checkClaude(fakeDeps())).status, 'ok')
  assert.equal((await checkClaude(fakeDeps({ claudeVersion: async () => null }))).status, 'fail')
})

test('socket: the folder must be writable and the path must fit a Unix socket address', () => {
  assert.equal(checkSocket(fakeDeps()).status, 'ok')
  assert.equal(checkSocket(fakeDeps({ dirWritable: () => false })).status, 'fail')
  const long = checkSocket(fakeDeps({ socketPath: '/' + 'x'.repeat(120) + '/s.sock' }))
  assert.equal(long.status, 'fail')
  assert.match(long.detail, /allows 107/)
})

test('env file: present and mode 600 pass; other modes fail with the fix; settings errors name the problem', () => {
  const ok = checkEnvFile(fakeDeps())
  assert.deepEqual(ok.map((c) => c.status), ['ok', 'ok'])
  const loose = checkEnvFile(fakeDeps({ envFileMode: () => 0o644 }))
  assert.equal(loose[0].status, 'fail')
  assert.match(loose[0].detail, /mode 644; run chmod 600/)
  const missing = checkEnvFile(fakeDeps({ envFileMode: () => null }))
  assert.equal(missing.length, 1)
  assert.equal(missing[0].status, 'fail')
  const bad = checkEnvFile(fakeDeps({ envSettings: () => 'STOLIK_TOKEN missing from /x' }))
  assert.equal(bad[1].status, 'fail')
  assert.doesNotMatch(JSON.stringify(ok), /token=|chat=/i)
})

test('config: a valid machine config passes; an invalid one fails with its message', () => {
  assert.equal(checkConfig(fakeDeps()).status, 'ok')
  const bad = checkConfig(fakeDeps({ machineConfig: () => ({ ok: false, error: '/x/config.json: logLevel: invalid' }) }))
  assert.equal(bad.status, 'fail')
  assert.match(bad.detail, /logLevel/)
})

test('disk: state and log folders each report their free space with a threshold', () => {
  const ok = checkDisk(fakeDeps())
  assert.deepEqual(ok.map((c) => c.status), ['ok', 'ok'])
  const low = checkDisk(fakeDeps({ freeBytes: (p) => (p.includes('notes') ? 500 * 1024 ** 2 : 100 * 1024 ** 2) }))
  assert.equal(low[0].status, 'fail')
  assert.equal(low[1].status, 'warn')
  const unknown = checkDisk(fakeDeps({ freeBytes: () => null }))
  assert.equal(unknown[0].status, 'warn')
})

test('database: a missing file is fine on a first run; an integrity problem fails', () => {
  assert.equal(checkDatabase(fakeDeps({ dbPath: join(ISOLATED_ROOT, 'no-such.db') })).status, 'ok')
  const dbPath = join(ISOLATED_ROOT, 'present.db')
  writeFileSync(dbPath, 'x')
  assert.equal(checkDatabase(fakeDeps({ dbPath })).status, 'ok')
  assert.equal(checkDatabase(fakeDeps({ dbPath, integrityCheck: () => 'row 4 missing from index' })).status, 'fail')
  assert.match(checkDatabase(fakeDeps({ dbPath, integrityCheck: () => { throw new Error('file is not a database') } })).detail, /not a database/)
  rmSync(dbPath, { force: true })
})

test('addons: a bad manifest fails; an enabled addon whose requirement is missing fails; a good one passes', () => {
  const dir = join(ISOLATED_ROOT, 'doctor-addons')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'good'), { recursive: true })
  mkdirSync(join(dir, 'broken'), { recursive: true })
  mkdirSync(join(dir, 'needy'), { recursive: true })
  const manifest = (name: string, requires: string[]) => ({
    name, version: '0.1.0', protocol: 2, command: ['node', 'x.mjs'], provides: [{ point: 'text-filter' }], access: ['message.text'], requires,
  })
  writeFileSync(join(dir, 'good', 'stolik-addon.json'), JSON.stringify(manifest('good', [])))
  writeFileSync(join(dir, 'needy', 'stolik-addon.json'), JSON.stringify(manifest('needy', ['ml-worker'])))
  writeFileSync(join(dir, 'broken', 'stolik-addon.json'), '{ not json')
  const enabled = new Set(['good', 'needy'])
  const checks = checkAddons({ addonDirs: [dir], addonEnabled: (n) => enabled.has(n) })
  const byId = Object.fromEntries(checks.map((c) => [c.id, c]))
  assert.equal(byId['addon-broken'].status, 'fail')
  assert.equal(byId['addon-good'].status, 'ok')
  assert.equal(byId['addon-needy'].status, 'fail')
  assert.match(byId['addon-needy'].detail, /needs ml-worker/)
  assert.equal(checkAddons({ addonDirs: [join(ISOLATED_ROOT, 'no-dir')], addonEnabled: () => false })[0].detail, 'none installed')
  rmSync(dir, { recursive: true, force: true })
})

test('ml: no venv warns; no GPU configured is fine; a GPU that nvidia-smi cannot see warns; CUDA is asked only in the full run', async () => {
  const noPy = await checkMl(fakeDeps({ mlPython: null, gpu: null }), 'startup')
  assert.equal(noPy[0].status, 'warn')
  assert.equal(noPy[1].status, 'ok')
  const hidden = await checkMl(fakeDeps({ gpuPresent: () => false }), 'startup')
  assert.equal(hidden[1].status, 'warn')
  assert.equal(hidden.length, 2, 'no CUDA check at startup')
  const startup = await checkMl(fakeDeps(), 'startup')
  assert.equal(startup.length, 2)
  const full = await checkMl(fakeDeps(), 'full')
  assert.equal(full[2].status, 'ok')
  const none = await checkMl(fakeDeps({ cudaCount: async () => 0 }), 'full')
  assert.equal(none[2].status, 'warn')
  const unknown = await checkMl(fakeDeps({ cudaCount: async () => null }), 'full')
  assert.equal(unknown[2].status, 'warn')
})

test('telegram: a bad token fails and stops; a DM-mode run warns; a non-forum group, missing rights and a good admin', async () => {
  const api = (over: Partial<DoctorApi> = {}): DoctorApi => ({
    getMe: async () => ({ id: 9, username: 'bridge_bot' }),
    getChat: async () => ({ type: 'supergroup', is_forum: true }),
    getChatMember: async () => ({ status: 'administrator', can_manage_topics: true, can_pin_messages: true }),
    ...over,
  })
  const good = await checkTelegram({ api: api(), groupId: tgChat(-100) })
  assert.deepEqual(good.map((c) => [c.id, c.status]), [['token', 'ok'], ['group', 'ok']])
  assert.match(good[0].detail, /@bridge_bot/)
  const badToken = await checkTelegram({ api: api({ getMe: async () => { throw new Error('Call to getMe failed! (401: Unauthorized)') } }), groupId: tgChat(-100) })
  assert.deepEqual(badToken.map((c) => c.status), ['fail'])
  const dm = await checkTelegram({ api: api(), groupId: null })
  assert.equal(dm[1].status, 'warn')
  const notForum = await checkTelegram({ api: api({ getChat: async () => ({ type: 'supergroup', is_forum: false }) }), groupId: tgChat(-100) })
  assert.equal(notForum[1].status, 'fail')
  const noRights = await checkTelegram({ api: api({ getChatMember: async () => ({ status: 'administrator', can_manage_topics: true }) }), groupId: tgChat(-100) })
  assert.equal(noRights[1].status, 'fail')
  assert.match(noRights[1].detail, /can_pin_messages/)
  const boom = await checkTelegram({ api: api({ getChat: async () => { throw new Error('chat not found') } }), groupId: tgChat(-100) })
  assert.match(boom[1].detail, /chat not found/)
})

test('run: the startup scope skips the network and the CUDA probe; the full scope includes both', async () => {
  let cuda = 0
  let telegram = 0
  const deps = fakeDeps({
    cudaCount: async () => {
      cuda++
      return 1
    },
    chatDoctor: () => {
      telegram++
      return checkTelegram({ api: { getMe: async () => ({ id: 1 }), getChat: async () => ({ type: 'supergroup', is_forum: true }), getChatMember: async () => ({ status: 'creator' }) }, groupId: tgChat(-100) })
    },
  })
  const startup = await runChecks(deps, 'startup')
  assert.equal(telegram, 0)
  assert.equal(cuda, 0)
  assert.ok(!startup.some((c) => c.id === 'token'))
  const full = await runChecks(deps, 'full')
  assert.equal(telegram, 1)
  assert.equal(cuda, 1)
  assert.ok(full.some((c) => c.id === 'token' && c.status === 'ok'))
  assert.ok(full.every((c) => c.status !== 'fail'))
})

test('free space: the nearest existing parent is measured for a folder that does not exist yet', () => {
  assert.ok((freeAt(join(ISOLATED_ROOT, 'does', 'not', 'exist')) ?? 0) > 0)
  assert.equal(freeAt(join(ISOLATED_ROOT, 'x')) !== null, true)
})

test('the command: unknown arguments give the usage and exit 2 (no machine check is run)', async () => {
  const errs: string[] = []
  const code = await runDoctorCommand(['--verbose'], () => {}, (s) => errs.push(s))
  assert.equal(code, 2)
  assert.match(errs[0], /usage: stolik doctor/)
})

// ---------- lock, schema, systemd scope, read-mode hook self-test ----------

test('instance lock: held or free, reported as ok either way (it says where the router runs)', () => {
  const held = checkInstanceLock({ routerLockHeld: () => true })
  assert.equal(held[0].status, 'ok')
  assert.match(held[0].detail, /held/)
  assert.match(checkInstanceLock({ routerLockHeld: () => false })[0].detail, /free/)
  assert.deepEqual(checkInstanceLock({}), [], 'absent: not checked')
})

test('schema: no file yet is ok; the same version is ok; an older file warns (migrated at start); a newer one fails', () => {
  assert.equal(checkSchema({ schema: () => ({ found: null, needed: 4 }) })[0].status, 'ok')
  assert.equal(checkSchema({ schema: () => ({ found: 4, needed: 4 }) })[0].status, 'ok')
  const older = checkSchema({ schema: () => ({ found: 2, needed: 4 }) })[0]
  assert.equal(older.status, 'warn')
  assert.match(older.detail, /v2; this build is v4/)
  const newer = checkSchema({ schema: () => ({ found: 5, needed: 4 }) })[0]
  assert.equal(newer.status, 'fail')
  assert.match(newer.detail, /newer than this build/)
  assert.deepEqual(checkSchema({}), [])
})

test('systemd scope: both present is ok; no systemd-run or no user manager warns (tmux still starts)', async () => {
  assert.equal((await checkSystemd({ systemd: async () => ({ systemdRun: true, userManager: true }) }))[0].status, 'ok')
  const noRun = (await checkSystemd({ systemd: async () => ({ systemdRun: false, userManager: false }) }))[0]
  assert.equal(noRun.status, 'warn')
  assert.match(noRun.detail, /systemd-run is not on PATH/)
  const noManager = (await checkSystemd({ systemd: async () => ({ systemdRun: true, userManager: false }) }))[0]
  assert.equal(noManager.status, 'warn')
  assert.match(noManager.detail, /--user manager does not answer/)
  assert.deepEqual(await checkSystemd({}), [])
})

test('read-mode hook self-test: a hook that denies the secret read is ok; one that does not fails and says read is off', () => {
  assert.equal(checkHookSelfTest({ hookSelfTest: () => true })[0].status, 'ok')
  const bad = checkHookSelfTest({ hookSelfTest: () => false })[0]
  assert.equal(bad.status, 'fail')
  assert.match(bad.detail, /read and web stay off/)
  assert.deepEqual(checkHookSelfTest({}), [])
})

test('runChecks: the new checks are part of the composed run when their inputs are given', async () => {
  const deps = fakeDeps({
    routerLockHeld: () => false,
    schema: () => ({ found: 4, needed: 4 }),
    systemd: async () => ({ systemdRun: true, userManager: true }),
    hookSelfTest: () => true,
  })
  const ids = (await runChecks(deps, 'startup')).map((c) => c.id)
  for (const id of ['instance-lock', 'schema', 'systemd-run', 'hook-selftest']) assert.ok(ids.includes(id), `${id} is run`)
})
