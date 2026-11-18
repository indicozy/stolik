// Who is on the other end of a router socket connection (finding 14). Linux only, and cheap: the accepted socket's inode
// comes from its fd, `ss -xpeH` gives the peer's inode, and the same listing names the pid that owns the peer's end.
// macOS and any failure give null. Callers then accept what the socket file allows: startSocketServer keeps the socket
// at 0600 and that is the only check on those platforms.
import { execFile } from 'node:child_process'
import { readFileSync, readlinkSync } from 'node:fs'
import type { Socket } from 'node:net'
import { findClaudePid } from '../platform/process.ts'
import { parseProcStat } from '../platform/linux-proc.ts'

const MAX_HOPS = 15
const peerCache = new WeakMap<Socket, Promise<number | null>>()

// The pid at the far end of an accepted connection, or null when it cannot be read. Cached per connection.
export function peerPidOf(socket: Socket): Promise<number | null> {
  if (process.platform !== 'linux') return Promise.resolve(null)
  let p = peerCache.get(socket)
  if (!p) {
    p = resolvePeer(socket)
    peerCache.set(socket, p)
  }
  return p
}

async function resolvePeer(socket: Socket): Promise<number | null> {
  // The accepted socket's fd (Node keeps it on the handle). Read now: the fd goes away when the client does.
  const fd = (socket as unknown as { _handle?: { fd?: unknown } })._handle?.fd
  if (typeof fd !== 'number') return null
  let ino: string
  try {
    const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/self/fd/${fd}`))
    if (!m) return null
    ino = m[1]
  } catch {
    return null
  }
  const listing = await ss()
  return listing === null ? null : peerPidFromSs(listing, ino)
}

function ss(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('ss', ['-xpeH'], { timeout: 3000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? null : stdout)
    })
  })
}

type SsRow = { localIno: string | null; peerIno: string | null; owner: number | null }

const isIno = (s: string | undefined): s is string => s !== undefined && /^\d+$/.test(s)

// One row per unix socket in `ss -xpeH` output: "Netid State Recv-Q Send-Q Local Peer [users:((...pid=N...))] ..."
// where an address is a path or '*', and each may be followed by its inode.
export function parseSsRows(text: string): SsRow[] {
  const rows: SsRow[] = []
  for (const line of text.split('\n')) {
    const cut = line.indexOf(' users:(')
    const head = (cut === -1 ? line : line.slice(0, cut)).trim().split(/\s+/)
    const addr = head.slice(4)
    if (addr.length < 2) continue
    let i = 1 // addr[0] is the local address
    const localIno = isIno(addr[i]) ? addr[i++] : null
    i++ // peer address
    const peerIno = isIno(addr[i]) ? addr[i] : null
    const pid = cut === -1 ? null : /pid=(\d+)/.exec(line.slice(cut))
    rows.push({ localIno, peerIno, owner: pid ? Number(pid[1]) : null })
  }
  return rows
}

// The owner pid of the peer of the socket whose inode is `localIno`, from an `ss -xpeH` listing. Pure.
export function peerPidFromSs(text: string, localIno: string): number | null {
  const rows = parseSsRows(text)
  const mine = rows.find((r) => r.localIno === localIno)
  if (!mine || mine.peerIno === null) return null
  const other = rows.find((r) => r.localIno === mine.peerIno)
  return other?.owner ?? null
}

// `pid` and its parents, nearest first, up to MAX_HOPS. Empty when /proc cannot be read.
export function ancestry(pid: number): number[] {
  const out: number[] = []
  let cur = pid
  for (let hop = 0; hop < MAX_HOPS && cur > 1; hop++) {
    out.push(cur)
    try {
      const parsed = parseProcStat(readFileSync(`/proc/${cur}/stat`, 'utf8'))
      if (!parsed) break
      cur = parsed.ppid
    } catch {
      break
    }
  }
  return out
}

// True when `pid` runs inside a Claude Code session (the claude process is itself or an ancestor).
export function isClaudeSession(pid: number): boolean {
  return findClaudePid(pid) !== null
}

// A claimed pid is honest when it is the peer or one of the peer's ancestors (the channel server and the hooks are
// children of the claude process that claims them).
export function claimHolds(claimed: number, peer: number): boolean {
  return ancestry(peer).includes(claimed)
}

// A pid as sent in a message: a positive integer, or null when the message carries none.
export function validPid(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null
}

export type Gate = { ok: true } | { ok: false; reason: string; reply?: object }

// Decides whether one socket message is dispatched. `peer` is the connection's pid, or null when unknown (then the
// claim cannot be checked and the message is accepted, as on macOS). Pure apart from the injected checks.
export function gateMessage(
  msg: any,
  peer: number | null,
  checks: { claimHolds: (claimed: number, peer: number) => boolean; isClaudeSession: (pid: number) => boolean } = { claimHolds, isClaudeSession },
): Gate {
  if (!msg || typeof msg !== 'object') return { ok: true }
  if (msg.claudePid !== undefined && msg.claudePid !== null) {
    const claimed = validPid(msg.claudePid)
    if (claimed === null) return { ok: false, reason: `${String(msg.t)}: claudePid is not a positive integer` }
    if (peer !== null && !checks.claimHolds(claimed, peer)) {
      return { ok: false, reason: `${String(msg.t)}: claudePid ${claimed} is not the caller or its parent (caller ${peer})` }
    }
  }
  // Unlock is refused from inside a Claude session, so a session cannot lift the kill switch it is under. Lock is allowed.
  if (msg.t === 'ctl' && msg.cmd === 'unlock' && peer !== null && checks.isClaudeSession(peer)) {
    return { ok: false, reason: 'ctl unlock refused: caller runs inside a Claude session', reply: { t: 'ctl_result', ok: false, error: 'unlock refused from inside a Claude session' } }
  }
  return { ok: true }
}
