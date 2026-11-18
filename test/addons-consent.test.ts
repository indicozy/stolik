// The owner's consent to an addon's manifest (design §3.2, trust). A user addon runs only with the manifest the owner
// allowed: a changed manifest stops it until `tg-bridge addon consent <name>` on the PC, and nothing from Telegram can
// allow it. A built-in ships with the code: its manifest is trusted and its hash follows it.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AddonHost } from '../src/addons-host/host.ts'
import { consentHash, readManifest } from '../src/addons-host/manifest.ts'
import { DbAddonSettings, JsonAddonSettings } from '../src/addons-host/settings.ts'
import { runAddonCommand, type CliDeps, type RunResult } from '../src/cli/addon.ts'
import { FakeClock, MemorySettings, copyFixture, recordingLogger, removeDir, tmpDir, waitFor, writeEchoLike } from './helpers/addon-fakes.ts'

const pin = (file: string, args: string[]) => ({ file, args })
const OK: RunResult = { status: 0, stdout: '', stderr: '' }
const RE_CONSENT = 'needs re-consent: run tg-bridge addon consent addon-x on the PC'

// The settings with the consent record (MemorySettings in helpers predates it).
class Settings extends MemorySettings {
  readonly consents = new Map<string, string>()
  consentHash(name: string): string | null {
    return this.consents.get(name) ?? null
  }
  setConsentHash(name: string, hash: string): void {
    this.consents.set(name, hash)
  }
}

// The hash of the manifest as it is in a folder now.
function hashIn(folder: string, name: string): string {
  const r = readManifest(join(folder, name))
  if (!('manifest' in r)) throw new Error(r.error)
  return consentHash(r.manifest)
}

function hostOver(addonsDir: string, settings: Settings, builtinDir?: string) {
  const { lines, logger } = recordingLogger()
  const alerts: string[] = []
  const host = new AddonHost({ addonsDir, builtinDir, settings, clock: new FakeClock(), logger, alert: (t) => alerts.push(t), pin })
  return { host, lines, alerts }
}

const running = (host: AddonHost, name: string) => host.running().some((r) => r.name === name)

test('a user addon whose manifest changed after the owner allowed it is stopped, switched off, and cannot be enabled', async () => {
  const dir = tmpDir('consent-change')
  const addonsDir = join(dir, 'addons')
  try {
    writeEchoLike(addonsDir, 'addon-x', { access: ['message.text'] })
    const settings = new Settings()
    settings.setConsentHash('addon-x', hashIn(addonsDir, 'addon-x'))
    const allowed = settings.consentHash('addon-x')
    settings.setEnabled('addon-x', true)
    const { host } = hostOver(addonsDir, settings)
    try {
      await host.start()
      await waitFor(() => running(host, 'addon-x'), 'addon-x running')

      // The manifest now asks for more (it could read files now): the owner's yes does not cover it.
      writeEchoLike(addonsDir, 'addon-x', { access: ['message.text', 'message.files'] })
      const row = host.list().find((a) => a.name === 'addon-x')
      assert.equal(row?.status, RE_CONSENT)
      assert.equal(row?.enabled, false)
      assert.equal(running(host, 'addon-x'), false)
      assert.equal(settings.isEnabled('addon-x'), false)
      assert.equal(settings.consentHash('addon-x'), allowed, 'nothing was allowed')

      // Turning it on from /addons is refused with the way to allow it.
      assert.equal(await host.setEnabled('addon-x', true), `addon-x ${RE_CONSENT}.`)
      assert.equal(running(host, 'addon-x'), false)
      assert.equal(settings.isEnabled('addon-x'), false)
    } finally {
      await host.stop()
    }
  } finally {
    removeDir(dir)
  }
})

test('a user addon with no recorded consent (copied in by hand) is not started at start()', async () => {
  const dir = tmpDir('consent-none')
  const addonsDir = join(dir, 'addons')
  try {
    copyFixture('addon-echo', addonsDir)
    const settings = new Settings()
    settings.setEnabled('addon-echo', true)
    const { host } = hostOver(addonsDir, settings)
    try {
      await host.start()
      assert.equal(running(host, 'addon-echo'), false)
      assert.equal(host.list()[0].status, 'needs re-consent: run tg-bridge addon consent addon-echo on the PC')
      assert.equal(settings.isEnabled('addon-echo'), false)
    } finally {
      await host.stop()
    }
  } finally {
    removeDir(dir)
  }
})

test('a built-in whose manifest changed is trusted: it is not blocked, and its hash follows it without an alert', async () => {
  const dir = tmpDir('consent-builtin')
  const builtin = join(dir, 'builtin')
  const addonsDir = join(dir, 'addons')
  try {
    writeEchoLike(builtin, 'modes', { access: ['message.text', 'messages.send'] })
    const settings = new Settings()
    settings.setConsentHash('modes', 'hash-of-an-older-build')
    const { host, alerts } = hostOver(addonsDir, settings, builtin)
    try {
      assert.equal(await host.setEnabled('modes', true), null)
      await waitFor(() => running(host, 'modes'), 'modes running')
      assert.equal(settings.consentHash('modes'), hashIn(builtin, 'modes'), 'the hash now matches the built-in manifest')
      assert.equal(alerts.length, 0)
    } finally {
      await host.stop()
    }
  } finally {
    removeDir(dir)
  }
})

test('a built-in with no recorded hash gets one on first sight, silently', async () => {
  const dir = tmpDir('consent-builtin-new')
  const builtin = join(dir, 'builtin')
  try {
    writeEchoLike(builtin, 'notes', {})
    const settings = new Settings()
    const { host, alerts } = hostOver(join(dir, 'addons'), settings, builtin)
    assert.equal(host.list()[0].status, 'off')
    assert.equal(settings.consentHash('notes'), hashIn(builtin, 'notes'))
    assert.equal(alerts.length, 0)
  } finally {
    removeDir(dir)
  }
})

// ---------- the consent command (tg-bridge addon consent <name>) ----------

type Rig = { deps: CliDeps; out: string[]; err: string[]; prompts: string[]; outAtPrompt: number[]; settings: Settings }

function rig(addonsDir: string, answer = 'yes', builtinDir?: string): Rig {
  const out: string[] = []
  const err: string[] = []
  const prompts: string[] = []
  const outAtPrompt: number[] = []
  const settings = new Settings()
  const deps: CliDeps = {
    addonsDir,
    builtinDir,
    settings,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    confirm: async (p) => {
      prompts.push(p)
      outAtPrompt.push(out.length)
      return answer
    },
    run: (): RunResult => OK,
  }
  return { deps, out, err, prompts, outAtPrompt, settings }
}

test('consent: the installed manifest and the listener warning are shown before the prompt; without the typed yes nothing is recorded', async () => {
  const dir = tmpDir('consent-cli-no')
  const addonsDir = join(dir, 'addons')
  try {
    writeEchoLike(addonsDir, 'addon-x', { provides: [{ point: 'listener' }], access: ['message.text'] })
    const r = rig(addonsDir, ' no ')
    assert.equal(await runAddonCommand(['consent', 'addon-x'], r.deps), 1)
    const shown = r.out.slice(0, r.outAtPrompt[0]).join('\n')
    assert.match(shown, /addon-x 0\.1\.0 asks for:/)
    assert.match(shown, /WARNING: addon-x is a LISTENER/)
    assert.equal(r.prompts.length, 1)
    assert.ok(r.out.some((l) => /Cancelled\. Nothing was changed\./.test(l)))
    assert.equal(r.settings.consentHash('addon-x'), null)
  } finally {
    removeDir(dir)
  }
})

test('consent: a typed yes records the hash of the installed manifest; the addon then turns on through /addons', async () => {
  const dir = tmpDir('consent-cli-yes')
  const addonsDir = join(dir, 'addons')
  try {
    writeEchoLike(addonsDir, 'addon-x', { access: ['message.text'] })
    const r = rig(addonsDir, 'yes')
    assert.equal(await runAddonCommand(['consent', 'addon-x'], r.deps), 0)
    assert.equal(r.settings.consentHash('addon-x'), hashIn(addonsDir, 'addon-x'))
    assert.equal(r.settings.isEnabled('addon-x'), false, 'consent does not switch the addon on')
    assert.ok(r.out.some((l) => /Allowed addon-x 0\.1\.0\. It is still off/.test(l)))

    // The same settings, a fresh host (the router picks the consent up on its next look at the folder).
    const { host } = hostOver(addonsDir, r.settings)
    try {
      assert.equal(await host.setEnabled('addon-x', true), null)
      await waitFor(() => running(host, 'addon-x'), 'addon-x running after consent')
    } finally {
      await host.stop()
    }
  } finally {
    removeDir(dir)
  }
})

test('consent: a changed manifest needs a fresh consent, and the new one is recorded', async () => {
  const dir = tmpDir('consent-cli-again')
  const addonsDir = join(dir, 'addons')
  try {
    writeEchoLike(addonsDir, 'addon-x', { access: ['message.text'] })
    const first = rig(addonsDir, 'yes')
    await runAddonCommand(['consent', 'addon-x'], first.deps)
    writeEchoLike(addonsDir, 'addon-x', { access: ['message.text', 'sessions.names'] })
    const again = rig(addonsDir, 'yes')
    again.settings.consents.set('addon-x', first.settings.consentHash('addon-x') as string)
    assert.equal(await runAddonCommand(['list'], again.deps), 0)
    assert.match(again.out.join('\n'), /^addon-x 0\.1\.0  needs consent/m)
    assert.equal(await runAddonCommand(['consent', 'addon-x'], again.deps), 0)
    assert.equal(again.settings.consentHash('addon-x'), hashIn(addonsDir, 'addon-x'))
  } finally {
    removeDir(dir)
  }
})

test('consent: a built-in name, a missing addon, and a folder whose manifest name differs are refused, with no prompt', async () => {
  const dir = tmpDir('consent-cli-bad')
  const addonsDir = join(dir, 'addons')
  const builtin = join(dir, 'builtin')
  try {
    writeEchoLike(builtin, 'modes', {})
    writeEchoLike(addonsDir, 'wrong', { name: 'right' })
    const r = rig(addonsDir, 'yes', builtin)
    assert.equal(await runAddonCommand(['consent', 'nothing-here'], r.deps), 1)
    assert.equal(await runAddonCommand(['consent', 'modes'], r.deps), 1)
    assert.equal(await runAddonCommand(['consent', 'wrong'], r.deps), 1)
    assert.match(r.err.join('\n'), /must be named right/)
    assert.equal(r.prompts.length, 0)
    assert.equal(r.settings.consentHash('modes'), null)
    assert.equal(r.settings.consentHash('wrong'), null)
  } finally {
    removeDir(dir)
  }
})

// ---------- the two settings stores ----------

test('JsonAddonSettings: the consent hash round trips, stays apart from enable state and flags, and an old file reads as none', () => {
  const dir = tmpDir('consent-json')
  const path = join(dir, 'addons.json')
  try {
    const s = new JsonAddonSettings(path)
    s.setEnabled('a', true)
    s.setConsentHash('a', 'h1')
    s.setFlag('offered')
    assert.equal(s.consentHash('a'), 'h1')
    assert.equal(s.consentHash('b'), null)
    assert.equal(s.isEnabled('a'), true)
    assert.equal(s.hasChoice('a'), true)
    assert.equal(s.getFlag('offered'), true)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { a: true, '#a': 'h1', '@offered': true })

    writeFileSync(path, JSON.stringify({ a: true, '@x': true }))
    const old = new JsonAddonSettings(path)
    assert.equal(old.consentHash('a'), null)
    assert.equal(old.isEnabled('a'), true)
  } finally {
    removeDir(dir)
  }
})

test('DbAddonSettings: the consent hash is stored under the addon name with key consent', () => {
  const values = new Map<string, string>()
  const db = {
    getAddonSetting: (addon: string, key: string) => values.get(`${addon}\u0000${key}`) ?? null,
    setAddonSetting: (addon: string, key: string, value: string) => void values.set(`${addon}\u0000${key}`, value),
  }
  const s = new DbAddonSettings(db)
  assert.equal(s.consentHash('voice'), null)
  s.setConsentHash('voice', 'h2')
  assert.equal(values.get('voice\u0000consent'), 'h2')
  assert.equal(s.consentHash('voice'), 'h2')
  assert.equal(s.hasChoice('voice'), false, 'a consent is not a choice of on or off')
})
