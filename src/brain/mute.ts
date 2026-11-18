// Folder-topic mutes (spec 24 §4): `/silent` mutes the default-level sends of a folder topic. Keyed by the folder's cwd,
// so the mute survives a restart and a topic close/reopen. Pure: no Telegram, no I/O. The router holds the map and saves
// it through the store (src/router/mute.ts).
import { parseCommandWord } from './commands.ts'
const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS

export const MAX_MUTE_MS = WEEK_MS

// cwd -> until (epoch ms), or null for "until /silent off".
export type Mutes = Record<string, number | null>

// Stored as JSON text. Anything that is not a cwd with a number or null is dropped.
export function parseMutes(json: string): Mutes {
  if (json.trim() === '') return {}
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return {}
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Mutes = {}
  for (const [cwd, until] of Object.entries(raw)) {
    if (until === null || (typeof until === 'number' && Number.isFinite(until))) out[cwd] = until
  }
  return out
}

export function serializeMutes(mutes: Mutes): string {
  return JSON.stringify(mutes)
}

// The mute in force for a folder at `now`, or null when there is none. An expired one counts as none.
export function activeMute(mutes: Mutes, cwd: string, now: number): { until: number | null } | null {
  if (!Object.hasOwn(mutes, cwd)) return null
  const until = mutes[cwd]
  if (until !== null && until <= now) return null
  return { until }
}

export const SILENT_USAGE = 'Use /silent for until /silent off, /silent <duration> (30m, 2h, 1d, 1w), /silent off, or /silent status.'

export type SilentCommand =
  | { kind: 'on' }
  | { kind: 'off' }
  | { kind: 'status' }
  | { kind: 'for'; ms: number }
  | { kind: 'refuse'; reason: string }

const UNIT_MS: Record<string, number> = { m: MINUTE_MS, h: HOUR_MS, d: DAY_MS, w: WEEK_MS }

// `/silent` in a folder topic (also `/silent@<botname>`). Null for any other message. A bad or too long duration is a
// refusal with the reason, so the owner is told why nothing changed.
export function parseSilentCommand(text: string): SilentCommand | null {
  const c = parseCommandWord(text)
  if (!c || c.word.toLowerCase() !== 'silent') return null
  const arg = c.arg.toLowerCase()
  if (arg === '') return { kind: 'on' }
  if (arg === 'off') return { kind: 'off' }
  if (arg === 'status') return { kind: 'status' }
  const d = /^(\d+)([mhdw])$/.exec(arg)
  if (!d) return { kind: 'refuse', reason: SILENT_USAGE }
  const n = Number(d[1])
  if (n === 0) return { kind: 'refuse', reason: `The duration must be more than 0. ${SILENT_USAGE}` }
  const ms = n * UNIT_MS[d[2]]
  if (ms > MAX_MUTE_MS) {
    return { kind: 'refuse', reason: 'The longest /silent is 1w (7 days). For longer, send /silent and /silent off later.' }
  }
  return { kind: 'for', ms }
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// A local time as the owner reads it: "Wed 18:30".
export function localDayTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${DAY_NAMES[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// The reply to /silent (an ack, sent silent). `until` is the mute's end, or null for "until /silent off".
export function muteAckText(until: number | null): string {
  return until === null
    ? '🔕 Muted until /silent off. Approvals and questions still ping.'
    : `🔕 Muted until ${localDayTime(until)}. Approvals and questions still ping.`
}

export function muteStatusText(mute: { until: number | null } | null): string {
  if (mute === null) return '🔔 Not muted. /silent mutes this folder\'s topic.'
  return mute.until === null ? '🔕 Muted until /silent off.' : `🔕 Muted until ${localDayTime(mute.until)}.`
}

export const UNMUTED_TEXT = '🔔 Unmuted.'
