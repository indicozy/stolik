// Linux process and boot facts from /proc: the claude process walk, argv parsing, the boot id and pid liveness.
// Parsers are pure (fixtures in test/); the readers wrap them and return null or '' when a file cannot be read.
import { readFileSync, readdirSync } from 'node:fs'

const MAX_HOPS = 15
const BOOT_ID_SRC = '/proc/sys/kernel/random/boot_id'

// /proc/<pid>/stat: "pid (comm) state ppid ...". comm may contain spaces or parens, so parse after the last ')'.
export function parseProcStat(stat: string): { ppid: number } | null {
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const ppid = Number(rest[1])
  if (!Number.isInteger(ppid)) return null
  return { ppid }
}

// The start time of a process: field 22 of /proc/<pid>/stat (clock ticks since boot). Stable for the life of a process,
// so pid + start time identifies it. Parsed after the last ')' like parseProcStat (field 3 is rest[0]).
export function parseProcStart(stat: string): string | null {
  const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  return start !== undefined && /^\d+$/.test(start) ? start : null
}

export function readProcStart(pid: number): string | null {
  try {
    return parseProcStart(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return null
  }
}

// The executable name of a pid (/proc/<pid>/comm), or null when it cannot be read.
export function readProcComm(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
  } catch {
    return null
  }
}

// The parent pid of a pid, or null when it cannot be read.
export function readParentPid(pid: number): number | null {
  try {
    return parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))?.ppid ?? null
  } catch {
    return null
  }
}

// Returns { comm, ppid } for a pid from /proc, or null if it cannot be read.
function readProcInfo(pid: number): { comm: string; ppid: number } | null {
  try {
    const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
    const parsed = parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))
    if (!parsed) return null
    return { comm, ppid: parsed.ppid }
  } catch {
    return null
  }
}

// Walks from `start` up the parent chain and returns the first pid whose comm is 'claude', or null.
export function findClaudePid(start: number = process.ppid): number | null {
  try {
    let pid = start
    for (let hop = 0; hop < MAX_HOPS && pid > 1; hop++) {
      const info = readProcInfo(pid)
      if (!info) return null
      if (info.comm === 'claude') return pid
      pid = info.ppid
    }
    return null
  } catch {
    return null
  }
}

// True for an interactive claude session. Print mode (-p / --print) and the stream formats mark a
// non-interactive run spawned by another tool. Pure: takes the argv, not a pid.
export function isInteractiveClaude(argv: string[]): boolean {
  for (const a of argv) {
    if (a === '-p' || a === '--print' || a.startsWith('--print=')) return false
    if (a === '--output-format' || a.startsWith('--output-format=')) return false
    if (a === '--input-format' || a.startsWith('--input-format=')) return false
  }
  return true
}

// Splits the raw /proc/<pid>/cmdline text (NUL-separated) into argv, or null when it is empty (e.g. a kernel thread).
export function parseCmdline(raw: string): string[] | null {
  if (raw.length === 0) return null
  return raw.replace(/\0$/, '').split('\0')
}

// Reads /proc/<pid>/cmdline as an argv array, or null if it cannot be read (or is empty, e.g. a kernel thread).
export function readCmdline(pid: number): string[] | null {
  try {
    return parseCmdline(readFileSync(`/proc/${pid}/cmdline`, 'utf8'))
  } catch {
    return null
  }
}

// Kernel boot id (changes at every boot), or '' when unreadable.
export function readBootId(): string {
  try {
    return readFileSync(BOOT_ID_SRC, 'utf8').trim()
  } catch {
    return ''
  }
}

// Whether a process exists. A permission error counts as alive.
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Terminal emulators that can host one claude session in one window. A multi-window process is never one of these
// for this purpose, because terminalWindowPid also requires that it hosts exactly one child.
export const TERMINAL_NAMES = ['alacritty', 'xterm', 'foot', 'urxvt', 'st', 'kitty'] as const

// Every /proc read below takes `root` so tests can point them at a fixture tree. The router passes nothing.
const PROC_ROOT = '/proc'
const PID_DIR_RE = /^\d+$/

// The pids whose parent is `pid`. Null when /proc cannot be listed. A process that vanishes mid-scan is skipped.
export function childPids(pid: number, root: string = PROC_ROOT): number[] | null {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return null
  }
  const out: number[] = []
  for (const name of entries) {
    if (!PID_DIR_RE.test(name)) continue
    try {
      const parsed = parseProcStat(readFileSync(`${root}/${name}/stat`, 'utf8'))
      if (parsed?.ppid === pid) out.push(Number(name))
    } catch {
      // vanished between the listing and the read
    }
  }
  return out
}

// Every descendant of `pid` with its argv, depth first. Null when any living process in the walk cannot be read.
// A process that exited mid-walk is skipped. A live process with an empty cmdline (a zombie) has argv [].
export function descendants(pid: number, root: string = PROC_ROOT): Array<{ pid: number; argv: string[] }> | null {
  const out: Array<{ pid: number; argv: string[] }> = []
  const seen = new Set<number>([pid])
  const stack = [pid]
  while (stack.length > 0) {
    const parent = stack.pop() as number
    const kids = childPids(parent, root)
    if (kids === null) return null
    for (const kid of kids) {
      if (seen.has(kid)) continue
      seen.add(kid)
      let raw: string
      try {
        raw = readFileSync(`${root}/${kid}/cmdline`, 'utf8')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
        return null
      }
      out.push({ pid: kid, argv: parseCmdline(raw) ?? [] })
      stack.push(kid)
    }
  }
  return out
}

// The executable name of a pid (/proc/<pid>/comm, trimmed), or null when it cannot be read.
export function processName(pid: number, root: string = PROC_ROOT): string | null {
  try {
    return readFileSync(`${root}/${pid}/comm`, 'utf8').trim()
  } catch {
    return null
  }
}

// Sends a signal to a pid. False when it fails (no such process, or no permission).
export function signal(pid: number, sig: 'SIGTERM' | 'SIGKILL'): boolean {
  try {
    process.kill(pid, sig)
    return true
  } catch {
    return false
  }
}

// The terminal window that hosts only this claude session, or null. Two shapes count: `terminal > shell > claude`
// (a shell started in the window) and `terminal > claude` (`alacritty -e claude`). The terminal must have exactly
// that one child, so a window shared with other sessions never matches. Read this BEFORE claude is killed, because
// the parent links vanish with it.
export function terminalWindowPid(claudePid: number, root: string = PROC_ROOT): number | null {
  const hosts = (term: number | null, only: number): boolean => {
    if (term === null || term <= 1) return false
    const name = processName(term, root)
    if (name === null || !(TERMINAL_NAMES as readonly string[]).includes(name)) return false
    const kids = childPids(term, root)
    return kids !== null && kids.length === 1 && kids[0] === only
  }
  const parent = readParentPidAt(claudePid, root)
  if (parent !== null && parent > 1) {
    const grand = readParentPidAt(parent, root)
    if (grand !== null && hosts(grand, parent)) return grand
  }
  if (parent !== null && hosts(parent, claudePid)) return parent
  return null
}

// Parent pid read from an arbitrary /proc root (readParentPid is fixed to /proc).
function readParentPidAt(pid: number, root: string): number | null {
  try {
    return parseProcStat(readFileSync(`${root}/${pid}/stat`, 'utf8'))?.ppid ?? null
  } catch {
    return null
  }
}
