// /resume, I/O side: reads Claude Code's transcripts (~/.claude/projects) and live session files (~/.claude/sessions).
// Only the fields the list needs are read, and a missing or odd field degrades to "unknown". The pure list logic is
// in brain/resume.ts. Transcript reads are async and cached for a few seconds, so a big folder never blocks the router.
import { readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { validSessionId } from '../router/state.ts'
import { isResumeId, pickTitle, type TranscriptMeta } from '../brain/resume.ts'
import { processComm } from './platform/process.ts'

// Transcripts and ~/.claude/sessions are Claude Code's internal files.
export const TRANSCRIPT_SCAN_MAX = 200
// Reads start at CHUNK_BYTES and widen (doubling) until a whole line is in hand, never past MAX_LINE_BYTES.
const CHUNK_BYTES = 64 * 1024
const MAX_LINE_BYTES = 4 * 1024 * 1024
// A scan is reused for this long: the folder picker and /resume ask for the list several times in a row.
export const TRANSCRIPT_CACHE_MS = 10_000
// A session id as the hooks check it. It also keeps the transcript path inside the projects folder.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
// Lines worth parsing: the only fields read are cwd, entrypoint, the title records and the first user prompt.
const USEFUL_LINE_RE = /"(?:cwd|entrypoint|aiTitle|lastPrompt)"|"type":\s*"user"/

// The projects folder name of a working directory: every character that is not a letter or digit becomes '-', so
// /home/me/proj is -home-me-proj. The `u` flag makes a code point one dash, as Claude Code names it.
export function projectFolder(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/gu, '-')
}

// The transcript of a session: <home>/.claude/projects/<folder of cwd>/<session id>.jsonl. Null when the session id is not
// usable (missing, or not the hooks' id shape) or the folder is empty.
export function transcriptPath(home: string, cwd: string, sessionId: string | null): string | null {
  if (sessionId === null || !SESSION_ID_RE.test(sessionId) || cwd === '') return null
  return join(home, '.claude', 'projects', projectFolder(cwd), `${sessionId}.jsonl`)
}

// The newest mtime under a folder, recursively. 0 when the folder is gone. Null when a folder exists but cannot be read,
// so the caller can count the session as busy. A file that vanishes mid-walk is skipped.
function newestMtimeIn(dir: string): number | null {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : null
  }
  let newest = 0
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      const sub = newestMtimeIn(path)
      if (sub === null) return null
      newest = Math.max(newest, sub)
    } else if (entry.isFile()) {
      try {
        newest = Math.max(newest, statSync(path).mtimeMs)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return null
      }
    }
  }
  return newest
}

// The newest write to a session: the max mtime of <id>.jsonl and of every file under <id>/ (subagent transcripts).
// Null when <id>.jsonl is missing or the session id is unusable, or when a file cannot be read.
export function latestTranscriptMtime(home: string, cwd: string, sessionId: string | null): number | null {
  const main = transcriptPath(home, cwd, sessionId)
  if (main === null) return null
  let mainMtime: number
  try {
    mainMtime = statSync(main).mtimeMs
  } catch {
    return null
  }
  const sub = newestMtimeIn(main.slice(0, -'.jsonl'.length))
  return sub === null ? null : Math.max(mainMtime, sub)
}

// ---------- readers ----------

async function readRange(fh: FileHandle, start: number, len: number): Promise<string> {
  const buf = Buffer.alloc(len)
  const { bytesRead } = await fh.read(buf, 0, len, start)
  return buf.subarray(0, bytesRead).toString('utf8')
}

function parseLines(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const line of text.split('\n')) {
    if (!USEFUL_LINE_RE.test(line)) continue
    try {
      const v: unknown = JSON.parse(line)
      if (v && typeof v === 'object') out.push(v as Record<string, unknown>)
    } catch {
      // a line cut by a chunk boundary, or not JSON: skipped
    }
  }
  return out
}

// First (or last, with `fromEnd`) string value of `key` on records of `type` (any type when type is null).
function strField(recs: readonly Record<string, unknown>[], type: string | null, key: string, fromEnd = false): string | null {
  const list = fromEnd ? [...recs].reverse() : recs
  for (const r of list) {
    if (type !== null && r.type !== type) continue
    const v = r[key]
    if (typeof v === 'string' && v !== '') return v
  }
  return null
}

// The text of a user prompt, or null for tool results, meta records and command wrappers.
function userPromptText(r: Record<string, unknown>): string | null {
  if (r.type !== 'user' || r.isMeta === true) return null
  const content = (r.message as { content?: unknown } | undefined)?.content
  let text = ''
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    text = content
      .filter((p): p is { type: string; text: string } => !!p && typeof p === 'object' && (p as { type?: unknown }).type === 'text' && typeof (p as { text?: unknown }).text === 'string')
      .map((p) => p.text)
      .join(' ')
  }
  text = text.trimStart()
  if (text === '' || /^<(command-|local-command-|system-reminder)/.test(text)) return null
  return text
}

// The head of a transcript: whole lines from the start. The read widens until the first line is complete. A first line
// longer than MAX_LINE_BYTES yields no head (the transcript then has no readable cwd and is skipped).
async function readHead(fh: FileHandle, size: number): Promise<string> {
  let len = Math.min(size, CHUNK_BYTES)
  let text = await readRange(fh, 0, len)
  while (len < size && !text.includes('\n') && len < MAX_LINE_BYTES) {
    len = Math.min(size, len * 2, MAX_LINE_BYTES)
    text = await readRange(fh, 0, len)
  }
  if (len >= size) return text
  const lastNl = text.lastIndexOf('\n')
  return lastNl >= 0 ? text.slice(0, lastNl + 1) : ''
}

// The tail of a transcript: whole lines from the end. The read widens backwards until a complete line is in hand (a line
// break before the last one), bounded like the head. A last line still being written fails to parse and is skipped.
async function readTail(fh: FileHandle, size: number): Promise<string> {
  let len = Math.min(size, CHUNK_BYTES)
  let text = await readRange(fh, size - len, len)
  const complete = (t: string) => (t.endsWith('\n') ? t.slice(0, -1) : t).includes('\n')
  while (size - len > 0 && !complete(text) && len < MAX_LINE_BYTES) {
    len = Math.min(size, len * 2, MAX_LINE_BYTES)
    text = await readRange(fh, size - len, len)
  }
  if (len >= size) return text
  const firstNl = text.indexOf('\n')
  return firstNl >= 0 ? text.slice(firstNl + 1) : ''
}

// Reads the head and tail of one transcript (never the whole file) and returns what the list needs, or null when
// the file has no absolute cwd.
export async function readTranscript(path: string, id: string, mtime: number): Promise<TranscriptMeta | null> {
  let fh: FileHandle
  try {
    fh = await open(path, 'r')
  } catch {
    return null
  }
  let headText: string
  let tailText: string
  try {
    const size = (await fh.stat()).size
    if (size <= 2 * CHUNK_BYTES) {
      headText = await readRange(fh, 0, size)
      tailText = headText
    } else {
      headText = await readHead(fh, size)
      tailText = await readTail(fh, size)
    }
  } catch {
    return null
  } finally {
    await fh.close().catch(() => {})
  }
  const head = parseLines(headText)
  const tail = tailText === headText ? head : parseLines(tailText)

  const cwdHead = strField(head, null, 'cwd')
  const cwd = cwdHead !== null && cwdHead.startsWith('/') ? cwdHead : (strField(tail, null, 'cwd', true) ?? '')
  if (!cwd.startsWith('/')) return null

  let firstPrompt: string | null = null
  for (const r of head) {
    const t = userPromptText(r)
    if (t !== null) {
      firstPrompt = t
      break
    }
  }
  const aiTitle = strField(tail, 'ai-title', 'aiTitle', true) ?? strField(head, 'ai-title', 'aiTitle', true)
  const lastPrompt = strField(tail, 'last-prompt', 'lastPrompt', true) ?? strField(head, 'last-prompt', 'lastPrompt', true)
  const entrypoint = strField(head, null, 'entrypoint') ?? strField(tail, null, 'entrypoint')

  return {
    id,
    path,
    cwd,
    title: pickTitle({ aiTitle, lastPrompt, firstPrompt }),
    mtime,
    entrypoint,
  }
}

// The newest TRANSCRIPT_SCAN_MAX top-level <uuid>.jsonl files under ~/.claude/projects/<folder>/ (subagent folders are
// not read), kept when they are interactive (entrypoint cli). The folder name is never used as the cwd. Cached for
// TRANSCRIPT_CACHE_MS per folder and limit.
let scanCache: { key: string; at: number; list: TranscriptMeta[] } | null = null

export async function scanTranscripts(
  projectsDir: string = join(homedir(), '.claude', 'projects'),
  limit: number = TRANSCRIPT_SCAN_MAX,
): Promise<TranscriptMeta[]> {
  const key = `${projectsDir}\0${limit}`
  if (scanCache && scanCache.key === key && Date.now() - scanCache.at < TRANSCRIPT_CACHE_MS) return [...scanCache.list]
  const list = await scanUncached(projectsDir, limit)
  scanCache = { key, at: Date.now(), list }
  return [...list]
}

async function scanUncached(projectsDir: string, limit: number): Promise<TranscriptMeta[]> {
  let folders: string[]
  try {
    folders = (await readdir(projectsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
  const found: Array<{ id: string; path: string; mtime: number }> = []
  for (const folder of folders) {
    const dir = join(projectsDir, folder)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const id = name.slice(0, -'.jsonl'.length)
      if (!isResumeId(id)) continue
      const path = join(dir, name)
      try {
        const st = await stat(path)
        if (st.isFile()) found.push({ id, path, mtime: st.mtimeMs })
      } catch {
        // vanished between readdir and stat
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime)
  const out: TranscriptMeta[] = []
  for (const f of found.slice(0, limit)) {
    const meta = await readTranscript(f.path, f.id, f.mtime)
    if (meta && meta.entrypoint === 'cli') out.push(meta)
  }
  return out
}

// True when the pid's executable is 'claude' (the same test the router uses to find a session's process).
function isClaudeProcess(pid: number): boolean {
  return processComm(pid) === 'claude'
}

// Session id -> pid, for ~/.claude/sessions/<pid>.json entries whose process is alive and is claude.
export function liveSessions(dir: string = join(homedir(), '.claude', 'sessions')): Map<string, number> {
  const out = new Map<string, number>()
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names) {
    const m = /^(\d{1,9})\.json$/.exec(name)
    if (!m) continue
    const pid = Number(m[1])
    let sid: string | null = null
    try {
      const data = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { sessionId?: unknown } | null
      sid = validSessionId(data?.sessionId)
    } catch {
      continue
    }
    if (sid !== null && isClaudeProcess(pid)) out.set(sid, pid)
  }
  return out
}
