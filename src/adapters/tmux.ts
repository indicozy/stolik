// Starts and watches the agent's tmux sessions (router-started sessions). Argv is passed without a shell.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { REPO_DIR, SOCKET_PATH } from '../config.ts'
import { warn } from '../router/log.ts'
import { isAcceptedChannelsBanner, isDevChannelsDialog, mentionsDevChannels } from '../router/state.ts'

// The dialog is looked for this often; Enter is pressed at most DIALOG_ENTER_MAX times, DIALOG_RETRY_MS apart.
const POLL_MS = 500
export const DIALOG_RETRY_MS = 2000
export const DIALOG_ENTER_MAX = 5
// Lines of the pane kept for the log when a start fails.
export const PANE_TAIL_LINES = 10
// Scoped starts tried before the plain fallback (each under its own unit name).
const SCOPE_ATTEMPTS = 2

export type Run = { code: number; stdout: string; stderr: string }
// Runs one tmux command. The default runs the real binary; tests pass a fake.
export type TmuxRun = (cmd: string, args: string[]) => Promise<Run>

// How a watched startup ended. `done`: the session registered (or the router no longer waits for it). `gone`: the tmux
// session disappeared before that; `pane` is the last capture taken while it still existed. `timeout`: the deadline passed.
export type StartupOutcome = { kind: 'done' } | { kind: 'gone'; pane: string[] } | { kind: 'timeout'; pane: string[] }

export type WatchOptions = {
  run?: TmuxRun
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  // Called once when the pane mentions the development channels but the dialog matcher does not see the dialog.
  onMiss?: (pane: string[]) => void
}

export function runTmux(cmd: string, args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout, stderr) => {
      // Non-zero exit gives a numeric err.code; spawn failures (ENOENT, timeout) give -1.
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

// `=name:` is the session named exactly `name` (a prefix of another session's name never matches), at its active window
// and pane.
export function exactTarget(name: string): string {
  return `=${name}:`
}

// The last `n` non-empty lines of a captured pane.
export function paneTailLines(pane: string, n: number = PANE_TAIL_LINES): string[] {
  return pane
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '')
    .slice(-n)
}

export function tmuxNameFor(project: string): string {
  return 'tg-' + project.replace(/[^A-Za-z0-9_-]/g, '_')
}

// The router socket when none is configured: $XDG_RUNTIME_DIR/stolik.sock (the same rule as src/config.ts).
export function defaultSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  return join(env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`, 'stolik.sock')
}

// argv for `tmux new-session`: the tg-claude launcher, then any extra arguments (e.g. --resume <id>). Passed as
// separate argv, no shell, so the extra arguments are never interpreted.
// The session gets the router's socket as its environment: the tmux server's environment would otherwise win over the
// router's own, and a session would register with the wrong router. When the router uses a non-default socket (from
// config or STOLIK_SOCKET), the session also gets STOLIK_CHANNEL=self, which makes bin/tg-claude load this
// checkout's channel server instead of the user-scope "stolik" one.
// `spawnToken` (router-started sessions only) is passed as STOLIK_SPAWN_TOKEN; the channel echoes it in `register`, so
// the router can tell which spawn a registering session belongs to.
export function tmuxNewSessionArgs(
  name: string,
  dir: string,
  extra: readonly string[] = [],
  socket: string = SOCKET_PATH,
  spawnToken: string | null = null,
): string[] {
  const env = ['-e', `STOLIK_SOCKET=${socket}`]
  if (socket !== defaultSocketPath()) {
    env.push('-e', 'STOLIK_CHANNEL=self')
    if (process.env.STOLIK_ENV_FILE) env.push('-e', `STOLIK_ENV_FILE=${process.env.STOLIK_ENV_FILE}`)
  }
  if (spawnToken !== null) env.push('-e', `STOLIK_SPAWN_TOKEN=${spawnToken}`)
  return ['new-session', '-d', '-s', name, '-c', dir, ...env, join(REPO_DIR, 'bin', 'tg-claude'), ...extra]
}

// How the tmux server is started. The server inherits the environment and cgroup of the process that starts it, so the
// router's unit (CPUAffinity, Nice, a short PATH) would otherwise pass on to every session. With systemd-run, the server
// gets its own scope with default properties; the PATH is the user's login PATH, so claude and node are found as in a
// terminal.
export type LaunchDeps = {
  // True when systemd-run is on PATH.
  hasSystemdRun(): boolean
  // True when the systemd --user manager answers (a read-only probe: `systemctl --user show-environment`).
  userManagerUp(): Promise<boolean>
  // The PATH for the tmux server.
  loginPath(): Promise<string>
}

export type ServerLaunch = { file: string; args: string[] }

// Warnings about the scope start, each kind once per process. They go to the journal and the Logs topic (warn level).
const warnedOnce = new Set<string>()

export function warnOnce(kind: string, msg: string): void {
  if (warnedOnce.has(kind)) return
  warnedOnce.add(kind)
  warn(msg, 'tmux')
}

// Test hook: forgets the warnings given so far.
export function resetLaunchWarnings(): void {
  warnedOnce.clear()
}

// Whether the tmux server can get its own scope: systemd-run is on PATH and the systemd --user manager answers. Each
// missing piece is warned about once; the start then runs plain tmux.
async function scopeAvailable(deps: LaunchDeps): Promise<boolean> {
  if (!deps.hasSystemdRun()) {
    warnOnce('no-systemd-run', 'systemd-run is not on PATH: the tmux server starts without its own systemd scope (it inherits the router unit settings)')
    return false
  }
  if (!(await deps.userManagerUp())) {
    warnOnce('no-user-manager', 'the systemd --user manager does not answer: the tmux server starts without its own systemd scope')
    return false
  }
  return true
}

// The unit's PATH (the router's own PATH) plus ~/.local/bin and /usr/local/bin, without repeats.
export function fallbackPath(routerPath: string | undefined, home: string): string {
  const entries = [...(routerPath ?? '').split(':'), `${home}/.local/bin`, '/usr/local/bin'].filter((e) => e !== '')
  return [...new Set(entries)].join(':')
}

// The user's login PATH: `$SHELL -lc 'printf %s "$PATH"'`. The fallback when that fails or prints nothing.
export async function loginPathFrom(
  runner: (file: string, args: string[]) => Promise<Run>,
  shell: string,
  fallback: string,
): Promise<string> {
  const r = await runner(shell, ['-lc', 'printf %s "$PATH"'])
  const found = r.stdout.trim()
  return r.code === 0 && found !== '' ? found : fallback
}

// The transient unit a scoped start runs in: a new name for every start, so a unit left over from an earlier start (its
// processes still alive) can never make this one fail with "already loaded". `tg-tmux-<hex>` shows in `systemctl --user`.
export function scopeUnitName(): string {
  return `tg-tmux-${randomBytes(4).toString('hex')}`
}

// argv for starting the tmux server with the given tmux arguments (new-session ...). The probes and the PATH are read
// once per process and cached; a test passes its own deps. `plain` skips the scope (the fallback after a failed scope).
export type ServerLauncher = (tmuxArgs: string[], opts?: { plain?: boolean }) => Promise<ServerLaunch>

export function createServerLauncher(deps: LaunchDeps): ServerLauncher {
  let scope: Promise<boolean> | null = null
  let path: Promise<string> | null = null
  return async (tmuxArgs, opts = {}) => {
    path ??= deps.loginPath()
    scope ??= scopeAvailable(deps)
    const [p, scoped] = await Promise.all([path, scope])
    const wrap = scoped && !opts.plain ? ['systemd-run', '--user', '--scope', '--quiet', `--unit=${scopeUnitName()}`, '--'] : []
    return { file: 'env', args: [`PATH=${p}`, ...wrap, 'tmux', ...tmuxArgs] }
  }
}

export const defaultLaunchDeps: LaunchDeps = {
  hasSystemdRun: () => (process.env.PATH ?? '').split(':').some((d) => d !== '' && existsSync(join(d, 'systemd-run'))),
  userManagerUp: async () => (await runTmux('systemctl', ['--user', 'show-environment'])).code === 0,
  loginPath: () =>
    loginPathFrom(runTmux, process.env.SHELL || '/bin/sh', fallbackPath(process.env.PATH, process.env.HOME ?? homedir())),
}

const launchServer = createServerLauncher(defaultLaunchDeps)

// Starts `bin/tg-claude` detached in a new tmux session. Returns the session name.
export async function startTmux(
  project: string,
  dir: string,
  extra: readonly string[] = [],
  run: TmuxRun = runTmux,
  spawnToken: string | null = null,
  launcher: ServerLauncher = launchServer,
): Promise<string> {
  const base = tmuxNameFor(project)
  let name = base
  for (let n = 2; (await run('tmux', ['has-session', '-t', `=${name}`])).code === 0; n++) {
    name = `${base}-${n}`
  }
  const argv = tmuxNewSessionArgs(name, dir, extra, SOCKET_PATH, spawnToken)
  let launch = await launcher(argv)
  let r = await run(launch.file, launch.args)
  // A refused scoped start is tried again under a new unit name (the first may have failed for a reason that does not last).
  // A session that exists by then was made by the start that reported the error, so it is not started a second time.
  for (let attempt = 1; r.code !== 0 && launch.args.includes('systemd-run') && attempt < SCOPE_ATTEMPTS; attempt++) {
    if ((await run('tmux', ['has-session', '-t', `=${name}`])).code === 0) return name
    launch = await launcher(argv)
    r = await run(launch.file, launch.args)
  }
  // A failed start in the scope (systemd-run missing, refused, or the scope failed) falls back to plain tmux: the session
  // still starts, and the owner is told once. The plain server then shares the router's cgroup; doctor reports that.
  if (r.code !== 0 && launch.args.includes('systemd-run')) {
    warnOnce('scope-failed', `systemd-run could not start the tmux server (${r.stderr.trim() || `exit ${r.code}`}); starting it without its own scope`)
    launch = await launcher(argv, { plain: true })
    r = await run(launch.file, launch.args)
  }
  if (r.code !== 0) throw new Error(`tmux new-session failed: ${r.stderr.trim() || r.code}`)
  return name
}

// argv that stops one tmux session by its exact name (`=` turns off prefix and pattern matching, so only that session
// can end).
export function killSessionArgs(name: string): string[] {
  return ['kill-session', '-t', `=${name}`]
}

// Stops a router-started session by its exact name. True when tmux ended it; a failure is otherwise ignored (the session
// may already be gone). `run` is a fake in tests.
export async function killTmuxSession(name: string, run: TmuxRun = runTmux): Promise<boolean> {
  return (await run('tmux', killSessionArgs(name))).code === 0
}

// The pid of the pane process of a session (the shell tmux started; claude runs below it), or null.
export async function tmuxPanePid(name: string, run: TmuxRun = runTmux): Promise<number | null> {
  const r = await run('tmux', ['display-message', '-p', '-t', exactTarget(name), '#{pane_pid}'])
  const n = r.code === 0 ? Number(r.stdout.trim()) : NaN
  return Number.isInteger(n) && n > 0 ? n : null
}

// The last lines of a session's pane, for the log. Empty when the session is gone or tmux fails.
export async function paneTail(name: string, run: TmuxRun = runTmux): Promise<string[]> {
  const pane = await run('tmux', ['capture-pane', '-p', '-t', exactTarget(name)])
  return pane.code === 0 ? paneTailLines(pane.stdout) : []
}

// Watches a starting session until it registers, its tmux session disappears, or timeoutMs passes. While the
// development-channels dialog is shown, Enter is pressed (first at once, then every DIALOG_RETRY_MS, at most
// DIALOG_ENTER_MAX times). Each poll that finds the session keeps its pane, so a session that vanishes later still
// reports what it last showed.
export async function watchDevChannelsDialog(
  name: string,
  timeoutMs: number,
  isRegistered: () => boolean,
  opts: WatchOptions = {},
): Promise<StartupOutcome> {
  const run = opts.run ?? runTmux
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = opts.now ?? Date.now
  const deadline = now() + timeoutMs
  let pane: string[] = []
  let enters = 0
  let lastEnter = Number.NEGATIVE_INFINITY
  let missReported = false
  while (now() < deadline) {
    await sleep(POLL_MS)
    if (isRegistered()) return { kind: 'done' }
    const cap = await run('tmux', ['capture-pane', '-p', '-t', exactTarget(name)])
    if (cap.code !== 0) return { kind: 'gone', pane }
    pane = paneTailLines(cap.stdout)
    if (isDevChannelsDialog(cap.stdout)) {
      if (enters < DIALOG_ENTER_MAX && now() - lastEnter >= DIALOG_RETRY_MS) {
        enters++
        lastEnter = now()
        await run('tmux', ['send-keys', '-t', exactTarget(name), 'Enter'])
      }
    } else if (!missReported && mentionsDevChannels(cap.stdout) && !isAcceptedChannelsBanner(cap.stdout)) {
      missReported = true
      opts.onMiss?.(pane)
    }
  }
  return { kind: 'timeout', pane }
}
