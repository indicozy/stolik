// Prefix words in General (design §4.3): "to <session>:", "new <project>:", "oc <project>:" (opencode), "note:", "quick:", "read:", "web:".
// Pure: no I/O. Only General messages are parsed; inside a session topic nothing is (ticket 07).
// Also here: name matching for `to` and `new` (matchName), and the legacy note reader kept for test/notes.test.ts.

export type PrefixKind = 'to' | 'new' | 'oc' | 'note' | 'quick' | 'read' | 'web'

// `name` is set for the kinds that take one (to, new); it is absent when the name is empty.
export type Prefix = { kind: PrefixKind; name?: string; body: string }

// The words per kind, lower case. Spoken forms with a second word ("quick question", "web search", "send to") are
// listed as phrases; whitespace inside a phrase matches any run of spaces.
export const PREFIX_WORDS: Readonly<Record<PrefixKind, readonly string[]>> = {
  to: ['to', 'send to', 'отправь в'],
  new: ['new', 'новая', 'новый'],
  oc: ['oc', 'opencode'],
  note: ['note', 'заметка', 'запиши'],
  quick: ['quick', 'quick question', 'question', 'вопрос', 'быстро'],
  read: ['read', 'check', 'почитай', 'проверь'],
  web: ['web', 'web search', 'search', 'поиск', 'загугли'],
}

const NAME_KINDS: ReadonlySet<PrefixKind> = new Set(['to', 'new', 'oc'])

// The phrases that start opencode after the word "new" ("new oc stolik: hi"). They are oc, not new.
const OC_PHRASES: readonly string[] = ['new oc', 'new opencode']
// A name longer than this, or one spanning lines, is a sentence that happens to start with "to", not a name.
export const PREFIX_NAME_MAX = 60

function normWord(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ')
}

const PHRASE_KIND = new Map<string, PrefixKind>()
for (const kind of Object.keys(PREFIX_WORDS) as PrefixKind[]) {
  for (const w of PREFIX_WORDS[kind]) PHRASE_KIND.set(normWord(w), kind)
}
for (const w of OC_PHRASES) PHRASE_KIND.set(normWord(w), 'oc')

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Longest phrase first, so "quick question" wins over "quick". A word must not run on into a longer word.
const WORD_RE = new RegExp(
  `^\\s*(${[...PHRASE_KIND.keys()]
    .sort((a, b) => b.length - a.length)
    .map((p) => escapeRe(p).replace(/ /g, '\\s+'))
    .join('|')})(?![\\p{L}\\p{N}_])`,
  'iu',
)

// Splits "<name><sep><body>" for to and new. The separator is the first colon or comma, or a dash with spaces around
// it (so "stolik: hi" and "stolik - hi" both name stolik). Null when there is no separator or no clean name.
function splitName(rest: string): { name?: string; body: string } | null {
  if (!/^(\s|[:,])/.test(rest)) return null
  const sep = /[:,]|\s[-–—]+(?=\s|$)/.exec(rest)
  if (!sep) return null
  const name = rest.slice(0, sep.index).trim()
  if (name.length > PREFIX_NAME_MAX || /[\r\n]/.test(name)) return null
  return { name: name === '' ? undefined : name, body: rest.slice(sep.index + sep[0].length).trim() }
}

// The separator after a prefix word that takes no name: a colon or a comma (directly or after spaces), or a dash that is
// followed by a space ("quick - x", "quick- x"). A dash inside a word ("quick-fix", "read-only", "note-to-self") is not one.
const SEPARATOR_RE = /^\s*(?:[:,]|[-–—]+(?=\s))/

// The text after the separator, or null when `rest` does not start with one. Shared with the addon prefix parser.
export function afterSeparator(rest: string): string | null {
  const m = SEPARATOR_RE.exec(rest)
  return m ? rest.slice(m[0].length) : null
}

function splitBody(rest: string): { body: string } | null {
  const after = afterSeparator(rest)
  return after === null ? null : { body: after.trim() }
}

// The prefix of a General message, or null. The word is case-insensitive, must be followed by a colon, comma or
// dash, and must start the message (after whitespace). "note that the build failed" has no separator, so it is not a prefix.
export function parsePrefix(text: string): Prefix | null {
  const w = WORD_RE.exec(text)
  if (!w) return null
  const kind = PHRASE_KIND.get(normWord(w[1]))
  if (!kind) return null
  const rest = text.slice(w[0].length)
  if (NAME_KINDS.has(kind)) {
    const parts = splitName(rest)
    if (!parts) return null
    return parts.name === undefined ? { kind, body: parts.body } : { kind, name: parts.name, body: parts.body }
  }
  const parts = splitBody(rest)
  return parts ? { kind, body: parts.body } : null
}

// The entry point for a General message (text or a voice transcript). Inside a session topic the caller does not
// call it at all.
export function parseGeneral(text: string): Prefix | null {
  return text === '' ? null : parsePrefix(text)
}

// ---------- name matching ----------

export type NameMatch = { match: string } | { ambiguous: string[] } | null

// Case, spaces, dashes and underscores do not count. "stolik", "stolik" and "stolik" are the same name.
function normName(s: string): string {
  return s.toLowerCase().replace(/[\s_\-–—]+/g, '')
}

// The last segment of "parent/name" (the whole string when there is no slash).
function lastSegment(s: string): string {
  const i = s.lastIndexOf('/')
  return i === -1 ? s : s.slice(i + 1)
}

// Levenshtein distance, with an early exit above `limit` (returns limit + 1 then).
export function editDistance(a: string, b: string, limit = Infinity): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      cur.push(v)
      if (v < rowMin) rowMin = v
    }
    if (rowMin > limit) return limit + 1
    prev = cur
  }
  return prev[b.length]
}

const MAX_EDIT = 2

// Finds the name a user typed among `list` (session names, folder names). In order: an exact match, then a unique
// prefix, then the closest name within edit distance 2. Each candidate also matches by the last segment of
// "parent/name". Several hits at the same stage are ambiguous and are returned together.
export function matchName(name: string, list: readonly string[]): NameMatch {
  const q = normName(name)
  if (q === '') return null
  const items = [...new Set(list)].map((item) => ({ item, full: normName(item), last: normName(lastSegment(item)) }))

  const pick = (hits: string[]): NameMatch | null => {
    if (hits.length === 0) return null
    return hits.length === 1 ? { match: hits[0] } : { ambiguous: hits }
  }

  // Full names are tried before last segments, so "notes" picks a session named notes over parent/notes.
  for (const test of [(k: string) => k === q, (k: string) => k.startsWith(q)]) {
    const full = pick(items.filter((i) => test(i.full)).map((i) => i.item))
    if (full) return full
    const last = pick(items.filter((i) => test(i.last)).map((i) => i.item))
    if (last) return last
  }

  let best = MAX_EDIT + 1
  let hits: string[] = []
  for (const i of items) {
    const d = Math.min(editDistance(q, i.full, MAX_EDIT), editDistance(q, i.last, MAX_EDIT))
    if (d > MAX_EDIT) continue
    if (d < best) {
      best = d
      hits = [i.item]
    } else if (d === best) {
      hits.push(i.item)
    }
  }
  return pick(hits)
}

// ---------- legacy note reader ----------

// The old "note" reader: a "note" word followed by any separator, a space or a newline, or nothing. The notes inbox
// and test/notes.test.ts still use it. General routing does not: it uses parsePrefix, which needs a separator.
const LEGACY_NOTE_RE = /^\s*note\b[\s:.,\-—]*/i

// The note's text with the prefix stripped, or null if the message is not a note. '' is a note with no text.
export function parseNote(text: string): string | null {
  const m = LEGACY_NOTE_RE.exec(text)
  return m ? text.slice(m[0].length).trim() : null
}
