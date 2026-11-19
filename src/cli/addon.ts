// `stolik addon add | list | remove` (plan 2.10). Install fetches the addon into a staging folder inside the addons
// folder, validates it, shows what it may see, and moves it into place only after the typed yes. Nothing is installed
// from Telegram.
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { consentHash, readManifest, type Manifest } from '../addons-host/manifest.ts'
import { consentGiven, CONSENT_PROMPT, describeAccess, listenerWarning, RECONSENT_PROMPT } from '../addons-host/consent.ts'
import type { AddonSettings } from '../addons-host/settings.ts'
import { isDirectory } from '../brain/common.ts'

export type RunResult = { status: number | null; stdout: string; stderr: string }

export type CliDeps = {
  // `<config dir>/addons`.
  addonsDir: string
  // The built-in addons folder (`dist/addons`). A user addon cannot take a built-in's name, and a built-in counts as an
  // installed requirement.
  builtinDir?: string
  settings: AddonSettings
  out: (line: string) => void
  err: (line: string) => void
  // Shows the prompt and resolves with the one line typed back ('' when stdin is closed).
  confirm: (prompt: string) => Promise<string>
  // Runs a program and collects its output (git, npm, tar).
  run: (file: string, args: string[]) => RunResult
}

export type SourceKind = 'folder' | 'git' | 'npm'

const GIT_RE = /^(https?:\/\/|ssh:\/\/|git:\/\/|file:\/\/|git@)|\.git$/
// npm names never start with a dash, so a name can never be read as an option of npm or git.
const NPM_RE = /^(@[a-z0-9~][a-z0-9-._~]*\/)?[a-z0-9~][a-z0-9-._~]*(@[^\s]+)?$/

// What an install argument is: an existing folder, a git URL, or an npm package name. Null when it is none of these.
export function classifySource(src: string, isDir: (p: string) => boolean = (p) => isDirectory(p)): SourceKind | null {
  if (isDir(resolve(src))) return 'folder'
  if (GIT_RE.test(src)) return 'git'
  if (NPM_RE.test(src)) return 'npm'
  return null
}

// A built-in addon of this name ships with stolik (its folder under the built-in folder).
function isBuiltin(name: string, deps: CliDeps): boolean {
  return deps.builtinDir !== undefined && isDirectory(join(deps.builtinDir, name))
}


const usage = [
  'usage:',
  '  stolik addon add <git url | npm name | folder>   install after showing what it may see (type yes)',
  '  stolik addon list                               installed addons and whether they are on',
  '  stolik addon remove <name>                      delete an installed addon',
  '  stolik addon consent <name>                     allow an installed addon whose manifest changed (type yes)',
  'Turn an addon on or off in Telegram with /addons.',
].join('\n')

export async function runAddonCommand(args: string[], deps: CliDeps): Promise<number> {
  const [cmd, ...rest] = args
  if (cmd === 'add' && rest.length === 1) return install(rest[0], deps)
  if (cmd === 'list' && rest.length === 0) return list(deps)
  if (cmd === 'remove' && rest.length === 1) return remove(rest[0], deps)
  if (cmd === 'consent' && rest.length === 1) return consent(rest[0], deps)
  deps.err(usage)
  return 2
}

// Fetches `src` into `dir` (a fresh folder under the staging area). Returns an error text, or null.
function fetchInto(kind: SourceKind, src: string, staging: string, dir: string, deps: CliDeps): string | null {
  if (kind === 'folder') {
    cpSync(resolve(src), dir, { recursive: true, filter: (p) => basename(p) !== '.git' })
    return null
  }
  if (kind === 'git') {
    const r = deps.run('git', ['clone', '--depth', '1', '--', src, dir])
    if (r.status !== 0) return `git clone failed: ${r.stderr.trim().split('\n').pop() ?? 'unknown error'}`
    rmSync(join(dir, '.git'), { recursive: true, force: true })
    return null
  }
  // npm: pack the package without running its scripts, then unpack the tarball.
  const packed = deps.run('npm', ['pack', src, '--pack-destination', staging, '--ignore-scripts', '--silent'])
  if (packed.status !== 0) return `npm pack failed: ${packed.stderr.trim().split('\n').pop() ?? 'unknown error'}`
  const tgz = packed.stdout.trim().split('\n').pop() ?? ''
  if (!tgz) return 'npm pack printed no file name'
  mkdirSync(dir, { recursive: true })
  const tar = deps.run('tar', ['-xzf', join(staging, basename(tgz)), '-C', dir, '--strip-components=1'])
  if (tar.status !== 0) return `unpacking failed: ${tar.stderr.trim().split('\n').pop() ?? 'unknown error'}`
  return null
}

async function install(src: string, deps: CliDeps): Promise<number> {
  const kind = classifySource(src)
  if (!kind) {
    deps.err(`${src} is not a folder, a git URL or an npm package name.`)
    return 1
  }
  const staging = join(deps.addonsDir, `.staging-${randomBytes(6).toString('hex')}`)
  const dir = join(staging, 'addon')
  try {
    mkdirSync(staging, { recursive: true, mode: 0o700 })
    const fetchError = fetchInto(kind, src, staging, dir, deps)
    if (fetchError) {
      deps.err(fetchError)
      return 1
    }
    const r = readManifest(dir)
    if ('error' in r) {
      deps.err(`Not installed: ${r.error}`)
      return 1
    }
    const m: Manifest = r.manifest
    if (isBuiltin(m.name, deps)) {
      deps.err(`Not installed: ${m.name} is the name of a built-in addon. Pick another name for it.`)
      return 1
    }
    const target = join(deps.addonsDir, m.name)
    if (existsSync(target)) {
      deps.err(`Not installed: ${m.name} is already installed. Remove it first with stolik addon remove ${m.name}.`)
      return 1
    }
    // A required addon counts as present when it is installed here or ships as a built-in.
    const missing = m.requires.filter((req) => !isDirectory(join(deps.addonsDir, req)) && !isBuiltin(req, deps))
    if (missing.length > 0) {
      deps.err(`Not installed: ${m.name} needs ${missing.join(', ')}. Install ${missing.length > 1 ? 'them' : 'it'} first.`)
      return 1
    }
    for (const line of describeAccess(m)) deps.out(line)
    const warning = listenerWarning(m)
    if (warning) deps.out(warning)
    const answer = await deps.confirm(CONSENT_PROMPT)
    if (!consentGiven(answer)) {
      deps.out('Cancelled. Nothing was installed.')
      return 1
    }
    mkdirSync(deps.addonsDir, { recursive: true, mode: 0o700 })
    renameSync(dir, target)
    // The owner's yes covers exactly this manifest; the addon starts off whatever an old record said.
    deps.settings.setConsentHash(m.name, consentHash(m))
    deps.settings.setEnabled(m.name, false)
    deps.out(`Installed ${m.name} ${m.version}. It is off. Turn it on in Telegram with /addons.`)
    return 0
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

// Allows an installed addon whose manifest is not the one the owner allowed before (the host stops it until then). It
// shows what the installed manifest asks for, then needs the typed yes. The addon stays off: turn it on in Telegram.
async function consent(name: string, deps: CliDeps): Promise<number> {
  const dir = join(deps.addonsDir, name)
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(name) || !isDirectory(dir) || isBuiltin(name, deps)) {
    deps.err(`No installed addon named ${name}.`)
    return 1
  }
  const r = readManifest(dir)
  if ('error' in r) {
    deps.err(`Not allowed: ${r.error}`)
    return 1
  }
  const m = r.manifest
  if (m.name !== name) {
    deps.err(`Not allowed: the folder must be named ${m.name}.`)
    return 1
  }
  for (const line of describeAccess(m)) deps.out(line)
  const warning = listenerWarning(m)
  if (warning) deps.out(warning)
  const answer = await deps.confirm(RECONSENT_PROMPT)
  if (!consentGiven(answer)) {
    deps.out('Cancelled. Nothing was changed.')
    return 1
  }
  deps.settings.setConsentHash(name, consentHash(m))
  deps.out(`Allowed ${m.name} ${m.version}. It is still off. Turn it on in Telegram with /addons.`)
  return 0
}

// One line per installed addon: name, version, on or off, and what it provides. Broken ones say why.
function list(deps: CliDeps): number {
  const names = installedFolders(deps.addonsDir)
  if (names.length === 0) {
    deps.out('No addons installed.')
    return 0
  }
  for (const name of names) {
    const r = readManifest(join(deps.addonsDir, name))
    if ('error' in r) {
      deps.out(`${name}: invalid (${r.error})`)
      continue
    }
    const m = r.manifest
    const on = deps.settings.consentHash(name) !== consentHash(m) ? 'needs consent' : deps.settings.isEnabled(name) ? 'on' : 'off'
    deps.out(`${m.name} ${m.version}  ${on}  ${m.provides.map((p) => p.point).join(', ')}`)
  }
  return 0
}

function remove(name: string, deps: CliDeps): number {
  const dir = join(deps.addonsDir, name)
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(name) || !existsSync(dir)) {
    deps.err(`No installed addon named ${name}.`)
    return 1
  }
  const needed = installedFolders(deps.addonsDir).filter((other) => {
    if (other === name) return false
    const r = readManifest(join(deps.addonsDir, other))
    return 'manifest' in r && r.manifest.requires.includes(name)
  })
  if (needed.length > 0) {
    deps.err(`Not removed: ${needed.join(', ')} ${needed.length > 1 ? 'require' : 'requires'} ${name}.`)
    return 1
  }
  rmSync(dir, { recursive: true, force: true })
  deps.settings.setEnabled(name, false)
  deps.out(`Removed ${name}. A running router drops it on its next /addons.`)
  return 0
}

// Folder names in the addons folder, skipping the staging folders and anything hidden.
function installedFolders(addonsDir: string): string[] {
  try {
    return readdirSync(addonsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}
