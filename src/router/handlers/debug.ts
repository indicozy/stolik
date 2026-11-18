// /debug (owner, General) and /trace (owner, reply to any message) (design §Observability). The report is built from the
// router's state here and the extras the composition root gives (queues, ML worker, quota, version). The rules are pure
// (src/brain/observe.ts); the log level switch is in src/router/log.ts.
import type { Inbound } from '../../brain/chat-types.ts'
import {
  DEBUG_DEFAULT_MINUTES, buildDebugReport, formatTimeline, parseDebugArgs, type DebugMl, type DebugSession, type DebugAddon,
} from '../../brain/observe.ts'
import { debugUntil, effectiveLevel, readEntries, setDebugUntil, allRouterFiles, log } from '../log.ts'
import { chunkText, displayFolder, textLimit } from '../state.ts'
import { inboundTarget } from '../topics.ts'
import { say } from '../send.ts'
import type { Router } from '../core.ts'

// What the composition root knows that the router does not (app.ts builds it).
export type DebugExtras = {
  version: string
  gitSha: string | null
  // Outbound queue depth per chat label ("group", "dm").
  queues: Record<string, number>
  ml: DebugMl
  quota: { weeklyUsedPct: number; aheadBy: number } | null
}

// The /trace timeline is short: this many lines at most, and at most this many traces for one message.
export const TRACE_LINES_MAX = 60
export const TRACE_TRACES_MAX = 3

const MINUTE_MS = 60_000

// The /debug command: a report, `on [minutes]` (debug lines for a while) or `off`.
export async function debugCommand(router: Router, arg: string, m: Inbound): Promise<void> {
  const to = inboundTarget(router, m)
  const cmd = parseDebugArgs(arg)
  if (cmd === null) {
    return say(router, `Usage: /debug (report), /debug on [minutes] (default ${DEBUG_DEFAULT_MINUTES}), /debug off`, m.messageId, to)
  }
  const now = router.clock.now()
  // The debug window runs on the wall clock, the one the log level reads (the router's clock may be a fake).
  if (cmd.action === 'on') {
    const until = Date.now() + cmd.minutes * MINUTE_MS
    setDebugUntil(until)
    router.audit.event({ event: 'debug', action: 'on', minutes: cmd.minutes })
    log(`debug logging on for ${cmd.minutes} min`)
    const at = new Date(until)
    const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
    return say(router, `Debug logging on until ${hhmm} (${cmd.minutes} min). /debug off stops it early.`, m.messageId, to)
  }
  if (cmd.action === 'off') {
    setDebugUntil(0)
    router.audit.event({ event: 'debug', action: 'off' })
    log('debug logging off')
    return say(router, 'Debug logging off.', m.messageId, to)
  }
  const extras = await debugExtras(router)
  const text = buildDebugReport({
    now,
    uptimeSec: process.uptime(),
    version: extras.version,
    gitSha: extras.gitSha,
    level: effectiveLevel(),
    debugUntil: debugUntil() > Date.now() ? debugUntil() : null,
    sessions: sessionRows(router),
    addons: addonRows(router),
    queues: extras.queues,
    ml: extras.ml,
    quota: extras.quota,
    logsTopic: router.logsTopic ? (router.groupId === null ? 'DM errors only' : 'on') : 'off',
  })
  for (const chunk of chunkText(text, textLimit(router.chat))) await say(router, chunk, m.messageId, to)
}

// The extras, or what can be said without them (no composition root in tests).
async function debugExtras(router: Router): Promise<DebugExtras> {
  if (router.debugExtras) {
    try {
      return await router.debugExtras()
    } catch (e) {
      log(`debug extras failed: ${(e as Error).message}`)
    }
  }
  return { version: 'unknown', gitSha: null, queues: {}, ml: { ok: false, reason: 'not available' }, quota: null }
}

function sessionRows(router: Router): DebugSession[] {
  return router.registry
    .list()
    .map((s) => ({
      name: s.name,
      folder: displayFolder(s.cwd, router.home),
      connected: s.connected,
      lastActive: s.lastActive,
      tmux: router.tmuxBySession.get(s.key) ?? null,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

function addonRows(router: Router): DebugAddon[] {
  return (router.addons?.list() ?? []).map((a) => ({
    name: a.name,
    status: a.status,
    running: a.running,
    restarts: a.restarts ?? 0,
    lastError: a.lastError ?? null,
  }))
}

// `/trace` as a reply: the timeline of the message replied to, from the log files. Works in any topic.
export async function traceCommand(router: Router, m: Inbound): Promise<void> {
  const to = inboundTarget(router, m)
  if (m.replyToId === null) {
    return say(router, 'Reply to a message with /trace to see what happened to it.', m.messageId, to)
  }
  const found = router.traces?.tracesForMessage(m.replyToId) ?? []
  const traces = [...new Set(found.map((t) => t.trace))].slice(0, TRACE_TRACES_MAX)
  if (traces.length === 0) {
    return say(router, 'No trace is kept for that message (kept 7 days, and only for messages this router handled).', m.messageId, to)
  }
  const entries = readEntries(allRouterFiles())
  for (const trace of traces) {
    const mine = entries.filter((e) => e.trace === trace)
    if (mine.length === 0) {
      await say(router, `trace ${trace}: its log lines are gone (rotated out).`, m.messageId, to)
      continue
    }
    const lines = formatTimeline(mine, { short: true, max: TRACE_LINES_MAX })
    const text = `trace ${trace}\n${lines.join('\n')}`
    for (const chunk of chunkText(text, textLimit(router.chat))) await say(router, chunk, m.messageId, to)
  }
  router.audit.event({ event: 'trace', traces: traces.length })
}
