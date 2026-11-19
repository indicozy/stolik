import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { consentHash, readManifest } from '../src/addons-host/manifest.ts'
import { classifySource, runAddonCommand, type CliDeps, type RunResult } from '../src/cli/addon.ts'
import { MemorySettings, copyFixture, removeDir, tmpDir, writeEchoLike } from './helpers/addon-fakes.ts'

const OK: RunResult = { status: 0, stdout: '', stderr: '' }

// The settings the install writes: MemorySettings (helpers) predates the consent record.
class Settings extends MemorySettings {
  readonly consents = new Map<string, string>()
  consentHash(name: string): string | null {
    return this.consents.get(name) ?? null
  }
  setConsentHash(name: string, hash: string): void {
    this.consents.set(name, hash)
  }
}

type Rig = { deps: CliDeps; out: string[]; err: string[]; prompts: string[]; outAtPrompt: number[]; settings: Settings }

function rig(addonsDir: string, answer: string | (() => string) = 'yes', run: CliDeps['run'] = () => OK, builtinDir?: string): Rig {
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
      return typeof answer === 'function' ? answer() : answer
    },
    run,
  }
  return { deps, out, err, prompts, outAtPrompt, settings }
}

test('classifySource: an existing folder, a git URL, an npm name, or none of them', () => {
  const dir = tmpDir('classify')
  try {
    const isDir = (p: string) => p === '/some/folder'
    assert.equal(classifySource('/some/folder', isDir), 'folder')
    assert.equal(classifySource('https://example.org/owner/addon.git', () => false), 'git')
    assert.equal(classifySource('git@example.org:owner/addon.git', () => false), 'git')
    assert.equal(classifySource('stolik-addon-foo', () => false), 'npm')
    assert.equal(classifySource('@scope/pkg@1.2.0', () => false), 'npm')
    assert.equal(classifySource('!!not a source', () => false), null)
    assert.equal(classifySource('--upload-pack=evil', () => false), null)
    assert.equal(classifySource('-rf', () => false), null)
    assert.equal(classifySource(dir, (p) => existsSync(p)), 'folder')
  } finally {
    removeDir(dir)
  }
})

test('add: without the typed yes nothing is installed, and the staging folder is removed', async () => {
  const work = tmpDir('add-no')
  const addonsDir = join(work, 'addons')
  try {
    const src = copyFixture('addon-echo', work)
    const r = rig(addonsDir, 'no')
    assert.equal(await runAddonCommand(['add', src], r.deps), 1)
    assert.ok(r.out.some((l) => /Cancelled\. Nothing was installed\./.test(l)))
    assert.equal(r.prompts.length, 1)
    assert.equal(existsSync(join(addonsDir, 'addon-echo')), false)
    assert.deepEqual(readdirSync(addonsDir).filter((n) => n.startsWith('.staging-')), [])
  } finally {
    removeDir(work)
  }
})

test('add: the access list is shown before the prompt; a typed yes installs it, off', async () => {
  const work = tmpDir('add-yes')
  const addonsDir = join(work, 'addons')
  try {
    const src = copyFixture('addon-echo', work)
    const r = rig(addonsDir, ' yes ')
    assert.equal(await runAddonCommand(['add', src], r.deps), 0)
    const shown = r.out.slice(0, r.outAtPrompt[0]).join('\n')
    assert.match(shown, /addon-echo 0\.1\.0 asks for:/)
    assert.match(shown, /read the text of your messages/)
    assert.match(shown, /see the names of your agent sessions/)
    assert.match(shown, /Addons run as your user with no sandbox/)
    assert.ok(existsSync(join(addonsDir, 'addon-echo', 'stolik-addon.json')))
    assert.equal(r.settings.isEnabled('addon-echo'), false)
    assert.ok(r.out.some((l) => /Installed addon-echo 0\.1\.0\. It is off\./.test(l)))
    assert.deepEqual(readdirSync(addonsDir).filter((n) => n.startsWith('.staging-')), [])

    const listed = rig(addonsDir)
    // The same store as the install (a fresh rig has none): the install's consent is what keeps it from "needs consent".
    listed.settings.setConsentHash('addon-echo', r.settings.consentHash('addon-echo') as string)
    assert.equal(await runAddonCommand(['list'], listed.deps), 0)
    assert.match(listed.out.join('\n'), /^addon-echo 0\.1\.0  off  media, text-filter/m)
  } finally {
    removeDir(work)
  }
})

test('add: a listener gets the loud warning before the prompt', async () => {
  const work = tmpDir('add-listener')
  const addonsDir = join(work, 'addons')
  try {
    const src = join(work, 'src')
    writeEchoLike(work, 'src', { provides: [{ point: 'listener' }] })
    const r = rig(addonsDir, 'no')
    assert.equal(await runAddonCommand(['add', src], r.deps), 1)
    const shown = r.out.slice(0, r.outAtPrompt[0]).join('\n')
    assert.match(shown, /WARNING: src is a LISTENER/)
  } finally {
    removeDir(work)
  }
})

test('add: an invalid manifest, a taken name, and a missing requirement are each refused, with no prompt', async () => {
  const work = tmpDir('add-bad')
  const addonsDir = join(work, 'addons')
  try {
    const broken = join(work, 'broken')
    mkdirSync(broken)
    writeFileSync(join(broken, 'stolik-addon.json'), JSON.stringify({ name: 'broken', protocol: 9 }))
    const r1 = rig(addonsDir)
    assert.equal(await runAddonCommand(['add', broken], r1.deps), 1)
    assert.match(r1.err.join('\n'), /Not installed: .*protocol/)

    const echo = copyFixture('addon-echo', work)
    assert.equal(await runAddonCommand(['add', echo], rig(addonsDir).deps), 0)
    const r2 = rig(addonsDir)
    assert.equal(await runAddonCommand(['add', echo], r2.deps), 1)
    assert.match(r2.err.join('\n'), /already installed/)
    assert.equal(r2.prompts.length, 0)

    const needy = join(work, 'needy')
    writeEchoLike(work, 'needy', { requires: ['not-installed'] })
    const r3 = rig(addonsDir)
    assert.equal(await runAddonCommand(['add', needy], r3.deps), 1)
    assert.match(r3.err.join('\n'), /needs not-installed/)
    assert.equal(r3.prompts.length, 0)
  } finally {
    removeDir(work)
  }
})

test('add: the install records the consent hash of the manifest it installed, and sets the addon off even if an old record said on', async () => {
  const work = tmpDir('add-consent')
  const addonsDir = join(work, 'addons')
  try {
    const src = copyFixture('addon-echo', work)
    const r = rig(addonsDir, 'yes')
    r.settings.setEnabled('addon-echo', true)
    assert.equal(await runAddonCommand(['add', src], r.deps), 0)
    const installed = readManifest(join(addonsDir, 'addon-echo'))
    assert.ok('manifest' in installed)
    assert.equal(r.settings.consentHash('addon-echo'), consentHash(installed.manifest))
    assert.equal(r.settings.isEnabled('addon-echo'), false)
  } finally {
    removeDir(work)
  }
})

test('add: a name that is a built-in addon is refused, with no prompt and nothing installed', async () => {
  const work = tmpDir('add-builtin-name')
  const addonsDir = join(work, 'addons')
  const builtin = join(work, 'builtin')
  try {
    writeEchoLike(builtin, 'modes', {})
    const src = join(work, 'src')
    writeEchoLike(work, 'src', { name: 'modes' })
    const r = rig(addonsDir, 'yes', undefined, builtin)
    assert.equal(await runAddonCommand(['add', src], r.deps), 1)
    assert.match(r.err.join('\n'), /modes is the name of a built-in addon/)
    assert.equal(r.prompts.length, 0)
    assert.equal(existsSync(join(addonsDir, 'modes')), false)
    assert.equal(r.settings.consentHash('modes'), null)
  } finally {
    removeDir(work)
  }
})

test('add: a required addon that ships as a built-in counts as present', async () => {
  const work = tmpDir('add-builtin-req')
  const addonsDir = join(work, 'addons')
  const builtin = join(work, 'builtin')
  try {
    writeEchoLike(builtin, 'ml-worker', { access: ['message.audio'] })
    const needy = join(work, 'needy')
    writeEchoLike(work, 'needy', { requires: ['ml-worker'] })
    const r = rig(addonsDir, 'yes', undefined, builtin)
    assert.equal(await runAddonCommand(['add', needy], r.deps), 0)
    assert.equal(r.prompts.length, 1)
    assert.equal(r.settings.isEnabled('needy'), false)

    const alone = rig(addonsDir, 'yes')
    const other = join(work, 'other')
    writeEchoLike(work, 'other', { requires: ['ml-worker'] })
    assert.equal(await runAddonCommand(['add', other], alone.deps), 1)
    assert.match(alone.err.join('\n'), /other needs ml-worker/)
  } finally {
    removeDir(work)
  }
})

test('add from git or npm: a failing fetch is reported and nothing is left behind', async () => {
  const work = tmpDir('add-remote')
  const addonsDir = join(work, 'addons')
  try {
    const git = rig(addonsDir, 'yes', () => ({ status: 128, stdout: '', stderr: 'fatal: repository not found\n' }))
    assert.equal(await runAddonCommand(['add', 'https://example.org/none/none.git'], git.deps), 1)
    assert.match(git.err.join('\n'), /git clone failed: fatal: repository not found/)

    const npm = rig(addonsDir, 'yes', (file) =>
      file === 'npm' ? { status: 0, stdout: 'pkg-1.0.0.tgz\n', stderr: '' } : { status: 2, stdout: '', stderr: 'tar: broken\n' },
    )
    assert.equal(await runAddonCommand(['add', 'stolik-addon-foo'], npm.deps), 1)
    assert.match(npm.err.join('\n'), /unpacking failed: tar: broken/)
    assert.equal(npm.prompts.length, 0)
    const left = existsSync(addonsDir) ? readdirSync(addonsDir).filter((n) => n.startsWith('.staging-')) : []
    assert.deepEqual(left, [])
  } finally {
    removeDir(work)
  }
})

test('remove: deletes the folder; a requirement of another addon blocks it; a bad name is refused', async () => {
  const work = tmpDir('remove')
  const addonsDir = join(work, 'addons')
  try {
    const echo = copyFixture('addon-echo', work)
    await runAddonCommand(['add', echo], rig(addonsDir, 'yes').deps)
    writeEchoLike(addonsDir, 'child-addon', { requires: ['addon-echo'] })
    const blocked = rig(addonsDir)
    assert.equal(await runAddonCommand(['remove', 'addon-echo'], blocked.deps), 1)
    assert.match(blocked.err.join('\n'), /child-addon requires addon-echo/)
    assert.equal(existsSync(join(addonsDir, 'addon-echo')), true)

    removeDir(join(addonsDir, 'child-addon'))
    const r = rig(addonsDir)
    assert.equal(await runAddonCommand(['remove', 'addon-echo'], r.deps), 0)
    assert.equal(existsSync(join(addonsDir, 'addon-echo')), false)
    assert.equal(await runAddonCommand(['remove', 'addon-echo'], r.deps), 1)
    assert.equal(await runAddonCommand(['remove', '../escape'], r.deps), 1)
  } finally {
    removeDir(work)
  }
})

test('usage: an unknown or incomplete command prints the usage and exits 2', async () => {
  const work = tmpDir('usage')
  try {
    const r = rig(join(work, 'addons'))
    assert.equal(await runAddonCommand([], r.deps), 2)
    assert.equal(await runAddonCommand(['add'], r.deps), 2)
    assert.equal(await runAddonCommand(['install', 'x'], r.deps), 2)
    assert.match(r.err.join('\n'), /usage:/)
  } finally {
    removeDir(work)
  }
})
