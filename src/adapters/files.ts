// Chat-log files under the log root (design §4.11, config `logRoot`):
//   log/YYYY-MM.jsonl       one JSON line per message (monthly, by local time)
//   YYYY-MM-DD.md           the readable daily log, with a heading when the day starts
//   attachments/YYYY-MM-DD/ incoming files, named HHMMSS-<name>
// Never throws into the router: a failed write is reported through onError and the message goes on.
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  attachmentRelPath, localDay, markdownLine, parseJsonl, selectExchanges, jsonlLine, type ChatLine, type ChatTarget,
} from '../brain/chatlog.ts'
import type { ChatLogPort } from '../ports.ts'
import { addDays } from '../brain/schedule.ts'

const MONTH_FILE_RE = /^\d{4}-\d{2}\.jsonl$/

export class FilesChatLog implements ChatLogPort {
  // The day of the Markdown file written last, with its path: a new day starts with its heading.
  private lastMd: { path: string; day: string } | null = null

  private readonly root: string
  private readonly onError: (msg: string) => void

  constructor(root: string, onError: (msg: string) => void = () => {}) {
    this.root = root
    this.onError = onError
  }

  append(line: ChatLine): void {
    try {
      const logDir = join(this.root, 'log')
      mkdirSync(logDir, { recursive: true, mode: 0o700 })
      const day = localDay(line.ts)
      const month = day.slice(0, 7)
      const monthFile = join(logDir, `${month}.jsonl`)
      // After a crash mid-write the file may end without "\n": the record starts on a new line, so the torn record
      // stays alone (parseJsonl skips it) and this one is not glued onto it.
      appendFileSync(monthFile, (endsAtLineStart(monthFile) ? '' : '\n') + jsonlLine(line), { mode: 0o600 })

      const md = join(this.root, `${day}.md`)
      const lastDay = this.lastMd?.path === md ? this.lastMd.day : existsSync(md) ? day : null
      const out = markdownLine(line, lastDay)
      appendFileSync(md, out.text, { mode: 0o600 })
      this.lastMd = { path: md, day: out.day }
    } catch (e) {
      this.onError(`chat log write failed: ${errText(e)}`)
    }
  }

  attachmentPath(name: string, ts: number): { path: string; rel: string } | null {
    try {
      // The pure namer asks `taken` for each candidate in turn. A free name is claimed at once (an empty file made with
      // the wx flag), so two downloads in the same second cannot take the same name.
      const rel = attachmentRelPath(ts, name, (r) => !this.claim(r))
      return { path: join(this.root, rel), rel }
    } catch (e) {
      this.onError(`attachment folder failed: ${errText(e)}`)
      return null
    }
  }

  // True when the file was created now, false when the name is already taken.
  private claim(rel: string): boolean {
    const abs = join(this.root, rel)
    mkdirSync(dirname(abs), { recursive: true, mode: 0o700 })
    try {
      writeFileSync(abs, '', { flag: 'wx', mode: 0o600 })
      return true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw e
    }
  }

  recentExchanges(target: ChatTarget, n: number): ChatLine[] {
    try {
      const logDir = join(this.root, 'log')
      const months = readdirSync(logDir).filter((f) => MONTH_FILE_RE.test(f)).sort().slice(-2)
      const lines = months.flatMap((f) => parseJsonl(readTail(join(logDir, f))))
      return selectExchanges(lines, target, n)
    } catch {
      return []
    }
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// True when the file is missing or empty, or its last byte is "\n".
function endsAtLineStart(path: string): boolean {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw e
  }
  try {
    const size = fstatSync(fd).size
    if (size === 0) return true
    const last = Buffer.alloc(1)
    readSync(fd, last, 0, 1, size - 1)
    return last[0] === 0x0a
  } finally {
    closeSync(fd)
  }
}

// The chat log is read from its end only: the last CHAT_TAIL_BYTES of a month file. When the read starts inside the
// file, its first line is cut and dropped.
export const CHAT_TAIL_BYTES = 2 * 1024 * 1024

export function readTail(path: string, maxBytes = CHAT_TAIL_BYTES): string {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const buf = Buffer.alloc(size - start)
    let got = 0
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got)
      if (n === 0) break
      got += n
    }
    const text = buf.subarray(0, got).toString('utf8')
    if (start === 0) return text
    const nl = text.indexOf('\n')
    return nl === -1 ? '' : text.slice(nl + 1)
  } finally {
    closeSync(fd)
  }
}

// Lines of `days` local days from `fromDay` (`YYYY-MM-DD`), oldest first, read from the monthly JSONL files under `root`.
// At most `maxLines` (the newest). A missing or unreadable file gives what the others hold; never throws.
export function readChatDays(root: string, fromDay: string, days: number, maxLines = 2000): ChatLine[] {
  const from = fromDay
  const toDay = addDays(fromDay, days - 1)
  const months = new Set([from.slice(0, 7), toDay.slice(0, 7)])
  const lines: ChatLine[] = []
  for (const month of months) {
    try {
      lines.push(...parseJsonl(readTail(join(root, 'log', `${month}.jsonl`))))
    } catch {
      // No file for that month: nothing to read from it.
    }
  }
  const inRange = lines.filter((l) => {
    const day = localDay(l.ts)
    return day >= from && day <= toDay
  })
  inRange.sort((a, b) => a.ts - b.ts)
  return inRange.slice(-maxLines)
}
