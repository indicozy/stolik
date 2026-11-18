// Single-instance guards for the router: a pid lock file in the state folder (`router.lock`) plus a probe of the router
// socket. The router takes the lock first thing at startup; the migration and the socket server only check.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'

export class AlreadyRunningError extends Error {}

export interface RouterLock {
  readonly path: string
  release(): void
}

const LOCK_FILE = 'router.lock'

function lockPath(stateDir: string): string {
  return join(stateDir, LOCK_FILE)
}

// A pid that exists (EPERM: it exists but belongs to someone else) counts as alive.
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// The pid in a lock file, or null when the file is missing or does not hold a pid.
function readPid(path: string): number | null {
  try {
    const n = Number(readFileSync(path, 'utf8').trim())
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

// Creates the lock file exclusively (O_EXCL) and writes this process's pid. False when it already exists.
function takeLockFile(path: string): boolean {
  let fd: number
  try {
    fd = openSync(path, 'wx', 0o600)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw e
  }
  try {
    writeSync(fd, `${process.pid}\n`)
  } finally {
    closeSync(fd)
  }
  return true
}

// True when something accepts connections on the socket. Never throws; a timeout, a missing socket, a refused
// connection or any other error all count as "nothing answers".
export function socketAnswers(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    let sock: ReturnType<typeof createConnection> | null = null
    const finish = (answered: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      sock?.destroy()
      resolve(answered)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref()
    try {
      sock = createConnection(socketPath)
      sock.once('connect', () => finish(true))
      sock.once('error', () => finish(false))
    } catch {
      finish(false)
    }
  })
}

// The pid of the running router from its lock file, or null when none is running. Never throws.
export function routerLockPid(stateDir: string): number | null {
  try {
    const pid = readPid(lockPath(stateDir))
    return pid !== null && pidAlive(pid) ? pid : null
  } catch {
    return null
  }
}

// True when the lock file exists and its pid is alive. Never throws.
export function routerLockHeld(stateDir: string): boolean {
  try {
    const pid = readPid(lockPath(stateDir))
    return pid !== null && pidAlive(pid)
  } catch {
    return false
  }
}

// Takes the router lock in stateDir (created with mode 0700 when missing), then checks the socket. A live pid in the
// lock file, or an answering socket, throws AlreadyRunningError. A lock whose pid is dead is taken over.
export async function acquireRouterLock(stateDir: string, socketPath: string): Promise<RouterLock> {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const path = lockPath(stateDir)
  if (!takeLockFile(path)) {
    const pid = readPid(path)
    if (pid !== null && pidAlive(pid)) {
      throw new AlreadyRunningError(`another tg-bridge router is running (pid ${pid}, lock ${path}). Stop it first, then start this one.`)
    }
    // Stale (dead pid, or no pid yet): remove and retry once.
    rmSync(path, { force: true })
    if (!takeLockFile(path)) {
      throw new AlreadyRunningError(`another tg-bridge router took the lock ${path} while this one was starting. Stop it first, then start this one.`)
    }
  }
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    if (readPid(path) === process.pid) rmSync(path, { force: true })
  }
  if (await socketAnswers(socketPath)) {
    release()
    throw new AlreadyRunningError(`another tg-bridge router is answering on the socket ${socketPath}. Stop it first, then start this one.`)
  }
  return { path, release }
}
