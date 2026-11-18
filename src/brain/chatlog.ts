// Chat log (design §4.11): one line per message the router handles, in both directions. Pure: the line shape, the
// JSONL and Markdown renderers, the daily rollover, attachment names and the reader's filter. The files are written by
// src/adapters/files.ts.
import { sanitizeFileName } from '../router/state.ts'
import type { MessageId, ThreadId } from './chat-types.ts'
import { fromDbMsg, fromDbThread, hasDbNumber, toDbId } from '../adapters/store-ids.ts'
import { isWellFormedId } from '../adapters/legacy-ids.ts'

// What a line is about: a live session, a mode (quick, read, web), a note, or a folder a new session starts in.
export type ChatTarget = { type: 'session' | 'mode' | 'note' | 'project'; name: string }

export type ChatLine = {
  // Epoch milliseconds. Written as an ISO string in the JSONL file.
  ts: number
  dir: 'in' | 'out'
  // Telegram kind for incoming messages (text, photo, voice, ...); the message kind for outgoing ones.
  kind: string
  text: string
  // The raw voice transcript before any cleanup. Null until a cleanup step exists (plan 3.2).
  raw: string | null
  target: ChatTarget | null
  topic_id: ThreadId | null
  backend: string | null
  scores: Record<string, number> | null
  gap: number | null
  // Paths relative to the log root (incoming files) or absolute paths (outgoing files, as sent).
  attachments: string[]
  tg_message_id: MessageId | null
}

// The fields a caller gives; the rest take their empty values.
export type ChatLineInput = Pick<ChatLine, 'ts' | 'dir' | 'kind' | 'text'> & Partial<Omit<ChatLine, 'ts' | 'dir' | 'kind' | 'text'>>

export function newChatLine(input: ChatLineInput): ChatLine {
  return {
    raw: null,
    target: null,
    topic_id: null,
    backend: null,
    scores: null,
    gap: null,
    attachments: [],
    tg_message_id: null,
    ...input,
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

// Local calendar parts of an epoch time. Local, because the notes and the daily files are read by the owner.
export function localDay(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function localMonth(ts: number): string {
  return localDay(ts).slice(0, 7)
}

export function localTime(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// The compact time used in attachment names: HHMMSS.
export function localHms(ts: number): string {
  return localTime(ts).replace(/:/g, '')
}

// One JSONL line, ending in a newline. Keys in the order of the design; ts as an ISO string. A Telegram or e2e id keeps
// its number in tg_message_id / topic_id. An id of another platform has no number: it is written as a string in
// message_id / thread_id, which only such lines carry (Telegram lines keep their keys).
export function jsonlLine(line: ChatLine): string {
  const msg = line.tg_message_id
  const thread = line.topic_id
  const out = {
    ts: new Date(line.ts).toISOString(),
    dir: line.dir,
    kind: line.kind,
    text: line.text,
    raw: line.raw,
    target: line.target,
    topic_id: thread !== null && hasDbNumber(thread) ? toDbId(thread) : null,
    backend: line.backend,
    scores: line.scores,
    gap: line.gap,
    attachments: line.attachments,
    tg_message_id: msg !== null && hasDbNumber(msg) ? toDbId(msg) : null,
    ...(thread !== null && !hasDbNumber(thread) ? { thread_id: thread } : {}),
    ...(msg !== null && !hasDbNumber(msg) ? { message_id: msg } : {}),
  }
  return JSON.stringify(out) + '\n'
}

// Reads JSONL text back. Lines that do not parse are skipped (a half-written last line must not hide the rest).
export function parseJsonl(text: string): ChatLine[] {
  const out: ChatLine[] = []
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    try {
      const o = JSON.parse(raw) as Record<string, unknown>
      if (typeof o.ts !== 'string' || (o.dir !== 'in' && o.dir !== 'out')) continue
      out.push({
        ts: Date.parse(o.ts),
        dir: o.dir,
        kind: String(o.kind ?? ''),
        text: String(o.text ?? ''),
        raw: typeof o.raw === 'string' ? o.raw : null,
        target: isTarget(o.target) ? o.target : null,
        topic_id: typeof o.topic_id === 'number' ? fromDbThread(o.topic_id) : typeof o.thread_id === 'string' && isWellFormedId(o.thread_id) ? (o.thread_id as ThreadId) : null,
        backend: typeof o.backend === 'string' ? o.backend : null,
        scores: o.scores && typeof o.scores === 'object' ? (o.scores as Record<string, number>) : null,
        gap: typeof o.gap === 'number' ? o.gap : null,
        attachments: Array.isArray(o.attachments) ? o.attachments.map(String) : [],
        tg_message_id: typeof o.tg_message_id === 'number' ? fromDbMsg(o.tg_message_id) : typeof o.message_id === 'string' && isWellFormedId(o.message_id) ? (o.message_id as MessageId) : null,
      })
    } catch {
      // Not JSON: skip it.
    }
  }
  return out
}

function isTarget(v: unknown): v is ChatTarget {
  if (!v || typeof v !== 'object') return false
  const t = v as Record<string, unknown>
  return typeof t.name === 'string' && (t.type === 'session' || t.type === 'mode' || t.type === 'note' || t.type === 'project')
}

// ---------- Markdown ----------

// Text for one Markdown line: a message never adds lines or markup. Newlines become " ↵ ", and backslashes, backticks,
// angle brackets and square brackets are escaped. A leading "#" is escaped too.
export function mdInline(s: string): string {
  let out = s.replace(/\r\n|\r|\n/g, ' ↵ ')
  out = out.replace(/[\\`<>[\]]/g, (c) => '\\' + c)
  if (out.startsWith('#')) out = '\\' + out
  return out
}

// The daily heading, written above the first line of a day's file.
export function dayHeader(day: string): string {
  return `# ${day}\n\n`
}

// One Markdown line for `line`, plus the day heading when the day differs from `lastDay` (null: nothing written yet).
// Returns the text to append and the day to remember for the next call.
export function markdownLine(line: ChatLine, lastDay: string | null): { text: string; day: string } {
  const day = localDay(line.ts)
  const head = day === lastDay ? '' : dayHeader(day)
  const target = line.target ? ` [${mdInline(`${line.target.type} ${line.target.name}`)}]` : ''
  const kind = line.kind && line.kind !== 'text' ? ` (${mdInline(line.kind)})` : ''
  const files = line.attachments.length > 0 ? ` attachments: ${line.attachments.map((a) => mdInline(a)).join(', ')}` : ''
  const body = line.text === '' ? '' : ` ${mdInline(line.text)}`
  return { text: `${head}- ${localTime(line.ts)} **${line.dir}**${target}${kind}${body}${files}\n`, day }
}

// What the router learns about an incoming message while it handles it. Written as one line when it is done.
export type ChatTrace = {
  text?: string
  // The raw voice transcript, when the text is its cleaned version (plan 3.2).
  raw?: string | null
  target?: ChatTarget | null
  attachments?: string[]
  // The forum topic of the session the message went to (null: General), and its backend.
  topic_id?: ThreadId | null
  backend?: string | null
}

// ---------- attachments ----------

// Where an incoming file goes, relative to the log root: attachments/YYYY-MM-DD/HHMMSS-<name>. When that name is
// taken, HHMMSS-2-<name>, HHMMSS-3-<name>, ... is used. `taken` says whether a relative path exists.
export function attachmentRelPath(ts: number, name: string, taken: (rel: string) => boolean): string {
  const day = localDay(ts)
  const base = sanitizeFileName(name)
  const hms = localHms(ts)
  let rel = `attachments/${day}/${hms}-${base}`
  for (let n = 2; taken(rel); n++) rel = `attachments/${day}/${hms}-${n}-${base}`
  return rel
}

// ---------- reader ----------

// The last `n` lines (oldest first) whose target is `target`: the exchanges with one session, mode or note.
export function selectExchanges(lines: readonly ChatLine[], target: ChatTarget, n: number): ChatLine[] {
  const hits = lines.filter((l) => l.target !== null && l.target.type === target.type && l.target.name === target.name)
  return n <= 0 ? [] : hits.slice(-n)
}
