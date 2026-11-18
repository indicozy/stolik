// `tg-bridge doctor` (design §Observability): checks the install and the running configuration, and says what is wrong.
// Each check is a function of its inputs, so it is tested without the machine (test/doctor.test.ts). The router runs the
// checks that need no network at start-up (scope "startup") and posts failures to the Logs topic. Exit code 1 when a
// check fails; warnings do not fail. Secrets are never printed: the env file is checked by its mode, not its contents.
import { execFile, spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  REPO_DIR, SOCKET_PATH, STATE_DIR, chatLogRoot, envFilePath, loadConfig, loadTgConfig, parseTgConfig, tgConfigDir, tgConfigPath, type TgConfig,
} from '../config.ts'
import { readManifest } from '../addons-host/manifest.ts'
import { MIGRATIONS, DB_FILE, ReadOnlyStore, integrityCheck } from '../adapters/store-sqlite.ts'
import { routerLockHeld, routerLockPid } from '../adapters/instance-lock.ts'
import { readRouterCgroup, type RouterCgroupFacts } from '../adapters/cgroup.ts'
import { defaultLaunchDeps } from '../adapters/tmux.ts'
import { selfTestInput, selfTestPasses } from '../brain/hook-policy.ts'
import { redact } from '../brain/common.ts'
import type { ChatId } from '../brain/chat-types.ts'
import { fromDbChat } from '../adapters/store-ids.ts'
import { checkTelegram, checkTelegramPrivacy, telegramFor } from '../adapters/chat/telegram-doctor.ts'
import {
  SOCKET_PATH_MAX_BYTES, checksJson, diskStatus, formatChecks, resolveOnPath, summarizeChecks, unitExecStart, unitPathValue,
  type Check, type CheckStatus,
} from '../brain/observe.ts'

export type DoctorScope = 'startup' | 'full'

// Everything the checks read from the machine. The CLI builds the real one (buildDoctorDeps); tests build fakes.
export type DoctorDeps = {
  nodeVersion: string
  pathValue: string | undefined
  isExecutable: (file: string) => boolean
  // Output of `claude --version` (first line), or null when it does not run.
  claudeVersion: () => Promise<string | null>
  socketPath: string
  // Whether a directory exists and is writable.
  dirWritable: (dir: string) => boolean
  // The env file's permission bits, or null when it does not exist.
  envFileMode: (path: string) => number | null
  envFile: string
  // Config: the env-file settings (loadConfig) and the machine config (loadTgConfig). Errors are messages without secrets.
  envSettings: () => string | null
  // Whether an owner is paired (the config or the env file names one). Absent: not checked.
  ownerPaired?: () => boolean
  machineConfig: () => { ok: true; cfg: TgConfig } | { ok: false; error: string }
  // The systemd user units of this machine: name and text, for the units that run this checkout's router.
  serviceUnits: () => Array<{ name: string; text: string }>
  repoDir: string
  // The user's home folder: systemd's %h in a unit's PATH.
  home: string
  // Addon folders (built-in and the user's) and whether an addon is enabled in the store.
  addonDirs: string[]
  addonEnabled: (name: string) => boolean
  // Free bytes at a path (or of the nearest existing parent), or null when unknown.
  freeBytes: (path: string) => number | null
  stateDir: string
  logRoot: string
  dbPath: string
  integrityCheck: (path: string) => string
  mlPython: string | null
  // nvidia-smi sees the GPU at this index.
  gpuPresent: (index: string) => boolean
  // CUDA devices the ML venv's Python sees on the configured GPU, or null when it cannot be asked.
  cudaCount: () => Promise<number | null>
  gpu: { cudaVisibleDevices: string; cudaDeviceOrder: string } | null
  // The chat app's own checks (adapters/chat/telegram-doctor.ts for Telegram: the token, the group). Run in the full scope
  // only. Absent: the network checks are skipped.
  chatDoctor?: () => Promise<Check[]>
  // The chat app's privacy checks (group: 'privacy'; decision 12). Run in both scopes: the router runs them at start and
  // reports their failures once to the owner. Absent: not checked.
  chatPrivacy?: () => Promise<Check[]>
  // The router's instance lock: true while a router runs from this state folder. Absent: not checked.
  routerLockHeld?: () => boolean
  // The schema version the database file holds (null: no file or no version yet) and the one this build needs.
  schema?: () => { found: number | null; needed: number }
  // systemd-run on PATH, and whether the systemd --user manager answers (the tmux server's own scope).
  systemd?: () => Promise<{ systemdRun: boolean; userManager: boolean }>
  // The read-mode hook run on its self-test input: true when it answers the deny JSON (the modes addon checks the same).
  hookSelfTest?: () => boolean
  // The router's cgroup and the processes in it that are not the router's tree; null when no router runs or it cannot be
  // read. Absent: not checked.
  routerCgroup?: () => RouterCgroupFacts | null
}

const MIN_NODE = [22, 13] as const

export function parseNodeVersion(v: string): number[] {
  return v.replace(/^v/, '').split('.').map((n) => Number(n))
}

export function checkNode(version: string): Check {
  const have = parseNodeVersion(version)
  const ok = have[0] > MIN_NODE[0] || (have[0] === MIN_NODE[0] && have[1] >= MIN_NODE[1])
  return {
    id: 'node',
    title: 'node version',
    status: ok ? 'ok' : 'fail',
    detail: ok ? version : `${version} is older than v${MIN_NODE.join('.')}; node:sqlite needs it`,
  }
}

// claude and tmux on PATH, as the router and the tmux launcher find them. A missing tmux fails (no session can start);
// a missing claude fails for the same reason.
export function checkPath(d: Pick<DoctorDeps, 'pathValue' | 'isExecutable'>): Check[] {
  const claude = resolveOnPath('claude', d.pathValue, d.isExecutable)
  const tmux = resolveOnPath('tmux', d.pathValue, d.isExecutable)
  const out: Check[] = [
    {
      id: 'path-claude',
      title: 'claude on PATH',
      status: claude ? 'ok' : 'fail',
      detail: claude ?? 'not found on PATH; router-started sessions cannot run',
    },
    {
      id: 'path-tmux',
      title: 'tmux on PATH',
      status: tmux ? 'ok' : 'fail',
      detail: tmux ?? 'not found on PATH; router-started sessions cannot run',
    },
  ]
  return out
}

// The PATH of each systemd unit that runs this checkout's router: claude and tmux must resolve on it too, because the
// router runs under systemd, which does not read the shell's PATH.
export function checkUnitPaths(d: Pick<DoctorDeps, 'serviceUnits' | 'repoDir' | 'isExecutable' | 'home'>): Check[] {
  const routerScript = join(d.repoDir, 'dist', 'router', 'main.js')
  const units = d.serviceUnits().filter((u) => {
    const exec = unitExecStart(u.text)
    return exec !== null && exec.includes(routerScript)
  })
  if (units.length === 0) return [{ id: 'unit-path', title: 'router unit PATH', status: 'ok', detail: 'no systemd unit runs this checkout (nothing to compare)' }]
  return units.map((u): Check => {
    const pathValue = unitPathValue(u.text, d.home)
    if (pathValue === null) {
      return { id: 'unit-path', title: `unit ${u.name} PATH`, status: 'warn', detail: 'no PATH in the unit; systemd uses its default PATH' }
    }
    const missing = ['claude', 'tmux'].filter((b) => resolveOnPath(b, pathValue, d.isExecutable) === null)
    return missing.length === 0
      ? { id: 'unit-path', title: `unit ${u.name} PATH`, status: 'ok', detail: `claude and tmux found (PATH ${pathValue})` }
      : { id: 'unit-path', title: `unit ${u.name} PATH`, status: 'fail', detail: `${missing.join(' and ')} not found on the unit's PATH (${pathValue})` }
  })
}

export async function checkClaude(d: Pick<DoctorDeps, 'claudeVersion'>): Promise<Check> {
  const v = await d.claudeVersion()
  return { id: 'claude', title: 'claude --version', status: v ? 'ok' : 'fail', detail: v ?? 'did not run' }
}

// The socket's folder must exist and be writable, and the path must fit a Unix socket address.
export function checkSocket(d: Pick<DoctorDeps, 'socketPath' | 'dirWritable'>): Check {
  const bytes = Buffer.byteLength(d.socketPath, 'utf8')
  if (bytes > SOCKET_PATH_MAX_BYTES) {
    return { id: 'socket', title: 'socket path', status: 'fail', detail: `${bytes} bytes; a Unix socket path allows ${SOCKET_PATH_MAX_BYTES}` }
  }
  const dir = dirname(d.socketPath)
  if (!d.dirWritable(dir)) {
    return { id: 'socket', title: 'socket path', status: 'fail', detail: `${dir} is missing or not writable` }
  }
  return { id: 'socket', title: 'socket path', status: 'ok', detail: d.socketPath }
}

// The env file exists and is readable by its owner only. Its contents are never read into the output.
// The owner. A fresh install is pairing-only until `tg-bridge setup` pairs it: a warning, not a failure. Nothing is listed
// once paired, so a paired install's output does not change.
// Whether the owner has paired. A Discord config keeps the owner in `discord.ownerUserId` (loadConfig leaves the top-level
// ownerUserId null there), so the Discord field is read when the config has one.
export function configOwnerPaired(c: { ownerUserId: string | null; discord?: { ownerUserId: string | null } }): boolean {
  return (c.discord !== undefined ? c.discord.ownerUserId : c.ownerUserId) !== null
}

export function checkOwner(d: Pick<DoctorDeps, 'ownerPaired'>): Check[] {
  if (!d.ownerPaired || d.ownerPaired()) return []
  return [{ id: 'owner', title: 'owner', status: 'warn', detail: 'not paired yet: run tg-bridge setup' }]
}

export function checkEnvFile(d: Pick<DoctorDeps, 'envFile' | 'envFileMode' | 'envSettings'>): Check[] {
  const mode = d.envFileMode(d.envFile)
  if (mode === null) return [{ id: 'env-file', title: 'secrets file', status: 'fail', detail: `${d.envFile} is missing` }]
  const perms = mode & 0o777
  const perm: Check =
    perms === 0o600
      ? { id: 'env-file', title: 'secrets file', status: 'ok', detail: `${d.envFile} (mode 600)` }
      : { id: 'env-file', title: 'secrets file', status: 'fail', detail: `${d.envFile} is mode ${perms.toString(8)}; run chmod 600` }
  const settings = d.envSettings()
  const keys: Check = settings === null
    ? { id: 'env-settings', title: 'secrets file settings', status: 'ok', detail: 'token and chat id present' }
    : { id: 'env-settings', title: 'secrets file settings', status: 'fail', detail: settings }
  return [perm, keys]
}

export function checkConfig(d: Pick<DoctorDeps, 'machineConfig'>): Check {
  const r = d.machineConfig()
  return r.ok
    ? { id: 'config', title: 'config', status: 'ok', detail: 'valid' }
    : { id: 'config', title: 'config', status: 'fail', detail: r.error }
}

// Free space at the state folder and the chat-log folder.
export function checkDisk(d: Pick<DoctorDeps, 'freeBytes' | 'stateDir' | 'logRoot'>): Check[] {
  return [
    { label: 'state folder', path: d.stateDir, id: 'disk-state' },
    { label: 'chat log folder', path: d.logRoot, id: 'disk-logs' },
  ].map(({ label, path, id }): Check => {
    const free = d.freeBytes(path)
    if (free === null) return { id, title: `disk: ${label}`, status: 'warn', detail: `${path}: free space unknown` }
    const status: CheckStatus = diskStatus(free)
    const gib = (free / 1024 ** 3).toFixed(1)
    return { id, title: `disk: ${label}`, status, detail: `${path}: ${gib} GiB free` }
  })
}

// The database file is sound. A missing file (a first run) is fine.
export function checkDatabase(d: Pick<DoctorDeps, 'dbPath' | 'integrityCheck'>): Check {
  if (!existsSync(d.dbPath)) return { id: 'sqlite', title: 'database', status: 'ok', detail: 'no database yet (created at first start)' }
  try {
    const r = d.integrityCheck(d.dbPath)
    return r === 'ok'
      ? { id: 'sqlite', title: 'database integrity', status: 'ok', detail: d.dbPath }
      : { id: 'sqlite', title: 'database integrity', status: 'fail', detail: r }
  } catch (e) {
    return { id: 'sqlite', title: 'database integrity', status: 'fail', detail: (e as Error).message }
  }
}

// The router's instance lock. Informational: a running router holds it; with none, a start takes it.
export function checkInstanceLock(d: Pick<DoctorDeps, 'routerLockHeld'>): Check[] {
  if (!d.routerLockHeld) return []
  const held = d.routerLockHeld()
  return [
    {
      id: 'instance-lock',
      title: 'router instance lock',
      status: 'ok',
      detail: held ? 'held: a router is running from this state folder' : 'free: no router is running from this state folder',
    },
  ]
}

// The database's schema version against this build. An older file is migrated by the router at its next start (warn);
// a newer one was written by a newer build and is refused (fail).
export function checkSchema(d: Pick<DoctorDeps, 'schema'>): Check[] {
  if (!d.schema) return []
  const { found, needed } = d.schema()
  const base = { id: 'schema', title: 'database schema' }
  if (found === null) return [{ ...base, status: 'ok', detail: `no schema yet (this build is v${needed}; created at first start)` }]
  if (found === needed) return [{ ...base, status: 'ok', detail: `v${found}, the version this build needs` }]
  if (found < needed) return [{ ...base, status: 'warn', detail: `v${found}; this build is v${needed}: the router migrates it at its next start` }]
  return [{ ...base, status: 'fail', detail: `v${found} is newer than this build (v${needed}): run the build that wrote it` }]
}

// The tmux server's systemd scope. Without it the server starts plain (the router falls back and says so once): a warning.
export async function checkSystemd(d: Pick<DoctorDeps, 'systemd'>): Promise<Check[]> {
  if (!d.systemd) return []
  const s = await d.systemd()
  if (s.systemdRun && s.userManager) {
    return [{ id: 'systemd-run', title: 'systemd scope for tmux', status: 'ok', detail: 'systemd-run and the --user manager answer' }]
  }
  const why = s.systemdRun ? 'the systemd --user manager does not answer' : 'systemd-run is not on PATH'
  return [{ id: 'systemd-run', title: 'systemd scope for tmux', status: 'warn', detail: `${why}: tmux starts without its own scope` }]
}

// The read-mode hook: it must deny the self-test read, or read and web stay off (the modes addon checks at its start too).
export function checkHookSelfTest(d: Pick<DoctorDeps, 'hookSelfTest'>): Check[] {
  if (!d.hookSelfTest) return []
  return [
    d.hookSelfTest()
      ? { id: 'hook-selftest', title: 'read-mode hook self-test', status: 'ok', detail: 'the hook denies the self-test read' }
      : { id: 'hook-selftest', title: 'read-mode hook self-test', status: 'fail', detail: 'the hook did not deny the self-test read: read and web stay off' },
  ]
}

// The router's own cgroup must hold the router and its children, nothing else. A tmux server or a session process in it
// keeps the unit loaded after a stop (the next start fails with "already loaded"): a warning that names each process.
export function checkRouterCgroup(d: Pick<DoctorDeps, 'routerCgroup'>): Check[] {
  if (!d.routerCgroup) return []
  const id = 'router-cgroup'
  const title = "router's cgroup"
  const facts = d.routerCgroup()
  if (facts === null) return [{ id, title, status: 'ok', detail: 'no router running here (or its cgroup cannot be read): nothing to compare' }]
  if (facts.foreign.length === 0) {
    return [{ id, title, status: 'ok', detail: `${facts.path} holds only the router and its own processes (${facts.total})` }]
  }
  const n = facts.foreign.length
  const list = facts.foreign.map((p) => `${p.comm} (pid ${p.pid})`).join(', ')
  return [
    {
      id,
      title,
      status: 'warn',
      detail: `${n} ${n === 1 ? 'process' : 'processes'} outside the router's own tree share its cgroup (${facts.path}): ${list}. ` +
        'They keep the unit loaded after a stop; the tmux server should be in its own scope (tmux.ts).',
    },
  ]
}

// Each addon folder has a valid manifest, and an enabled addon has its requirements installed and enabled.
export function checkAddons(d: Pick<DoctorDeps, 'addonDirs' | 'addonEnabled'>): Check[] {
  const manifests = new Map<string, { requires: string[] }>()
  const problems: Check[] = []
  for (const root of d.addonDirs) {
    let names: string[] = []
    try {
      names = readdirSync(root, { withFileTypes: true }).filter((x) => x.isDirectory() && !x.name.startsWith('.')).map((x) => x.name)
    } catch {
      continue
    }
    for (const name of names) {
      const r = readManifest(join(root, name))
      if ('error' in r) problems.push({ id: `addon-${name}`, title: `addon ${name}`, status: 'fail', detail: `manifest: ${r.error}` })
      else manifests.set(name, { requires: r.manifest.requires })
    }
  }
  const out: Check[] = [...problems]
  for (const [name, m] of manifests) {
    if (!d.addonEnabled(name)) continue
    const missing = m.requires.filter((r) => !manifests.has(r) || !d.addonEnabled(r))
    out.push(
      missing.length === 0
        ? { id: `addon-${name}`, title: `addon ${name}`, status: 'ok', detail: 'enabled; requirements met' }
        : { id: `addon-${name}`, title: `addon ${name}`, status: 'fail', detail: `enabled, but needs ${missing.join(', ')} installed and enabled` },
    )
  }
  if (out.length === 0) out.push({ id: 'addons', title: 'addons', status: 'ok', detail: 'none installed' })
  return out
}

// The ML venv's Python and, with a GPU configured, the GPU's presence (startup) and the CUDA devices Python sees (full).
export async function checkMl(d: Pick<DoctorDeps, 'mlPython' | 'gpuPresent' | 'cudaCount' | 'gpu'>, scope: DoctorScope): Promise<Check[]> {
  const out: Check[] = []
  out.push(
    d.mlPython
      ? { id: 'ml-python', title: 'ml venv python', status: 'ok', detail: d.mlPython }
      : { id: 'ml-python', title: 'ml venv python', status: 'warn', detail: 'missing; voice, cleanup and digest need the ML worker' },
  )
  if (d.gpu === null) {
    out.push({ id: 'ml-gpu', title: 'ml GPU', status: 'ok', detail: 'no GPU configured; the ML worker uses the CPU' })
    return out
  }
  const index = d.gpu.cudaVisibleDevices.split(',')[0] ?? ''
  if (!index || !d.gpuPresent(index)) {
    out.push({ id: 'ml-gpu', title: 'ml GPU', status: 'warn', detail: `GPU index ${index || '(none)'} is not visible to nvidia-smi` })
    return out
  }
  out.push({ id: 'ml-gpu', title: 'ml GPU', status: 'ok', detail: `GPU ${index} visible to nvidia-smi` })
  if (scope === 'full') {
    const n = await d.cudaCount()
    out.push(
      n !== null && n > 0
        ? { id: 'ml-cuda', title: 'ml CUDA', status: 'ok', detail: `${n} CUDA device${n === 1 ? '' : 's'} visible to the ML venv` }
        : { id: 'ml-cuda', title: 'ml CUDA', status: 'warn', detail: 'the ML venv sees no CUDA device on the configured GPU (the CPU is used)' },
    )
  }
  return out
}

// The checks for a scope. `startup` is what the router runs: the local checks, the chat's privacy checks (reads only), and
// no process that loads a model. The full scope adds the chat app's own checks (token, group).
export async function runChecks(d: DoctorDeps, scope: DoctorScope): Promise<Check[]> {
  const out: Check[] = [checkNode(d.nodeVersion)]
  out.push(...checkPath(d))
  out.push(...checkUnitPaths(d))
  out.push(await checkClaude(d))
  out.push(checkSocket(d))
  out.push(...checkEnvFile(d))
  out.push(checkConfig(d))
  out.push(...checkOwner(d))
  out.push(...checkDisk(d))
  out.push(checkDatabase(d))
  out.push(...checkSchema(d))
  out.push(...checkInstanceLock(d))
  out.push(...checkRouterCgroup(d))
  out.push(...(await checkSystemd(d)))
  out.push(...checkHookSelfTest(d))
  out.push(...checkAddons(d))
  out.push(...(await checkMl(d, scope)))
  if (d.chatPrivacy) out.push(...(await d.chatPrivacy()))
  if (scope === 'full' && d.chatDoctor) out.push(...(await d.chatDoctor()))
  return out
}

// ---------- the real machine ----------

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function writable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK)
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

// Free bytes at `path`, or at its nearest existing parent (a folder that does not exist yet).
export function freeAt(path: string): number | null {
  let p = path
  while (!existsSync(p)) {
    const parent = dirname(p)
    if (parent === p) return null
    p = parent
  }
  try {
    const s = statfsSync(p)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

function runFirstLine(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 10_000 }, (err, stdout) => {
      if (err) return resolve(null)
      const line = String(stdout).split('\n').find((l) => l.trim() !== '')
      resolve(line ? line.trim() : null)
    })
  })
}

// The systemd user units of this machine (their text is read; nothing is changed).
function userUnits(): Array<{ name: string; text: string }> {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.startsWith('/') ? xdg : join(process.env.HOME ?? '', '.config')
  const dir = join(base, 'systemd', 'user')
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.service'))
      .map((f) => ({ name: f, text: readFileSync(join(dir, f), 'utf8') }))
  } catch {
    return []
  }
}

function nvidiaSmiSees(index: string): boolean {
  const r = spawnSync('nvidia-smi', ['-i', index, '--query-gpu=name', '--format=csv,noheader'], { encoding: 'utf8', timeout: 10_000 })
  return r.status === 0
}

function cudaCountFor(cfg: TgConfig): Promise<number | null> {
  const python = join(REPO_DIR, 'ml', '.venv', 'bin', 'python')
  if (!existsSync(python) || cfg.gpu === null) return Promise.resolve(null)
  const env = { ...process.env, CUDA_DEVICE_ORDER: cfg.gpu.cudaDeviceOrder, CUDA_VISIBLE_DEVICES: cfg.gpu.cudaVisibleDevices }
  return new Promise((resolve) => {
    execFile(python, ['-I', '-c', 'import ctranslate2; print(ctranslate2.get_cuda_device_count())'], { env, timeout: 60_000 }, (err, stdout) => {
      if (err) return resolve(null)
      const n = Number(String(stdout).trim())
      resolve(Number.isInteger(n) ? n : null)
    })
  })
}

// What the router (or the CLI) knows from the store: which addons are enabled, and the bound group.
export type StoreFacts = { isAddonEnabled(name: string): boolean; groupId(): ChatId | null }

// The deps of the real machine. `facts` comes from the store (the router passes its own); without it, no addon is
// enabled and the group comes from the config. The machine config is read here (a bad file is reported, not thrown).
export function buildDoctorDeps(facts?: StoreFacts): DoctorDeps {
  const cfgResult = ((): { ok: true; cfg: TgConfig } | { ok: false; error: string } => {
    try {
      return { ok: true, cfg: loadTgConfig() }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })()
  // A config file that does not parse is reported by checkConfig; the paths below then use the schema defaults.
  const cfg: TgConfig = cfgResult.ok ? cfgResult.cfg : parseTgConfig({})
  const envFile = envFilePath()
  return {
    nodeVersion: process.version,
    pathValue: process.env.PATH,
    home: homedir(),
    isExecutable: isExecutableFile,
    claudeVersion: () => runFirstLine('claude', ['--version']),
    socketPath: SOCKET_PATH,
    dirWritable: writable,
    envFileMode: (p) => {
      try {
        return statSync(p).mode
      } catch {
        return null
      }
    },
    envFile,
    ownerPaired: () => {
    try {
      return configOwnerPaired(loadConfig())
    } catch {
      // A missing token is reported by the config check; no second warning here.
      return true
    }
  },
  envSettings: () => {
      try {
        loadConfig()
        return null
      } catch (e) {
        return (e as Error).message
      }
    },
    machineConfig: () => cfgResult,
    serviceUnits: userUnits,
    repoDir: REPO_DIR,
    addonDirs: [join(REPO_DIR, 'dist', 'addons'), join(tgConfigDir(), 'addons')],
    addonEnabled: (name) => facts?.isAddonEnabled(name) ?? false,
    freeBytes: freeAt,
    stateDir: STATE_DIR,
    logRoot: chatLogRoot(cfg),
    dbPath: join(STATE_DIR, DB_FILE),
    integrityCheck,
    routerLockHeld: () => routerLockHeld(STATE_DIR),
    schema: () => ({ found: new ReadOnlyStore(join(STATE_DIR, DB_FILE)).schemaVersion(), needed: MIGRATIONS.length }),
    systemd: async () => {
      const systemdRun = defaultLaunchDeps.hasSystemdRun()
      return { systemdRun, userManager: systemdRun ? await defaultLaunchDeps.userManagerUp() : false }
    },
    routerCgroup: () => {
      const pid = routerLockPid(STATE_DIR)
      return pid === null ? null : readRouterCgroup(pid)
    },
    hookSelfTest: readHookSelfTest,
    mlPython: existsSync(join(REPO_DIR, 'ml', '.venv', 'bin', 'python')) ? join(REPO_DIR, 'ml', '.venv', 'bin', 'python') : null,
    gpuPresent: nvidiaSmiSees,
    cudaCount: () => cudaCountFor(cfg),
    gpu: cfg.gpu,
  }
}

// The read-mode hook (dist/addons/modes/hook.js) run on the self-test input with a minimal policy file: the same check the
// modes addon makes at its start. The policy lives in a folder made for the check and removed after it.
// The read policy the self-test runs the hook with: every field the hook's parser needs (a missing one would make the hook
// deny for the wrong reason, and the self-test would pass without checking the guard).
export function selfTestPolicy(home: string): Record<string, unknown> {
  return { mode: 'read', home, cwd: join(home, 'Documents', 'projects', 'master'), roots: [], webHosts: [], webLog: null, auditFile: null, deniedLog: null }
}

function readHookSelfTest(): boolean {
  const hook = join(REPO_DIR, 'dist', 'addons', 'modes', 'hook.js')
  if (!existsSync(hook)) return false
  const dir = mkdtempSync(join(tmpdir(), 'tgb-doctor-'))
  try {
    const policy = join(dir, 'policy.json')
    const home = homedir()
    writeFileSync(policy, JSON.stringify(selfTestPolicy(home)), { mode: 0o600 })
    const r = spawnSync(process.execPath, [hook, 'read', policy], { input: JSON.stringify(selfTestInput(home)), encoding: 'utf8', timeout: 10_000 })
    return selfTestPasses(r.stdout ?? '')
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// The group id of the machine config (startup value), or null when the file is missing or does not parse.
export function configGroupId(): ChatId | null {
  try {
    // The config file keeps the number (store boundary: src/adapters/store-ids.ts).
    return fromDbChat(loadTgConfig().groupId)
  } catch {
    return null
  }
}

// The store facts of the real database, read-only (the schema is not migrated by a doctor run). Null when there is no
// database yet.
export function storeFacts(): { facts: StoreFacts; close(): void } | null {
  const path = join(STATE_DIR, DB_FILE)
  if (!existsSync(path)) return null
  const ro = new ReadOnlyStore(path)
  return {
    facts: {
      isAddonEnabled: (name) => ro.getAddonSetting(name, 'enabled') === '1',
      groupId: () => ro.readGroupId() ?? configGroupId(),
    },
    close: () => {},
  }
}

// The CLI entry: `tg-bridge doctor [--json]`. Prints the report; returns the exit code. Secrets (the bot token) are
// redacted from the output; the env file's contents are never printed.
export async function runDoctorCommand(args: string[], out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const json = args.includes('--json')
  const unknown = args.filter((a) => a !== '--json')
  if (unknown.length > 0) {
    err('usage: tg-bridge doctor [--json]')
    return 2
  }
  const env = ((): { token?: string; oldToken?: string; ownerId: string | null } => {
    try {
      const c = loadConfig()
      return { token: c.token, oldToken: c.oldToken, ownerId: c.ownerUserId }
    } catch {
      return { ownerId: null }
    }
  })()
  // The chat settings (app, Discord token and home) come from a light module; the Discord modules load in their branch.
  const { readChatSettings, discordHome } = await import('../adapters/chat/discord-setup.ts')
  const chat = readChatSettings(envFilePath(), tgConfigPath())
  const secrets = [env.token, env.oldToken, chat.token].filter((s): s is string => typeof s === 'string' && s.length >= 8)
  const store = storeFacts()
  let checks: Check[]
  try {
    const d = buildDoctorDeps(store?.facts)
    if (chat.app === 'discord') {
      // Loaded here only: a Telegram install never imports the Discord modules.
      try {
        const { checkDiscord, discordFor } = await import('../adapters/chat/discord-doctor.ts')
        const { checkDiscordPrivacy } = await import('../adapters/chat/discord-privacy.ts')
        const dc = await discordFor(chat.token ?? undefined, discordHome(chat.homeId))
        d.chatDoctor = dc
          ? () => checkDiscord(dc)
          : async () => [{ id: 'token', title: 'bot token', status: 'fail', detail: 'no DISCORD_BOT_TOKEN in the secrets file; run tg-bridge setup --chat discord' }]
        if (dc) d.chatPrivacy = () => checkDiscordPrivacy(dc)
      } catch (e) {
        d.chatDoctor = async () => [{ id: 'token', title: 'bot token', status: 'fail', detail: `Discord library not loadable: ${(e as Error).message}` }]
      }
    } else {
      const tg = telegramFor(env.token, store ? store.facts.groupId() : configGroupId(), env.ownerId)
      if (tg) {
        d.chatDoctor = () => checkTelegram(tg)
        d.chatPrivacy = () => (tg.groupId === null ? Promise.resolve([]) : checkTelegramPrivacy({ ...tg, groupId: tg.groupId }))
      }
    }
    checks = await runChecks(d, 'full')
  } catch (e) {
    checks = [{ id: 'doctor', title: 'doctor', status: 'fail', detail: (e as Error).message }]
  } finally {
    store?.close()
  }
  checks = checks.map((c) => ({ ...c, detail: redact(c.detail, secrets) }))
  out(json ? checksJson(checks) : formatChecks(checks))
  return summarizeChecks(checks).exitCode
}
