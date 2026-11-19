// Chat connector step 0e, batch 1: config `chat` section, owner pairing, setup. No network: the pairing driver is a fake.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkAttempt, hashCode, makeCode, newPairing, PAIR_MAX_WRONG, PAIR_TTL_MS, readPairing, startPairing, attemptPairing, pairingPath } from '../src/brain/pairing.ts'
import { loadConfig, parseTgConfig, resolveTelegramOwner, ConfigError } from '../src/config.ts'
import { PairingControl } from '../src/router/pairing-control.ts'
import { runSetup, parseSetupArgs, type SetupDeps } from '../src/cli/setup.ts'
import type { PairingDriver } from '../src/adapters/chat/telegram-setup.ts'

const TOKEN = '123456789:AAHfakeTokenForTestsOnly_abcdefgh'

// A temp home with the env file and config folder; returns the env for loadConfig and a cleanup.
function home(files: { env?: string; config?: object }) {
  const h = mkdtempSync(join(tmpdir(), 'tgb-0e-'))
  const env: NodeJS.ProcessEnv = { STOLIK_ENV_FILE: join(h, 'bridge.env'), XDG_CONFIG_HOME: join(h, 'xdg') }
  if (files.env !== undefined) writeFileSync(join(h, 'bridge.env'), files.env)
  if (files.config !== undefined) {
    mkdirSync(join(h, 'xdg', 'stolik'), { recursive: true })
    writeFileSync(join(h, 'xdg', 'stolik', 'config.json'), JSON.stringify(files.config))
  }
  return { h, env, cleanup: () => rmSync(h, { recursive: true, force: true }) }
}

// ---------- config ----------

test('live shape: env with token and TG_CHAT, config without a chat section resolves to the same token, owner and chat', () => {
  const t = home({
    env: `STOLIK_TOKEN=${TOKEN}\nTG_CHAT=424242\n`,
    config: { presence: 'logind', cpuAffinity: '8-19', nice: 19, gpu: { cudaVisibleDevices: '1', cudaDeviceOrder: 'PCI_BUS_ID' }, weeklyLimitPct: 99 },
  })
  try {
    const cfg = loadConfig(t.env, t.h)
    assert.equal(cfg.token, TOKEN)
    assert.equal(cfg.ownerUserId, '424242')
    assert.equal(cfg.chatId, '424242')
  } finally {
    t.cleanup()
  }
})

test('back-compat: owner from the top-level ownerUserId; chat section wins over it; TG_CHAT is the chat id', () => {
  const top = home({ env: `STOLIK_TOKEN=${TOKEN}\nTG_CHAT=-100555\n`, config: { ownerUserId: '111' } })
  try {
    const cfg = loadConfig(top.env, top.h)
    assert.equal(cfg.ownerUserId, '111')
    assert.equal(cfg.chatId, '-100555')
  } finally {
    top.cleanup()
  }
  const both = home({ env: `STOLIK_TOKEN=${TOKEN}\n`, config: { ownerUserId: '111', chat: { telegram: { ownerUserId: '222' } } } })
  try {
    const cfg = loadConfig(both.env, both.h)
    assert.equal(cfg.ownerUserId, '222')
    assert.equal(cfg.chatId, '222')
  } finally {
    both.cleanup()
  }
})

test('back-compat: notify TG_CHAT is the last owner fallback, as before', () => {
  const t = home({ env: `STOLIK_TOKEN=${TOKEN}\n`, config: {} })
  try {
    mkdirSync(join(t.h, '.config'), { recursive: true })
    writeFileSync(join(t.h, '.config', 'telegram-notify.env'), 'TG_CHAT=777\n')
    const cfg = loadConfig(t.env, t.h)
    assert.equal(cfg.ownerUserId, '777')
    assert.equal(cfg.chatId, '777')
  } finally {
    t.cleanup()
  }
})

test('config: a missing owner is pairing-only, not an error; a missing token is still one', () => {
  const none = home({ env: `STOLIK_TOKEN=${TOKEN}\n` })
  try {
    assert.equal(loadConfig(none.env, none.h).ownerUserId, null)
  } finally {
    none.cleanup()
  }
  const noToken = home({ env: 'TG_CHAT=1\n' })
  try {
    assert.throws(() => loadConfig(noToken.env, noToken.h), (e: unknown) => e instanceof ConfigError && /STOLIK_TOKEN missing/.test((e as Error).message))
  } finally {
    noToken.cleanup()
  }
})

test('config: chat section is accepted by the strict schema; unknown keys and unknown apps are refused', () => {
  assert.equal(parseTgConfig({ chat: { app: 'telegram', telegram: { ownerUserId: '5', homeId: 'tg:-100123' } } }).chat?.app, 'telegram')
  assert.equal(parseTgConfig({ chat: {} }).chat?.app, 'telegram', 'app defaults to telegram')
  assert.throws(() => parseTgConfig({ chat: { app: 'signal' } }), /app/)
  assert.throws(() => parseTgConfig({ chat: { telegram: { ownerUserId: '5', extra: 1 } } }))
  assert.throws(() => parseTgConfig({ chat: { telegram: { ownerUserId: 'abc' } } }), /numeric/)
  assert.throws(() => parseTgConfig({ chat: { telegram: { homeId: '-100123' } } }))
})

test('config: chat.app discord needs DISCORD_BOT_TOKEN (a ConfigError without it) and reads the discord section', () => {
  const none = home({ env: `STOLIK_TOKEN=${TOKEN}\n`, config: { chat: { app: 'discord' } } })
  try {
    assert.throws(() => loadConfig(none.env, none.h), (e: unknown) => e instanceof ConfigError && /DISCORD_BOT_TOKEN missing/.test((e as Error).message))
  } finally {
    none.cleanup()
  }
  const t = home({ env: 'DISCORD_BOT_TOKEN=x.y.z\n', config: { chat: { app: 'discord', discord: { ownerUserId: '800000000000000001', homeId: 'dc:g100000000000000001:l100000000000000002' } } } })
  try {
    const cfg = loadConfig(t.env, t.h)
    assert.equal(cfg.token, 'x.y.z')
    assert.deepEqual(cfg.discord, { ownerUserId: '800000000000000001', homeId: 'dc:g100000000000000001:l100000000000000002' })
  } finally {
    t.cleanup()
  }
})

test('resolveTelegramOwner: chat section, then top-level, then the env chat ids', () => {
  const tg = parseTgConfig({ ownerUserId: '3', chat: { telegram: { ownerUserId: '4' } } })
  assert.equal(resolveTelegramOwner(tg, '5', '6'), '4')
  assert.equal(resolveTelegramOwner(parseTgConfig({ ownerUserId: '3' }), '5', '6'), '3')
  assert.equal(resolveTelegramOwner(parseTgConfig({}), undefined, '6'), '6')
  assert.equal(resolveTelegramOwner(parseTgConfig({}), undefined, undefined), null)
})

// ---------- pairing (pure and file) ----------

test('pairing: a six-digit code, zero-padded; the injected source is used', () => {
  assert.equal(makeCode(() => 42), '000042')
  assert.equal(makeCode(() => 999_999), '999999')
  assert.match(makeCode(), /^\d{6}$/)
})

test('pairing: the right code pairs; the file is then done; the stored hash does not show the code', () => {
  const now = 1_000_000
  const f = newPairing('telegram', '123456', now, 'aa')
  assert.ok(!JSON.stringify(f).includes('123456'))
  assert.equal(f.codeHash, hashCode('123456', 'aa'))
  assert.deepEqual(checkAttempt(f, ' 123456 ', now + 1).verdict, 'paired')
  assert.deepEqual(checkAttempt(f, '123457', now + 1).verdict, 'wrong')
})

test('pairing: five wrong codes lock it; a wrong code keeps the count', () => {
  let f = newPairing('telegram', '123456', 0, 'bb')
  for (let i = 1; i < PAIR_MAX_WRONG; i++) {
    const r = checkAttempt(f, '000000', 1)
    assert.equal(r.verdict, 'wrong', `attempt ${i}`)
    f = r.next!
    assert.equal(f.wrong, i)
  }
  const fifth = checkAttempt(f, '000000', 2)
  assert.equal(fifth.verdict, 'locked')
  assert.equal(fifth.next, null, 'the file is deleted')
  assert.equal(checkAttempt({ ...f, wrong: PAIR_MAX_WRONG }, '123456', 2).verdict, 'locked', 'locked even with the right code')
})

test('pairing: expired after five minutes, whatever is sent', () => {
  const f = newPairing('telegram', '123456', 0, 'cc')
  assert.equal(checkAttempt(f, '123456', PAIR_TTL_MS - 1).verdict, 'paired')
  assert.equal(checkAttempt(f, '123456', PAIR_TTL_MS).verdict, 'expired')
})

test('pairing: attempts from the file: wrong keeps it, paired deletes it, a restart reloads the same pairing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tgb-pair-'))
  try {
    const code = startPairing(dir, 'telegram', 1000, '246810')
    assert.equal(code, '246810')
    assert.equal(attemptPairing(dir, '111111', 2000), 'wrong')
    // A restart is a new read of the file: the count and the code survive it.
    assert.equal(readPairing(dir)?.wrong, 1)
    assert.equal(attemptPairing(dir, '246810', 3000), 'paired')
    assert.equal(existsSync(pairingPath(dir)), false, 'deleted on success')
    assert.equal(attemptPairing(dir, '246810', 3001), 'closed', 'no pairing active: nothing counts')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pairing: the file is mode 600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tgb-pair-'))
  try {
    startPairing(dir, 'telegram')
    assert.equal(statSync(pairingPath(dir)).mode & 0o777, 0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- router side ----------

test('PairingControl: a match is reported to a waiting pair request; confirm yes makes the sender the owner, no does not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tgb-ctl-'))
  try {
    const applied: string[] = []
    const ctl = new PairingControl(dir, (id) => applied.push(id), () => 1000)
    startPairing(dir, 'telegram', 1000, '135790')
    const waiting = ctl.wait()
    const hook = ctl.hook()
    assert.equal(hook.attempt('nope'), 'wrong')
    assert.equal(hook.attempt('135790'), 'paired')
    hook.paired({ userId: '77', name: 'Ann', username: 'ann' })
    assert.deepEqual(await waiting, { ok: true, candidate: { userId: '77', name: 'Ann', username: 'ann' } })
    assert.deepEqual(ctl.confirm('88', true), { ok: false, error: 'no pairing waits for that user id' })
    assert.deepEqual(ctl.confirm('77', false), { ok: true })
    assert.deepEqual(applied, [], 'no answer, no owner')
    hook.paired({ userId: '77', name: 'Ann', username: null })
    assert.deepEqual(ctl.confirm('77', true), { ok: true })
    assert.deepEqual(applied, ['77'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('PairingControl: wait without an active code answers at once with the way to start one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tgb-ctl-'))
  try {
    const r = await new PairingControl(dir, () => {}).wait()
    assert.equal(r.ok, false)
    assert.match((r as { error: string }).error, /stolik setup --pair/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- setup (fakes) ----------

function setupPaths(h: string): SetupDeps['paths'] {
  return { envFile: join(h, 'bridge.env'), configFile: join(h, 'config.json'), pluginDir: '/p', nodePath: '/usr/bin/node' }
}

function fakeDriver(result: Awaited<ReturnType<PairingDriver['wait']>>) {
  const confirmed: Array<[string, boolean]> = []
  let begun = 0
  const driver: PairingDriver = {
    begin: async () => {
      begun += 1
      return { code: '112233', bot: '@testbot' }
    },
    wait: async () => result,
    confirm: async (id, yes) => {
      confirmed.push([id, yes])
    },
  }
  return { driver, confirmed, begun: () => begun }
}

function run(h: string, answers: string[], extra: Partial<SetupDeps> = {}) {
  const out: string[] = []
  const asked: string[] = []
  const next = (q: string) => {
    asked.push(q)
    return Promise.resolve(answers.shift() ?? '')
  }
  const deps: SetupDeps = { ask: next, askSecret: next, out: (l) => out.push(l), paths: setupPaths(h), ...extra }
  return { deps, out, asked, run: () => runSetup(deps) }
}

test('setup, fresh install: shows the code, asks the owner yes, then saves the owner as chat.telegram and TG_CHAT', async () => {
  const t = home({})
  try {
    const f = fakeDriver({ ok: true, candidate: { userId: '4242', name: 'Ann', username: null } })
    const r = run(t.h, [TOKEN, 'y'], { pairing: f.driver })
    assert.equal(await r.run(), 0)
    assert.ok(r.out.some((l) => l.includes('112233') && l.includes('@testbot')))
    assert.deepEqual(f.confirmed, [['4242', true]])
    assert.match(readFileSync(setupPaths(t.h).envFile, 'utf8'), /TG_CHAT=4242/)
    assert.equal(JSON.parse(readFileSync(setupPaths(t.h).configFile, 'utf8')).chat.telegram.ownerUserId, '4242')
  } finally {
    t.cleanup()
  }
})

test('setup, fresh install: a no answers, nothing is saved as owner, exit 1', async () => {
  const t = home({})
  try {
    const f = fakeDriver({ ok: true, candidate: { userId: '4242', name: 'Stranger', username: null } })
    const r = run(t.h, [TOKEN, 'n'], { pairing: f.driver })
    assert.equal(await r.run(), 1)
    assert.deepEqual(f.confirmed, [['4242', false]])
    assert.equal(existsSync(setupPaths(t.h).configFile) && /ownerUserId/.test(readFileSync(setupPaths(t.h).configFile, 'utf8')), false)
  } finally {
    t.cleanup()
  }
})

test('setup, an expired code: the error is shown, exit 1, no owner saved', async () => {
  const t = home({})
  try {
    const f = fakeDriver({ ok: false, error: 'the pairing code expired; run setup --pair again' })
    const r = run(t.h, [TOKEN], { pairing: f.driver })
    assert.equal(await r.run(), 1)
    assert.ok(r.out.some((l) => /expired/.test(l)))
    assert.equal(f.confirmed.length, 0)
  } finally {
    t.cleanup()
  }
})

test('setup, an existing owner (top-level or TG_CHAT) is never asked again; --pair starts a new pairing', async () => {
  const t = home({ env: `STOLIK_TOKEN=${TOKEN}\nTG_CHAT=555\n`, config: {} })
  try {
    const f = fakeDriver({ ok: true, candidate: { userId: '9', name: 'New', username: null } })
    const kept = run(t.h, [''], { pairing: f.driver })
    assert.equal(await kept.run(), 0)
    assert.equal(f.begun(), 0, 'no code is made for a paired install')
    assert.ok(kept.out.some((l) => /owner already paired \(id 555\)\. Run stolik setup --pair/.test(l)))
    assert.equal(kept.asked.length, 1, 'only the token is asked')

    const again = run(t.h, ['', 'y'], { pairing: f.driver, options: { pair: true } })
    assert.equal(await again.run(), 0)
    assert.equal(f.begun(), 1)
    assert.deepEqual(f.confirmed, [['9', true]])
  } finally {
    t.cleanup()
  }
})

test('setup: an unknown app and a bad --owner-id are refused', async () => {
  const t = home({})
  try {
    const u = run(t.h, [], { options: { chat: 'signal' } })
    assert.equal(await u.run(), 1)
    const b = run(t.h, [TOKEN], { options: { ownerId: 'x1' } })
    assert.equal(await b.run(), 1)
  } finally {
    t.cleanup()
  }
})

test('setup: flags parse; a flag without its value or an unknown flag is an error', () => {
  assert.deepEqual(parseSetupArgs(['--chat', 'telegram', '--pair', '--owner-id', '12']), { chat: 'telegram', pair: true, ownerId: '12' })
  assert.deepEqual(parseSetupArgs([]), {})
  assert.match(parseSetupArgs(['--chat']) as string, /needs a value/)
  assert.match(parseSetupArgs(['--nope']) as string, /unknown option/)
})
