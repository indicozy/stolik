// Notification levels (spec 24): how loud one message the bot sends is. Pure. This module is the one place that decides
// whether a send pings: callers pass a level (or ask `pingFor`) and never build `silent` themselves.
//   silent   never pings (progress, milestones, FYI, bot status notices, the Logs topic)
//   default  pings, unless the topic is muted (answers, finished tasks)
//   critical always pings (approvals, questions, blockers that need the owner now)
export const LEVELS = ['silent', 'default', 'critical'] as const
export type NotifyLevel = (typeof LEVELS)[number]

// The level a message gets when none is given.
export const DEFAULT_LEVEL: NotifyLevel = 'default'

// Parses a level that came from outside (a channel reply, a socket message). Undefined or null means no level given
// (the default). Returns null for anything else, so the caller can refuse it.
export function parseLevel(v: unknown): NotifyLevel | null {
  if (v === undefined || v === null) return DEFAULT_LEVEL
  return (LEVELS as readonly unknown[]).includes(v) ? (v as NotifyLevel) : null
}

export const LEVEL_ERROR = `level must be one of ${LEVELS.join(', ')}`

// Whether a message of `level` pings the owner. `muted`: its folder topic is muted with /silent (src/brain/mute.ts).
export function pingFor(level: NotifyLevel, muted: boolean): boolean {
  if (level === 'critical') return true
  if (level === 'silent') return false
  return !muted
}

// Whether a send goes out silent: it asked for silent, or its level does not ping in this topic (`muted`). The router's
// send wrapper (src/router/mute.ts) is the one caller; a send with no level is a default one.
export function isSilentSend(opts: { silent?: boolean; level?: NotifyLevel }, muted: boolean): boolean {
  return opts.silent === true || !pingFor(opts.level ?? DEFAULT_LEVEL, muted)
}
