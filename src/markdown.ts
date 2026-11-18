// Markdown (what Claude writes) to Telegram's HTML subset: b, i, s, code, pre, a href, blockquote and
// <pre><code class="language-x">. Pure: no imports, so the tg-notify CLI can use it without the router.
//
// Everything that is not markup is escaped (&, <, >). Inline code and links are set aside as placeholders
// before emphasis runs, so no marker inside them is ever read as markup.

const PH_OPEN = ''
const PH_CLOSE = ''
const PH_RE = /(\d+)/g
const SCHEME_OK = /^(https?|mailto|tg):/i

// A line that opens a fenced code block: ``` with an optional info string. Returns the language (sanitised), or null.
export function fenceOpen(line: string): { lang: string } | null {
  const m = /^\s*```([^`]*)$/.exec(line)
  if (!m) return null
  const word = (m[1] ?? '').trim().split(/\s+/)[0] ?? ''
  return { lang: word.replace(/[^\w+#.-]/g, '') }
}

// A line that closes a fenced code block.
export function isFenceClose(line: string): boolean {
  return /^\s*```\s*$/.test(line)
}

// Whether a line starts a block construct (heading, list, quote, rule, table, fence). Such a line must not follow
// a `[name] ` prefix on the same line.
export function startsBlock(line: string): boolean {
  return (
    fenceOpen(line) !== null ||
    /^\s{0,3}#{1,6}\s/.test(line) ||
    /^\s*[-*+]\s/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*\|/.test(line) ||
    /^\s*([-*])(\s*\1){2,}\s*$/.test(line)
  )
}

// `prefix` then `body`, on one line unless the body starts with a block construct (then the body starts its own line).
export function prefixLine(prefix: string, body: string): string {
  const first = body.split('\n', 1)[0] ?? ''
  return `${prefix}${startsBlock(first) ? '\n' : ' '}${body}`
}

// Makes split chunks safe to send alone: a chunk that ends inside an open fence is closed, and the next chunk
// re-opens the same fence. The last chunk is left as it is (the converter closes an open fence at the end anyway).
export function reopenFences(chunks: readonly string[]): string[] {
  const out: string[] = []
  let lang: string | null = null
  chunks.forEach((chunk, idx) => {
    const prefix = lang === null ? '' : `\`\`\`${lang}\n`
    let open: string | null = lang
    for (const line of chunk.split('\n')) {
      if (open === null) {
        const f = fenceOpen(line)
        if (f) open = f.lang
      } else if (isFenceClose(line)) open = null
    }
    const close = open !== null && idx < chunks.length - 1 ? '\n```' : ''
    out.push(prefix + chunk + close)
    lang = open
  })
  return out
}

export function mdToTelegramHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const fence = fenceOpen(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !isFenceClose(lines[i]!)) body.push(lines[i++]!)
      i++ // the closing fence, or past the end when the fence is never closed
      const code = esc(body.join('\n'))
      out.push(fence.lang ? `<pre><code class="language-${fence.lang}">${code}</code></pre>` : `<pre>${code}</pre>`)
      continue
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && isSeparatorRow(lines[i + 1]!)) {
      const rows: string[] = []
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) rows.push(lines[i++]!)
      out.push(renderTable(rows))
      continue
    }
    if (/^\s*>/.test(line)) {
      const quoted: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i]!)) quoted.push(lines[i++]!.replace(/^\s*>\s?/, ''))
      out.push(`<blockquote>${quoted.map(inline).join('\n')}</blockquote>`)
      continue
    }
    out.push(blockLine(line))
    i++
  }
  return out.join('\n')
}

function blockLine(line: string): string {
  const heading = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line)
  if (heading) return `<b>${inline(stripBold(heading[1] ?? ''))}</b>`
  if (/^\s*([-*])(\s*\1){2,}\s*$/.test(line)) return '──────────'
  const item = /^(\s*)[-*+]\s+(.*)$/.exec(line)
  if (item) return `${item[1] ?? ''}• ${inline(item[2] ?? '')}`
  return inline(line)
}

// Splits one table row into cell texts. `\|` is a literal pipe inside a cell.
function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let k = 0; k < s.length; k++) {
    const ch = s[k]!
    if (ch === '\\' && s[k + 1] === '|') {
      cur += '|'
      k++
    } else if (ch === '|') {
      cells.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  cells.push(cur.trim())
  return cells
}

function isSeparatorRow(line: string): boolean {
  if (!/^\s*\|/.test(line)) return false
  const cells = splitRow(line)
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c))
}

// Cell text as plain text: the inline markers that would show as noise inside a <pre> block are removed.
function cellPlain(cell: string): string {
  return cell
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, '$1 ($2)')
}

// A table as aligned text in one <pre> block. The first row is the header; the separator row becomes a rule.
function renderTable(rows: string[]): string {
  const body = rows.filter((_, idx) => idx !== 1).map((r) => splitRow(r).map(cellPlain))
  const cols = Math.max(...body.map((r) => r.length))
  const widths: number[] = Array.from({ length: cols }, () => 0)
  for (const r of body) r.forEach((c, k) => (widths[k] = Math.max(widths[k]!, Array.from(c).length)))
  const fmt = (r: string[]): string =>
    Array.from({ length: cols }, (_, k) => {
      const c = r[k] ?? ''
      return c + ' '.repeat(widths[k]! - Array.from(c).length)
    })
      .join(' | ')
      .trimEnd()
  const rule = '─'.repeat(widths.reduce((a, w) => a + w, 0) + 3 * (cols - 1))
  const lines: string[] = []
  body.forEach((r, idx) => {
    lines.push(fmt(r))
    if (idx === 0) lines.push(rule)
  })
  return `<pre>${esc(lines.join('\n'))}</pre>`
}

function stripBold(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1')
}

// Inline markup for one line (or one cell of a quote). Output is escaped HTML.
function inline(src: string): string {
  const stash: string[] = []
  const hold = (html: string): string => {
    stash.push(html)
    return `${PH_OPEN}${stash.length - 1}${PH_CLOSE}`
  }
  // Sentinels in the input would collide with ours; they never occur in text, so drop them.
  let s = src.split(PH_OPEN).join('').split(PH_CLOSE).join('')
  s = s.replace(/(`+)([^`\n]+?)\1/g, (_m, _t: string, code: string) => hold(`<code>${esc(code)}</code>`))
  s = s.replace(/\[([^[\]\n]+)\]\(([^()\s]+)\)/g, (m, text: string, url: string) =>
    SCHEME_OK.test(url) ? hold(`<a href="${escAttr(url)}">${inline(text)}</a>`) : m,
  )
  s = emphasis(esc(s))
  return s.replace(PH_RE, (_m, idx: string) => stash[Number(idx)] ?? '')
}

function emphasis(s: string): string {
  s = wrap(s, /\*\*(?=\S)(.+?)(?<=\S)\*\*(?!\*)/gu, 'b')
  s = wrap(s, /(?<![\p{L}\p{N}_])__(?=\S)(.+?)(?<=\S)__(?![\p{L}\p{N}_])/gu, 'b')
  s = wrap(s, /~~(?=\S)(.+?)(?<=\S)~~/gu, 's')
  s = wrap(s, /(?<!\*)\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?!\*)/gu, 'i')
  s = wrap(s, /(?<![\p{L}\p{N}_])_(?=[^\s_])([^_\n]+?)(?<=[^\s_])_(?![\p{L}\p{N}_])/gu, 'i')
  return s
}

// Wraps each match in `tag`, unless its content would leave a b/i/s tag unbalanced (then the markers stay literal).
function wrap(s: string, re: RegExp, tag: string): string {
  let out = ''
  let last = 0
  re.lastIndex = 0
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const inner = m[1] ?? ''
    if (!balanced(inner)) {
      re.lastIndex = m.index + 1
      continue
    }
    out += s.slice(last, m.index) + `<${tag}>${inner}</${tag}>`
    last = m.index + m[0].length
  }
  return out + s.slice(last)
}

function balanced(html: string): boolean {
  const stack: string[] = []
  for (const m of html.matchAll(/<(\/?)([bis])>/g)) {
    if (m[1]) {
      if (stack.pop() !== m[2]) return false
    } else stack.push(m[2]!)
  }
  return stack.length === 0
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escAttr(text: string): string {
  return esc(text).replace(/"/g, '&quot;')
}
