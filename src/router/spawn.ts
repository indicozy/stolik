// Router spawn and resume flow: starts a session in tmux for a queued message or /resume, and flushes the queue on register.
//
// Each start gets a spawn token in the session's tmux environment (TG_BRIDGE_SPAWN_TOKEN). The channel echoes it in its
// `register`, and only the register that carries a queue's token takes that queue (its messages, spawned flag and
// resumeOf). A register without a token (an older channel) matches a queue only when its claude process is below that
// queue's tmux pane. A start that times out is stopped (its tmux session is killed); its token stays retired for a while,
// so a register that still arrives is counted as router-started.
import { randomBytes } from 'node:crypto'
import { basename } from 'node:path'
import type { Inbound } from '../brain/chat-types.ts'
import { isResumeId, type ResumeItem } from '../brain/resume.ts'
import { deliver, send } from './deliver.ts'
import { errMsg } from './log.ts'
import { warnOrLog } from '../brain/observe.ts'
import { say, sayStatus } from './send.ts'
import { inboundTarget } from './topics.ts'
import { SPAWN_TIMEOUT_MS, type Prepared, type SpawnQueue } from './shared.ts'
import { MAX_SPAWNED_SESSIONS, hasDeliverableBody, type Session } from './state.ts'
import type { Router } from './core.ts'

// A retired token is kept this long after its start was stopped.
export const RETIRED_TOKEN_MS = 60 * 60 * 1000
// Ancestry walk limit for the token-less fallback (the same bound the claude lookup uses).
const MAX_HOPS = 15

export function newSpawnToken(): string {
  return randomBytes(16).toString('hex')
}

// Where the model of a new bot-started session comes from: the `/model` setting in the store, else config claudeModel,
// else nothing (Claude Code's own default).
export type ModelSource = 'bot' | 'config' | 'default'
export function effectiveModel(router: Router): { model: string | null; source: ModelSource } {
  const bot = router.store.defaultModel()
  if (bot !== null) return { model: bot, source: 'bot' }
  if (router.configModel !== null) return { model: router.configModel, source: 'config' }
  return { model: null, source: 'default' }
}

// The value of `--model` in a start's arguments, or null when there is none.
export function modelArg(args: readonly string[]): string | null {
  const i = args.indexOf('--model')
  return i >= 0 ? (args[i + 1] ?? null) : null
}

// The announcement of a new session. It is always a new message (never an edit), so each start names its own instance.
export function startingText(tmuxName: string, project: string, model: string | null): string {
  return `🆕 Starting new instance ${tmuxName} (${project}${model ? `, model ${model}` : ''})…`
}

// What a register belongs to: a queue it takes (`queue`), or a start that was stopped (`late`, counted as spawned).
export type SpawnClaim = { kind: 'queue'; q: SpawnQueue } | { kind: 'late' }

// The spawn a register belongs to, or null. `real` is the realpath of the registering folder, `claudePid` its claude
// process. Pure apart from the platform's parent-pid reads.
export function claimSpawn(router: Router, real: string | null, token: string | null, claudePid: number | null): SpawnClaim | null {
  if (token !== null) {
    for (const q of router.spawns.values()) if (q.token === token) return { kind: 'queue', q }
    return router.retiredSpawns.has(token) ? { kind: 'late' } : null
  }
  if (real === null || claudePid === null) return null
  const q = router.spawns.get(real)
  if (!q || q.panePid === null) return null
  return isBelow(router, claudePid, q.panePid) ? { kind: 'queue', q } : null
}

// Whether `pid` is a descendant of `ancestor`.
function isBelow(router: Router, pid: number, ancestor: number): boolean {
  let p: number | null = pid
  for (let hop = 0; hop < MAX_HOPS && p !== null && p > 1; hop++) {
    p = router.platform.parentPid(p)
    if (p === ancestor) return true
  }
  return false
}

// Keeps the token of a stopped start until RETIRED_TOKEN_MS has passed.
function retire(router: Router, token: string, real: string): void {
  const now = router.clock.now()
  router.retiredSpawns.set(token, { real, at: now })
  for (const [t, r] of router.retiredSpawns) if (now - r.at > RETIRED_TOKEN_MS) router.retiredSpawns.delete(t)
}

// Options of a start. `announce: false` leaves the start message to the caller (startRouted sends its own, with buttons).
// `onQueued` is called with the queue of a new start, synchronously, before the start (the tmux call) begins: a message
// that arrives during the start can then already find the queue.
export type SpawnOptions = { announce?: boolean; onQueued?: (q: SpawnQueue) => void }

// `real` is the resolved project folder (a realpath, see resolveProject). `extraArgs` go to the claude command in tmux
// (New with Read-only passes --permission-mode plan). A new start also gets `--model` when a model is set and the
// arguments do not already name one. Returns the tmux session name when one was started, else null.
export async function spawnFor(
  router: Router,
  project: string,
  real: string,
  m: Inbound,
  content: string,
  prepared?: Prepared,
  extraArgs: readonly string[] = [],
  options: SpawnOptions = {},
): Promise<string | null> {
  const queued = router.spawns.get(real)
  if (queued) {
    queued.items.push({ m, content, prepared })
    await sayStatus(router, `${project} is still starting; your message will be delivered when it connects.`, m.messageId, inboundTarget(router, m))
    return null
  }
  if (!router.agent.isTrusted(real)) {
    await say(router, `${project} hasn't been trusted yet — open it once at the desk to trust it`, m.messageId, inboundTarget(router, m))
    return null
  }
  if (runningSpawns(router) >= MAX_SPAWNED_SESSIONS) {
    await say(router, `Not starting ${project}: ${MAX_SPAWNED_SESSIONS} router-started sessions are already running.`, m.messageId, inboundTarget(router, m))
    return null
  }
  // The model flag is added to new starts only (a resumed session keeps its own model), and not twice.
  const model = effectiveModel(router).model
  const hasModel = extraArgs.some((a) => a === '--model' || a.startsWith('--model='))
  const args = model !== null && !hasModel ? ['--model', model, ...extraArgs] : [...extraArgs]
  // The queue entry is set before the start (no await in between), so a second message for this folder joins it
  // instead of starting a second session, and the entry counts toward the cap while the start is pending.
  const q: SpawnQueue = { project, real, tmuxName: '', items: [{ m, content, prepared }], timer: null, token: newSpawnToken(), panePid: null, extraArgs: args }
  router.spawns.set(real, q)
  options.onQueued?.(q)
  let tmuxName: string
  try {
    tmuxName = await router.agent.startSession(project, real, args, q.token)
  } catch (e) {
    await failSpawn(router, real, q, errMsg(e), [])
    return null
  }
  q.tmuxName = tmuxName
  q.panePid = await router.agent.panePid(tmuxName).catch(() => null)
  // The session may have registered during the start, which flushes and removes the queue: then there is no timeout.
  if (router.spawns.get(real) === q) {
    q.timer = router.clock.setTimer(() => void spawnTimeout(router, real, q), SPAWN_TIMEOUT_MS)
  }
  router.audit.event({ event: 'spawn', project })
  watchStart(router, real, q)
  if (options.announce !== false) {
    await sayStatus(router, startingText(tmuxName, project, modelArg(args)), m.messageId, inboundTarget(router, m))
  }
  return tmuxName
}

// Watches a router-started session until it registers. If its tmux session disappears first, the start has failed.
function watchStart(router: Router, real: string, q: SpawnQueue): void {
  router.agent
    .watchStartup(q.tmuxName, SPAWN_TIMEOUT_MS, () => router.spawns.get(real) !== q, (pane) => { router.logger.log(`start dialog not recognised in ${q.tmuxName}; pane: ${pane.join(' | ')}`); void say(router, `${q.tmuxName} is showing a dialog the bridge does not recognise. Answer it at the desk.`) })
    .then((o) => {
      if (o.kind === 'gone') return failSpawn(router, real, q, `the tmux session ${q.tmuxName} ended before it connected`, o.pane)
    })
    .catch((e) => router.logger.log(`dialog watch failed: ${errMsg(e)}`))
}

// A router-started session that did not start: its queue is removed, a started tmux session is killed, the log gets the
// last lines of its pane, and the chat is told why, with the messages that were queued for it (they were not delivered).
// `q` must still be the queue of `real`; otherwise the start already succeeded or was reported, and nothing is said.
// `label` names the session in the chat (a /resume names its transcript title).
async function failSpawn(
  router: Router,
  real: string,
  q: SpawnQueue,
  reason: string,
  pane: string[],
  label: string = q.project,
  note = '',
): Promise<void> {
  if (router.spawns.get(real) !== q) return
  router.spawns.delete(real)
  if (q.timer !== null) router.clock.clearTimer(q.timer)
  if (q.resumeOf !== undefined) router.resumingIds.delete(q.resumeOf)
  if (q.tmuxName !== '') {
    retire(router, q.token, real)
    await router.agent.killSession(q.tmuxName).catch(() => {})
  }
  // The forensics file (argv, environment names, pane, claude version) is written first; the message and the log name it.
  const forensicsPath = router.forensics
    ? await router.forensics({ project: q.project, cwd: real, argv: startArgv(router, q, real), tmuxName: q.tmuxName || null, pane, reason })
    : null
  const where = forensicsPath ? ` Forensics: ${forensicsPath}` : ''
  warnOrLog(router.logger, `${label} didn't start: ${reason}${forensicsPath ? `. Forensics: ${forensicsPath}` : ''}`, 'spawn')
  if (pane.length === 0) router.logger.log('  pane: no output')
  for (const line of pane) router.logger.log(`  pane | ${line}`)
  const n = q.items.length
  const lost = n === 0 ? '' : n === 1 ? " The message wasn't delivered." : ` ${n} messages weren't delivered.`
  const first = q.items[0]?.m
  await say(router, `${label} didn't start: ${reason}.${lost}${note}${where}`, first?.messageId, first ? inboundTarget(router, first) : {})
}

// The command line a start of this queue used (the backend builds it; empty when it has none to show).
function startArgv(router: Router, q: SpawnQueue, real: string): string[] {
  return router.agent.startCommand?.(q.project, real, q.extraArgs ?? []) ?? []
}

// Router-started sessions: starting ones plus registered ones that the router spawned.
export function runningSpawns(router: Router): number {
  return router.spawns.size + router.registry.list().filter((s) => s.spawned).length
}

// Runs SPAWN_FLUSH_DELAY_MS after the claimed register. If the session has gone away by then, the queue is kept: its next
// registration flushes it, or the spawn timeout reports it.
export async function flushSpawn(router: Router, s: Session, q: SpawnQueue): Promise<void> {
  if (!router.agent.isConnected(s.key)) return
  if (router.spawns.get(q.real) !== q) return
  if (q.timer !== null) router.clock.clearTimer(q.timer)
  router.spawns.delete(q.real)
  if (q.resumeOf !== undefined) router.resumingIds.delete(q.resumeOf)
  s.spawned = true
  if (q.tmuxName) router.tmuxBySession.set(s.key, q.tmuxName)
  for (const it of q.items) {
    if (!hasDeliverableBody(it)) continue
    if (it.prepared) await send(router, s, it.m, it.prepared)
    else await deliver(router, s, it.m, it.content)
  }
}

// The registration timeout of the start `armed`: the session did not connect in time. Its pane is read for the log first,
// then it is stopped. A queue that is no longer the one that armed the timer (it was replaced) is left alone.
export async function spawnTimeout(router: Router, real: string, armed: SpawnQueue): Promise<void> {
  const q = router.spawns.get(real)
  if (!q || q !== armed) return
  const pane = await router.agent.paneTail(q.tmuxName).catch(() => [] as string[])
  await failSpawn(router, real, q, `it didn't connect within ${SPAWN_TIMEOUT_MS / 1000} s`, pane, q.project, ' Its tmux session was stopped.')
}

// Starts `claude --resume <id>` in tmux, after the same checks /to makes (folder, trust, spawn cap). The session
// is then watched for the development-channels dialog, like a new spawn.
export async function resumeEnded(router: Router, it: ResumeItem): Promise<void> {
  const title = it.title
  if (!isResumeId(it.id)) return say(router, `Can't resume ${title}: its session id is not valid.`)
  if (router.resumingIds.has(it.id)) return say(router, `${title} is already being resumed.`)
  if (router.platform.fileInfo(it.path) === null) return say(router, `Can't resume ${title}: its transcript is gone.`)
  const real = router.platform.realpath(it.cwd)
  if (real === null || !router.platform.isDirectory(real)) return say(router, `Can't resume ${title}: its folder ${it.cwd} no longer exists.`)
  const folder = basename(real)
  if (!router.agent.isTrusted(real)) {
    return say(router, `${folder} hasn't been trusted yet — open it once at the desk to trust it`)
  }
  if (router.spawns.has(real)) return say(router, `${folder} is still starting; try again in a moment.`)
  if (runningSpawns(router) >= MAX_SPAWNED_SESSIONS) {
    return say(router, `Not resuming ${title}: ${MAX_SPAWNED_SESSIONS} router-started sessions are already running.`)
  }
  // The transcript id and the queue entry are reserved before the start (no await in between), as spawnFor does. Both
  // are released when the session registers or the start fails (failSpawn, flushSpawn).
  router.resumingIds.add(it.id)
  const q: SpawnQueue = { project: folder, real, tmuxName: '', items: [], timer: null, resumeOf: it.id, token: newSpawnToken(), panePid: null, extraArgs: ['--resume', it.id] }
  router.spawns.set(real, q)
  let tmuxName: string
  try {
    tmuxName = await router.agent.startSession(folder, real, ['--resume', it.id], q.token)
  } catch (e) {
    return failSpawn(router, real, q, errMsg(e), [], title)
  }
  q.tmuxName = tmuxName
  q.panePid = await router.agent.panePid(tmuxName).catch(() => null)
  if (router.spawns.get(real) === q) {
    q.timer = router.clock.setTimer(() => void spawnTimeout(router, real, q), SPAWN_TIMEOUT_MS)
  }
  router.audit.event({ event: 'resume', project: folder })
  watchStart(router, real, q)
  await sayStatus(router, `🔁 Resuming ${title} as ${tmuxName} (${folder})…`)
}
