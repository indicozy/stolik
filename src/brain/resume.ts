// /resume, pure side: which Claude Code sessions the owner can continue from Telegram, their titles, labels and
// button data. The readers that feed it (transcript scan, live session pids) are in adapters/transcripts.ts.
import { basename } from 'node:path'
import type { Session } from '../router/state.ts'

export const RESUME_LIST_MAX = 10
export const RESUME_TITLE_MAX = 60
export const RESUME_PENDING_TTL_MS = 30 * 60_000
export const RESUME_PENDING_CAP = 20
const LABEL_MAX = 64
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ResumeState = 'ended' | 'live-channel' | 'live-no-channel'

// What the scanner reads from one transcript. `path` is the file it came from.
export type TranscriptMeta = {
  id: string
  path: string
  cwd: string
  title: string
  mtime: number
  entrypoint: string | null
}

export type ResumeItem = {
  id: string
  path: string
  cwd: string
  title: string
  lastActive: number
  state: ResumeState
}

export function isResumeId(id: string): boolean {
  return UUID_RE.test(id)
}

// One line, trimmed, at most `max` characters (the last one an ellipsis). Counts code points, not UTF-16 units.
export function cleanTitle(text: string, max: number = RESUME_TITLE_MAX): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim())
  if (chars.length <= max) return chars.join('')
  return chars.slice(0, max - 1).join('') + '…'
}

// The AI title, else the last prompt, else the first prompt; a placeholder when none is usable.
export function pickTitle(parts: { aiTitle?: string | null; lastPrompt?: string | null; firstPrompt?: string | null }): string {
  for (const t of [parts.aiTitle, parts.lastPrompt, parts.firstPrompt]) {
    const c = cleanTitle(t ?? '')
    if (c !== '') return c
  }
  return '(untitled session)'
}

// Newest first, at most RESUME_LIST_MAX. Keeps only interactive (entrypoint cli) transcripts with a usable id and
// cwd. A session id that is live in a channel session is 'live-channel'; live without one is 'live-no-channel'.
export function listResumable(
  entries: readonly TranscriptMeta[],
  liveSessionIds: ReadonlySet<string>,
  channelSessionIds: ReadonlySet<string>,
  now: number,
): ResumeItem[] {
  const newest = new Map<string, TranscriptMeta>()
  for (const e of entries) {
    if (!isResumeId(e.id) || e.entrypoint !== 'cli' || e.cwd === '') continue
    const prev = newest.get(e.id)
    if (!prev || e.mtime > prev.mtime) newest.set(e.id, e)
  }
  return [...newest.values()]
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, RESUME_LIST_MAX)
    .map((e) => ({
      id: e.id,
      path: e.path,
      cwd: e.cwd,
      title: e.title,
      lastActive: Math.min(e.mtime, now),
      state: channelSessionIds.has(e.id) ? 'live-channel' : liveSessionIds.has(e.id) ? 'live-no-channel' : 'ended',
    }))
}

// The channel session that runs transcript `id`: its hook reported the id, or its live pid is the one that
// ~/.claude/sessions maps to the id (covers the gap before the first hook).
export function channelSessionFor(
  id: string,
  sessions: readonly Session[],
  live: ReadonlyMap<string, number>,
): Session | undefined {
  const pid = live.get(id)
  return sessions.find((s) => s.hasChannel && (s.backendSessionId === id || (pid !== undefined && s.pid === pid)))
}

export function relativeAgo(then: number, now: number): string {
  const min = Math.floor(Math.max(0, now - then) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.floor(h / 24)} d ago`
}

const STATE_MARK: Record<ResumeState, string> = {
  ended: '',
  'live-channel': ' · live',
  'live-no-channel': ' · live, no channel',
}

// Button text: "title · folder · 3 h ago" plus the live mark. Only the title is shortened, to fit Telegram's
// button width.
export function resumeLabel(item: ResumeItem, now: number): string {
  const folder = basename(item.cwd) || item.cwd
  const rest = ` · ${folder} · ${relativeAgo(item.lastActive, now)}${STATE_MARK[item.state]}`
  const room = LABEL_MAX - Array.from(rest).length
  return cleanTitle(item.title, Math.max(8, room)) + rest
}

export function resumeCallbackData(pendingId: string, idx: number): string {
  return `rz:${pendingId}:${idx}`
}

export function parseResumeCallback(data: string): { pendingId: string; idx: number } | null {
  const m = /^rz:([0-9a-f]{8}):(\d{1,2})$/.exec(data)
  return m ? { pendingId: m[1], idx: Number(m[2]) } : null
}
