// Runs one `claude` process in its own process group, so a timeout kills the CLI and anything it started.
import { spawn } from 'node:child_process'

export type RawRun = { stdout: string; stderr: string; code: number | null; timedOut: boolean; durationMs: number }

export const KILL_GRACE_MS = 5_000
const MAX_OUTPUT = 10 * 1024 * 1024
// Process groups of runs in progress: the addon kills them when it is stopped (its runs are detached).
const live = new Set<number>()

export function killAllRuns(): void {
  for (const pid of live) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  live.clear()
}

// Runs a command through `sh -c` with `stdin` text and resolves with its stdout (the exit code is the caller's to read
// from the output). Killed after `timeoutMs`. Used for the hook self-test; it is in the same process-group set as runs.
export function runShell(command: string, stdin: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], { detached: true, stdio: ['pipe', 'pipe', 'ignore'] })
    if (child.pid !== undefined) live.add(child.pid)
    let stdout = ''
    const timer = setTimeout(() => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += c
    })
    // The command may exit before reading its input: that is not an error here.
    child.stdin.on('error', () => {})
    child.stdin.end(stdin)
    const finish = () => {
      clearTimeout(timer)
      if (child.pid !== undefined) live.delete(child.pid)
    }
    child.on('error', (err) => {
      finish()
      reject(err)
    })
    child.on('close', () => {
      finish()
      resolve(stdout)
    })
  })
}

export function runProcess(
  file: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number; killGraceMs?: number },
): Promise<RawRun> {
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    if (child.pid !== undefined) live.add(child.pid)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let grace: ReturnType<typeof setTimeout> | null = null
    const killGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, sig)
      } catch {
        // Already gone.
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      killGroup('SIGTERM')
      grace = setTimeout(() => killGroup('SIGKILL'), opts.killGraceMs ?? KILL_GRACE_MS)
    }, opts.timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += c
    })
    child.stderr.on('data', (c: string) => {
      if (stderr.length < 4000) stderr += c
    })
    const done = (code: number | null) => {
      clearTimeout(timer)
      if (grace) clearTimeout(grace)
      if (child.pid !== undefined) live.delete(child.pid)
      resolve({ stdout, stderr, code, timedOut, durationMs: Date.now() - started })
    }
    child.on('error', (err) => {
      stderr += String(err.message)
      done(null)
    })
    child.on('close', (code) => done(code))
  })
}
