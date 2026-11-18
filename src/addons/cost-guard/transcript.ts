// Reads a Claude Code session's transcript for cost-guard: the JSONL file under ~/.claude/projects. This is the port of the
// token-guard hook's analyze() (~/.claude/hooks/token-guard/prompt_guard.py): the context of the last main-chain assistant
// entry, and nothing when a compaction came after it. Pure apart from readTail, which reads the file's tail.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

// The bytes read from the end of a transcript. The newest assistant entry is near the end of a long one.
export const TAIL_BYTES = 2_000_000
// The usage fields that make up a turn's context (what the model re-reads).
const CTX_KEYS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const

export type Analysis = { contextTokens: number; lastAt: number }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// The transcript path helpers live in the adapter layer (the idle check uses them too); re-exported here for cost-guard.
export { projectFolder, transcriptPath } from '../../adapters/transcripts.ts'


// The last `bytes` of a file, as lines. The first line is dropped when the read starts inside it. Null when the file
// cannot be read (missing, unreadable).
export function readTail(path: string, bytes: number = TAIL_BYTES): string[] | null {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const start = Math.max(0, size - bytes)
    const len = size - start
    const buf = Buffer.alloc(len)
    let off = 0
    while (off < len) {
      const n = readSync(fd, buf, off, len - off, start + off)
      if (n === 0) break
      off += n
    }
    let data = buf.subarray(0, off)
    if (start > 0) {
      const nl = data.indexOf(0x0a)
      data = nl >= 0 ? data.subarray(nl + 1) : Buffer.alloc(0)
    }
    return data.toString('utf8').split('\n')
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

// The context and the time of the last main-chain assistant entry with usage. Null when there is none, when a compaction
// came after it (the context is gone), or when its timestamp is missing or unreadable. Sidechain (subagent) entries are
// ignored. A line that is not a JSON object is skipped.
export function analyze(lines: readonly string[]): Analysis | null {
  let last: { usage: Record<string, unknown>; timestamp: unknown; index: number } | null = null
  let compactIndex = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue
    let obj: unknown
    try {
      obj = JSON.parse(lines[i])
    } catch {
      continue
    }
    if (!isObj(obj)) continue
    if (obj.type === 'assistant' && obj.isSidechain !== true) {
      const usage = isObj(obj.message) ? obj.message.usage : undefined
      if (isObj(usage)) last = { usage, timestamp: obj.timestamp, index: i }
    } else if (obj.type === 'system' && obj.subtype === 'compact_boundary') {
      compactIndex = i
    }
  }
  if (last === null || compactIndex > last.index) return null
  const lastAt = typeof last.timestamp === 'string' ? Date.parse(last.timestamp) : NaN
  if (!Number.isFinite(lastAt)) return null
  const contextTokens = CTX_KEYS.reduce((sum, k) => {
    const v = last!.usage[k]
    return sum + (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  }, 0)
  return { contextTokens, lastAt }
}

// The analysis of a transcript file, or null when it cannot be read or has no usable entry.
export function analyzeTranscript(path: string): Analysis | null {
  const lines = readTail(path)
  return lines === null ? null : analyze(lines)
}
