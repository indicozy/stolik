// Deterministic name matching for plain General messages (design §4.4, step 2): a session or folder name in the text.
// Pure: no I/O. The router decides with it; the route addon is only asked when no name matches.
//
// Two kinds of hit. A "start" hit: the name is the first word of the message (or the second, after "in"/"в"), followed by
// a separator (":", ",", or " -"). A "mid" hit: the name appears anywhere else. Short names (4 characters or fewer) and
// words of the stopword list never produce a hit in the middle of a sentence; a stopword never produces a hit at all.

export const MAX_TEXT_CHARS = 2000
// Names this long or shorter never match in the middle of a sentence.
export const SHORT_NAME_MAX = 4

// Common English and Russian words that are also likely folder names. Kept small on purpose (under 80 words).
export const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'for', 'with', 'from', 'into', 'about', 'this', 'that', 'these', 'those',
  'what', 'which', 'who', 'when', 'where', 'why', 'how', 'are', 'was', 'were', 'is', 'be', 'do', 'not', 'you',
  'your', 'it', 'its', 'to', 'of', 'in', 'on', 'at', 'by', 'if', 'can', 'will', 'please', 'now', 'new', 'one',
  'это', 'для', 'что', 'как', 'или', 'так', 'все', 'мне', 'его', 'она', 'они', 'был', 'была', 'будет', 'при',
  'про', 'без', 'там', 'вот', 'если', 'когда', 'где', 'только', 'нет', 'да', 'ну', 'ли', 'в', 'на', 'с', 'и', 'а', 'но',
])

export type MatchSession = { name: string; folder: string; lastActiveAt: number }
export type MatchFolder = { name: string; path: string }
export type NameInput = { text: string; sessions: readonly MatchSession[]; folders: readonly MatchFolder[] }
// forward: deliver to a live session (named, or live in the named folder). folder: a trusted folder with no live session
// there; `start` says the name led the message (so it may start by itself in auto mode).
export type NameHit =
  | { kind: 'forward'; session: string; folder: string; reason: string }
  | { kind: 'folder'; folder: string; start: boolean; reason: string }

type Tok = { w: string; start: number; end: number }

// Lowercase letter or digit runs with their positions in the original text (Unicode, so Cyrillic words split correctly).
function tokens(s: string): Tok[] {
  const out: Tok[] = []
  for (const m of s.matchAll(/[\p{L}\p{N}]+/gu)) {
    const start = m.index ?? 0
    out.push({ w: m[0].toLowerCase(), start, end: start + m[0].length })
  }
  return out
}

// The lowercase words of a text or a name.
export function words(s: string): string[] {
  return tokens(s).map((t) => t.w)
}

// The last segment of a path ("/a/b" gives "b").
export function baseName(path: string): string {
  return path.split('/').filter((x) => x !== '').pop() ?? path
}

// A separator right after a name: a colon or a comma (after optional spaces), or a dash set off by a space.
const SEPARATOR_RE = /^(?:\s*[:,]|\s+[-–—])/

// True when any word of the name is a stopword (the name never matches).
export function isStopName(name: string): boolean {
  return words(name).some((w) => STOPWORDS.has(w))
}

// The hit for one name: null when it does not occur, or occurs only where a short or stopword name may not match.
// `start` is true when some occurrence leads the message with a separator after it.
function hitOf(text: string, tk: readonly Tok[], name: string): { start: boolean } | null {
  const nw = words(name)
  if (nw.length === 0 || isStopName(name)) return null
  let start = false
  let mid = false
  for (let i = 0; i + nw.length <= tk.length; i++) {
    let ok = true
    for (let j = 0; j < nw.length; j++) {
      if (tk[i + j].w !== nw[j]) {
        ok = false
        break
      }
    }
    if (!ok) continue
    const leads = i === 0 || (i === 1 && (tk[0].w === 'in' || tk[0].w === 'в'))
    if (leads && SEPARATOR_RE.test(text.slice(tk[i + nw.length - 1].end))) start = true
    else mid = true
  }
  if (start) return { start: true }
  if (mid && Array.from(name).length > SHORT_NAME_MAX) return { start: false }
  return null
}

// The most recently active session (ties by name), or undefined.
function latest<T extends { name: string; lastActiveAt: number }>(list: readonly T[]): T | undefined {
  return [...list].sort((a, b) => b.lastActiveAt - a.lastActiveAt || (a.name < b.name ? -1 : 1))[0]
}

// The match for a message. Null when no name matches, or the names point at more than one folder (the model or the
// buttons decide then).
export function nameHit(input: NameInput): NameHit | null {
  const text = input.text.slice(0, MAX_TEXT_CHARS)
  const tk = tokens(text)
  if (tk.length === 0) return null
  const sessionHits = input.sessions.flatMap((s) => {
    const h = hitOf(text, tk, s.name)
    return h ? [{ s, start: h.start }] : []
  })
  // A full display name (bikerepair/sales) beats a bare basename (sales) that several folders share.
  const fullHits = input.folders.flatMap((f) => {
    const h = hitOf(text, tk, f.name)
    return h ? [{ f, start: h.start }] : []
  })
  const folderHits = fullHits.length > 0
    ? fullHits
    : input.folders.flatMap((f) => {
      const h = hitOf(text, tk, baseName(f.path))
      return h ? [{ f, start: h.start }] : []
    })
  const folders = new Set<string>([...sessionHits.map((x) => x.s.folder), ...folderHits.map((x) => x.f.path)])
  if (folders.size !== 1) return null
  const [folder] = [...folders]
  const named = latest(sessionHits.map((x) => x.s))
  if (named) return { kind: 'forward', session: named.name, folder, reason: `names session ${named.name}` }
  const live = latest(input.sessions.filter((s) => s.folder === folder))
  if (live) return { kind: 'forward', session: live.name, folder, reason: `names ${baseName(folder)}; live session there` }
  return { kind: 'folder', folder, start: folderHits.some((x) => x.start), reason: `names folder ${baseName(folder)}` }
}

// Text as data inside a prompt or a forwarded mode request: every run of three or more double quotes is removed, and
// the ends are trimmed of quotes, so the text cannot contain a `"""` delimiter. The caller wraps it in `"""`.
export function quoteData(text: string): string {
  const t = text.replace(/"{3,}/g, '').replace(/^"+|"+$/g, '')
  return `"""${t}"""`
}
