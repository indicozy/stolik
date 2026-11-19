// Config errors (ConfigError), the chat id fallback to the owner's user id, the CPU list rule and the default socket path.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ConfigError, defaultSocketPath, loadConfig, loadTgConfig, parseTgConfig } from '../src/config.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const uid = process.getuid?.() ?? 0

// A home folder with an optional machine config (~/.config/stolik/config.json) and an env file for the token.
function setup(configJson?: unknown, envLines = 'STOLIK_TOKEN=123:fixturetokenfixturetokenX\n') {
  const home = mkdtempSync(join(HERE, '.tmp-config-errors-'))
  mkdirSync(join(home, '.config', 'stolik'), { recursive: true })
  const envFile = join(home, 'bridge.env')
  writeFileSync(envFile, envLines)
  if (configJson !== undefined) {
    writeFileSync(join(home, '.config', 'stolik', 'config.json'), typeof configJson === 'string' ? configJson : JSON.stringify(configJson))
  }
  return { home, env: { STOLIK_ENV_FILE: envFile }, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

test('loadConfig: without TG_CHAT the chat id is the owner user id from the machine config', () => {
  const { home, env, cleanup } = setup({ ownerUserId: '123456789' })
  try {
    const cfg = loadConfig(env, home)
    assert.equal(cfg.chatId, '123456789')
    assert.equal(cfg.token, '123:fixturetokenfixturetokenX')
  } finally {
    cleanup()
  }
})

test('loadConfig: TG_CHAT still wins over the owner user id', () => {
  const { home, env, cleanup } = setup({ ownerUserId: '123456789' }, 'STOLIK_TOKEN=123:fixturetokenfixturetokenX\nTG_CHAT=-100555\n')
  try {
    assert.equal(loadConfig(env, home).chatId, '-100555')
  } finally {
    cleanup()
  }
})

test('loadConfig: no TG_CHAT and no owner is pairing-only (plan 0e): no error, owner null, chat id empty', () => {
  const { home, env, cleanup } = setup()
  try {
    const cfg = loadConfig(env, home)
    assert.equal(cfg.ownerUserId, null)
    assert.equal(cfg.chatId, '')
  } finally {
    cleanup()
  }
})

test('loadConfig: a missing token is a ConfigError with the config error prefix', () => {
  const { home, env, cleanup } = setup(undefined, 'TG_CHAT=-100555\n')
  try {
    assert.throws(() => loadConfig(env, home), (e: unknown) => e instanceof ConfigError && e.message === `config error: STOLIK_TOKEN missing from ${env.STOLIK_ENV_FILE}`)
  } finally {
    cleanup()
  }
})

test('loadConfig: a bad machine config file stops it with a ConfigError (no silent fallback to the defaults)', () => {
  const { home, env, cleanup } = setup('{ "ownerUserId": ')
  try {
    assert.throws(() => loadConfig(env, home), (e: unknown) => e instanceof ConfigError && e.message.includes('config.json'))
  } finally {
    cleanup()
  }
})

test('loadTgConfig: invalid JSON throws a ConfigError that names the path and the parse error', () => {
  const dir = mkdtempSync(join(HERE, '.tmp-config-errors-'))
  try {
    const path = join(dir, 'config.json')
    writeFileSync(path, '{ "presence": ')
    assert.throws(
      () => loadTgConfig(path),
      (e: unknown) => e instanceof ConfigError && e.message.startsWith(`config error: ${path} is not valid JSON: `),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadTgConfig: a missing file gives the defaults, not an error', () => {
  const dir = mkdtempSync(join(HERE, '.tmp-config-errors-'))
  try {
    assert.equal(loadTgConfig(join(dir, 'absent.json')).presence, 'logind')
    assert.equal(loadTgConfig(join(dir, 'absent.json')).shutdownTimeoutMs, 10000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cpuAffinity: single CPUs and ascending ranges are accepted', () => {
  assert.equal(parseTgConfig({ cpuAffinity: '8-19' }).cpuAffinity, '8-19')
  assert.equal(parseTgConfig({ cpuAffinity: '0,2,8-10' }).cpuAffinity, '0,2,8-10')
  assert.equal(parseTgConfig({ cpuAffinity: '3' }).cpuAffinity, '3')
  assert.equal(parseTgConfig({ cpuAffinity: '4-4' }).cpuAffinity, '4-4')
})

test('cpuAffinity: a reversed range and a malformed list are refused, naming the field', () => {
  assert.throws(() => parseTgConfig({ cpuAffinity: '19-8' }), /cpuAffinity: ranges must ascend/)
  assert.throws(() => parseTgConfig({ cpuAffinity: '0,8-2' }), /cpuAffinity/)
  assert.throws(() => parseTgConfig({ cpuAffinity: '8,x' }), /cpuAffinity/)
  assert.throws(() => parseTgConfig({ cpuAffinity: '8-' }), /cpuAffinity/)
  assert.throws(() => parseTgConfig({ cpuAffinity: '' }), /cpuAffinity/)
})

test('cpuAffinity: a reversed range in the machine config is a ConfigError', () => {
  const dir = mkdtempSync(join(HERE, '.tmp-config-errors-'))
  try {
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({ cpuAffinity: '19-8' }))
    assert.throws(() => loadTgConfig(path), (e: unknown) => e instanceof ConfigError && /cpuAffinity/.test(e.message) && e.message.includes(path))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('defaultSocketPath: linux uses XDG_RUNTIME_DIR, else /run/user/<uid>', () => {
  assert.equal(defaultSocketPath({ XDG_RUNTIME_DIR: '/run/u/7' }, 'linux', '/home/u'), '/run/u/7/stolik.sock')
  assert.equal(defaultSocketPath({}, 'linux', '/home/u'), `/run/user/${uid}/stolik.sock`)
})

test('defaultSocketPath: darwin with XDG_RUNTIME_DIR uses it too', () => {
  assert.equal(defaultSocketPath({ XDG_RUNTIME_DIR: '/run/u/7' }, 'darwin', '/Users/u'), '/run/u/7/stolik.sock')
})

test('defaultSocketPath: darwin without XDG_RUNTIME_DIR uses the v3 state folder when the path is short', () => {
  assert.equal(defaultSocketPath({}, 'darwin', '/Users/u'), '/Users/u/.local/state/stolik/router.sock')
  assert.equal(defaultSocketPath({ XDG_STATE_HOME: '/x/state' }, 'darwin', '/Users/u'), '/x/state/stolik/router.sock')
})

test('defaultSocketPath: darwin keeps a path of exactly 100 bytes and moves a 101-byte one to TMPDIR', () => {
  // '/' + n a's + '/stolik/router.sock' is n + 20 bytes.
  const exact = `/${'a'.repeat(80)}/stolik/router.sock`
  assert.equal(Buffer.byteLength(exact), 100)
  assert.equal(defaultSocketPath({ XDG_STATE_HOME: `/${'a'.repeat(80)}` }, 'darwin', '/Users/u'), exact)

  const long = `/${'a'.repeat(81)}/stolik/router.sock`
  assert.equal(Buffer.byteLength(long), 101)
  assert.equal(defaultSocketPath({ XDG_STATE_HOME: `/${'a'.repeat(81)}`, TMPDIR: '/var/folders/T' }, 'darwin', '/Users/u'), `/var/folders/T/stolik-${uid}.sock`)
})

test('defaultSocketPath: darwin fallback uses TMPDIR without a trailing slash, and /tmp when TMPDIR is unset', () => {
  const longHome = `/Users/${'a'.repeat(90)}`
  assert.equal(defaultSocketPath({ TMPDIR: '/var/folders/T/' }, 'darwin', longHome), `/var/folders/T/stolik-${uid}.sock`)
  assert.equal(defaultSocketPath({}, 'darwin', longHome), `/tmp/stolik-${uid}.sock`)
})

test('importing config.ts with a bad config file does not throw; currentTgConfig() reports the ConfigError on demand', () => {
  // A fresh process: the module loads with the bad file in place, as a channel server or notify process would.
  const dir = mkdtempSync(join(HERE, '.tmp-config-errors-'))
  try {
    mkdirSync(join(dir, 'stolik'), { recursive: true })
    const bad = join(dir, 'stolik', 'config.json')
    writeFileSync(bad, '{ "cpuAffinity": "19-8" }')
    const src = pathToFileURL(join(HERE, '..', 'src', 'config.ts')).href
    const script = `const m = await import(${JSON.stringify(src)});
let e = null;
try { m.currentTgConfig() } catch (x) { e = { name: x.name, message: x.message } }
console.log(JSON.stringify({ loaded: typeof m.currentTgConfig, e }));`
    const out = execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
      env: { ...process.env, XDG_CONFIG_HOME: dir },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const r = JSON.parse(out.trim())
    assert.equal(r.loaded, 'function')
    assert.equal(r.e.name, 'ConfigError')
    assert.ok(r.e.message.startsWith('config error: '))
    assert.ok(r.e.message.includes(bad))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
