// logind presence: `loginctl show-session` gives the session's IdleHint, IdleSinceHint and LockedHint. No X display
// is needed. IdleHint is set by the desktop's own idle watcher, so the idle time is counted from the moment the hint
// went idle (IdleSinceHint), not from the last keypress; it lags the X11 idle time by the watcher's threshold.
import { execFile } from 'node:child_process'

export type LogindState = {
  idleHint: boolean | null
  // IdleSinceHint in microseconds since the epoch (CLOCK_REALTIME), or null when unset (systemd prints 0).
  idleSinceUs: number | null
  locked: boolean | null
}

// Pure parser for the KEY=VALUE lines of `loginctl show-session -p ...`. Unknown or missing keys give null.
export function parseLoginctlShow(text: string): LogindState {
  const kv = new Map<string, string>()
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) kv.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  }
  const bool = (key: string): boolean | null => {
    const v = kv.get(key)
    return v === 'yes' ? true : v === 'no' ? false : null
  }
  const since = Number(kv.get('IdleSinceHint'))
  return {
    idleHint: bool('IdleHint'),
    idleSinceUs: Number.isSafeInteger(since) && since > 0 ? since : null,
    locked: bool('LockedHint'),
  }
}

// Idle milliseconds from logind: 0 when not idle; with IdleHint yes, the time since the hint went idle; null when the
// hint or its time is unknown (the caller treats null as away).
export function logindIdleMs(s: LogindState, nowMs: number): number | null {
  if (s.idleHint === null) return null
  if (!s.idleHint) return 0
  if (s.idleSinceUs === null) return null
  return Math.max(0, Math.floor(nowMs - s.idleSinceUs / 1000))
}

// Runs loginctl with the arguments; its stdout, or null when it fails. Injected in tests.
export type LoginctlRun = (args: string[]) => Promise<string | null>

export function runLoginctl(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('loginctl', args, { timeout: 2000 }, (err, stdout) => resolve(err ? null : String(stdout)))
  })
}

// Reads the session's state with loginctl. `session` is a session id (see resolveGraphicalSession). Null when loginctl
// fails.
export function logindState(session: string, run: LoginctlRun = runLoginctl): Promise<LogindState | null> {
  return run(['show-session', session, '-p', 'IdleHint', '-p', 'IdleSinceHint', '-p', 'LockedHint']).then((text) =>
    text === null ? null : parseLoginctlShow(text),
  )
}

// One row of `loginctl list-sessions --no-legend`: "SESSION UID USER SEAT TTY" (SEAT and TTY may be empty).
export type SessionRow = { id: string; uid: number }

export function parseSessionList(text: string): SessionRow[] {
  const rows: SessionRow[] = []
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f.length < 2 || f[0] === '') continue
    const uid = Number(f[1])
    if (Number.isSafeInteger(uid) && uid >= 0) rows.push({ id: f[0] as string, uid })
  }
  return rows
}

// The Type and Active values of one session (`loginctl show-session -p Type -p Active`).
export type SessionProps = { type: string | null; active: boolean | null }

export function parseSessionProps(text: string): SessionProps {
  const kv = new Map<string, string>()
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) kv.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  }
  const type = kv.get('Type') ?? ''
  const active = kv.get('Active')
  return { type: type === '' ? null : type, active: active === 'yes' ? true : active === 'no' ? false : null }
}

// The graphical session of `uid`: the first one whose Type is x11 or wayland and that is Active. Null when there is
// none (the caller then has no idle source, which the away rule reads as unknown).
export function pickGraphicalSession(
  sessions: Array<{ id: string; uid: number } & SessionProps>,
  uid: number,
): string | null {
  const hit = sessions.find((s) => s.uid === uid && (s.type === 'x11' || s.type === 'wayland') && s.active === true)
  return hit ? hit.id : null
}

// What loginctl says about the uid's graphical sessions. `session`: an active one (the idle source). `none`: loginctl
// ran and the uid has no x11 or wayland session at all (no graphical login, e.g. the PC sits at the greeter). `unknown`:
// loginctl failed, or a session could not be read, or a graphical session exists but is not active.
export type GraphicalLookup = { kind: 'session'; id: string } | { kind: 'none' } | { kind: 'unknown' }

export async function lookupGraphicalSession(uid: number, run: LoginctlRun = runLoginctl): Promise<GraphicalLookup> {
  const list = await run(['list-sessions', '--no-legend', '--no-pager'])
  if (list === null) return { kind: 'unknown' }
  const sessions: Array<{ id: string; uid: number } & SessionProps> = []
  let unreadable = false
  for (const row of parseSessionList(list)) {
    if (row.uid !== uid) continue
    const text = await run(['show-session', row.id, '-p', 'Type', '-p', 'Active'])
    if (text === null) {
      unreadable = true // skipped, as before; it only matters when nothing else is found
      continue
    }
    sessions.push({ ...row, ...parseSessionProps(text) })
  }
  const id = pickGraphicalSession(sessions, uid)
  if (id !== null) return { kind: 'session', id }
  const graphical = sessions.some((s) => s.type === 'x11' || s.type === 'wayland')
  return unreadable || graphical ? { kind: 'unknown' } : { kind: 'none' }
}

// Finds the caller's graphical session with loginctl: list the sessions, then ask each one of this uid for its Type
// and Active. Null when loginctl fails or no active graphical session of the uid exists.
export async function resolveGraphicalSession(uid: number, run: LoginctlRun = runLoginctl): Promise<string | null> {
  const found = await lookupGraphicalSession(uid, run)
  return found.kind === 'session' ? found.id : null
}
