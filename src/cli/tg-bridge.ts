#!/usr/bin/env node
// The `tg-bridge` command (package.json bin): `setup`, `service install|uninstall|status`, `addon add|list|remove|consent`,
// `doctor`, `logs`, `trace` (docs/install.md).
// The modules that load config.ts are imported inside the commands, not at the top: a bad config file throws while
// config.ts loads, and that throw must reach the entry point's handler (message on stderr, exit 1), not a stack trace.
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CliDeps } from './addon.ts'
import type { ServiceDeps } from './service.ts'
import type { SqliteStore } from '../adapters/store-sqlite.ts'

const out = (line: string) => process.stdout.write(line + '\n')
const err = (line: string) => process.stderr.write(line + '\n')
const runCmd = (file: string, args: string[]) => {
  const r = spawnSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error.message) : '') }
}

// The CLI owns no schema: it opens the store without migrating. An old or newer database makes the store throw
// SchemaMismatchError, which the entry point prints and exits 1 on. The router is the only process that migrates.
export async function openCliStore(paths: ConstructorParameters<typeof SqliteStore>[0]): Promise<SqliteStore> {
  const { SqliteStore: Store } = await import('../adapters/store-sqlite.ts')
  return new Store(paths, { migrate: false })
}

// Files this CLI creates are private (owner only). Called first thing by the entry point.
export function applyPrivateUmask(): void {
  process.umask(0o077)
}

async function cmdSetup(args: string[]): Promise<number> {
  const { REPO_DIR, STATE_DIR, SOCKET_PATH, currentTgConfig, envFilePath, pinned, tgConfigPath } = await import('../config.ts')
  const { parseSetupArgs, runSetup } = await import('./setup.ts')
  const { makeTelegramPairing } = await import('../adapters/chat/telegram-setup.ts')
  const { systemMlDeps } = await import('./ml-setup.ts')
  const { createPrompter } = await import('./prompt.ts')
  const options = parseSetupArgs(args)
  if (typeof options === 'string') {
    out(`error: ${options}`)
    return 2
  }
  const prompter = createPrompter()
  try {
    return await runSetup({
      options,
      pairing: makeTelegramPairing({ stateDir: STATE_DIR, socketPath: SOCKET_PATH }),
      ask: prompter.ask,
      askSecret: prompter.askSecret,
      out,
      paths: {
        envFile: envFilePath(),
        configFile: tgConfigPath(),
        pluginDir: join(REPO_DIR, 'plugin'),
        nodePath: process.execPath,
      },
      // The ML step pins its commands with the same CPU and nice settings as the services (config cpuAffinity, nice).
      ml: systemMlDeps(REPO_DIR, process.env.PATH, (file, args) => pinned(currentTgConfig(), file, args)),
    })
  } finally {
    prompter.close()
  }
}

async function cmdService(args: string[]): Promise<number> {
  const { REPO_DIR, loadTgConfig } = await import('../config.ts')
  const { parseServiceArgs, runService } = await import('./service.ts')
  const parsed = parseServiceArgs(args)
  if (typeof parsed === 'string') {
    err(parsed)
    return 2
  }
  let cfg
  try {
    cfg = loadTgConfig()
  } catch (e) {
    err((e as Error).message)
    return 1
  }
  const deps: ServiceDeps = {
    platform: process.platform,
    home: homedir(),
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    uid: process.getuid?.() ?? 0,
    nodePath: process.execPath,
    scriptPath: join(REPO_DIR, 'dist', 'router', 'main.js'),
    presence: cfg.presence,
    cpuAffinity: cfg.cpuAffinity,
    nice: cfg.nice,
    exists: (p) => existsSync(p),
    out,
    err,
    run: runCmd,
  }
  return runService(parsed, deps)
}

async function cmdAddon(args: string[]): Promise<number> {
  const { INBOX_DIR, NOTES_DIR, REPO_DIR, STATE_DIR, tgConfigDir } = await import('../config.ts')
  const { DbAddonSettings } = await import('../addons-host/settings.ts')
  const { runAddonCommand } = await import('./addon.ts')
  const configDir = tgConfigDir()
  const deps: CliDeps = {
    addonsDir: join(configDir, 'addons'),
    builtinDir: join(REPO_DIR, 'dist', 'addons'),
    settings: new DbAddonSettings(await openCliStore({ stateDir: STATE_DIR, inboxDir: INBOX_DIR, notesDir: NOTES_DIR })),
    out,
    err,
    confirm: (prompt) =>
      new Promise<string>((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout })
        let answered = false
        rl.on('close', () => {
          if (!answered) resolve('')
        })
        rl.question(prompt, (answer) => {
          answered = true
          rl.close()
          resolve(answer)
        })
      }),
    run: runCmd,
  }
  return runAddonCommand(args, deps)
}

async function cmdDoctor(args: string[]): Promise<number> {
  const { runDoctorCommand } = await import('./doctor.ts')
  return runDoctorCommand(args, out, err)
}

async function cmdLogs(args: string[]): Promise<number> {
  const { runLogsCommand } = await import('./logs.ts')
  return runLogsCommand(args, out, err)
}

async function cmdTrace(args: string[]): Promise<number> {
  const { runTraceCommand } = await import('./logs.ts')
  return runTraceCommand(args, out, err)
}

const USAGE =
  'usage: tg-bridge setup | service install|uninstall|status [--name N] [--start|--stop] | addon add|list|remove|consent ... | doctor [--json] | logs [--addon N] [--level L] [--since 10m] [--trace ID] [-f] | trace <traceId|telegramMessageId>\n'

export async function runCli(argv: string[]): Promise<number> {
  const [command, ...args] = argv
  switch (command) {
    case 'setup':
      return cmdSetup(args)
    case 'service':
      return cmdService(args)
    case 'addon':
      return cmdAddon(args)
    case 'doctor':
      return cmdDoctor(args)
    case 'logs':
      return cmdLogs(args)
    case 'trace':
      return cmdTrace(args)
    default:
      process.stderr.write(USAGE)
      return 2
  }
}

// Runs only when this file is the entry point (not when a test imports it).
const isEntry = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
})()
if (isEntry) {
  applyPrivateUmask()
  try {
    process.exitCode = await runCli(process.argv.slice(2))
  } catch (e) {
    // Config errors and schema mismatches arrive here as their message: no stack trace for the owner.
    err((e as Error).message)
    process.exitCode = 1
  }
}
