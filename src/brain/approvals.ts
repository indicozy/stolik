// Tool approvals and approval reminders: verdict parsing, the owner check, the TTL and the prompt text. No I/O.
import { MINUTE, cutAt, redact } from './common.ts'

export const PERMISSION_TTL_MS = 30 * MINUTE
export const TG_PERMISSION_EXPAND_LIMIT = 3500
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// ---------- permissions ----------

export type PermissionDetails = { tool_name: string; description: string; input_preview: string }

// The owner is the one private chat the router serves: its Telegram user id equals the chat id.
export function isOwnerUser(fromId: string | undefined, ownerId: string): boolean {
  return fromId !== undefined && fromId !== '' && fromId === ownerId
}

// Label put on a permission prompt after a button tap or a text verdict. It says what was sent, not what
// happened: Claude Code sends no acknowledgement, and the terminal may have answered first.
export function verdictLabel(behavior: 'allow' | 'deny'): string {
  return behavior === 'allow' ? 'Sent: allow' : 'Sent: deny'
}

export function permissionVerdict(text: string): { requestId: string; behavior: 'allow' | 'deny' } | null {
  const m = PERMISSION_REPLY_RE.exec(text)
  if (!m) return null
  return { requestId: m[2].toLowerCase(), behavior: m[1].toLowerCase().startsWith('y') ? 'allow' : 'deny' }
}

export function parseCallbackData(data: string): { behavior: 'allow' | 'deny' | 'more'; requestId: string } | null {
  const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(data)
  if (!m) return null
  return { behavior: m[1] as 'allow' | 'deny' | 'more', requestId: m[2] }
}

// True once a tool permission has passed its TTL. Expired prompts are edited to APPROVAL_EXPIRED_TEXT and dropped.
export function permissionExpired(p: { createdAt: number }, now: number, ttlMs: number = PERMISSION_TTL_MS): boolean {
  return now - p.createdAt > ttlMs
}

// Approval reminders (design §4.7). One reply to the prompt, once half of the TTL has passed and the prompt is
// still open. Applies to tool permissions (PERMISSION_TTL_MS) and to AskUserQuestion / plan asks (their own TTL).
// Never due after expiry; `reminded` is set by the caller once the reminder is sent.
export function approvalReminderDue(
  p: { createdAt: number; reminded: boolean },
  now: number,
  ttlMs: number = PERMISSION_TTL_MS,
): boolean {
  if (p.reminded) return false
  const elapsed = now - p.createdAt
  return elapsed >= ttlMs / 2 && elapsed <= ttlMs
}

// Minutes left are rounded up, so the reminder never claims less time than there is.
export function approvalReminderText(remainingMs: number): string {
  return `⏰ Still waiting for your answer (expires in ${Math.max(1, Math.ceil(remainingMs / MINUTE))} min).`
}

// Note added to a prompt when it expires unanswered.
export const APPROVAL_EXPIRED_TEXT = '⌛ Expired. Answer at the desk or /resume.'
// Note added to every open prompt when the router stops (its buttons go with it).
export const BRIDGE_RESTART_TEXT = 'Bridge restarted, answer at the desk.'

export const PERMISSION_DESC_LIMIT = 300
export const PERMISSION_INPUT_LIMIT = 600
export const PERMISSION_INPUT_MORE = '… (truncated, tap See more)'
export const PERMISSION_REDACTED_NOTE =
  "⚠️ Part of this input was hidden because it looks like a secret. Approve it at the desk if it's expected."
export const PERMISSION_REDACTED_REFUSAL = "Can't allow this one from Telegram — part of it was hidden. Approve at the desk."

// Pretty-prints JSON tool input; anything that does not parse is returned unchanged.
function prettyInput(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

// Compact prompt sent with the Allow / Deny / See more buttons. Shows the real tool input, not just
// the model-written description, so the user can see what they are allowing.
// Redaction runs before any truncation: a secret cut in half would no longer match the patterns.
// The input is redacted both before and after pretty-printing, since JSON parsing can decode escapes
// (e.g. g for "g") that would otherwise hide a literal token from the first pass.
function safeInput(raw: string, secrets: readonly string[]): string {
  return redact(prettyInput(redact(raw, secrets)), secrets)
}

// True when redaction changes the description or the input (either pass). Computed once when the request
// arrives. A redacted request can only be denied from Telegram: part of what the user would approve is hidden.
export function permissionRedacted(d: PermissionDetails, secrets: readonly string[] = []): boolean {
  if (redact(d.description, secrets) !== d.description) return true
  const once = redact(d.input_preview, secrets)
  if (once !== d.input_preview) return true
  const pretty = prettyInput(once)
  return redact(pretty, secrets) !== pretty
}

// Why a verdict must not be applied from Telegram, or null when it may be. Only allow is ever refused.
export function permissionRefusal(behavior: 'allow' | 'deny', redacted: boolean): string | null {
  return behavior === 'allow' && redacted ? PERMISSION_REDACTED_REFUSAL : null
}

export type PermButton = { text: string; data: string }

// The inline keyboard for a permission prompt. A redacted request never gets Allow, initial or expanded.
export function permissionButtons(requestId: string, opts: { withMore: boolean; redacted: boolean }): PermButton[] {
  const buttons: PermButton[] = []
  if (opts.withMore) buttons.push({ text: 'See more', data: `perm:more:${requestId}` })
  if (!opts.redacted) buttons.push({ text: '✅ Allow', data: `perm:allow:${requestId}` })
  buttons.push({ text: '❌ Deny', data: `perm:deny:${requestId}` })
  return buttons
}

export function permissionPromptText(
  sessionName: string,
  d: PermissionDetails,
  secrets: readonly string[] = [],
  redacted = false,
): string {
  const descClean = redact(d.description, secrets)
  const desc = descClean.length > PERMISSION_DESC_LIMIT ? cutAt(descClean, PERMISSION_DESC_LIMIT) + '…' : descClean
  let input = safeInput(d.input_preview, secrets)
  if (input.length > PERMISSION_INPUT_LIMIT) input = cutAt(input, PERMISSION_INPUT_LIMIT) + PERMISSION_INPUT_MORE
  const body = `🔐 [${sessionName}] ${d.tool_name}\n${desc}\n\ninput:\n${input}`
  return redacted ? `${body}\n\n${PERMISSION_REDACTED_NOTE}` : body
}

// `limit` is the chat's text limit; the expanded text stays under it and under TG_PERMISSION_EXPAND_LIMIT.
export function expandedPermissionText(d: PermissionDetails, secrets: readonly string[] = [], redacted = false, limit: number = TG_PERMISSION_EXPAND_LIMIT): string {
  const cap = Math.min(TG_PERMISSION_EXPAND_LIMIT, limit)
  const text = redact(
    `🔐 Permission: ${d.tool_name}\n\ndescription: ${d.description}\ninput:\n${safeInput(d.input_preview, secrets)}`,
    secrets,
  )
  if (!redacted) return text.length > cap ? cutAt(text, cap) + '…' : text
  // The note always stays at the end, so the body is cut to leave room for it.
  const note = `\n\n${PERMISSION_REDACTED_NOTE}`
  const room = cap - note.length - 1
  return (text.length > room ? cutAt(text, room) + '…' : text) + note
}
