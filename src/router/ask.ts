// Forwarding to Telegram every permission prompt (any tool), AskUserQuestion (pick from a list) and ExitPlanMode (plan
// approval). Pure logic only: input parsing, the hook decisions, message text, buttons, callback data and text-reply
// targeting. The I/O wiring (sending, editing, releasing the hook connection) lives in handlers/ask.ts.
import type { AskDecision } from '../adapters/channel/protocol.ts'
import { MINUTE, TG_TEXT_LIMIT, chunkText, redact, type Rows } from './state.ts'
import type { MessageId } from '../brain/chat-types.ts'

// A pending ask is released (the terminal dialog takes over) after this long without an answer.
export const ASK_TTL_MS = 55 * MINUTE
// Option labels on buttons are cut to this many characters.
export const ASK_OPTION_CHARS = 40
// Sanity limits: a question list or option list beyond these is malformed (callback data holds 2 digits).
export const ASK_MAX_QUESTIONS = 20
export const ASK_MAX_OPTIONS = 30
export const PLAN_FOOTER = '(or reply with feedback to reject and revise)'
export const ASK_REJECT_MESSAGE = 'The user rejected the plan from Telegram.'
export const PERM_DENY_MESSAGE = 'The user denied this tool call from Telegram.'
// Characters of a permission prompt's detail shown in Telegram (the rest is cut, after redaction).
export const PERM_DETAIL_CHARS = 1500

export type AskOption = { label: string; description: string }
export type AskQuestion = { question: string; header: string; options: AskOption[]; multiSelect: boolean }
export type AskInput =
  | { tool: 'AskUserQuestion'; questions: AskQuestion[] }
  | { tool: 'ExitPlanMode'; plan: string }
  // Any other tool's permission prompt: its name, and a short summary of the call (see permissionDetail).
  | { tool: 'Permission'; toolName: string; detail: string }

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

// The forwardable input of a PermissionRequest, or null (malformed input, or no tool name). Every other tool is a
// Permission prompt.
export function parseAskInput(toolName: string, toolInput: unknown): AskInput | null {
  const input = asRecord(toolInput)
  if (!input || toolName === '') return null
  if (toolName === 'AskUserQuestion') {
    const questions = parseQuestions(input.questions)
    return questions ? { tool: 'AskUserQuestion', questions } : null
  }
  if (toolName === 'ExitPlanMode') {
    return typeof input.plan === 'string' && input.plan.trim() !== '' ? { tool: 'ExitPlanMode', plan: input.plan } : null
  }
  return { tool: 'Permission', toolName, detail: permissionDetail(toolName, input) }
}

const PATH_TOOLS = new Set(['Edit', 'Write', 'Read', 'NotebookEdit'])

// A short human summary of a tool call: the command for Bash (its description above it), the path or URL or query for
// the file and web tools, and the whole input as JSON for anything else (MCP tools included). Not cut here: the message
// builder redacts first and cuts after.
export function permissionDetail(toolName: string, input: Record<string, unknown>): string {
  const field = (key: string): string | null => (typeof input[key] === 'string' ? (input[key] as string) : null)
  if (toolName === 'Bash') {
    const command = field('command')
    if (command !== null) {
      const description = field('description')
      return description ? `${description}\n${command}` : command
    }
  } else if (PATH_TOOLS.has(toolName)) {
    const path = field('file_path')
    if (path !== null) return path
  } else if (toolName === 'WebFetch') {
    const url = field('url')
    if (url !== null) return url
  } else if (toolName === 'WebSearch') {
    const query = field('query')
    if (query !== null) return query
  }
  return JSON.stringify(input, null, 1)
}

// The tool an ask is about: the real tool name for a permission prompt, else the variant's own name.
export function askToolName(input: AskInput): string {
  return input.tool === 'Permission' ? input.toolName : input.tool
}

// Options are optional: a question without usable options is answered as free text only.
function parseQuestions(raw: unknown): AskQuestion[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > ASK_MAX_QUESTIONS) return null
  const out: AskQuestion[] = []
  for (const item of raw) {
    const q = asRecord(item)
    if (!q || typeof q.question !== 'string' || q.question.trim() === '') return null
    const options: AskOption[] = []
    if (Array.isArray(q.options)) {
      for (const o of q.options) {
        if (options.length >= ASK_MAX_OPTIONS) break
        const r = asRecord(o)
        if (!r || typeof r.label !== 'string' || r.label.trim() === '') continue
        options.push({ label: r.label, description: typeof r.description === 'string' ? r.description : '' })
      }
    }
    out.push({
      question: q.question,
      header: typeof q.header === 'string' ? q.header : '',
      options,
      multiSelect: q.multiSelect === true,
    })
  }
  return out
}

// ---------- decisions for the hook ----------

// AskUserQuestion answered: the original input plus the answers, keyed by question text.
export function answersDecision(toolInput: unknown, answers: Record<string, string>): AskDecision {
  return { behavior: 'allow', updatedInput: { ...(asRecord(toolInput) ?? {}), answers } }
}

// ExitPlanMode approved: the input unchanged.
export function approveDecision(toolInput: unknown): AskDecision {
  return { behavior: 'allow', updatedInput: toolInput }
}

export function denyDecision(message: string): AskDecision {
  return { behavior: 'deny', message }
}

export function feedbackMessage(text: string): string {
  return `The user rejected the plan from Telegram with this feedback: ${text}`
}

export function denyFeedbackMessage(text: string): string {
  return `The user denied this tool call from Telegram with this feedback: ${text}`
}

// ---------- messages and buttons ----------

// Label cut to ASK_OPTION_CHARS characters (code points, so an emoji is never split), with an ellipsis.
export function cutLabel(label: string): string {
  const chars = Array.from(label)
  return chars.length <= ASK_OPTION_CHARS ? label : chars.slice(0, ASK_OPTION_CHARS - 1).join('') + '…'
}

// Text cut to `limit` characters (code points, so an emoji is never split) with an ellipsis. A Telegram message holds
// one limit's worth; a longer question or answer is shortened rather than failing the send.
export function fitText(text: string, limit: number = TG_TEXT_LIMIT): string {
  const chars = Array.from(text)
  return chars.length <= limit ? text : chars.slice(0, limit - 1).join('') + '…'
}

// "❓ [session] <header>", the question, the numbered options with descriptions, and a hint.
export function questionText(sessionName: string, q: AskQuestion, limit: number = TG_TEXT_LIMIT): string {
  const header = q.header.trim()
  const lines = [header ? `❓ [${sessionName}] ${header}` : `❓ [${sessionName}]`, q.question]
  if (q.options.length === 0) return fitText([...lines, '', '(reply with your answer)'].join('\n'), limit)
  q.options.forEach((o, i) => {
    lines.push(o.description ? `${i + 1}. ${o.label} — ${o.description}` : `${i + 1}. ${o.label}`)
  })
  lines.push(q.multiSelect ? '(tap options to pick several, then ✅ Done)' : '(tap an option, or reply with your own answer)')
  return fitText(lines.join('\n'), limit)
}

// One button per option, one per row. Multi-select shows ☐/☑ and adds a Done button.
export function questionRows(askId: string, qIdx: number, q: AskQuestion, selected: ReadonlySet<number>): Rows {
  const rows: Rows = q.options.map((o, i) => {
    const label = cutLabel(o.label)
    const text = q.multiSelect ? `${selected.has(i) ? '☑' : '☐'} ${label}` : label
    return [{ text, data: `aq:${askId}:${qIdx}:${i}` }]
  })
  if (q.multiSelect && q.options.length > 0) rows.push([{ text: '✅ Done', data: `aq:${askId}:${qIdx}:d` }])
  return rows
}

export function toggleSelected(selected: ReadonlySet<number>, idx: number): Set<number> {
  const next = new Set(selected)
  if (next.has(idx)) next.delete(idx)
  else next.add(idx)
  return next
}

// Labels of the picked options, in option order.
export function selectedLabels(q: AskQuestion, selected: ReadonlySet<number>): string[] {
  return q.options.filter((_, i) => selected.has(i)).map((o) => o.label)
}

export function planRows(askId: string): Rows {
  return [[
    { text: '✅ Approve', data: `ap:${askId}:y` },
    { text: '❌ Reject', data: `ap:${askId}:n` },
  ]]
}

export function permRows(askId: string): Rows {
  return [[
    { text: '✅ Allow', data: `apm:${askId}:y` },
    { text: '❌ Deny', data: `apm:${askId}:n` },
  ]]
}

// The plan as Telegram messages: a heading, then the plan, redacted before splitting so a secret across a
// split cannot slip through. The footer goes on the last message (its own message when it does not fit).
export function planMessages(sessionName: string, plan: string, secrets: readonly string[] = [], limit: number = TG_TEXT_LIMIT): string[] {
  const body = redact(`📋 [${sessionName}] plan ready for approval\n\n${plan}`, secrets)
  const chunks = chunkText(body, limit)
  const last = chunks[chunks.length - 1]
  if (last.length + PLAN_FOOTER.length + 2 <= limit) chunks[chunks.length - 1] = `${last}\n\n${PLAN_FOOTER}`
  else chunks.push(PLAN_FOOTER)
  return chunks
}

// A permission prompt as one message: the heading, then the detail. The detail is redacted before it is cut, so a
// secret straddling the cut cannot slip through; the whole message then fits one Telegram message.
export function permissionMessage(sessionName: string, toolName: string, detail: string, secrets: readonly string[] = [], limit: number = TG_TEXT_LIMIT): string {
  const shown = fitText(redact(detail, secrets), Math.min(PERM_DETAIL_CHARS, limit))
  return fitText(`🔐 [${sessionName}] wants to run ${toolName}\n\n${shown}`, limit)
}

// ---------- callback data ----------

export type AskCallback =
  | { kind: 'question'; askId: string; qIdx: number; opt: number | 'done' }
  | { kind: 'plan'; askId: string; approve: boolean }
  | { kind: 'perm'; askId: string; allow: boolean }

export function parseAskCallback(data: string): AskCallback | null {
  const q = /^aq:([0-9a-f]{8}):(\d{1,2}):(\d{1,2}|d)$/.exec(data)
  if (q) return { kind: 'question', askId: q[1], qIdx: Number(q[2]), opt: q[3] === 'd' ? 'done' : Number(q[3]) }
  const p = /^ap:([0-9a-f]{8}):([yn])$/.exec(data)
  if (p) return { kind: 'plan', askId: p[1], approve: p[2] === 'y' }
  const m = /^apm:([0-9a-f]{8}):([yn])$/.exec(data)
  if (m) return { kind: 'perm', askId: m[1], allow: m[2] === 'y' }
  return null
}

// ---------- text replies ----------

export type TextTargetable = { id: string; messageIds: readonly MessageId[] }

// The pending ask a text message answers. A reply targets the ask whose message it swipe-replies to.
// Without a reply, the answer depends on where the message was written:
// - DM mode (no `group`): a plain message targets the only pending ask, when there is exactly one.
// - group mode (`group` given): a plain message in General is never an answer (it routes as any General message).
//   In a topic it answers the one pending ask whose session owns that topic (`group.inTopic`).
// Each ask waits on one thing at a time (a question or a plan), so one ask means one waiting question.
export function findTextTarget<T extends TextTargetable>(
  asks: readonly T[],
  replyToId: MessageId | null,
  group: { inTopic: (a: T) => boolean } | null = null,
): T | null {
  if (replyToId !== null) return asks.find((a) => a.messageIds.includes(replyToId)) ?? null
  if (group === null) return asks.length === 1 ? asks[0] : null
  const topicAsks = asks.filter(group.inTopic)
  return topicAsks.length === 1 ? topicAsks[0] : null
}
