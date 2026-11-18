// Process and boot facts for the running platform: Linux reads /proc, macOS runs ps and sysctl (plan P4). Callers
// import from here, not from linux-proc.ts or macos.ts, so they do not depend on the OS.
import * as linux from './linux-proc.ts'
import * as mac from './macos.ts'

export { isInteractiveClaude, parseCmdline } from './linux-proc.ts'
export { pidAlive, signal } from './linux-proc.ts'

const onMac = () => process.platform === 'darwin'

// The argv of a pid, or null when it cannot be read.
export function readCmdline(pid: number): string[] | null {
  return onMac() ? mac.macProcessArgv(pid) : linux.readCmdline(pid)
}

// The claude process above `start`, or null.
export function findClaudePid(start: number = process.ppid): number | null {
  return onMac() ? mac.macFindClaudePid(start) : linux.findClaudePid(start)
}

// The start time of a process (a string, stable for its life), or null when it cannot be read. With pid it identifies
// the process: a pid alone is reused by the OS.
export function processStart(pid: number): string | null {
  return onMac() ? mac.macProcessStart(pid) : linux.readProcStart(pid)
}

// The executable name of a process (basename), or null when it cannot be read.
export function processComm(pid: number): string | null {
  return onMac() ? mac.macProcessComm(pid) : linux.readProcComm(pid)
}

// The parent pid of a process, or null when it cannot be read.
export function parentPid(pid: number): number | null {
  return onMac() ? mac.macParentPid(pid) : linux.readParentPid(pid)
}

// The direct children of a pid. macOS has no /proc and no cheap process-tree read here, so null: idle detection then
// counts the session as busy, which is the fail-closed side.
export function childPids(pid: number): number[] | null {
  return onMac() ? null : linux.childPids(pid)
}

// Every descendant of a pid with its argv, or null when unreadable (always null on macOS, see childPids).
export function descendants(pid: number): Array<{ pid: number; argv: string[] }> | null {
  return onMac() ? null : linux.descendants(pid)
}

// The executable name of a process, or null when it cannot be read.
export function processName(pid: number): string | null {
  return onMac() ? mac.macProcessComm(pid) : linux.processName(pid)
}

// The terminal window hosting only this session, or null (always null on macOS, which has no window-to-pid link here).
export function terminalWindowPid(claudePid: number): number | null {
  return onMac() ? null : linux.terminalWindowPid(claudePid)
}

// Identifier of this boot ('' when unreadable).
export function readBootId(): string {
  return onMac() ? mac.macBootId() : linux.readBootId()
}
