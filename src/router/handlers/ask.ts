// Router approvals in Telegram while the user is away: every permission prompt (any tool), AskUserQuestion and plan
// (ExitPlanMode) prompts.
import type { AskDecision, AskMsg } from '../../adapters/channel/protocol.ts'
import type { ButtonPress } from '../../brain/chat-types.ts'
import type { SocketConn } from '../../ports.ts'
import { procRef } from '../../brain/sessions.ts'
import { ASK_REJECT_MESSAGE, PERM_DENY_MESSAGE, approveDecision, answersDecision, askToolName, denyDecision, denyFeedbackMessage, feedbackMessage, fitText, parseAskInput, permRows, permissionMessage, planMessages, planRows, questionRows, questionText, selectedLabels, toggleSelected, type AskCallback } from '../ask.ts'
import { errMsg } from '../log.ts'
import { recordMsg } from '../send.ts'
import { inTopic, sendTarget } from '../topics.ts'
import { logSessionOut, rememberRecentPerm } from '../approvals.ts'
import { PENDING_CAP, ASK_CANCELLED_TEXT, newRouteId, lastMessageId, str, type PendingAsk, type Answer } from '../shared.ts'
import { redact } from '../../brain/common.ts'
import { callKey } from '../../brain/posttool.ts'
import { APPROVAL_EXPIRED_TEXT, textLimit } from '../state.ts'
import type { Router } from '../core.ts'

// Ends a PermissionRequest hook's connection. No decision = the terminal dialog shows.
export function endAsk(router: Router, conn: SocketConn, decision?: AskDecision): void {
  router.agent.respondToAsk(conn, decision ?? null)
}

// Forwarded to Telegram only when the user is away. Every other case gets no decision at once, so the
// terminal dialog shows as usual. A raced ask (the mod races it against the terminal, `race`) skips that gate: it is
// sent after askDelay for the owner's desk or away mode, unless the terminal answered first (the connection closed).
export async function onAsk(router: Router, conn: SocketConn, msg: AskMsg): Promise<void> {
  const pid = typeof msg.claudePid === 'number' ? msg.claudePid : null
  const raceId = str(msg.raceId)
  const toolName = str(msg.tool_name) ?? ''
  const tool = toolName || '?'
  const input = parseAskInput(toolName, msg.tool_input)
  // A silent release is logged with its reason, so a missing forward shows in the journal.
  const release = (reason: string) => {
    router.logger.log(`ask not forwarded to Telegram: ${reason} (${tool})`)
    return endAsk(router, conn)
  }
  if (!input) return release('unreadable input')
  if (router.locked) return release('router locked')
  if (!router.agent.isInteractive(pid)) return release('not an interactive session')
  if (msg.race === true) {
    const delay = router.askDelay[await router.platform.resourceMode()]
    if (delay > 0) await new Promise<void>((resolve) => { router.clock.setTimer(() => resolve(), delay * 1000) })
    if (conn.destroyed || router.stopping || (raceId !== undefined && router.raceResolved.has(raceId))) {
      router.logger.log(`ask not forwarded to Telegram: the terminal answered first (${tool})`)
      return
    }
  } else {
    // Only a known away answers the question here. Unknown idle time (the source is down) releases it to the terminal.
    const state = await router.platform.awayState()
    if (state !== 'idle' || router.locked) return release(`not away (${state})`)
    if (conn.destroyed) return
  }
  const now = router.clock.now()
  const session = router.registry.upsertFromHook(procRef(pid, (p) => router.platform.processStart(p)), str(msg.cwd) ?? '', now)
  // A session with the channel attached already relays tool permission prompts (permission_request, perm: buttons);
  // the hook path covers only sessions without it, so a prompt is never sent twice.
  if (input.tool === 'Permission' && session.connected) return release('channel relays this permission prompt')
  if (router.asks.size >= PENDING_CAP) {
    const oldest = router.asks.values().next().value
    if (oldest) releaseAsk(router, oldest, APPROVAL_EXPIRED_TEXT, 'expired')
  }
  const a: PendingAsk = {
    id: newRouteId(), ...(raceId !== undefined ? { raceId } : {}), input, toolInput: msg.tool_input, session, conn, createdAt: now,
    messageIds: [], text: '', qIdx: 0, selected: new Set(), answers: {}, reminded: false,
  }
  router.asks.set(a.id, a)
  router.audit.event({ event: 'ask', tool: askToolName(input), session: session.name })
  try {
    if (input.tool === 'AskUserQuestion') await sendQuestion(router, a)
    else await sendApproval(router, a)
  } catch (e) {
    router.logger.log(`ask forward failed: ${errMsg(e)}`)
    if (router.asks.get(a.id) === a) {
      router.asks.delete(a.id)
      endAsk(router, conn)
    }
  }
}

// Sends the question at a.qIdx as a new message with its buttons; that message is the ask's current one. A send into a
// topic that Telegram says is gone moves to a new topic (see inTopic).
export async function sendQuestion(router: Router, a: PendingAsk): Promise<void> {
  if (a.input.tool !== 'AskUserQuestion') return
  const q = a.input.questions[a.qIdx]
  const text = questionText(a.session.name, q, textLimit(router.chat))
  const rows = questionRows(a.id, a.qIdx, q, a.selected)
  const to = { ...sendTarget(router, 'ask', a.session), session: String(a.session.key) }
  const sent = await inTopic(router, a.session, to, (t) =>
    // A question is critical: it always pings, whatever the topic's mute.
    router.chat.sendText(text, { ...(rows.length > 0 ? { rows } : {}), ...t, priority: 'urgent', level: 'critical' }),
  )
  recordMsg(router, a.session, sent.value, sent.to.thread ?? null)
  logSessionOut(router, a.session, sent.to, 'ask', text, sent.value)
  a.messageIds = [sent.value]
  a.text = text
}

// A plan (one or more messages, sent as one group: no normal message lands between them; an urgent one may, which keeps
// the order; the last one carries Approve / Reject) or a permission prompt (one message with Allow / Deny).
export async function sendApproval(router: Router, a: PendingAsk): Promise<void> {
  if (a.input.tool === 'AskUserQuestion') return
  const isPlan = a.input.tool === 'ExitPlanMode'
  const chunks = a.input.tool === 'ExitPlanMode'
    ? planMessages(a.session.name, a.input.plan, router.secrets, textLimit(router.chat))
    : a.input.tool === 'Permission'
      ? [permissionMessage(a.session.name, a.input.toolName, a.input.detail, router.secrets, textLimit(router.chat))]
      : []
  const rows = isPlan ? planRows(a.id) : permRows(a.id)
  const kind = isPlan ? 'plan' : 'approval'
  const to = { ...sendTarget(router, kind, a.session), session: String(a.session.key) }
  const sent = await inTopic(router, a.session, to, (t) =>
    router.chat.sendChunks(chunks, { ...t, rows, priority: 'urgent' }),
  )
  sent.value.forEach((id, i) => {
    recordMsg(router, a.session, id, sent.to.thread ?? null)
    logSessionOut(router, a.session, sent.to, kind, chunks[i], id)
  })
  a.messageIds = sent.value
  a.text = chunks[chunks.length - 1]
}

// Every path answers the tap first and only then does the work: the work may wait on queued edits, and the tap's
// spinner must not wait with it. The answer is a plain call (not queued).
export async function onAskCallback(router: Router, cb: ButtonPress, r: AskCallback): Promise<void> {
  const answer: Answer = (t?: string) => router.chat.ackButton(cb.pressId, t).catch(() => {})
  const a = router.asks.get(r.askId)
  if (!a) return answer('Expired or already answered.')
  if (r.kind === 'plan') {
    if (a.input.tool !== 'ExitPlanMode') return answer('Expired or already answered.')
    answer()
    if (r.approve) await resolveApproval(router, a, approveDecision(a.toolInput), '✅ Approved', 'approved')
    else await resolveApproval(router, a, denyDecision(ASK_REJECT_MESSAGE), '❌ Rejected', 'rejected')
    return
  }
  if (r.kind === 'perm') {
    if (a.input.tool !== 'Permission') return answer('Expired or already answered.')
    answer()
    if (r.allow) await resolveApproval(router, a, approveDecision(a.toolInput), '✅ Allowed', 'allowed')
    else await resolveApproval(router, a, denyDecision(PERM_DENY_MESSAGE), '❌ Denied', 'denied')
    return
  }
  if (a.input.tool !== 'AskUserQuestion' || r.qIdx !== a.qIdx) return answer('Expired or already answered.')
  const q = a.input.questions[a.qIdx]
  if (r.opt === 'done') {
    if (!q.multiSelect) return answer('Expired or already answered.')
    const picked = selectedLabels(q, a.selected)
    if (picked.length === 0) return answer('pick at least one')
    answer()
    await answerQuestion(router, a, picked.join(', '))
    return
  }
  if (r.opt >= q.options.length) return answer('Expired or already answered.')
  if (q.multiSelect) {
    answer()
    a.selected = toggleSelected(a.selected, r.opt)
    const id = lastMessageId(a)
    if (id !== undefined) await router.chat.editRows(id, a.text, questionRows(a.id, a.qIdx, q, a.selected), 'urgent').catch(() => {})
    return
  }
  answer()
  await answerQuestion(router, a, q.options[r.opt].label)
}

// Records the answer to the current question, then shows the next one, or ends the hook with all answers.
export async function answerQuestion(router: Router, a: PendingAsk, answer: string): Promise<void> {
  if (a.input.tool !== 'AskUserQuestion') return
  const q = a.input.questions[a.qIdx]
  const doneId = lastMessageId(a)
  const doneText = fitText(`${a.text}\n\n✅ ${answer}`, textLimit(router.chat))
  a.answers[q.question] = answer
  a.qIdx++
  a.selected = new Set()
  const more = a.qIdx < a.input.questions.length
  if (!more) {
    router.asks.delete(a.id)
    endAsk(router, a.conn, answersDecision(a.toolInput, a.answers))
    router.audit.event({ event: 'ask_answer', tool: 'AskUserQuestion', session: a.session.name, outcome: 'answered' })
  }
  if (doneId !== undefined) await router.chat.editRows(doneId, doneText, [], 'urgent').catch(() => {})
  if (!more) return
  try {
    await sendQuestion(router, a)
  } catch (e) {
    router.logger.log(`ask next question failed: ${errMsg(e)}`)
    if (router.asks.get(a.id) === a) {
      router.asks.delete(a.id)
      endAsk(router, a.conn)
    }
  }
}

// Approve or reject a plan, or allow or deny a permission prompt. The decision goes back on the hook connection.
export async function resolveApproval(router: Router, a: PendingAsk, decision: AskDecision, label: string, outcome: string): Promise<void> {
  router.asks.delete(a.id)
  endAsk(router, a.conn, decision)
  router.audit.event({ event: 'ask_answer', tool: askToolName(a.input), session: a.session.name, outcome })
  const id = lastMessageId(a)
  if (id !== undefined) await router.chat.editRows(id, `${a.text}\n\n${label}`, [], 'urgent').catch(() => {})
}

// A text reply answers the question (as typed), or rejects the plan / denies the tool call with the text as feedback.
export async function answerAskText(router: Router, a: PendingAsk, text: string): Promise<void> {
  if (a.input.tool === 'AskUserQuestion') return answerQuestion(router, a, text)
  if (a.input.tool === 'Permission') return resolveApproval(router, a, denyDecision(denyFeedbackMessage(text)), '❌ Denied with feedback', 'feedback')
  return resolveApproval(router, a, denyDecision(feedbackMessage(text)), '❌ Rejected with feedback', 'feedback')
}

// Ends a pending ask without an answer, so the terminal dialog takes over. `note` is added to its message.
export function releaseAsk(router: Router, a: PendingAsk, note: string, outcome: string): void {
  if (router.asks.get(a.id) !== a) return
  router.asks.delete(a.id)
  endAsk(router, a.conn)
  router.audit.event({ event: 'ask_answer', tool: askToolName(a.input), session: a.session.name, outcome })
  noteAskMessage(router, a, note, outcome === 'expired' ? 'expired' : 'notice')
  rememberAskPerm(router, a)
}

// A Permission ask that ends without a verdict from the router leaves its message open to the terminal's verdict: a
// PermResolved that comes later edits it (see onPermResolved).
function rememberAskPerm(router: Router, a: PendingAsk): void {
  const id = lastMessageId(a)
  if (a.input.tool !== 'Permission' || id === undefined || a.session.pid === null) return
  rememberRecentPerm(router, { pid: a.session.pid, tool_name: a.input.toolName, key: callKey(a.toolInput), preview: null, messageId: id, text: a.text })
}

// The hook connection closed first (interrupted in the terminal, or the session died).
export function dropAsk(router: Router, a: PendingAsk): void {
  if (router.asks.get(a.id) !== a) return
  router.asks.delete(a.id)
  router.audit.event({ event: 'ask_answer', tool: askToolName(a.input), session: a.session.name, outcome: 'cancelled' })
  noteAskMessage(router, a, ASK_CANCELLED_TEXT, 'notice')
  rememberAskPerm(router, a)
}

// The Telegram note for a raced dialog the terminal answered: the verdict (see the mod's terminalVerdict), redacted
// and cut to 200 characters.
export const RACE_RESOLVED_TTL_MS = 5 * 60_000
const RESOLVED_VERDICT_MAX = 200
export function resolvedNote(router: Router, verdict: string): string {
  if (verdict === 'dismissed') return '✖ Dismissed in terminal'
  if (verdict === 'denied') return '✖ Denied in terminal'
  const cut = redact([...verdict].slice(0, RESOLVED_VERDICT_MAX).join(''), router.secrets)
  return cut ? `✅ Answered in terminal: ${cut}` : '✅ Answered in terminal'
}

// The terminal answered a raced dialog (the mod sent ask_resolved before it stopped the race). A sent ask loses its
// buttons and ends with no decision; an ask still in its delay is recorded so onAsk never sends it.
export function onAskResolved(router: Router, raceId: string, verdict: string): void {
  const a = [...router.asks.values()].find((x) => x.raceId === raceId)
  if (!a) {
    router.raceResolved.set(raceId, verdict)
    router.clock.setTimer(() => router.raceResolved.delete(raceId), RACE_RESOLVED_TTL_MS)
    return
  }
  router.asks.delete(a.id)
  endAsk(router, a.conn)
  router.audit.event({ event: 'ask_answer', tool: askToolName(a.input), session: a.session.name, outcome: 'terminal' })
  noteAskMessage(router, a, resolvedNote(router, verdict), 'notice')
}

// Adds a note to the ask's current message (an edit, not a new message). The note is logged as its own line.
export function noteAskMessage(router: Router, a: PendingAsk, note: string, kind: string): void {
  const id = lastMessageId(a)
  if (id === undefined) return
  router.chat.editRows(id, `${a.text}\n\n${note}`, []).catch(() => {})
  logSessionOut(router, a.session, sendTarget(router, 'ask', a.session), kind, note, id)
}
