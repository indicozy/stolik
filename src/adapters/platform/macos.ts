// macOS platform facts (plan P4). UNVERIFIED: this was written without a Mac to run it on. The parsers are pure and
// tested with fixture text in test/platform-macos.test.ts; the commands are the ones the plan names:
//   process info  ps -o lstart=,ppid=,args= -p <pid>     and  ps -o ppid=,comm= -p <pid>
//   boot time     sysctl -n kern.boottime
//   idle          ioreg -c IOHIDSystem, HIDIdleTime (nanoseconds). Not an Apple API; see research 17 (c).
//   lock          best effort: CGSSessionScreenIsLocked in ioreg's Root entry. Unverified; false when not found.
// There is no CPU pinning on macOS (taskset is Linux-only), so the platform port's pinCpus is a no-op there.
import { execFile, execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import type { IdleReading, IdleSource } from './index.ts'

const TIMEOUT_MS = 2000
const MAX_HOPS = 15

// `ps -o lstart=,ppid=,args= -p <pid>`: "Sat Nov 14 10:31:02 2026   4000 /usr/local/bin/claude --resume x".
// lstart is fixed width (the day is space padded); args are split on whitespace, so an argument with spaces is lossy.
export function parsePsLine(text: string): { startedAt: number | null; ppid: number; args: string[] } | null {
  const m = /^\s*(\w{3}) (\w{3}) +(\d{1,2}) (\d{2}:\d{2}:\d{2}) (\d{4})\s+(\d+)\s+(.*?)\s*$/.exec(text)
  if (!m) return null
  const [, dow, mon, day, time, year, ppid, args] = m
  const startedAt = Date.parse(`${dow} ${mon} ${day} ${year} ${time}`)
  const argv = args === '' ? [] : args.split(/\s+/)
  return { startedAt: Number.isNaN(startedAt) ? null : startedAt, ppid: Number(ppid), args: argv }
}

// `ps -o ppid=,comm= -p <pid>`: comm is the executable path on macOS, so the caller compares basenames.
export function parsePsComm(text: string): { ppid: number; comm: string } | null {
  const m = /^\s*(\d+)\s+(.*?)\s*$/.exec(text)
  if (!m) return null
  return { ppid: Number(m[1]), comm: m[2] }
}

// `sysctl -n kern.boottime`: "{ sec = 1794600000, usec = 123456 } Sat Nov 14 ...". Returns the boot time in seconds.
export function parseKernBoottime(text: string): number | null {
  const m = /sec = (\d+)/.exec(text)
  return m ? Number(m[1]) : null
}

// `ioreg -c IOHIDSystem`: the HIDIdleTime property in nanoseconds, returned as milliseconds (floored).
export function parseHidIdleMs(text: string): number | null {
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(text)
  if (!m) return null
  return Math.floor(Number(m[1]) / 1_000_000)
}

// `ioreg -n Root -d1` lists CGSSessionScreenIsLocked = Yes while the screen is locked. Unverified on a real Mac.
export function parseScreenLocked(text: string): boolean {
  return /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(text)
}

// Walks up from `start` through parent pids and returns the first one whose name or argv[0] basename is 'claude'.
// `info` reads one pid (null when it is gone). Pure: the caller supplies the reader.
export function walkClaudePid(
  start: number,
  info: (pid: number) => { ppid: number; names: string[] } | null,
  maxHops: number = MAX_HOPS,
): number | null {
  let pid = start
  for (let hop = 0; hop < maxHops && pid > 1; hop++) {
    const i = info(pid)
    if (!i) return null
    if (i.names.some((n) => basename(n) === 'claude')) return pid
    pid = i.ppid
  }
  return null
}

// ---------- readers (run the commands; null or '' when they fail) ----------

function run(file: string, args: string[]): string | null {
  try {
    return execFileSync(file, args, { encoding: 'utf8', timeout: TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

function runAsync(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', timeout: TIMEOUT_MS }, (e, stdout) => resolve(e ? null : String(stdout)))
  })
}

// The argv of a pid, or null when the process is gone or has no argv.
export function macProcessArgv(pid: number): string[] | null {
  const text = run('ps', ['-o', 'lstart=,ppid=,args=', '-p', String(pid)])
  const parsed = text === null ? null : parsePsLine(text)
  return parsed && parsed.args.length > 0 ? parsed.args : null
}

// Finds the claude process above this one (the macOS counterpart of linux-proc findClaudePid). Unverified.
export function macFindClaudePid(start: number = process.ppid): number | null {
  return walkClaudePid(start, (pid) => {
    const text = run('ps', ['-o', 'ppid=,comm=', '-p', String(pid)])
    const parsed = text === null ? null : parsePsComm(text)
    if (!parsed) return null
    const argv = macProcessArgv(pid) ?? []
    return { ppid: parsed.ppid, names: [parsed.comm, argv[0] ?? ''] }
  })
}

// `ps -o lstart= -p <pid>`: the start time text, trimmed (stable for the life of a process). Empty output is null.
export function parseLstart(text: string): string | null {
  const t = text.trim()
  return t === '' ? null : t
}

// `ps -o comm= -p <pid>`: the executable path, reduced to its basename. Empty output is null.
export function parseCommBase(text: string): string | null {
  const t = text.trim()
  return t === '' ? null : basename(t)
}

export function macProcessStart(pid: number): string | null {
  const text = run('ps', ['-o', 'lstart=', '-p', String(pid)])
  return text === null ? null : parseLstart(text)
}

export function macProcessComm(pid: number): string | null {
  const text = run('ps', ['-o', 'comm=', '-p', String(pid)])
  return text === null ? null : parseCommBase(text)
}

export function macParentPid(pid: number): number | null {
  const text = run('ps', ['-o', 'ppid=', '-p', String(pid)])
  const n = text === null ? NaN : Number(text.trim())
  return Number.isInteger(n) ? n : null
}

// Boot time in seconds since the epoch (kern.boottime), or null.
export function macBootSeconds(): number | null {
  const text = run('sysctl', ['-n', 'kern.boottime'])
  return text === null ? null : parseKernBoottime(text)
}

// The boot identifier: kern.boottime changes at every boot. Empty when unreadable.
export function macBootId(): string {
  const sec = macBootSeconds()
  return sec === null ? '' : `kern.boottime:${sec}`
}

export function macUptimeSeconds(): number | null {
  const sec = macBootSeconds()
  return sec === null ? null : Math.max(0, Date.now() / 1000 - sec)
}

async function hidIdleMs(): Promise<number | null> {
  const text = await runAsync('ioreg', ['-c', 'IOHIDSystem'])
  return text === null ? null : parseHidIdleMs(text)
}

async function screenLocked(): Promise<boolean> {
  const text = await runAsync('ioreg', ['-n', 'Root', '-d1'])
  return text === null ? false : parseScreenLocked(text)
}

// Presence source for macOS (chosen by the factory whatever the presence config says).
export const macosSource: IdleSource = {
  name: 'macos',
  async read(): Promise<IdleReading> {
    const [idleMs, locked] = await Promise.all([hidIdleMs(), screenLocked()])
    return { idleMs, locked }
  },
}
