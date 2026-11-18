// Transient systemd scopes for work the router starts that must not stay in the router's cgroup. A process started by the
// router (or by an addon, which the router starts) is in the router's unit cgroup, and so are its children and their
// helpers: a helper that outlives the run keeps the unit loaded after a stop. Running the work in its own scope moves it
// out. The tmux server is scoped in tmux.ts; this module serves the other work (headless Claude runs).
import { randomBytes } from 'node:crypto'

// A unit name for one scope: `tg-<kind>-<8 hex>`. A new name for every run, so a leftover scope can never collide with one.
export function unitName(kind: string): string {
  return `tg-${kind}-${randomBytes(4).toString('hex')}`
}

// The command that runs `file args` in a new scope named `unit`, with the same environment and working folder.
export function wrapInScope(file: string, args: readonly string[], unit: string): { file: string; args: string[] } {
  return { file: 'systemd-run', args: ['--user', '--scope', '--quiet', `--unit=${unit}`, '--', file, ...args] }
}

export type ScopeProbe = {
  // True when systemd-run is on PATH.
  hasSystemdRun(): boolean
  // True when the systemd --user manager answers.
  userManagerUp(): Promise<boolean>
}

// Whether scopes can be made: systemd-run is on PATH and the --user manager answers. Asked once by the caller.
export async function scopeAvailable(probe: ScopeProbe): Promise<boolean> {
  if (!probe.hasSystemdRun()) return false
  return probe.userManagerUp()
}
