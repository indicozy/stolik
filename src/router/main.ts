// tg-bridge router: single Telegram poller plus the local socket that channel servers and hooks talk to.
// Exit codes (the systemd unit relies on them, src/cli/service.ts): 78 config error, 75 another router holds the lock.
export const EXIT_CONFIG = 78
export const EXIT_ALREADY_RUNNING = 75

import type { Config } from '../config.ts'
import type { RouterLock } from '../adapters/instance-lock.ts'
import type { Router } from './core.ts'

// The modules load inside this file, not by static import: config.ts reads the config file when it loads, so a bad file
// must fail inside the handler below (exit EXIT_CONFIG with the message), not as an import crash.
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const stderr = (msg: string): void => {
  process.stderr.write(`tg-bridge router: ${msg}\n`)
}

let cfg: Config
try {
  const { loadConfig } = await import('../config.ts')
  cfg = loadConfig()
} catch (e) {
  // loadConfig's messages name the missing setting and file; they never include a secret value.
  stderr(errText(e))
  process.exit(e instanceof Error && e.name === 'ConfigError' ? EXIT_CONFIG : 1)
}

// One router per state folder and socket. Taken first, before anything opens the store or the socket.
const { STATE_DIR, SOCKET_PATH, currentTgConfig } = await import('../config.ts')
const { acquireRouterLock, AlreadyRunningError } = await import('../adapters/instance-lock.ts')
let lock: RouterLock
try {
  lock = await acquireRouterLock(STATE_DIR, SOCKET_PATH)
} catch (e) {
  stderr(errText(e))
  process.exit(e instanceof AlreadyRunningError ? EXIT_ALREADY_RUNNING : 1)
}

// Owner-only files and socket by default.
process.umask(0o077)

const { log } = await import('./log.ts')
const { isFatalStoreError } = await import('../adapters/store-sqlite.ts')
const { saveNow } = await import('./send.ts')
const { shutdownRouter } = await import('./core.ts')

let router: Router | null = null

// A fatal error: say what happened (with the stack), save what can be saved, release the lock, exit 1.
function crash(label: string, e: unknown): void {
  const detail = e instanceof Error && e.stack ? e.stack : String(e)
  process.stderr.write(`${new Date().toISOString()} tg-bridge router: ${label}: ${detail}\n`)
  try {
    if (router) saveNow(router)
  } catch {
    // Best effort: the process is going down anyway.
  }
  try {
    lock.release()
  } catch {
    // Best effort.
  }
  process.exit(1)
}

process.on('uncaughtException', (e) => crash('uncaught exception', e))
let unhandledCount = 0
process.on('unhandledRejection', (reason) => {
  unhandledCount += 1
  if (isFatalStoreError(reason)) crash('unhandled rejection from the store', reason)
  log(`unhandled rejection #${unhandledCount}: ${errText(reason)}`)
})

const { buildRouter } = await import('../app.ts')
try {
  router = await buildRouter(cfg)
  await router.start()
} catch (e) {
  stderr(`failed to start: ${errText(e)}`)
  try {
    lock.release()
  } catch {
    // Best effort.
  }
  process.exit(1)
}

let shuttingDown = false
const shutdown = (sig: string): void => {
  if (shuttingDown) return
  shuttingDown = true
  log(`${sig}: shutting down`)
  // A signal during start-up: there is nothing to stop yet.
  if (!router) {
    lock.release()
    process.exit(0)
  }
  void shutdownRouter(router, {
    timeoutMs: currentTgConfig().shutdownTimeoutMs,
    release: () => lock.release(),
    exit: (code) => process.exit(code),
  })
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
