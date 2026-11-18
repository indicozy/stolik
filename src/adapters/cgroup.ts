// The router's own cgroup, for `tg-bridge doctor` and the router's start-up checks: which processes share it that the
// router did not start. Under systemd, a tmux server or a session process left in the router's unit keeps the unit loaded
// after a stop, so the next start fails ("already loaded"). The parsers are pure; `readRouterCgroup` takes its file source
// as an argument, so tests pass a fake.
import { readFileSync } from 'node:fs'

export const CGROUP_ROOT = '/sys/fs/cgroup'
// A parent chain longer than this is treated as foreign (a loop or a very deep tree is not the router's own work).
const MAX_DEPTH = 64

export type CgroupIo = { readText(path: string): string | null }

export type RouterCgroupFacts = {
  // The cgroup v2 path of the router, e.g. /user.slice/.../tg-bridge.service.
  path: string
  routerPid: number
  // Processes in the cgroup, the router included.
  total: number
  // Processes in the cgroup whose parent chain does not reach the router.
  foreign: Array<{ pid: number; comm: string }>
}

// The cgroup v2 path from the text of /proc/<pid>/cgroup (`0::/path`), or null when there is none (cgroup v1 only).
export function parseCgroupPath(text: string): string | null {
  for (const line of text.split('\n')) {
    const m = /^0::(\/.*)$/.exec(line.trim())
    if (m) return m[1]
  }
  return null
}

// The pids of a cgroup.procs file: one positive integer per line. Anything else is skipped.
export function parseCgroupProcs(text: string): number[] {
  const out: number[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (/^\d+$/.test(t) && Number(t) > 0) out.push(Number(t))
  }
  return out
}

// The parent pid from the text of /proc/<pid>/stat. The command name is in parentheses and may hold spaces or brackets,
// so the fields are read after the last closing parenthesis: state, then the parent pid.
export function parsePpid(stat: string): number | null {
  const close = stat.lastIndexOf(')')
  if (close === -1) return null
  const fields = stat.slice(close + 1).trim().split(/\s+/)
  const ppid = Number(fields[1])
  return Number.isInteger(ppid) && ppid >= 0 ? ppid : null
}

// The processes of the cgroup that are not the router's: a process is the router's when walking up its parents reaches
// the router. A process whose parent is unknown (it has gone) is left out. Returned in the order given.
export function foreignProcs(procs: number[], routerPid: number, ppidOf: (pid: number) => number | null): number[] {
  const out: number[] = []
  for (const pid of procs) {
    if (pid === routerPid) continue
    let cur = pid
    let verdict: 'router' | 'foreign' | 'gone' = 'foreign'
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const parent = ppidOf(cur)
      if (parent === null) {
        verdict = depth === 0 ? 'gone' : 'foreign'
        break
      }
      if (parent === routerPid) {
        verdict = 'router'
        break
      }
      if (parent <= 1) break
      cur = parent
    }
    if (verdict === 'foreign') out.push(pid)
  }
  return out
}

const defaultIo: CgroupIo = {
  readText: (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
}

// The router's cgroup and the processes in it that are not the router's own tree, or null when the router's cgroup cannot
// be read (the process is gone, the system has no cgroup v2, or the procs file is unreadable).
export function readRouterCgroup(routerPid: number, io: CgroupIo = defaultIo, root: string = CGROUP_ROOT): RouterCgroupFacts | null {
  const own = io.readText(`/proc/${routerPid}/cgroup`)
  if (own === null) return null
  const path = parseCgroupPath(own)
  if (path === null) return null
  const procsText = io.readText(`${root}${path === '/' ? '' : path}/cgroup.procs`)
  if (procsText === null) return null
  const procs = parseCgroupProcs(procsText)
  const ppidOf = (pid: number): number | null => {
    const stat = io.readText(`/proc/${pid}/stat`)
    return stat === null ? null : parsePpid(stat)
  }
  const foreign = foreignProcs(procs, routerPid, ppidOf).map((pid) => ({
    pid,
    comm: (io.readText(`/proc/${pid}/comm`) ?? '?').trim() || '?',
  }))
  return { path, routerPid, total: procs.length, foreign }
}
