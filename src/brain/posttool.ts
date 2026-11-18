// Prompts answered at the desk (plan 1.2, ticket 03): matching a PostToolUse event to a pending permission prompt.
// Pure: no I/O. The router applies the result (clears the buttons, drops the pending entry).
//
// Claude Code fires PostToolUse after a tool ran, with its name and input, and no request id. A prompt answered at the
// desk with "Yes" is followed by exactly that event. The hook does not send the input itself: it sends a CallKey (a hash
// of the input's canonical text, and the first HEAD_CHARS characters of that text). The prompt's `input_preview` is the
// channel's JSON-shaped copy of the input (whitespace folded, cut at Claude Code's cap). A preview that was not cut is
// matched by its hash; a cut one by its head. A different call never matches: containment of single values is not
// evidence (a short command is a prefix of a longer one).
//
// Known limit: a cut preview is compared by its head only, so two calls that differ only after the cut point match.
// Whitespace is removed on both sides, so "ls -la" and "ls-la" have the same key. The tool name must match too.

import { createHash } from 'node:crypto'

export const ANSWERED_AT_DESK_TEXT = '✅ Answered at the desk'

// Characters of the canonical input text kept as its head (the hook sends this many, and the router compares this many).
export const HEAD_CHARS = 2000
// A preview this long (in code points) was cut by Claude Code's cap (3,500), so only its head can be compared.
const PREVIEW_CUT_CHARS = 3000

export type CallKey = { hash: string; head: string }

const squash = (s: string): string => s.replace(/\s+/g, '')
const headOf = (s: string): string => [...s].slice(0, HEAD_CHARS).join('')
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

// The key of a tool input: its JSON with whitespace removed, hashed in full, and its head.
export function callKey(toolInput: unknown): CallKey {
  const text = squash(JSON.stringify(toolInput ?? null))
  return { hash: sha256(text), head: headOf(text) }
}

// True when the prompt's input preview is the preview of the call with this key.
export function previewMatches(preview: string, key: CallKey): boolean {
  const text = squash(preview)
  if ([...preview].length >= PREVIEW_CUT_CHARS) return headOf(text) === key.head
  return sha256(text) === key.hash
}

export type PendingPrompt = { id: string; tool_name: string; input_preview: string }

// The id of the oldest pending prompt (the input order is the arrival order) that this tool call answers, or null.
export function answeredAtDesk(prompts: readonly PendingPrompt[], tool: { tool_name: string; key: CallKey }): string | null {
  for (const p of prompts) {
    if (p.tool_name === tool.tool_name && previewMatches(p.input_preview, tool.key)) return p.id
  }
  return null
}
