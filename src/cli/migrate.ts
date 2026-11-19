// `stolik migrate` (also run first by `stolik setup`): a one-time COPY of the old tg-bridge settings and state into the
// stolik locations. The old files are never moved, changed or deleted, and an existing new file is never overwritten.
// Copying refuses while the old service runs, so the SQLite database is never copied mid-write.
import { execFile } from 'node:child_process'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  LEGACY_ENV_PREFIX,
  LEGACY_UNIT,
  defaultStateDir,
  envFilePath,
  legacyConfigDir,
  legacyEnvFile,
  legacyStateDir,
  tgConfigDir,
} from '../config.ts'

export type Step = { what: string; from: string; to: string }

export const REFUSED_MESSAGE =
  'The old tg-bridge service is running. Stop it first: systemctl --user disable --now tg-bridge ' +
  '(macOS: launchctl bootout gui/$(id -u)/com.tg-bridge.router), then run stolik migrate.'

const NEXT_STEPS = [
  'Next steps:',
  '  1. Stop and disable the old service: systemctl --user disable --now tg-bridge (macOS: launchctl bootout gui/$(id -u)/com.tg-bridge.router).',
  '  2. Start stolik: stolik service install --start',
  '  3. In Claude Code, remove the plugin tg-bridge@indicozy and add stolik@indicozy.',
  '  4. The channel tools are now mcp__stolik__...: update any CLAUDE.md, hooks or settings that name mcp__tg-bridge__ or tg-bridge.',
  '  5. The old files stay in place. Delete them once stolik works.',
]

// Config strings renamed in config.json (substring replacement inside string values only, in this order).
const CONFIG_RENAMES: [string, string][] = [
  ['tg-bridge-v3', 'stolik'],
  ['tg-bridge.sock', 'stolik.sock'],
  ['tg-bridge', 'stolik'],
]

// The steps still to copy: the env file, the config dir and the state dir, each only when the old one exists and the new
// one does not. Pure apart from existsSync.
export function planMigration(p: { home: string; env: NodeJS.ProcessEnv }): Step[] {
  const steps: Step[] = []
  const add = (what: string, from: string, to: string) => {
    if (existsSync(from) && !existsSync(to)) steps.push({ what, from, to })
  }
  add('env file', legacyEnvFile(p.home), envFilePath(p.env, p.home))
  add('config dir', legacyConfigDir(p.env, p.home), tgConfigDir(p.env, p.home))
  add('state dir', legacyStateDir(p.env, p.home), defaultStateDir(p.env, p.home))
  return steps
}

// True when the old service is running: systemd --user unit active (Linux), LaunchAgent loaded (macOS). Otherwise false.
export function oldServiceRunning(): Promise<boolean> {
  const exitsZero = (file: string, args: string[]) =>
    new Promise<boolean>((resolve) => {
      execFile(file, args, (err) => resolve(!err))
    })
  if (process.platform === 'linux') return exitsZero('systemctl', ['--user', 'is-active', '--quiet', LEGACY_UNIT])
  if (process.platform === 'darwin') return exitsZero('launchctl', ['list', 'com.tg-bridge.router'])
  return Promise.resolve(false)
}

function copyEnvFile(from: string, to: string): void {
  const text = readFileSync(from, 'utf8')
  const renamed = text.replace(new RegExp(`^([ \\t]*(?:export[ \\t]+)?)${LEGACY_ENV_PREFIX}`, 'gm'), '$1STOLIK_')
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
  writeFileSync(to, renamed, { mode: 0o600, flag: 'wx' })
  chmodSync(to, 0o600)
}

function renameInValues(value: unknown): unknown {
  if (typeof value === 'string') {
    return CONFIG_RENAMES.reduce((s, [from, to]) => s.replaceAll(from, to), value)
  }
  if (Array.isArray(value)) return value.map(renameInValues)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renameInValues(v)]))
  }
  return value
}

function copyConfigDir(from: string, to: string, log: (s: string) => void): void {
  cpSync(from, to, { recursive: true, errorOnExist: true, force: false })
  const cfg = join(to, 'config.json')
  if (!existsSync(cfg)) return
  const text = readFileSync(cfg, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    log(`warning: ${cfg} is not valid JSON; copied unchanged`)
    return
  }
  writeFileSync(cfg, JSON.stringify(renameInValues(parsed), null, 2) + (text.endsWith('\n') ? '\n' : ''))
}

function copyStateDir(from: string, to: string): void {
  // Sockets cannot be copied; a stale socket file is not state.
  cpSync(from, to, { recursive: true, errorOnExist: true, force: false, filter: (src) => !lstatSync(src).isSocket() })
  for (const suffix of ['', '-wal', '-shm']) {
    const oldDb = join(to, `tg-bridge.db${suffix}`)
    if (existsSync(oldDb)) renameSync(oldDb, join(to, `stolik.db${suffix}`))
  }
}

// Plans, then copies unless the old service runs. Returns the steps copied, or `refused` with the reason. An empty plan
// returns { copied: [] } and logs nothing.
export async function runMigration(deps: {
  home: string
  env: NodeJS.ProcessEnv
  isOldRunning: () => Promise<boolean>
  log: (s: string) => void
}): Promise<{ copied: Step[]; refused?: string }> {
  const plan = planMigration({ home: deps.home, env: deps.env })
  if (plan.length === 0) return { copied: [] }
  if (await deps.isOldRunning()) return { copied: [], refused: REFUSED_MESSAGE }
  const copied: Step[] = []
  for (const step of plan) {
    // Written since the plan was made: never overwrite it.
    if (existsSync(step.to)) continue
    if (step.what === 'env file') copyEnvFile(step.from, step.to)
    else if (step.what === 'config dir') copyConfigDir(step.from, step.to, deps.log)
    else copyStateDir(step.from, step.to)
    copied.push(step)
    deps.log(`copied ${step.what}: ${step.from} -> ${step.to}`)
  }
  if (copied.length > 0) for (const line of NEXT_STEPS) deps.log(line)
  return { copied }
}
