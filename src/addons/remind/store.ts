// Remind item store: a JSON file written atomically, and the due logic. An item fires once when it is due; a once item is
// then dropped, a repeating item gets its next future run. A missed run is never replayed: it fires once, marked late.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { nextRun, type Schedule } from './cron.ts'

export type Item = {
  id: string
  kind: 'remind' | 'task'
  text: string
  schedule: Schedule
  nextRun: number
  createdAt: number
  dir?: string
}

// A fire more than this past its due time is marked late in the message.
export const LATE_MS = 120_000

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

function isSchedule(v: unknown): v is Schedule {
  if (typeof v !== 'object' || v === null) return false
  const s = v as Record<string, unknown>
  if (s.kind === 'once') return typeof s.at === 'number'
  if (s.kind === 'cron') return typeof s.expr === 'string'
  return false
}

function isItem(v: unknown): v is Item {
  if (typeof v !== 'object' || v === null) return false
  const i = v as Record<string, unknown>
  return (
    typeof i.id === 'string' &&
    (i.kind === 'remind' || i.kind === 'task') &&
    typeof i.text === 'string' &&
    isSchedule(i.schedule) &&
    typeof i.nextRun === 'number' &&
    typeof i.createdAt === 'number' &&
    (i.dir === undefined || typeof i.dir === 'string')
  )
}

// Items from the file. A missing file is an empty list. Every valid item is kept; an invalid one is skipped with a stderr
// line. A file that is not valid JSON or not an array is renamed aside (`<path>.bad-<ms>`), so the next save cannot
// overwrite the owner's data, and the load is an empty list.
export function loadItems(path: string): Item[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }
  if (!Array.isArray(parsed)) {
    const backup = `${path}.bad-${Date.now()}`
    try {
      renameSync(path, backup)
      process.stderr.write(`remind: ${path} is not a list of items, moved aside to ${backup}\n`)
    } catch {
      process.stderr.write(`remind: ${path} is not a list of items and could not be moved aside\n`)
    }
    return []
  }
  const items: Item[] = []
  parsed.forEach((v: unknown, i: number) => {
    if (isItem(v)) items.push(v)
    else process.stderr.write(`remind: skipped invalid item ${i} in ${path}\n`)
  })
  return items
}

// Writes the items to a temp file, then renames it over the real one, so a crash never leaves half a file.
export function saveItems(path: string, items: Item[]): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(items, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

// Items due at `now`. Each due item fires once (`late` when more than LATE_MS past due). A once item is dropped after it
// fires; a cron item is kept with its next run after `now` (dropped if there is none). Not-due items are kept unchanged.
export function takeDue(items: Item[], now: number): { fire: Array<{ item: Item; late: boolean }>; keep: Item[] } {
  const fire: Array<{ item: Item; late: boolean }> = []
  const keep: Item[] = []
  for (const item of items) {
    if (item.nextRun > now) {
      keep.push(item)
      continue
    }
    fire.push({ item, late: now - item.nextRun > LATE_MS })
    const next = nextRun(item.schedule, now)
    if (next !== null) keep.push({ ...item, nextRun: next })
  }
  return { fire, keep }
}

// A short random id for an item (also used in button data, so it stays 8 characters).
export function newId(): string {
  return Array.from(randomBytes(8), (b) => ID_CHARS[b % ID_CHARS.length]).join('')
}
