import { statSync } from 'node:fs'
// Shared helpers for the brain modules: the minute constant, secret redaction and text cutting. No I/O.
export const MINUTE = 60_000
export const REDACTED = '[REDACTED]'

// Cuts to at most `limit` UTF-16 units without splitting a surrogate pair.
export function cutAt(s: string, limit: number): string {
  if (s.length <= limit) return s
  const code = s.charCodeAt(limit - 1)
  const end = code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit
  return s.slice(0, end)
}

// ---------- secret redaction ----------

const SECRET_PATTERNS: RegExp[] = [
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  // Unterminated blocks (cut before the END line) are redacted through the end of the text.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
]

// Replaces literal secrets (e.g. the bot tokens) and secret-shaped strings with [REDACTED].
export function redact(text: string, tokens: readonly string[]): string {
  let out = text
  for (const t of tokens) {
    if (t.length >= 8) out = out.split(t).join(REDACTED)
  }
  for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED)
  return out
}

// A path is an existing directory (false for a missing or unreadable one).
export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

// Size in bytes of a file, 0 when it cannot be read (a missing log is an empty one).
export function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
