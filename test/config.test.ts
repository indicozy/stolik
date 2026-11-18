import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultStateDir, envFilePath, expandHome, gpuEnv, loadConfig, loadTgConfig, OLD_STATE_DIR, parseTgConfig, pinned, pinPrefix, tgConfigPath } from '../src/config.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOG_ROOT = '~/Documents/notes/telegram'
const DEFAULTS = {
  groupId: null,
  ownerUserId: null,
  digestSchedule: 'request',
  presence: 'logind',
  cpuAffinity: null,
  nice: null,
  gpu: null,
  logRoot: LOG_ROOT,
  weeklyLimitPct: 99,
  routerAutoStart: 'confirm',
  startWhenNoSession: true,
  idleCloseMinutes: 60,
  nodePath: null,
  stateDir: null,
  socketPath: null,
  logLevel: 'info',
  logsTopic: true,
  shutdownTimeoutMs: 10000,
  askDelay: { desk: 60, away: 0 },
  claudeModel: null,
}
const OWNER = {
  groupId: -1001234567890,
  ownerUserId: '123456789',
  digestSchedule: 'request',
  presence: 'x11',
  logRoot: LOG_ROOT,
  cpuAffinity: '8-19',
  nice: 19,
  gpu: { cudaVisibleDevices: '1', cudaDeviceOrder: 'PCI_BUS_ID' },
  weeklyLimitPct: 99,
  routerAutoStart: 'confirm',
  startWhenNoSession: true,
  idleCloseMinutes: 60,
  nodePath: null,
  stateDir: null,
  socketPath: null,
  logLevel: 'info',
  logsTopic: true,
  shutdownTimeoutMs: 10000,
  askDelay: { desk: 60, away: 0 },
  claudeModel: null,
}

test('parseTgConfig: an empty object gives the defaults (logind, no pinning, no gpu config)', () => {
  assert.deepEqual(parseTgConfig({}), DEFAULTS)
})

test('parseTgConfig: the owner file parses as written', () => {
  assert.deepEqual(parseTgConfig(OWNER), OWNER)
})

test('parseTgConfig: invalid values are rejected and the error names the field', () => {
  const bad: Array<[string, unknown, RegExp]> = [
    ['presence', { presence: 'wayland' }, /presence/],
    ['cpuAffinity', { cpuAffinity: '8,x' }, /cpuAffinity/],
    ['nice', { nice: 25 }, /nice/],
    ['nice float', { nice: 1.5 }, /nice/],
    ['gpu order', { gpu: { cudaVisibleDevices: '1', cudaDeviceOrder: 'slow' } }, /gpu\.cudaDeviceOrder/],
    ['gpu devices', { gpu: { cudaVisibleDevices: 'one', cudaDeviceOrder: 'PCI_BUS_ID' } }, /gpu\.cudaVisibleDevices/],
    ['gpu missing key', { gpu: { cudaVisibleDevices: '1' } }, /gpu\.cudaDeviceOrder/],
    ['typo key', { presance: 'x11' }, /presance/],
    ['weekly limit high', { weeklyLimitPct: 101 }, /weeklyLimitPct/],
    ['weekly limit zero', { weeklyLimitPct: 0 }, /weeklyLimitPct/],
    ['weekly limit float', { weeklyLimitPct: 98.5 }, /weeklyLimitPct/],
    ['owner id not numeric', { ownerUserId: '@bob' }, /ownerUserId/],
    ['group id not integer', { groupId: 1.5 }, /groupId/],
    ['not an object', [], /\(root\)/],
  ]
  for (const [, raw, re] of bad) assert.throws(() => parseTgConfig(raw), re)
})

test('parseTgConfig: null means unset for the optional fields', () => {
  assert.deepEqual(parseTgConfig({ groupId: null, ownerUserId: null, cpuAffinity: null, nice: null, gpu: null }), DEFAULTS)
})

test('parseTgConfig: shutdownTimeoutMs defaults to 10000 and must be a positive integer', () => {
  assert.equal(parseTgConfig({}).shutdownTimeoutMs, 10000)
  assert.equal(parseTgConfig({ shutdownTimeoutMs: 4000 }).shutdownTimeoutMs, 4000)
  assert.throws(() => parseTgConfig({ shutdownTimeoutMs: 0 }), /shutdownTimeoutMs/)
  assert.throws(() => parseTgConfig({ shutdownTimeoutMs: -5 }), /shutdownTimeoutMs/)
  assert.throws(() => parseTgConfig({ shutdownTimeoutMs: 1.5 }), /shutdownTimeoutMs/)
})

test('parseTgConfig: askDelay defaults to desk 60 s and away 0 s; a partial object fills the other field; bad values throw', () => {
  assert.deepEqual(parseTgConfig({}).askDelay, { desk: 60, away: 0 })
  assert.deepEqual(parseTgConfig({ askDelay: { away: 5 } }).askDelay, { desk: 60, away: 5 })
  assert.deepEqual(parseTgConfig({ askDelay: { desk: 0, away: 3600 } }).askDelay, { desk: 0, away: 3600 })
  assert.throws(() => parseTgConfig({ askDelay: { desk: -1 } }), /askDelay\.desk/)
  assert.throws(() => parseTgConfig({ askDelay: { away: 3601 } }), /askDelay\.away/)
  assert.throws(() => parseTgConfig({ askDelay: { desk: 1.5 } }), /askDelay\.desk/)
  assert.throws(() => parseTgConfig({ askDelay: { desk: 60, extra: 1 } }), /askDelay/)
})

test('parseTgConfig: routerAutoStart accepts auto and off, and rejects yes', () => {
  assert.equal(parseTgConfig({ routerAutoStart: 'auto' }).routerAutoStart, 'auto')
  assert.equal(parseTgConfig({ routerAutoStart: 'off' }).routerAutoStart, 'off')
  assert.throws(() => parseTgConfig({ routerAutoStart: 'yes' }), /routerAutoStart/)
})

test('parseTgConfig: weeklyLimitPct defaults to 99 and accepts 1-100', () => {
  assert.equal(parseTgConfig({}).weeklyLimitPct, 99)
  assert.equal(parseTgConfig({ weeklyLimitPct: 1 }).weeklyLimitPct, 1)
  assert.equal(parseTgConfig({ weeklyLimitPct: 100 }).weeklyLimitPct, 100)
})

test('tgConfigPath: XDG_CONFIG_HOME when absolute, else ~/.config; a relative XDG value is ignored', () => {
  assert.equal(tgConfigPath({ XDG_CONFIG_HOME: '/srv/cfg' }, '/home/u'), '/srv/cfg/tg-bridge/config.json')
  assert.equal(tgConfigPath({}, '/home/u'), '/home/u/.config/tg-bridge/config.json')
  assert.equal(tgConfigPath({ XDG_CONFIG_HOME: 'rel' }, '/home/u'), '/home/u/.config/tg-bridge/config.json')
})

const DIR = join(dirname(fileURLToPath(import.meta.url)), '.tmp-config')

test('loadTgConfig: missing file gives the defaults; valid file is read; bad JSON and bad fields throw with the path', () => {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })
  try {
    assert.deepEqual(loadTgConfig(join(DIR, 'absent.json')), DEFAULTS)

    const good = join(DIR, 'good.json')
    writeFileSync(good, JSON.stringify(OWNER))
    assert.deepEqual(loadTgConfig(good), OWNER)

    const notJson = join(DIR, 'notjson.json')
    writeFileSync(notJson, '{ "presence": ')
    assert.throws(() => loadTgConfig(notJson), (e: Error) => e.message.includes(notJson) && /not valid JSON/.test(e.message))

    const badField = join(DIR, 'badfield.json')
    writeFileSync(badField, JSON.stringify({ nice: 40 }))
    assert.throws(() => loadTgConfig(badField), (e: Error) => e.message.includes(badField) && /nice/.test(e.message))
  } finally {
    rmSync(DIR, { recursive: true, force: true })
  }
})

test('pinPrefix: nice and taskset from config, empty when unset', () => {
  assert.deepEqual(pinPrefix(DEFAULTS), [])
  assert.deepEqual(pinPrefix(OWNER), ['nice', '-n', '19', 'taskset', '-c', '8-19'])
  assert.deepEqual(pinPrefix({ nice: 10, cpuAffinity: null }), ['nice', '-n', '10'])
  assert.deepEqual(pinPrefix({ nice: null, cpuAffinity: '0-3' }), ['taskset', '-c', '0-3'])
})

test('pinned: wraps the command in the prefix, or runs it bare when there is none', () => {
  assert.deepEqual(pinned(OWNER, 'claude', ['-p']), {
    file: 'nice',
    args: ['-n', '19', 'taskset', '-c', '8-19', 'claude', '-p'],
  })
  assert.deepEqual(pinned(DEFAULTS, 'claude', ['-p']), { file: 'claude', args: ['-p'] })
})

test('gpuEnv: the configured devices, or CPU-only (empty visible devices) when gpu is unset', () => {
  assert.deepEqual(gpuEnv(OWNER), { CUDA_DEVICE_ORDER: 'PCI_BUS_ID', CUDA_VISIBLE_DEVICES: '1' })
  assert.deepEqual(gpuEnv(DEFAULTS), { CUDA_VISIBLE_DEVICES: '' })
})

test('stateDir and socketPath: absolute or ~/ paths parse; a relative path is refused with the field named', () => {
  assert.equal(parseTgConfig({ stateDir: '~/state/v3', socketPath: '/run/x.sock' }).stateDir, '~/state/v3')
  assert.equal(parseTgConfig({ stateDir: '~/state/v3', socketPath: '/run/x.sock' }).socketPath, '/run/x.sock')
  assert.throws(() => parseTgConfig({ stateDir: 'state' }), /stateDir: must be an absolute path/)
  assert.throws(() => parseTgConfig({ socketPath: 'run.sock' }), /socketPath: must be an absolute path/)
})

test('defaultStateDir: $XDG_STATE_HOME/tg-bridge-v3 when absolute, else ~/.local/state/tg-bridge-v3; never the old folder', () => {
  assert.equal(defaultStateDir({ XDG_STATE_HOME: '/x/state' }, '/home/u'), '/x/state/tg-bridge-v3')
  assert.equal(defaultStateDir({ XDG_STATE_HOME: 'rel' }, '/home/u'), '/home/u/.local/state/tg-bridge-v3')
  assert.equal(defaultStateDir({}, '/home/u'), '/home/u/.local/state/tg-bridge-v3')
  assert.notEqual(defaultStateDir({}, '/home/u'), OLD_STATE_DIR)
})

test('expandHome: ~/ is the home folder; other paths are unchanged', () => {
  assert.equal(expandHome('~/a/b', '/home/u'), '/home/u/a/b')
  assert.equal(expandHome('/abs/c', '/home/u'), '/abs/c')
})

test('envFilePath: ~/.config/tg-bridge.env by default; TG_BRIDGE_ENV_FILE wins (absolute or ~/, expanded); anything else throws', () => {
  assert.equal(envFilePath({}, '/home/u'), '/home/u/.config/tg-bridge.env')
  assert.equal(envFilePath({ TG_BRIDGE_ENV_FILE: '' }, '/home/u'), '/home/u/.config/tg-bridge.env', 'an empty override is no override')
  assert.equal(envFilePath({ TG_BRIDGE_ENV_FILE: '/srv/trial.env' }, '/home/u'), '/srv/trial.env')
  assert.equal(envFilePath({ TG_BRIDGE_ENV_FILE: '~/trial/tg.env' }, '/home/u'), '/home/u/trial/tg.env')
  assert.throws(() => envFilePath({ TG_BRIDGE_ENV_FILE: 'trial.env' }, '/home/u'), /TG_BRIDGE_ENV_FILE must be an absolute path or start with ~\/: trial\.env/)
})

test('loadConfig: reads the token and chat from TG_BRIDGE_ENV_FILE; errors name the file actually read', () => {
  const home = mkdtempSync(join(HERE, '.tmp-config-'))
  try {
    mkdirSync(join(home, '.config'), { recursive: true })
    const trial = join(home, 'trial.env')
    writeFileSync(trial, 'TG_BRIDGE_TOKEN=123:trialtokentrialtokenXX\nTG_CHAT=-100777\n')
    // The default file holds a different token; the override must win.
    writeFileSync(join(home, '.config', 'tg-bridge.env'), 'TG_BRIDGE_TOKEN=123:defaulttokendefaulttokX\nTG_CHAT=-100111\n')
    const cfg = loadConfig({ TG_BRIDGE_ENV_FILE: '~/trial.env' }, home)
    assert.equal(cfg.token, '123:trialtokentrialtokenXX')
    assert.equal(cfg.chatId, '-100777')

    const missing = join(home, 'missing.env')
    assert.throws(() => loadConfig({ TG_BRIDGE_ENV_FILE: missing }, home), (e: Error) => e.message === `config error: TG_BRIDGE_TOKEN missing from ${missing}`)
    writeFileSync(join(home, 'nochat.env'), 'TG_BRIDGE_TOKEN=123:nochattokennochattokX\n')
    // No TG_CHAT and no owner: pairing-only (plan 0e), not an error.
    const noChat = loadConfig({ TG_BRIDGE_ENV_FILE: join(home, 'nochat.env') }, home)
    assert.equal(noChat.ownerUserId, null)
    assert.equal(noChat.chatId, '')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('parseTgConfig: logLevel takes debug, info, warn or error; logsTopic takes a boolean (design §Observability)', () => {
  assert.equal(parseTgConfig({ logLevel: 'warn' }).logLevel, 'warn')
  assert.equal(parseTgConfig({ logsTopic: false }).logsTopic, false)
  assert.throws(() => parseTgConfig({ logLevel: 'verbose' }), /logLevel/)
  assert.throws(() => parseTgConfig({ logsTopic: 'yes' }), /logsTopic/)
})
