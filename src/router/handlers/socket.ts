// Router socket handlers: messages from channel servers and hooks (register, reply, permission, hook, notify, ctl).
import type { AskMsg, ChClose, ChPermReq, ChRegister, ChReply, HookMsg, NotifyMsg } from '../../adapters/channel/protocol.ts'
import type { SocketConn } from '../../ports.ts'
import type { MessageId, SendTarget } from '../../brain/chat-types.ts'
import { onAsk, dropAsk, endAsk, noteAskMessage, onAskResolved } from './ask.ts'
import { errMsg } from '../log.ts'
import { outboundKeys } from '../outbound.ts'
import { resolveOutboundFiles, sendForSession, recordMsg } from '../send.ts'
import { parseLevel, LEVEL_ERROR } from '../../brain/notify-level.ts'
import { ANSWERED_AT_DESK_TEXT, answeredAtDesk, callKey, previewMatches, type CallKey } from '../../brain/posttool.ts'
import { syncPendingMarker, logSessionOut, pruneRecentPerms } from '../approvals.ts'
import { PENDING_CAP, str, type PendingPerm } from '../shared.ts'
import { claimSpawn, flushSpawn } from '../spawn.ts'
import { procRef, type SessionKey } from '../../brain/sessions.ts'
import { onE2e } from './e2e.ts'
import { closeSession } from '../close.ts'
import { announceTerminated, inTopic, onSessionRegistered, sendTarget } from '../topics.ts'
import { detachedSession, markNotification, markPrompt, markStop, notificationText, permissionPromptText, permissionRedacted, shouldDeliverReply, stopForwardText, SPAWN_FLUSH_DELAY_MS, validSessionId, type PermissionDetails, type Session } from '../state.ts'
import type { RecentPerm } from '../shared.ts'
import type { Router } from '../core.ts'
import { UNKNOWN_AWAY_NOTE } from '../../brain/away.ts'

// A reply longer than this is cut, with a notice. The Telegram chunker would split it anyway; this bounds the work (finding 13).
const MAX_REPLY_CHARS = 64_000
const REPLY_CUT_NOTICE = '\n\n[cut: the reply was longer than 64 KB]'
const HASH_HEX = /^[0-9a-f]{64}$/
// Prompts answered (at the desk, or in the terminal) while their send was still in flight: their buttons are sent after all,
// with the note for the verdict.
const answeredWhileSending = new WeakMap<object, string>()
// The notes that end a permission prompt once the terminal's verdict is known (PermResolved).
export const PERM_ALLOWED_IN_TERMINAL = '✅ Allowed in terminal'
export const PERM_DENIED_IN_TERMINAL = '❌ Denied in terminal'
const VERDICT_NOTE = { allowed: PERM_ALLOWED_IN_TERMINAL, denied: PERM_DENIED_IN_TERMINAL } as const

export function onSocket(router: Router, conn: SocketConn, msg: any): void {
  if (!msg || typeof msg !== 'object') return
  switch (msg.t) {
    case 'register':
      return onRegister(router, conn, msg as ChRegister)
    case 'reply':
      void onReply(router, conn, msg as ChReply)
      return
    case 'close':
      return onCloseSession(router, conn, msg as ChClose)
    case 'permission_request':
      void onPermissionRequest(router, conn, msg as ChPermReq)
      return
    case 'hook':
      void onHook(router, conn, msg as HookMsg)
      return
    case 'notify':
      void onNotify(router, conn, msg as NotifyMsg)
      return
    case 'ctl':
      return onCtl(router, conn, msg)
    case 'ask':
      void onAsk(router, conn, msg as AskMsg)
      return
    case 'ask_resolved':
      if (typeof msg.raceId === 'string' && typeof msg.verdict === 'string') onAskResolved(router, msg.raceId.slice(0, 100), msg.verdict.slice(0, 1000))
      return
    case 'e2e':
      return onE2e(router, conn, msg)
  }
}

// How long after a channel disconnects its session is checked for a terminated notice. A channel that reconnects (or a
// router restart) registers again within this time, so only a session whose process is really gone is announced.
export const TERMINATED_CHECK_MS = 5_000

// The key of the session whose connection this was, asked of every backend (the first one that had it).
function detachAny(router: Router, conn: SocketConn): SessionKey | null {
  for (const backend of router.allAgents()) {
    const key = backend.detachSession(conn)
    if (key !== null) return key
  }
  return null
}

export function onSocketClose(router: Router, conn: SocketConn): void {
  // The hook went away (the user answered in the terminal, Esc, or the session died): the ask is over.
  for (const a of [...router.asks.values()]) if (a.conn === conn) dropAsk(router, a)
  const s = router.connSession.get(conn)
  router.connSession.delete(conn)
  const key = detachAny(router, conn)
  if (s && key !== null) s.connected = false
  // The sweep would find a dead session later; this check is for speed, and it only acts on a process that is gone.
  if (s?.pendingTg) {
    router.clock.setTimer(() => {
      if (s.pid === null || router.platform.pidAlive(s.pid) || router.agentFor(s.key).isConnected(s.key)) return
      announceTerminated(router, s)
    }, TERMINATED_CHECK_MS)
  }
}

export function bind(router: Router, conn: SocketConn, s: Session): void {
  router.agentFor(s.key).attachSession(s.key, conn)
  router.connSession.set(conn, s)
}

export function onRegister(router: Router, conn: SocketConn, msg: ChRegister): void {
  const pid = typeof msg.claudePid === 'number' ? msg.claudePid : null
  if (!router.agent.isInteractive(pid)) {
    // Non-interactive claude (print mode): no session, no routing, no /list entry.
    conn.send({ t: 'registered', name: '' })
    router.audit.event({ event: 'register_ignored', reason: 'non-interactive' })
    return
  }
  const s = router.registry.registerChannel(procRef(pid, (p) => router.platform.processStart(p)), str(msg.cwd) ?? '', router.clock.now())
  bind(router, conn, s)
  conn.send({ t: 'registered', name: s.name })
  // Only the spawn this register belongs to (by its token) takes a queue; a stopped start's late register is counted.
  const claim = claimSpawn(router, router.platform.realpath(s.cwd), str(msg.spawnToken) ?? null, pid)
  if (claim?.kind === 'late') s.spawned = true
  const queue = claim?.kind === 'queue' ? claim.q : null
  void onSessionRegistered(router, s)
  router.logger.log(`session registered: ${s.name}`)
  router.audit.event({ event: 'register', session: s.name })
  // Delayed: the channel's notification handler is installed a few ms after registration, and a message that
  // arrives before it is dropped without a trace.
  if (queue) router.clock.setTimer(() => void flushSpawn(router, s, queue), SPAWN_FLUSH_DELAY_MS)
}

// close_session: the answer goes first, and the close follows after CLOSE_REQUEST_DELAY_MS, so the tool call returns and
// Claude can still say so. The session is the one this channel registered (a channel has one session).
export const CLOSE_REQUEST_DELAY_MS = 2_000

function onCloseSession(router: Router, conn: SocketConn, msg: ChClose): void {
  const s = router.connSession.get(conn)
  if (!s) return conn.send({ t: 'close_result', reqId: msg.reqId, ok: false, error: 'channel not registered with the router' })
  conn.send({ t: 'close_result', reqId: msg.reqId, ok: true })
  router.clock.setTimer(() => void closeSession(router, s, 'request'), CLOSE_REQUEST_DELAY_MS)
}

export async function onReply(router: Router, conn: SocketConn, msg: ChReply): Promise<void> {
  const reply = (r: { ok: boolean; delivered: boolean; error?: string }) =>
    conn.send({ t: 'reply_result', reqId: msg.reqId, ...r })
  const s = router.connSession.get(conn)
  if (!s) return reply({ ok: false, delivered: false, error: 'channel not registered with the router' })
  try {
    const now = router.clock.now()
    const kind = msg.kind ?? 'response'
    const level = parseLevel(msg.level)
    if (level === null) return reply({ ok: false, delivered: false, error: LEVEL_ERROR })
    const text = capReply(str(msg.text) ?? '')
    const files = Array.isArray(msg.files) ? msg.files.filter((f): f is string => typeof f === 'string') : []
    const away = kind === 'proactive' ? await router.platform.isAway() : false
    if (!shouldDeliverReply(kind, s, away, now, level)) return reply({ ok: true, delivered: false })
    if (!text.trim() && files.length === 0) return reply({ ok: false, delivered: false, error: 'empty reply' })
    const out = resolveOutboundFiles(router, files)
    if ('error' in out) return reply({ ok: false, delivered: false, error: out.error })
    const sent = await sendForSession(router, s, text, kind, out.paths, 'reply', 'markdown', level)
    if (sent.deduped) return reply({ ok: false, delivered: false, error: 'not sent: an identical message was already sent in this turn' })
    reply({ ok: true, delivered: true })
  } catch (e) {
    reply({ ok: false, delivered: false, error: errMsg(e) })
  }
}

export async function onPermissionRequest(router: Router, conn: SocketConn, msg: ChPermReq): Promise<void> {
  const s = router.connSession.get(conn)
  if (!s) return
  const requestId = str(msg.request_id) ?? ''
  if (!/^[a-km-z]{5}$/.test(requestId)) return
  // Locked: the prompt is not relayed, and the terminal dialog is the only one (finding 21). The channel relay has no
  // answer for Claude to wait on, so there is nothing else to send back.
  if (router.locked) {
    router.audit.event({ event: 'permission_not_relayed', session: s.name, reason: 'locked' })
    return
  }
  const details: PermissionDetails = {
    tool_name: str(msg.tool_name) ?? '',
    description: str(msg.description) ?? '',
    input_preview: str(msg.input_preview) ?? '',
  }
  try {
    const state = await router.platform.awayState()
    if (state === 'active') return // at the desk: the terminal prompt handles it
    const redacted = permissionRedacted(details, router.secrets)
    // Unknown idle time still relays the prompt (it is answerable at either place), marked as such.
    const text = permissionPromptText(s.name, details, router.secrets, redacted) + (state === 'unknown' ? `\n\n${UNKNOWN_AWAY_NOTE}` : '')
    if (router.pending.size >= PENDING_CAP) {
      const oldestKey = router.pending.keys().next().value
      const oldest = oldestKey === undefined ? undefined : router.pending.get(oldestKey)
      if (oldestKey !== undefined) router.pending.delete(oldestKey)
      if (oldest) syncPendingMarker(router, oldest.session.pid)
    }
    // The entry and its marker go in before the send, so a PostToolUse that arrives during the send finds them (finding 18).
    const entry: PendingPerm = { session: s, messageId: null, text, details, redacted, createdAt: router.clock.now(), reminded: false }
    router.pending.set(requestId, entry)
    syncPendingMarker(router, s.pid)
    let sent: { value: MessageId; to: SendTarget }
    try {
      const to = { ...sendTarget(router, 'approval', s), session: String(s.key) }
      // An approval is critical: it always pings, whatever the topic's mute.
      sent = await inTopic(router, s, to, (t) =>
        router.chat.sendText(text, { perm: { requestId, withMore: true, redacted }, ...t, priority: 'urgent', level: 'critical' }),
      )
    } catch (e) {
      if (router.pending.get(requestId) === entry) {
        router.pending.delete(requestId)
        syncPendingMarker(router, s.pid)
      }
      throw e
    }
    const id = sent.value
    recordMsg(router, s, id, sent.to.thread ?? null)
    logSessionOut(router, s, sent.to, 'approval', text, id)
    const note = answeredWhileSending.get(entry)
    if (note !== undefined) {
      router.chat.editText(id, `${text}\n\n${note}`, null).catch(() => {})
    } else if (router.pending.get(requestId) === entry) {
      entry.messageId = id
    }
    router.audit.event({ event: 'permission_prompt', session: s.name, tool: details.tool_name })
  } catch (e) {
    router.logger.log(`permission prompt failed: ${errMsg(e)}`)
  }
}

export async function onHook(router: Router, conn: SocketConn, msg: HookMsg): Promise<void> {
  conn.send({ t: 'ok' })
  conn.end()
  const now = router.clock.now()
  const pid = typeof msg.claudePid === 'number' ? msg.claudePid : null
  if (!router.agent.isInteractive(pid)) return
  const p = (msg.payload ?? {}) as Record<string, unknown>
  try {
    const s = router.registry.upsertFromHook(procRef(pid, (p) => router.platform.processStart(p)), str(msg.cwd) ?? '', now)
    const sid = validSessionId(p.session_id)
    if (sid !== null) s.backendSessionId = sid
    switch (msg.event) {
      case 'UserPromptSubmit':
        markPrompt(s, now)
        return
      case 'Stop': {
        const away = await router.platform.isAway()
        const text = stopForwardText(
          s,
          {
            stop_hook_active: p.stop_hook_active === true,
            last_assistant_message: str(p.last_assistant_message) ?? null,
          },
          away,
          now,
        )
        let forwarded = false
        if (text) {
          try {
            await sendForSession(router, s, text, 'response', [], 'hook')
            forwarded = true
          } catch (e) {
            router.logger.log(`stop forward failed: ${errMsg(e)}`)
          }
        }
        markStop(s, forwarded, now)
        // The turn is over: the end-of-turn text above was the answer, so later output is no longer a reply to it.
        s.pendingTg = null
        return
      }
      case 'PostToolUse':
        onToolDone(router, pid, p)
        return
      case 'PermResolved':
        onPermResolved(router, pid, p)
        return
      case 'Notification': {
        const type = str(p.notification_type)
        const away = await router.platform.isAway()
        const text = notificationText(s, { notification_type: type, message: str(p.message) ?? null }, away, now)
        markNotification(s, type, now)
        if (text) await sendForSession(router, s, text, 'response', [], 'hook')
        // A session that is idle at its prompt has finished its turn (see Stop above).
        if (type === 'idle_prompt') s.pendingTg = null
        return
      }
    }
  } catch (e) {
    router.logger.log(`hook ${String(msg.event)} failed: ${errMsg(e)}`)
  }
}

// A tool finished. When it is the call of a pending permission prompt of this session, that prompt was answered at the
// desk ("Yes" in the terminal): its buttons go and it says so. A terminal "No" fires nothing; the sweep covers it (plan 1.2).
export function onToolDone(router: Router, pid: number | null, p: Record<string, unknown>): void {
  const tool = str(p.tool_name)
  const key = toolKey(p)
  if (pid === null || tool === undefined || key === null) return
  // The tool ran, so the call was allowed (a PermResolved for the same call finds nothing left and does nothing).
  answerChannelPrompt(router, pid, tool, key, ANSWERED_AT_DESK_TEXT, 'allowed')
}

// The verdict of a permission the mod saw asked (sent by its tool.call hook): 'allowed' when the tool ran, 'denied' when the
// call was refused. The prompt's message loses its buttons and gets the verdict. Checks, in order: a channel prompt of this
// session, a hook-path Permission ask still open, a Permission message whose prompt ended without a verdict (recent).
export function onPermResolved(router: Router, pid: number | null, p: Record<string, unknown>): void {
  const tool = str(p.tool_name)
  const key = toolKey(p)
  const verdict = p.verdict === 'allowed' || p.verdict === 'denied' ? p.verdict : null
  if (pid === null || tool === undefined || key === null || verdict === null) return
  const note = VERDICT_NOTE[verdict]
  if (answerChannelPrompt(router, pid, tool, key, note, verdict)) return
  if (answerHookAsk(router, pid, tool, key, note, verdict)) return
  answerRecentPerm(router, pid, tool, key, note, verdict)
}

// The pending channel prompt of this session that this call answers: removed, and its message edited with `note`
// (no buttons). Returns false when no pending prompt matches.
function answerChannelPrompt(router: Router, pid: number, tool: string, key: CallKey, note: string, verdict: 'allowed' | 'denied'): boolean {
  const prompts = [...router.pending]
    .filter(([, x]) => x.session.pid === pid)
    .map(([id, x]) => ({ id, tool_name: x.details.tool_name, input_preview: x.details.input_preview }))
  const id = answeredAtDesk(prompts, { tool_name: tool, key })
  if (id === null) return false
  const prompt = router.pending.get(id)
  if (!prompt) return false
  router.pending.delete(id)
  syncPendingMarker(router, pid)
  router.audit.event({ event: 'permission_answered_at_desk', session: prompt.session.name, tool, verdict })
  // Still sending: there are no buttons to clear yet. onPermissionRequest says so once the send returns.
  if (prompt.messageId === null) answeredWhileSending.set(prompt, note)
  else router.chat.editText(prompt.messageId, `${prompt.text}\n\n${note}`, null).catch(() => {})
  return true
}

// The open hook-path Permission ask of this session for this call: ended with no decision (the terminal already
// answered), its message given the verdict. Returns false when no ask matches.
function answerHookAsk(router: Router, pid: number, tool: string, key: CallKey, note: string, verdict: 'allowed' | 'denied'): boolean {
  const a = [...router.asks.values()].find((x) =>
    x.input.tool === 'Permission' && x.session.pid === pid && x.input.toolName === tool && callKey(x.toolInput).hash === key.hash)
  if (!a) return false
  router.asks.delete(a.id)
  endAsk(router, a.conn)
  router.audit.event({ event: 'ask_answer', tool, session: a.session.name, outcome: 'terminal', verdict })
  noteAskMessage(router, a, note, 'notice')
  return true
}

// A Permission message whose prompt ended without a verdict the router saw (see RecentPerm): edited with the verdict.
function answerRecentPerm(router: Router, pid: number, tool: string, key: CallKey, note: string, verdict: 'allowed' | 'denied'): boolean {
  pruneRecentPerms(router)
  const i = router.recentPerms.findIndex((e) => e.pid === pid && e.tool_name === tool &&
    (e.key !== null ? e.key.hash === key.hash : e.preview !== null && previewMatches(e.preview, key)))
  if (i < 0) return false
  const [entry] = router.recentPerms.splice(i, 1) as [RecentPerm]
  router.audit.event({ event: 'permission_answered_at_desk', tool, verdict, late: true })
  router.chat.editText(entry.messageId, `${entry.text}\n\n${note}`, null).catch(() => {})
  return true
}

// The reply text the router sends, cut to MAX_REPLY_CHARS with a notice (finding 13).
export function capReply(text: string): string {
  return text.length <= MAX_REPLY_CHARS ? text : text.slice(0, MAX_REPLY_CHARS) + REPLY_CUT_NOTICE
}

// The call key a PostToolUse hook sends (hash and head of the canonical input), or null when absent or malformed.
export function toolKey(p: Record<string, unknown>): CallKey | null {
  const hash = p.input_hash
  const head = p.input_head
  if (typeof hash !== 'string' || !HASH_HEX.test(hash) || typeof head !== 'string' || head.length > 4000) return null
  return { hash, head }
}

export async function onNotify(router: Router, conn: SocketConn, msg: NotifyMsg): Promise<void> {
  const pid = typeof msg.claudePid === 'number' ? msg.claudePid : null
  try {
    // An explicit request is still delivered, but a non-interactive claude does not get a session entry.
    const cwd = str(msg.cwd) ?? ''
    const now = router.clock.now()
    const proc = procRef(pid, (p) => router.platform.processStart(p))
    const s = router.agent.isInteractive(pid) ? router.registry.upsertFromHook(proc, cwd, now) : detachedSession(proc, cwd, now)
    const level = parseLevel(msg.level)
    const out = level === null ? null : resolveOutboundFiles(router, Array.isArray(msg.files) ? msg.files : [])
    if (level === null || out === null) {
      conn.send({ t: 'ok', delivered: false, error: LEVEL_ERROR })
    } else if ('error' in out) {
      conn.send({ t: 'ok', delivered: false, error: out.error })
    } else {
      const text = str(msg.text) ?? ''
      // Already sent to the user this turn by reply: the same message is not sent again.
      if (s.outbound.hasSentBody(outboundKeys('requested', text, out.paths).bodyKey, now, 'reply')) {
        router.audit.event({ event: 'outbound_dedup', session: s.name, kind: 'requested' })
      } else {
        await sendForSession(router, s, text, 'requested', out.paths, 'notify', msg.plain === true ? 'plain' : 'markdown', level)
      }
      conn.send({ t: 'ok', delivered: true })
    }
  } catch (e) {
    conn.send({ t: 'ok', delivered: false, error: errMsg(e) })
  } finally {
    conn.end()
  }
}

export function onCtl(router: Router, conn: SocketConn, msg: { cmd?: unknown; userId?: unknown; yes?: unknown }): void {
  if (msg.cmd === 'pair' || msg.cmd === 'pair_confirm') return onPairCtl(router, conn, msg)
  if (msg.cmd === 'lock' || msg.cmd === 'unlock') {
    setLocked(router, msg.cmd === 'lock', 'socket')
  } else if (msg.cmd !== 'status') {
    conn.send({ t: 'ctl_result', ok: false, locked: router.locked, error: 'unknown command' })
    return
  }
  conn.send({ t: 'ctl_result', ok: true, locked: router.locked })
}

// `pair` waits (the answer comes later, on the same connection) for the owner's code; `pair_confirm` answers yes or no.
function onPairCtl(router: Router, conn: SocketConn, msg: { cmd?: unknown; userId?: unknown; yes?: unknown }): void {
  const send = (r: Record<string, unknown>): void => {
    try {
      conn.send({ t: 'ctl_result', locked: router.locked, ...r })
    } catch {
      // The setup side went away: nothing to answer.
    }
  }
  if (!router.pairing) return send({ ok: false, error: 'pairing is not available in this router' })
  if (msg.cmd === 'pair') {
    void router.pairing.wait().then((r) => (r.ok ? send({ ok: true, pair: r.candidate }) : send({ ok: false, error: r.error })))
    return
  }
  if (typeof msg.userId !== 'string' || !/^\d+$/.test(msg.userId) || typeof msg.yes !== 'boolean') {
    return send({ ok: false, error: 'pair_confirm needs a userId (digits) and yes (boolean)' })
  }
  const r = router.pairing.confirm(msg.userId, msg.yes)
  send(r.ok ? { ok: true } : { ok: false, error: r.error })
}

export function setLocked(router: Router, on: boolean, source: string): void {
  if (on === router.locked) return
  router.locked = on
  router.lockNotified = false
  try {
    router.store.setLocked(on)
  } catch (e) {
    router.logger.log(`lock state not persisted: ${errMsg(e)}`)
  }
  router.logger.log(on ? 'router LOCKED' : 'router unlocked')
  router.audit.event({ event: on ? 'lock' : 'unlock', source })
}
