// Modes addon entry point (plan 2.11): quick, read and web answers from headless `claude -p` runs. Started by the
// router's addon host, pinned like the other heavy work. Stdout is the protocol channel; logs go to stderr.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NOTES_DIR, STATE_DIR, chatLogRoot, currentTgConfig, pinned } from '../../config.ts'
import { MODE_CONCURRENCY, Semaphore } from '../../brain/concurrency.ts'
import { ThreadMap, hookCommand } from '../../brain/modes.ts'
import { AddonClient } from './client.ts'
import { ModesService } from './service.ts'
import { killAllRuns, runProcess, runShell } from './run.ts'
import { defaultLaunchDeps } from '../../adapters/tmux.ts'
import { scopeAvailable, unitName, wrapInScope } from '../../adapters/scope.ts'

const here = dirname(fileURLToPath(import.meta.url))
const home = homedir()
const stateDir = join(STATE_DIR, 'modes')
const threadsFile = join(stateDir, 'threads.json')
// The hook self-test's limit (the hook is a small script; this only stops a hang).
const HOOK_CHECK_MS = 10_000

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

const threads = ThreadMap.fromJSON(readText(threadsFile))

// Atomic write (temp file, then rename), mode 0600: the thread map holds answers.
function saveThreads(): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const tmp = threadsFile + '.tmp'
  writeFileSync(tmp, threads.toJSON(), { mode: 0o600 })
  renameSync(tmp, threadsFile)
}

const hookPath = join(here, 'hook.js')

const cfg = currentTgConfig()
// STOLIK_CLAUDE is for the tests only (a fake CLI); the real run is `claude` from PATH.
const claudeBin = process.env.STOLIK_CLAUDE ?? 'claude'

// Each headless run gets its own systemd scope, so the Claude processes and the helpers they start (plugin hooks) are not
// left in the router's unit cgroup. Probed once; without a scope the runs start plain and that is said once in the log.
const scoped = scopeAvailable(defaultLaunchDeps).then((ok) => {
  if (!ok) process.stderr.write('modes: warning: no systemd scope for the headless runs: they share the router unit cgroup\n')
  return ok
})

let client: AddonClient | null = null
const service = new ModesService({
  request: (op, payload) => {
    if (!client) throw new Error('not connected')
    return client.request(op, payload)
  },
  run: async (args, timeoutMs, cwd) => {
    const p = pinned(cfg, claudeBin, args)
    const s = (await scoped) ? wrapInScope(p.file, p.args, unitName('modes')) : p
    return runProcess(s.file, s.args, { cwd, env: process.env as Record<string, string>, timeoutMs })
  },
  hookCommand: (mode, policyPath) => hookCommand(process.execPath, hookPath, mode, policyPath),
  runHook: (command, stdin) => runShell(command, stdin, HOOK_CHECK_MS),
  stateDir,
  logRoot: chatLogRoot(cfg, home),
  notesDir: NOTES_DIR,
  now: () => Date.now(),
  home,
  threads,
  saveThreads,
  newKey: () => randomBytes(4).toString('hex'),
  semaphore: new Semaphore(MODE_CONCURRENCY),
  log: (msg) => process.stderr.write(`modes: ${msg}\n`),
})

// read and web stay off unless the hook passes its self-test (logged to stderr).
void service.selfTest()

client = new AddonClient(process.stdout, (op, payload) => {
  switch (op) {
    case 'prefix':
      return service.onPrefix(payload)
    case 'reply':
      return service.onReply(payload)
    case 'callback':
      return service.onCallback(payload)
    default:
      throw new Error(`modes has no ${op}`)
  }
})

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => client?.input(chunk))
process.stdin.on('end', () => {
  killAllRuns()
  process.exit(0)
})
process.on('SIGTERM', () => {
  killAllRuns()
  process.exit(0)
})
