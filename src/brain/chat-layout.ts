// Pure layout of one router message for a chat app's limits: text chunks and button rows. The router's own menus and the
// addons' rows go through the same functions, applied once at the chat boundary (adapters/chat/queued.ts).

// Room kept under the text limit for what a platform adds on its own (HTML conversion, a reopened code fence).
export const TEXT_MARGIN = 96

// Splits on newline boundaries where possible; never splits inside a surrogate pair.
export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    let skip = 1
    if (cut <= 0) {
      cut = limit
      skip = 0
      const code = rest.charCodeAt(cut - 1)
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut + skip)
  }
  out.push(rest)
  return out
}

export type ButtonLimits = { labelChars: number; maxRows: number; maxPerRow: number }

// The rows as a chat app shows them. Labels are cut to labelChars. A row longer than maxPerRow is split (order kept).
// When there are more rows than maxRows, consecutive single-button rows share rows of up to maxPerRow. Rows still past
// maxRows are dropped; `dropped` counts them so the caller can log it. A keyboard that already fits keeps its rows.
export function layoutButtonRows<T extends { text: string }>(
  rows: readonly (readonly T[])[],
  caps: ButtonLimits,
): { rows: T[][]; dropped: number } {
  let out: T[][] = []
  for (const row of rows) {
    const cut = row.map((b) => ({ ...b, text: Array.from(b.text).slice(0, caps.labelChars).join('') }))
    for (let i = 0; i < cut.length; i += caps.maxPerRow) out.push(cut.slice(i, i + caps.maxPerRow))
  }
  if (out.length > caps.maxRows) {
    const merged: T[][] = []
    let lastIsSingles = false
    for (const row of out) {
      const last = merged[merged.length - 1]
      if (row.length === 1 && lastIsSingles && last !== undefined && last.length < caps.maxPerRow) {
        last.push(row[0])
      } else {
        merged.push([...row])
        lastIsSingles = row.length === 1
      }
    }
    out = merged
  }
  const kept = out.slice(0, caps.maxRows)
  return { rows: kept, dropped: out.length - kept.length }
}

// ---- fitting text to the app's limit ----

// What the app counts: `max` characters, measured in `format` after the app's own transformation (see text.measure).
export type Fit = { max: number; format: 'plain' | 'markdown'; measure?: (text: string, format: 'plain' | 'markdown') => number }

export function measureOf(text: string, fit: Fit): number {
  return fit.measure ? fit.measure(text, fit.format) : text.length
}

// Pieces that each measure within fit.max. chunkText cuts at `target`; a piece still over the max (escaping adds
// characters) is halved by code point until it fits. A single code point that cannot fit is left as it is.
export function splitToFit(text: string, target: number, fit: Fit): string[] {
  const out: string[] = []
  for (const piece of chunkText(text, target)) out.push(...halve(piece, fit))
  return out
}

function halve(piece: string, fit: Fit): string[] {
  if (measureOf(piece, fit) <= fit.max) return [piece]
  const chars = Array.from(piece)
  if (chars.length <= 1) return [piece]
  const half = Math.ceil(chars.length / 2)
  return [...halve(chars.slice(0, half).join(''), fit), ...halve(chars.slice(half).join(''), fit)]
}

// The text cut to fit: the tail is kept (a status line sits there) behind a "… (cut)" marker.
export const CUT_MARKER = '… (cut)\n'
export function cutToFit(text: string, fit: Fit): string {
  if (measureOf(text, fit) <= fit.max) return text
  const chars = Array.from(text)
  let lo = 0
  let hi = chars.length
  // Smallest start index whose marked tail fits; a longer tail never measures shorter, so bisection holds.
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (measureOf(CUT_MARKER + chars.slice(mid).join(''), fit) <= fit.max) hi = mid
    else lo = mid + 1
  }
  return CUT_MARKER + chars.slice(lo).join('')
}
