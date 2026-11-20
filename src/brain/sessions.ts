// Session registry and per-session state: the Session type, names, history, and the live registry. No I/O.
//
// Identity: a session with a process is keyed `<pid>:<start>`, where start is the process start time (procKey). A pid
// alone is reused by the OS, so a dead session's key must never match a new process. A session without a pid is keyed
// `cwd:<folder>`. A key is fixed once assigned: a pid-less session that later gets a pid keeps its key, and is found by
// pid and start (Registry.claim), so topics and the message map never need rekeying.
import { basename } from 'node:path'
import { OutboundLedger } from '../router/outbound.ts'
import { MINUTE, cutAt, redact } from './common.ts'
import type { MessageId, ThreadId } from './chat-types.ts'
import type { AgentKind } from '../ports.ts'

export const NULL_PID_TTL_MS = 2 * 60 * MINUTE
export const HISTORY_LEN = 6
export const HISTORY_CHARS = 300

export type SessionKey = number | string

// A process as the router sees it: its pid and its start time ('' when it could not be read).
export type ProcRef = { pid: number; start: string }

export function procKey(p: ProcRef): string {
  return `${p.pid}:${p.start}`
}

// The ProcRef of a pid, or null without one. `readStart` gives the start time, or null when unreadable.
export function procRef(pid: number | null, readStart: (pid: number) => string | null): ProcRef | null {
  return pid === null ? null : { pid, start: readStart(pid) ?? '' }
}

// One message exchanged with the user, as the router saw it: inbound content delivered to the session
// ('user') or text the session sent ('agent'). Stored already redacted and truncated.
export type HistoryEntry = { dir: 'user' | 'agent'; text: string }

export type Session = {
  key: SessionKey
  name: string
  project: string
  cwd: string
  // The kind of agent this session runs. A new session is 'claude' (newSession).
  agent: AgentKind
  pid: number | null
  // The process start time that goes with pid ('' when unknown or no pid).
  start: string
  hasChannel: boolean
  connected: boolean
  spawned: boolean
  lastActive: number
  turnStart: number
  inTurn: boolean
  // What was sent in the current turn; see outbound.ts.
  outbound: OutboundLedger
  lastSentAt: number
  lastProactiveAt: number
  waiting: boolean
  // Last HISTORY_LEN messages, oldest first.
  history: HistoryEntry[]
  // The backend's session id (Claude Code: its session_id, the transcript name), from the hook payloads. Lets /resume
  // tell that a transcript is already open in a channel session.
  backendSessionId: string | null
  // The newest Telegram message delivered to this session whose turn has not ended yet. The session's answers quote it
  // (once), and a session that dies while it is set is reported as terminated. Cleared when the turn ends.
  pendingTg: { messageId: MessageId; thread: ThreadId | null; replied: boolean } | null
}

// ---------- names ----------

// `project` if free, else `project#N` with the lowest free N >= 2.
export function assignName(project: string, taken: ReadonlySet<string>): string {
  if (!taken.has(project)) return project
  for (let n = 2; ; n++) {
    const candidate = `${project}#${n}`
    if (!taken.has(candidate)) return candidate
  }
}

function mostRecent(list: Session[], pred: (s: Session) => boolean): Session | undefined {
  let best: Session | undefined
  for (const s of list) {
    if (!pred(s)) continue
    if (!best || s.lastActive > best.lastActive) best = s
  }
  return best
}

// ---------- registry ----------

export function newSession(key: SessionKey, name: string, cwd: string, pid: number | null, now: number, start = ''): Session {
  return {
    key,
    name,
    project: basename(cwd) || cwd,
    cwd,
    agent: 'claude',
    pid,
    start: pid === null ? '' : start,
    hasChannel: false,
    connected: false,
    spawned: false,
    lastActive: now,
    turnStart: now,
    inTurn: false,
    outbound: new OutboundLedger(),
    lastSentAt: 0,
    lastProactiveAt: 0,
    waiting: false,
    history: [],
    backendSessionId: null,
    pendingTg: null,
  }
}

// The session_id a hook payload carries. Anything else (missing, oversized, odd characters) is ignored.
export const SESSION_ID_RE = /^[A-Za-z0-9-]{1,200}$/
export function validSessionId(v: unknown): string | null {
  return typeof v === 'string' && SESSION_ID_RE.test(v) ? v : null
}

// Records one exchanged message. Redacts first, then truncates, so a secret cut at the limit cannot leak.
export function pushHistory(s: Session, dir: HistoryEntry['dir'], text: string, secrets: readonly string[]): void {
  const clean = redact(text, secrets).trim()
  if (!clean) return
  const short = clean.length > HISTORY_CHARS ? cutAt(clean, HISTORY_CHARS - 1) + '…' : clean
  s.history.push({ dir, text: short })
  if (s.history.length > HISTORY_LEN) s.history.splice(0, s.history.length - HISTORY_LEN)
}

// A session that is not in any registry: used to deliver a request (tg-notify) without listing the process.
export function detachedSession(proc: ProcRef | null, cwd: string, now: number): Session {
  const key = proc ? procKey(proc) : `cwd:${cwd}`
  return newSession(key, basename(cwd) || cwd, cwd, proc?.pid ?? null, now, proc?.start ?? '')
}

// Live session registry. Mutates only its own Session objects; no I/O.
export class Registry {
  private readonly byKey = new Map<SessionKey, Session>()
  // Called with each session as it is claimed: created, or adopted once its pid is known. The router uses it to attach
  // the session's outbound ledger (see core.ts).
  private readonly onClaim: ((s: Session) => void) | undefined

  constructor(onClaim?: (s: Session) => void) {
    this.onClaim = onClaim
  }

  list(): Session[] {
    return [...this.byKey.values()]
  }

  get(key: SessionKey): Session | undefined {
    return this.byKey.get(key)
  }

  // Forgets a session. Returns it, or undefined if it was not registered.
  remove(key: SessionKey): Session | undefined {
    const s = this.byKey.get(key)
    this.byKey.delete(key)
    return s
  }

  // A channel registration. Without a pid, the channel is its own session (one per connection). `agent` is the kind of
  // the registering session: only a pid-less session of that kind is adopted, and a new session gets that kind.
  registerChannel(proc: ProcRef | null, cwd: string, now: number, agent: AgentKind = 'claude'): Session {
    const s = this.claim(proc, cwd, now, true, agent)
    s.hasChannel = true
    s.connected = true
    return s
  }

  upsertFromHook(proc: ProcRef | null, cwd: string, now: number): Session {
    return this.claim(proc, cwd, now, false)
  }

  // Drops sessions whose process is gone: `alive(pid, start)` must say the process with that start time still exists.
  // A pid-less session lives while connected or recently active.
  sweep(now: number, alive: (pid: number, start: string) => boolean): Session[] {
    const removed: Session[] = []
    for (const s of this.byKey.values()) {
      const live = s.pid !== null ? alive(s.pid, s.start) : s.connected || now - s.lastActive < NULL_PID_TTL_MS
      if (!live) removed.push(s)
    }
    for (const s of removed) this.byKey.delete(s.key)
    return removed
  }

  private claim(proc: ProcRef | null, cwd: string, now: number, channel: boolean, agent: AgentKind = 'claude'): Session {
    let s: Session | undefined
    if (proc) {
      s = this.list().find((x) => x.pid === proc.pid && x.start === proc.start)
      if (!s) {
        // A hook session first seen without a pid is adopted once its pid is known. A connected channel is never adopted.
        // Only a session of the same kind is adopted (a claude hook never takes an opencode session, and the reverse).
        s = mostRecent(this.list(), (x) => x.pid === null && !x.connected && x.cwd === cwd && x.agent === agent)
        if (s) {
          s.pid = proc.pid
          s.start = proc.start
        }
      }
    } else if (!channel) {
      // A hook without a pid can only be attributed to a session without a pid in its folder.
      s = mostRecent(this.list(), (x) => x.pid === null && x.cwd === cwd && x.agent === agent)
    }
    if (!s) {
      const project = basename(cwd) || cwd
      const name = assignName(project, new Set(this.list().map((x) => x.name)))
      const key = proc ? procKey(proc) : this.pidlessKey(cwd)
      s = newSession(key, name, cwd, proc?.pid ?? null, now, proc?.start ?? '')
      s.agent = agent
      this.byKey.set(key, s)
    }
    s.lastActive = now
    this.onClaim?.(s)
    return s
  }

  private pidlessKey(cwd: string): string {
    let key = `cwd:${cwd}`
    for (let n = 2; this.byKey.has(key); n++) key = `cwd:${cwd}#${n}`
    return key
  }
}

export function mostRecentInProject(live: Session[], project: string): Session | undefined {
  return mostRecent(live, (s) => s.project === project)
}
