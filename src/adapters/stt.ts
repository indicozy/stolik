import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_DIR, currentTgConfig, gpuEnv, pinned } from '../config.ts'
import { log, errMsg } from '../router/log.ts'

const VENV_PY = join(REPO_DIR, 'stt', '.venv', 'bin', 'python')
const WORKER = join(REPO_DIR, 'stt', 'worker.py')
const REQUEST_TIMEOUT_MS = 120_000
const IDLE_KILL_MS = 10 * 60_000

type Pending = { resolve: (text: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

// Test seams: another request timeout, and a stand-in worker command in place of the venv python.
export type SttOptions = { requestTimeoutMs?: number; worker?: { file: string; args: string[] } }

// Client for stt/worker.py (NDJSON over stdio). The worker starts lazily and is killed after 10 min idle to free VRAM.
export class Stt {
  private child: ChildProcessWithoutNullStreams | null = null
  private buf = ''
  private seq = 0
  private readonly pending = new Map<number, Pending>()
  private idleTimer: NodeJS.Timeout | null = null
  private readonly opts: SttOptions

  constructor(opts: SttOptions = {}) {
    this.opts = opts
  }

  transcribe(path: string): Promise<string> {
    if (!this.opts.worker && !existsSync(VENV_PY)) return Promise.reject(new Error('voice transcription not installed'))
    let child: ChildProcessWithoutNullStreams
    try {
      child = this.ensure()
    } catch (e) {
      return Promise.reject(new Error(`transcriber failed to start: ${errMsg(e)}`))
    }
    const id = ++this.seq
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('transcription timed out'))
        // The worker is hung: kill it, so the next request starts a fresh one instead of queuing behind this job.
        this.kill()
      }, this.opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ id, path }) + '\n')
      this.armIdle()
    })
  }

  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.kill()
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child
    let cmd: { file: string; args: string[] }
    let gpu: Record<string, string> = {}
    if (this.opts.worker) {
      cmd = this.opts.worker
    } else {
      const cfg = currentTgConfig()
      cmd = pinned(cfg, VENV_PY, ['-I', WORKER])
      gpu = gpuEnv(cfg)
    }
    const child = spawn(cmd.file, cmd.args, {
      env: {
        ...process.env,
        ...gpu,
        HF_HOME: process.env.HF_HOME ?? '/mnt/ai_models/hf',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    this.buf = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onData(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) if (line.trim()) log(`stt: ${line.trim()}`)
    })
    const fail = (why: string) => {
      if (this.child === child) this.child = null
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error(why))
        this.pending.delete(id)
      }
    }
    child.on('error', (e) => fail(`transcriber error: ${errMsg(e)}`))
    child.on('exit', (code) => fail(`transcriber exited (code ${code})`))
    return child
  }

  private onData(chunk: string): void {
    this.buf += chunk
    let idx: number
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 1)
      if (!line.trim()) continue
      let msg: { id?: number; text?: string; error?: string }
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined
      if (!p || typeof msg.id !== 'number') continue
      clearTimeout(p.timer)
      this.pending.delete(msg.id)
      if (typeof msg.error === 'string') p.reject(new Error(msg.error))
      else p.resolve(String(msg.text ?? ''))
    }
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.pending.size > 0) return this.armIdle()
      this.kill()
    }, IDLE_KILL_MS)
  }

  private kill(): void {
    const child = this.child
    this.child = null
    if (child && !child.killed) child.kill('SIGTERM')
  }
}
