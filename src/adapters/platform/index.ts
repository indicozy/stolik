// Presence backend factory: picks the idle and lock source named in config.json (`presence`: x11 or logind).
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import type { TgConfig } from '../../config.ts'
import type { PlatformPort } from '../../ports.ts'
import { x11IdleMs, x11Locked } from './linux-x11.ts'
import { logindIdleMs, logindState, lookupGraphicalSession, resolveGraphicalSession } from './linux-logind.ts'
import { Presence } from './presence.ts'
import { readResourceMode } from './resource-mode.ts'
import {
  childPids,
  descendants,
  parentPid,
  pidAlive,
  processName,
  processStart,
  readBootId,
  readCmdline,
  signal,
  terminalWindowPid,
} from './process.ts'
import { macosSource, macUptimeSeconds } from './macos.ts'

// One reading for the away rule: idle milliseconds (null when unreadable) and the lock state.
export type { IdleReading } from '../../brain/away.ts'
import type { IdleReading } from '../../brain/away.ts'

export interface IdleSource {
  // Names the backend in log lines.
  readonly name: string
  read(): Promise<IdleReading>
}

// Idle time is unreadable: when loginctl says the uid has no graphical session at all, that is a logged-out reading
// (away); otherwise (a session exists or loginctl fails) the reading stays unknown.
async function noGraphicalLogin(uid: number): Promise<boolean> {
  return (await lookupGraphicalSession(uid)).kind === 'none'
}

const x11Source: IdleSource = {
  name: 'x11',
  async read() {
    const idleMs = await x11IdleMs()
    const locked = await x11Locked()
    if (idleMs !== null) return { idleMs, locked }
    const uid = process.getuid?.() ?? -1
    if (await noGraphicalLogin(uid)) return { idleMs: null, locked: false, loggedOut: true }
    return { idleMs, locked }
  },
}

// The session is XDG_SESSION_ID when the router runs inside a login session. Otherwise (a systemd user service has no
// such variable, and `self` is not a session there) it is the caller's graphical session, found by loginctl. The
// found id is kept until a read fails, then looked up again.
function logindSource(env: NodeJS.ProcessEnv): IdleSource {
  const uid = process.getuid?.() ?? -1
  let found: string | null = null
  return {
    name: 'logind',
    async read() {
      let session: string | null = env.XDG_SESSION_ID || found
      let loggedOut = false
      if (!session) {
        const lookup = await lookupGraphicalSession(uid)
        session = lookup.kind === 'session' ? lookup.id : null
        loggedOut = lookup.kind === 'none'
      }
      const s = session === null ? null : await logindState(session)
      found = s === null ? null : session
      if (s === null) return loggedOut ? { idleMs: null, locked: false, loggedOut: true } : { idleMs: null, locked: false }
      return { idleMs: logindIdleMs(s, Date.now()), locked: s.locked === true }
    },
  }
}

// The idle and lock source for this machine. macOS always uses its own source (plan P4): the presence config names
// Linux backends only.
export function presenceSource(
  cfg: Pick<TgConfig, 'presence'>,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): IdleSource {
  if (platform === 'darwin') return macosSource
  if (cfg.presence === 'x11') return x11Source
  return logindSource(env)
}

// The whole platform port for this machine: presence (idle and lock, with the away rule's cache), /proc facts, file
// facts and CPU pinning. Built once by the composition root (src/app.ts).
export function createPlatform(
  cfg: Pick<TgConfig, 'presence'>,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): PlatformPort {
  const source = presenceSource(cfg, env, platform)
  const presence = new Presence(source)
  const mac = platform === 'darwin'
  return {
    async idleMs() {
      return (await source.read()).idleMs
    },
    async isLocked() {
      return (await source.read()).locked
    },
    isAway: () => presence.isAway(),
    awayState: () => presence.awayState(),
    resourceMode: () => readResourceMode(),
    takeIdleAlert: () => presence.takeAlert(),
    setAway: () => presence.setAway(),
    setHere: (now) => presence.setHere(now),
    pidAlive,
    processArgv: (pid) => readCmdline(pid),
    processStart: (pid) => processStart(pid),
    parentPid: (pid) => parentPid(pid),
    childPids: (pid) => childPids(pid),
    descendants: (pid) => descendants(pid),
    processName: (pid) => processName(pid),
    signal: (pid, sig) => signal(pid, sig),
    terminalWindowPid: (claudePid) => terminalWindowPid(claudePid),
    bootId: () => readBootId(),
    uptimeSeconds: mac ? macUptimeSeconds : readUptimeSeconds,
    realpath(path) {
      try {
        return realpathSync(path)
      } catch {
        return null
      }
    },
    isDirectory(path) {
      try {
        return statSync(path).isDirectory()
      } catch {
        return false
      }
    },
    fileInfo(path) {
      try {
        const st = statSync(path)
        return { isFile: st.isFile(), size: st.size }
      } catch {
        return null
      }
    },
    pinCpus(cpus) {
      // macOS has no taskset: no pinning there (plan P4).
      if (mac) return
      execFileSync('taskset', ['-pc', cpus.join(','), String(process.pid)])
    },
  }
}

// Seconds since boot from /proc/uptime, or null if it cannot be read.
function readUptimeSeconds(): number | null {
  try {
    const n = Number.parseFloat(readFileSync('/proc/uptime', 'utf8').split(' ')[0] ?? '')
    return Number.isFinite(n) && n >= 0 ? n : null
  } catch {
    return null
  }
}
