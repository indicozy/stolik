// Router plain messages in General (design §4.4). In order: (1) the 30-minute rule: the one session active in the last 30
// minutes gets the message, with "wrong one?". (2) A name in the text (src/brain/route-match.ts): a live session or folder
// it names gets the message; a folder with no live session is offered as [Full] [👁 Read-only] [Other…], or started at
// once in auto mode when its name leads the message (quota permitting, one per 5 minutes). (3) The route addon (the local
// model) only preselects: "Send to <session>?" or "Start <folder>?" with one-tap buttons. (4) Buttons: each open session,
// New…, quick, read, web. Forwarded messages skip (1) to (3) and get the buttons. Config routerAutoStart "off" skips
// (2) and (3). quick, read and web are handed to the modes addon through its prefix dispatch (addons.general); with no
// addon they say which addon would answer it (or "not installed"). New… opens the folder picker. Also the prefix
// "new <project>:" (startNewFromPrefix) and "oc <project>:" (startOpencodeFromPrefix). Every decision is audited as a
// `route` event.
import { basename, join } from 'node:path'
import type { ButtonPress, Inbound } from '../../brain/chat-types.ts'
import type { MessageId } from '../../brain/chat-types.ts'
import { autoStartAllowed, folderPage, lastActivity, orderFolders, plainTarget } from '../../brain/route.ts'
import { nameHit, quoteData } from '../../brain/route-match.ts'
import type { AgentKind, RoutePayload } from '../../ports.ts'
import { startableDirs, prepare, send, deliverable } from '../deliver.ts'
import { errMsg } from '../log.ts'
import { recordMsg, logRouteDecision, say } from '../send.ts'
import { inboundTarget } from '../topics.ts'
import { newRouteId, type Answer, type Prepared, type RoutePending } from '../shared.ts'
import { effectiveModel, spawnFor, startingText } from '../spawn.ts'
import { tmuxNameFor } from '../../adapters/tmux.ts'
import {
  FORWARD_PREFIX, askOrder, folderLabels, folderPageRows, idleRows, launchRows, pickerRows, resolveProject, routeRows, sendRows, startRows,
  type RouteCallback, type RouteMode, type Rows, type Session,
} from '../state.ts'
import type { Router } from '../core.ts'

// Args for a Read-only session: claude starts in plan mode, opencode with its plan agent.
export const READ_ONLY_ARGS: readonly string[] = ['--permission-mode', 'plan']
export const OPENCODE_READ_ONLY_ARGS: readonly string[] = ['--agent', 'plan']
// The args of a start of the harness `agent`, Read-only or full.
export function startArgs(agent: AgentKind, readOnly: boolean): readonly string[] {
  if (!readOnly) return []
  return agent === 'opencode' ? OPENCODE_READ_ONLY_ARGS : READ_ONLY_ARGS
}
export const OC_UNAVAILABLE_TEXT = 'opencode is not available here.'
export const OC_USAGE = 'Usage: oc <name>: <text>. <name> is a trusted folder (see /list).'
export const ASK_TEXT = 'Which one?'
export const NO_SESSION_TEXT = 'No session can take it right now. Start one with New…, or ask quick, read or web.'

// The master folder: the first of the folder picker.
export function masterDir(router: Router): string {
  return join(router.home, 'Documents', 'projects', 'master')
}

// The newest transcript time per folder (ms), from the agent's transcript list.
export async function folderRecency(router: Router): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (const t of await router.agent.listTranscripts()) out.set(t.cwd, Math.max(out.get(t.cwd) ?? 0, t.mtime))
  return out
}

// Every trusted folder for the picker, in its order (master first, then recent activity, then by path).
export async function pickerFolders(router: Router): Promise<string[]> {
  return orderFolders(startableDirs(router), masterDir(router), await folderRecency(router))
}

// The short name of a folder on the buttons (parent/basename where two folders share a basename).
async function folderLabel(router: Router, dir: string): Promise<string> {
  return folderLabels(await pickerFolders(router)).get(dir) ?? basename(dir)
}

function pickerText(page: number, pages: number): string {
  return pages > 1 ? `${FOLDER_TEXT} (page ${page + 1} of ${pages})` : FOLDER_TEXT
}

// A plain General message (already prepared: media downloaded, transcript read). Forwarded messages get the buttons only.
export async function routeByContent(router: Router, candidates: Session[], m: Inbound, content: string, pre?: Prepared): Promise<void> {
  const prepared = pre ?? (await prepare(router, m, content))
  if (!prepared) return
  const live = deliverable(router)
  const alive = candidates.filter((s) => live.includes(s))
  if (m.forwarded) {
    router.audit.event({ event: 'route', decision: 'buttons', source: 'buttons', candidates: alive.length, reason: 'forwarded' })
    return askWhich(router, alive, m, prepared)
  }
  const target = plainTarget(alive, router.clock.now())
  if (target) {
    router.audit.event({ event: 'route', decision: 'forward', source: 'rule', session: target.name, candidates: alive.length, reason: 'the only session active in 30 minutes' })
    return forwardPlain(router, target, m, prepared)
  }
  // With no live session at all (and the message is not a reply), a folder hit or a model pick starts at once, quota permitting.
  const startNow = startsWhenNoSession(router, live, m)
  if (router.routerAutoStart !== 'off') {
    if (await routeByName(router, live, alive, m, prepared, startNow)) return
    if (await routeViaModel(router, live, alive, m, prepared, startNow)) return
  }
  router.audit.event({ event: 'route', decision: 'buttons', source: 'buttons', candidates: alive.length })
  return askWhich(router, alive, m, prepared)
}

// Config startWhenNoSession: with no live session at all, and the message is not a reply to a message, a folder may be
// started by the router itself (the same as routerAutoStart "auto" for any folder hit).
export function startsWhenNoSession(router: Router, live: Session[], m: Inbound): boolean {
  return router.startWhenNoSession && live.length === 0 && m.replyToId === null
}

// The name in the text: a live session or a trusted folder it names. True when the message was handled.
async function routeByName(router: Router, live: Session[], alive: Session[], m: Inbound, prepared: Prepared, startNow: boolean): Promise<boolean> {
  const folders = await pickerFolders(router)
  const labels = folderLabels(folders)
  const hit = nameHit({
    text: prepared.body,
    sessions: live.map((s) => ({ name: s.name, folder: s.cwd, lastActiveAt: lastActivity(s) })),
    folders: folders.map((p) => ({ name: labels.get(p) ?? basename(p), path: p })),
  })
  if (hit === null) return false
  if (hit.kind === 'forward') {
    const s = live.find((x) => x.name === hit.session)
    if (!s) return false
    router.audit.event({ event: 'route', decision: 'forward', source: 'match', session: s.name, reason: hit.reason })
    await forwardPlain(router, s, m, prepared)
    return true
  }
  const dir = hit.folder
  const name = basename(dir)
  if ((hit.start && router.routerAutoStart === 'auto') || startNow) {
    const block = await autoStartBlock(router)
    if (block === null) {
      router.audit.event({ event: 'route', decision: 'start', source: 'match', folder: name, reason: startNow ? 'no live session' : hit.reason })
      await startRouted(router, dir, m, prepared)
      return true
    }
    router.audit.event({ event: 'route', decision: 'confirm', source: 'match', folder: name, reason: block })
    await askStart(router, dir, m, prepared, alive, { source: 'match', reason: hit.reason }, block)
    return true
  }
  router.audit.event({ event: 'route', decision: 'confirm', source: 'match', folder: name, reason: hit.reason })
  await askStart(router, dir, m, prepared, alive, { source: 'match', reason: hit.reason })
  return true
}

// Why an auto-start may not happen now: the quota gate first (a refusal, or an unknown quota, gives its reason), then the
// one-per-5-minutes cap. Null when the auto-start may go ahead.
async function autoStartBlock(router: Router): Promise<string | null> {
  const quota = await quotaBlock(router)
  if (quota !== null) return quota
  if (!autoStartAllowed(router.lastAutoStartAt, router.clock.now())) return 'one auto-start every 5 minutes'
  return null
}

// The quota gate alone (an explicit folder, such as a topic, has no 5-minute cap): the refusal reason, or null.
export async function quotaBlock(router: Router): Promise<string | null> {
  const refusal = await router.quotaRefusal().catch(() => 'the quota is not known')
  if (refusal !== null) return refusal || 'the quota refused'
  return null
}

// The route addon (the local model) asked for a plain message. It only preselects: a session gets "Send to", a folder gets
// "Start", both with buttons. True when it preselected one; false when there is no addon, no usable answer, or no target.
async function routeViaModel(router: Router, live: Session[], alive: Session[], m: Inbound, prepared: Prepared, startNow: boolean): Promise<boolean> {
  if (!router.addons?.route) return false
  const folders = await pickerFolders(router)
  const labels = folderLabels(folders)
  const payload: RoutePayload = {
    text: prepared.body,
    sessions: live.map((s) => ({ name: s.name, folder: s.cwd, lastActiveAt: lastActivity(s) })),
    folders: folders.map((p) => ({ name: labels.get(p) ?? basename(p), path: p })),
  }
  const answer = await router.addons.route(payload).catch(() => null)
  if (!answer) {
    router.audit.event({ event: 'route', decision: 'none', source: 'model', reason: 'no usable answer' })
    return false
  }
  const t = answer.target
  if (t === null) {
    router.audit.event({ event: 'route', decision: 'none', source: 'model', reason: answer.reason, confidence: answer.confidence })
    return false
  }
  const via = { source: 'model' as const, reason: answer.reason, confidence: answer.confidence }
  if (t.kind === 'session') {
    const s = live.find((x) => x.name === t.name)
    if (!s) {
      router.audit.event({ event: 'route', decision: 'none', source: 'model', reason: 'not a live session', confidence: answer.confidence })
      return false
    }
    router.audit.event({ event: 'route', decision: 'confirm', source: 'model', session: s.name, reason: answer.reason, confidence: answer.confidence })
    await askSend(router, s, m, prepared, alive, via)
    return true
  }
  if (!folders.includes(t.folder)) {
    router.audit.event({ event: 'route', decision: 'none', source: 'model', reason: 'not a trusted folder', confidence: answer.confidence })
    return false
  }
  if (startNow) {
    const block = await autoStartBlock(router)
    if (block === null) {
      router.audit.event({ event: 'route', decision: 'start', source: 'model', folder: basename(t.folder), reason: 'no live session', confidence: answer.confidence })
      await startRouted(router, t.folder, m, prepared)
      return true
    }
    router.audit.event({ event: 'route', decision: 'confirm', source: 'model', folder: basename(t.folder), reason: block, confidence: answer.confidence })
    await askStart(router, t.folder, m, prepared, alive, via, block)
    return true
  }
  router.audit.event({ event: 'route', decision: 'confirm', source: 'model', folder: basename(t.folder), reason: answer.reason, confidence: answer.confidence })
  await askStart(router, t.folder, m, prepared, alive, via)
  return true
}

// "Send to <session>?" [Yes] [Other…], as a reply to the message.
async function askSend(router: Router, s: Session, m: Inbound, prepared: Prepared, alive: Session[], via: RoutePending['via']): Promise<void> {
  const id = newRouteId()
  const text = `Send to ${s.name}?`
  const messageId = await router.chat
    .sendText(text, { replyTo: m.messageId, ...inboundTarget(router, m), rows: sendRows(id) })
    .catch((e) => {
      router.logger.log(`send confirm failed: ${errMsg(e)}`)
      return null
    })
  if (messageId === null) return
  putRoutePending(router, id, {
    m, prepared, mode: 'confirm', messageId, text, candidates: alive, pick: s, folders: [], folder: null, via, createdAt: router.clock.now(),
  })
}

// "Start <folder>?" [Full] [👁 Read-only] [Other…], as a reply to the message. `notice` says why it was not started by itself.
async function askStart(
  router: Router,
  dir: string,
  m: Inbound,
  prepared: Prepared,
  alive: Session[],
  via: RoutePending['via'],
  notice?: string,
): Promise<void> {
  const id = newRouteId()
  const text = `Start ${await folderLabel(router, dir)}?${notice ? ` (not started by itself: ${notice})` : ''}`
  const messageId = await router.chat
    .sendText(text, { replyTo: m.messageId, ...inboundTarget(router, m), rows: startRows(id, router.hasAgent('opencode')) })
    .catch((e) => {
      router.logger.log(`start confirm failed: ${errMsg(e)}`)
      return null
    })
  if (messageId === null) return
  putRoutePending(router, id, {
    m, prepared, mode: 'confirm', messageId, text, candidates: alive, folders: [], folder: dir, via, createdAt: router.clock.now(),
  })
}

// A new full session in `dir` started by the router with the message as its first prompt (auto mode, a name that leads
// the message). This is the one start message (spawnFor is told not to send its own): it carries "wrong one?", which
// offers Stop it and the folder picker.
async function startRouted(router: Router, dir: string, m: Inbound, prepared: Prepared): Promise<void> {
  const project = basename(dir)
  const agent = autoStartAgent(router)
  const model = agent === 'claude' ? effectiveModel(router).model : null
  const text = startingText(tmuxNameFor(project), project, model)
  const id = newRouteId()
  router.lastAutoStartAt = router.clock.now()
  const messageId = await router.chat
    .sendText(text, { replyTo: m.messageId, ...inboundTarget(router, m), rows: wrongOneRows(id) })
    .catch((e) => {
      router.logger.log(`start reply failed: ${errMsg(e)}`)
      return null
    })
  if (messageId !== null) {
    putRoutePending(router, id, {
      m, prepared, mode: 'started', messageId, text, candidates: [], folders: [], folder: dir, createdAt: router.clock.now(),
    })
  }
  const tmuxName = await spawnFor(router, project, dir, m, prepared.body, prepared, [], { announce: false, agent })
  const p = router.routePending.get(id)
  if (tmuxName !== null && p) p.tmuxName = tmuxName
  // The name was taken (a -2 suffix), so the start message names the instance that really runs. Its buttons stay.
  if (tmuxName !== null && p && tmuxName !== tmuxNameFor(project)) {
    p.text = startingText(tmuxName, project, model)
    await router.chat.editRows(p.messageId, p.text, wrongOneRows(id)).catch(() => {})
  }
}

// The harness of the bot's own starts: config defaultAgent, or claude when this router does not run it.
export function autoStartAgent(router: Router): AgentKind {
  return router.hasAgent(router.defaultAgent) ? router.defaultAgent : 'claude'
}

// The "wrong one?" button under a start or a delivery confirmation.
function wrongOneRows(id: string): Rows {
  return [[{ text: '↩ wrong one?', data: `rt:w:${id}` }]]
}

// Delivers to the one active session and offers "wrong one?" on the confirmation.
export async function forwardPlain(router: Router, s: Session, m: Inbound, prepared: Prepared): Promise<void> {
  if (!(await send(router, s, m, prepared))) return
  const id = newRouteId()
  const text = `→ [${s.name}]`
  const messageId = await router.chat
    .sendText(text, { replyTo: m.messageId, ...inboundTarget(router, m), rows: [[{ text: '↩ wrong one?', data: `rt:w:${id}` }]] })
    .catch((e) => {
      router.logger.log(`route reply failed: ${errMsg(e)}`)
      return null
    })
  if (messageId === null) return
  recordMsg(router, s, messageId, null)
  putRoutePending(router, id, {
    m, prepared, mode: 'delivered', messageId, text, candidates: [], from: s, folders: [], folder: null, createdAt: router.clock.now(),
  })
}

// The buttons for a plain message: the open sessions (most recently active first), New…, quick, read, web. With no live
// session: New… and the modes only.
export async function askWhich(router: Router, sessions: Session[], m: Inbound, prepared: Prepared): Promise<void> {
  const ordered = askOrder(sessions)
  const id = newRouteId()
  const text = ordered.length > 0 ? ASK_TEXT : NO_SESSION_TEXT
  const rows = ordered.length > 0 ? routeRows(id, ordered) : idleRows(id)
  const messageId = await router.chat
    .sendText(text, { replyTo: m.messageId, ...inboundTarget(router, m), rows })
    .catch((e) => {
      router.logger.log(`ask reply failed: ${errMsg(e)}`)
      return null
    })
  if (messageId === null) return
  putRoutePending(router, id, {
    m, prepared, mode: 'ask', messageId, text, candidates: ordered, folders: [], folder: null, createdAt: router.clock.now(),
  })
}

// `new <project>:` (or `new:` alone). A named project goes straight to [Read-only] [Full]; no name opens the folder picker.
// The text after the prefix is the new session's first message.
export async function startNewFromPrefix(router: Router, name: string | undefined, body: string, m: Inbound, prepared?: Prepared): Promise<void> {
  const ready: Prepared | null = prepared ? { body, meta: prepared.meta } : await prepare(router, m, body)
  if (!ready) return
  const target = inboundTarget(router, m)
  if (name === undefined) {
    const folders = await pickerFolders(router)
    if (folders.length === 0) return say(router, 'No trusted folder to start in. Run claude there once at the desk to trust it.', m.messageId, target)
    return askFolder(router, m, ready, folders)
  }
  const r = resolveProject(name, startableDirs(router))
  if (r.status === 'none') return say(router, `No trusted folder named "${name}". See /list for the folders.`, m.messageId, target)
  if (r.status === 'ambiguous') return say(router, r.error, m.messageId, target)
  return askLaunch(router, m, ready, r.dir)
}

// `oc <name>:` (or `new oc <name>:`): a new opencode session in the named trusted folder, in full, at once (no question),
// with the text as its first message. Plan mode is in the new-prefix question's opencode plan button.
export async function startOpencodeFromPrefix(router: Router, name: string, body: string, m: Inbound, prepared?: Prepared): Promise<void> {
  const target = inboundTarget(router, m)
  if (!router.hasAgent('opencode')) return say(router, OC_UNAVAILABLE_TEXT, m.messageId, target)
  const ready: Prepared | null = prepared ? { body, meta: prepared.meta } : await prepare(router, m, body)
  if (!ready) return
  const r = resolveProject(name, startableDirs(router))
  if (r.status === 'none') return say(router, `No trusted folder named "${name}". See /list for the folders.`, m.messageId, target)
  if (r.status === 'ambiguous') return say(router, r.error, m.messageId, target)
  await spawnFor(router, basename(r.dir), r.dir, m, ready.body, ready, [], { agent: 'opencode' })
}

// The folder picker (page 0), as a new message replying to `m`.
async function askFolder(router: Router, m: Inbound, prepared: Prepared, folders: string[]): Promise<void> {
  const id = newRouteId()
  const pg = folderPage(folders.length, 0)
  const text = pickerText(0, pg.pages)
  const rows = pickerRows(id, folders, 0, folderLabels(folders), false)
  const messageId = await router.chat
    .sendText(text, { replyTo: m.messageId, ...inboundTarget(router, m), rows })
    .catch((e) => {
      router.logger.log(`folder picker failed: ${errMsg(e)}`)
      return null
    })
  if (messageId === null) return
  putRoutePending(router, id, { m, prepared, mode: 'folder', messageId, text, candidates: [], folders, folder: null, createdAt: router.clock.now(), page: 0 })
}

// [Read-only] [Full] for one folder, as a new message replying to `m` (the `new <name>:` prefix).
async function askLaunch(router: Router, m: Inbound, prepared: Prepared, dir: string): Promise<void> {
  const id = newRouteId()
  const text = launchText(dir)
  const messageId = await router.chat
    .sendText(text, { replyTo: m.messageId, ...inboundTarget(router, m), rows: launchRows(id, router.hasAgent('opencode')) })
    .catch((e) => {
      router.logger.log(`launch prompt failed: ${errMsg(e)}`)
      return null
    })
  if (messageId === null) return
  putRoutePending(router, id, { m, prepared, mode: 'launch', messageId, text, candidates: [], folders: [], folder: dir, createdAt: router.clock.now() })
}

export const FOLDER_TEXT = 'Start a session in which folder?'
function launchText(dir: string): string {
  return `Start ${basename(dir)}: read-only or full?`
}

export function putRoutePending(router: Router, id: string, p: RoutePending): void {
  router.routePending.put(id, p)
}

// Ends a pending route. A delivered or started message just loses its button; a moved one keeps its target; the rest say so.
export function expireRoute(router: Router, id: string, p: RoutePending): void {
  router.routePending.delete(id)
  const keep = p.mode === 'delivered' || p.mode === 'started'
  const text = keep ? p.text : p.mode === 'moving' && p.from ? `→ [${p.from.name}]` : `${p.text}\n\n⌛ expired, resend`
  router.chat.editRows(p.messageId, text, []).catch(() => {})
}

export async function onRouteCallback(router: Router, cb: ButtonPress, r: RouteCallback): Promise<void> {
  const answer: Answer = (t?: string) => router.chat.ackButton(cb.pressId, t).catch(() => {})
  const p = router.routePending.get(r.pendingId)
  if (!p) return answer('expired, resend')
  if (router.routePending.isExpired(p, router.clock.now())) {
    expireRoute(router, r.pendingId, p)
    return answer('expired, resend')
  }
  switch (r.kind) {
    case 'w':
      return offerMove(router, r.pendingId, p, answer)
    case 'n':
      return openFolders(router, r.pendingId, p, answer)
    case 'y':
      return confirmSend(router, r.pendingId, p, answer)
    case 'o':
      return otherChoice(router, r.pendingId, p, answer)
    case 'k':
      return stopStarted(router, r.pendingId, p, answer)
    case 'p':
      return turnPage(router, r.pendingId, p, r.page, answer)
    case 's':
      return pickSession(router, r.pendingId, p, r.idx, answer)
    case 'f':
    case 'r':
      return startFolder(router, r.pendingId, p, r.idx, r.kind === 'r', answer)
    case 'm':
      return runMode(router, r.pendingId, p, r.mode, answer)
    case 'l':
      return launch(router, r.pendingId, p, r.agent, r.readOnly, answer)
  }
}

// "wrong one?": on a delivered message, the same buttons for the other open sessions (and New… and the modes). On a
// started one, Stop it and the folder picker (the session it started stays until Stop it is tapped).
export async function offerMove(router: Router, id: string, p: RoutePending, answer: Answer): Promise<void> {
  if (p.mode === 'started') return openFolders(router, id, p, answer)
  if (p.mode !== 'delivered' || !p.from) return answer('Already routed.')
  const others = deliverable(router).filter((s) => s !== p.from)
  p.candidates = askOrder(others)
  p.mode = 'moving'
  p.text = `→ [${p.from.name}] — move to:`
  void router.chat.editRows(p.messageId, p.text, routeRows(id, p.candidates)).catch(() => {})
  return answer()
}

// Yes on a session confirm: the message goes to the session the name or the model chose.
export async function confirmSend(router: Router, id: string, p: RoutePending, answer: Answer): Promise<void> {
  if (p.mode !== 'confirm' || !p.pick) return answer('Already answered.')
  const s = p.pick
  if (!deliverable(router).includes(s)) return answer('That session is no longer running.')
  if (!(await send(router, s, p.m, p.prepared))) return answer('Not connected.')
  router.audit.event({
    event: 'route', decision: 'forward', source: p.via?.source ?? 'model', session: s.name, reason: 'confirmed', ...(p.via ? { confidence: p.via.confidence ?? -1 } : {}),
  })
  // The message now belongs to this session, and its "wrong one?" works as after a forward.
  p.mode = 'delivered'
  p.from = s
  p.pick = undefined
  p.text = `→ [${s.name}]`
  recordMsg(router, s, p.messageId, null)
  logRouteDecision(router, p.m, s)
  await router.chat.editRows(p.messageId, p.text, [[{ text: '↩ wrong one?', data: `rt:w:${id}` }]]).catch(() => {})
  return answer()
}

// Other… on a confirm: the buttons of the open sessions (a session confirm), or the folder picker (a folder confirm).
export async function otherChoice(router: Router, id: string, p: RoutePending, answer: Answer): Promise<void> {
  if (p.mode !== 'confirm') return answer('Already answered.')
  if (p.folder !== null) return openFolders(router, id, p, answer)
  const ordered = askOrder(p.candidates.filter((s) => deliverable(router).includes(s)))
  p.mode = 'ask'
  p.pick = undefined
  p.candidates = ordered
  p.text = ordered.length > 0 ? ASK_TEXT : NO_SESSION_TEXT
  const rows = ordered.length > 0 ? routeRows(id, ordered) : idleRows(id)
  await router.chat.editRows(p.messageId, p.text, rows).catch(() => {})
  return answer()
}

// Stop it on a started session: ends its tmux session (only that one), drops its start queue so nothing reports it as
// failed, and shows the folder picker without the button.
export async function stopStarted(router: Router, id: string, p: RoutePending, answer: Answer): Promise<void> {
  if (p.mode !== 'folder' || p.tmuxName === undefined || p.folder === null) return answer('Nothing to stop.')
  const tmuxName = p.tmuxName
  const folder = p.folder
  // The router ends these sessions itself, so their process dying is not a termination to report.
  for (const [key, name] of router.tmuxBySession) {
    if (name !== tmuxName) continue
    const s = router.registry.get(key)
    if (s) s.pendingTg = null
  }
  const stopped = await router.stopSession(tmuxName).catch(() => false)
  const q = router.spawns.get(folder)
  if (q && q.tmuxName === tmuxName) {
    if (q.timer !== null) router.clock.clearTimer(q.timer)
    router.spawns.delete(folder)
  }
  p.tmuxName = undefined
  const labels = folderLabels(p.folders)
  await router.chat
    .editRows(p.messageId, pickerText(p.page ?? 0, folderPage(p.folders.length, p.page ?? 0).pages), pickerRows(id, p.folders, p.page ?? 0, labels, false))
    .catch(() => {})
  return answer(stopped ? 'Stopped.' : 'Could not stop it; it may have ended.')
}

// A tap on a session button: the message goes to that session.
export async function pickSession(router: Router, id: string, p: RoutePending, idx: number, answer: Answer): Promise<void> {
  if (p.mode === 'delivered') return answer('Tap ↩ wrong one? first.')
  if (p.mode !== 'ask' && p.mode !== 'moving') return answer('Already answered.')
  const target = p.candidates[idx]
  if (!target || !deliverable(router).includes(target)) return answer('That session is no longer running.')
  if (!(await send(router, target, p.m, p.prepared))) return answer('Not connected.')
  router.routePending.delete(id)
  const text = p.mode === 'moving' ? `→ [${target.name}] (moved)` : `→ [${target.name}]`
  recordMsg(router, target, p.messageId, null)
  logRouteDecision(router, p.m, target)
  void router.chat.editRows(p.messageId, text, []).catch(() => {})
  return answer()
}

// The text a mode gets. A forwarded message is quoted as data and marked untrusted (it never reaches a session as an
// instruction).
function modeText(p: RoutePending): string {
  return p.m.forwarded ? FORWARD_PREFIX + quoteData(p.prepared.body) : p.prepared.body
}

// quick, read or web: the text goes to the modes addon as "<mode>: <text>" (its prefix dispatch). No addon answers for
// that word: the notice says which addon it comes from (see unansweredNotice). The answer is a reply to the question.
export async function runMode(router: Router, id: string, p: RoutePending, mode: RouteMode, answer: Answer): Promise<void> {
  if (p.mode !== 'ask' && p.mode !== 'moving') return answer('Already answered.')
  const reply = await modeReply(router, mode, modeText(p), p.m.messageId)
  if (reply === null) {
    const n = unansweredNotice(router, mode)
    await say(router, n.text, p.m.messageId, inboundTarget(router, p.m), n.rows)
    return answer(n.text)
  }
  router.routePending.delete(id)
  void router.chat.editRows(p.messageId, `→ ${mode}`, []).catch(() => {})
  // '' = the addon took the question and sends its own answer.
  if (reply !== '') await say(router, reply, p.m.messageId, inboundTarget(router, p.m))
  return answer()
}

// A typed "quick:", "read:" or "web:" in General: the same as the buttons.
export async function runModeText(router: Router, mode: RouteMode, body: string, m: Inbound): Promise<void> {
  const reply = await modeReply(router, mode, body, m.messageId)
  if (reply === null) {
    const n = unansweredNotice(router, mode)
    return say(router, n.text, m.messageId, inboundTarget(router, m), n.rows)
  }
  // '' = the addon took the question and sends its own answer.
  if (reply !== '') return say(router, reply, m.messageId, inboundTarget(router, m))
}

// What to say when no addon answers a prefix word. "not installed" only when no installed addon declares it; when one
// does and it is off (or not running), the notice names it and offers its /addons entry.
export function unansweredNotice(router: Router, word: string): { text: string; rows?: Rows } {
  const d = router.addons?.declaring?.('prefix', word) ?? null
  if (!d) return { text: `"${word}" is not installed.` }
  const rows: Rows = [[{ text: `Open ${d.name} in /addons`, data: `ad:${d.name}:show` }]]
  if (!d.enabled) return { text: `"${word}" comes from the ${d.name} addon, which is off. Turn it on in /addons.`, rows }
  return { text: `"${word}" comes from the ${d.name} addon, which is not running (${d.status}). Check /addons.`, rows }
}

// The modes addon's answer to "<mode>: <text>", from the addon host's prefix dispatch; null when no addon takes the word.
export async function modeReply(router: Router, mode: RouteMode, text: string, messageId?: MessageId): Promise<string | null> {
  if (!router.addons) return null
  return router.addons.general(`${mode}: ${text}`, messageId).catch(() => null)
}

// New… (and Other… on a folder confirm): the folder picker, on the same message (page 0 of every trusted folder).
export async function openFolders(router: Router, id: string, p: RoutePending, answer: Answer): Promise<void> {
  if (p.mode !== 'ask' && p.mode !== 'moving' && p.mode !== 'started' && p.mode !== 'confirm') return answer('Already answered.')
  const folders = await pickerFolders(router)
  if (folders.length === 0) return answer('No trusted folder to start in.')
  p.mode = 'folder'
  p.folders = folders
  p.page = 0
  p.pick = undefined
  p.text = pickerText(0, folderPage(folders.length, 0).pages)
  await router.chat
    .editRows(p.messageId, p.text, pickerRows(id, folders, 0, folderLabels(folders), p.tmuxName !== undefined))
    .catch(() => {})
  return answer()
}

// ◀ and ▶ on the picker: the same message, another page.
export async function turnPage(router: Router, id: string, p: RoutePending, page: number, answer: Answer): Promise<void> {
  if (p.mode !== 'folder') return answer('Already answered.')
  const pg = folderPage(p.folders.length, page)
  p.page = pg.page
  p.text = pickerText(pg.page, pg.pages)
  await router.chat
    .editRows(p.messageId, p.text, pickerRows(id, p.folders, pg.page, folderLabels(p.folders), p.tmuxName !== undefined))
    .catch(() => {})
  return answer()
}

// ＋ (Full) or 👁 (read-only) on a picker row: starts the session now, with the message as its first prompt.
export async function startFolder(router: Router, id: string, p: RoutePending, idx: number, readOnly: boolean, answer: Answer): Promise<void> {
  if (p.mode !== 'folder') return answer('Already answered.')
  const dir = p.folders[idx]
  if (!dir) return answer('That folder is no longer listed.')
  router.routePending.delete(id)
  const project = basename(dir)
  void router.chat.editRows(p.messageId, `→ starting ${project} (${readOnly ? 'read-only' : 'full'})`, []).catch(() => {})
  await spawnFor(router, project, dir, p.m, p.prepared.body, p.prepared, readOnly ? READ_ONLY_ARGS : [])
  return answer()
}

// [Claude] / [opencode] (with read-only or plan) of the `new <name>:` prefix, or of a folder confirm: starts the session in
// the chosen folder with the chosen harness.
export async function launch(router: Router, id: string, p: RoutePending, agent: AgentKind, readOnly: boolean, answer: Answer): Promise<void> {
  if ((p.mode !== 'launch' && p.mode !== 'confirm') || !p.folder) return answer('Nothing to start.')
  if (!router.hasAgent(agent)) return answer(`${agent} is not available here.`)
  router.routePending.delete(id)
  const dir = p.folder
  const project = basename(dir)
  if (p.mode === 'confirm') {
    router.audit.event({ event: 'route', decision: 'start', source: p.via?.source ?? 'model', folder: project, reason: 'confirmed' })
  }
  const how = agent === 'opencode' ? `opencode, ${readOnly ? 'read-only' : 'full'}` : readOnly ? 'read-only' : 'full'
  await router.chat.editRows(p.messageId, `→ starting ${project} (${how})`, []).catch(() => {})
  await spawnFor(router, project, dir, p.m, p.prepared.body, p.prepared, startArgs(agent, readOnly), { agent })
  return answer()
}
