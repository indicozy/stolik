import type { Register } from 'claude-code'

// Node binary the engine runs the tg-bridge PermissionRequest hook with (dist/hook.js, from `npm run build`).
const NODE = '/home/user/.asdf/installs/nodejs/24.5.0/bin/node'
const DISMISSED = 'Dismissed from Telegram.'
// The router is told the terminal answered within this time; past it the race goes on without waiting.
const RESOLVE_CAP_MS = 3000
// Tools with their own paths: a question or a plan is answered in its own dialog, never reported as PermResolved.
const UNREPORTED = new Set(['AskUserQuestion', 'ExitPlanMode'])
// Calls asked of the person in the main loop (tool.check said 'ask'), by tool_use_id, until their tool.call ends. Capped:
// the oldest entry goes first.
const ASKED_CAP = 200
type Asked = { tool: string; input: unknown }
const asked = new Map<string, Asked>()

export type Verdict = { answers: Record<string, string> } | { deny: string }
type Piece = { stream: 'stdout' | 'stderr'; text: string }
type Child = AsyncGenerator<Piece, unknown> & { readonly result: Promise<{ code: number | null }> }
export type Settled<R> = { ok: true; value: R } | { ok: false; error: unknown }
type Decision = { behavior?: string; updatedInput?: { answers?: unknown } }

// The verdict the hook printed, or null when Telegram was not involved (no output, non-zero exit, unparsable).
export function parseVerdict(stdout: string, code: number | null): Verdict | null {
  if (code !== 0) return null
  for (const line of stdout.split('\n')) {
    let decision: Decision | undefined
    try {
      decision = (JSON.parse(line) as { hookSpecificOutput?: { decision?: Decision } }).hookSpecificOutput?.decision
    } catch {
      continue
    }
    if (decision?.behavior === 'deny') return { deny: DISMISSED }
    const answers = decision?.updatedInput?.answers
    if (decision?.behavior === 'allow' && answers && typeof answers === 'object') {
      return { answers: answers as Record<string, string> }
    }
  }
  return null
}

// Reads the child to its end. A child that cannot start or fails counts as "Telegram not involved".
async function readVerdict(child: Child): Promise<Verdict | null> {
  let stdout = ''
  try {
    for await (const piece of child) if (piece.stream === 'stdout') stdout += piece.text
    return parseVerdict(stdout, (await child.result).code)
  } catch {
    return null
  }
}

// What the terminal produced, as the router shows it: the answer labels joined by ', ', 'denied' for a non-answer
// result, or 'dismissed' when the terminal dialog was rejected.
export function terminalVerdict<R>(s: Settled<R>): string {
  if (!s.ok) return 'dismissed'
  const answers = (s.value as { result?: { answers?: unknown } } | null)?.result?.answers
  if (answers && typeof answers === 'object') {
    return Object.values(answers).filter((v): v is string => typeof v === 'string').join(', ')
  }
  return 'denied'
}

// Runs the AskResolved hook (start() spawns it) and waits for it, at most RESOLVE_CAP_MS (sleep is the host's clock).
// Never throws: a router that could not be told leaves the dialog to resolve as before.
export async function announceResolved(sleep: (ms: number) => Promise<void>, start: () => Child): Promise<void> {
  const done = (async () => {
    const child = start()
    for await (const piece of child) void piece
    await child.result
  })()
  try {
    await Promise.race([done, sleep(RESOLVE_CAP_MS)])
  } catch {
    // the hook could not run or was not answered in time
  }
}

// Races the terminal dialog against the Telegram child. Whichever answers first wins; the child is stopped
// (its loop ended, which closes the socket) once either settles. A terminal rejection is rethrown after stopping.
// When the terminal wins, onTerminalWin runs first (before the child is stopped) and its failure is ignored.
export async function race<R>(
  terminal: Promise<R>,
  child: Child,
  fromTelegram: (v: Verdict) => R,
  onTerminalWin?: (settled: Settled<R>) => Promise<void>,
): Promise<R> {
  const tg = readVerdict(child)
  const settled = terminal.then(
    (value): Settled<R> => ({ ok: true, value }),
    (error: unknown): Settled<R> => ({ ok: false, error }),
  )
  let won = await Promise.race([settled.then((s) => ({ s })), tg.then((v) => (v ? { v } : null))])
  if (won === null) won = { s: await settled } // Telegram not involved: the terminal dialog decides
  if (!('v' in won) && onTerminalWin) await onTerminalWin(won.s).catch(() => undefined)
  void child.return(undefined).catch(() => undefined)
  if ('v' in won) return fromTelegram(won.v)
  if (!won.s.ok) throw won.s.error
  return won.s.value
}

function rememberAsked(id: string, tool: string, input: unknown): void {
  asked.delete(id)
  if (asked.size >= ASKED_CAP) asked.delete(asked.keys().next().value as string)
  asked.set(id, { tool, input })
}

// The asked call with this id, forgotten. Undefined when it was not asked (or was already reported).
function takeAsked(id: string | undefined): Asked | undefined {
  if (!id) return undefined
  const seen = asked.get(id)
  asked.delete(id)
  return seen
}

// The hook entrypoint (dist/hook.js) beside this plugin's folder.
const hookOf = (root: string): string => `${root}/../dist/hook.js`

// Drains a child started only to report: its output is not read, and its failure goes nowhere.
async function drain(child: Child): Promise<void> {
  for await (const piece of child) void piece
  await child.result
}

// Starts the PermResolved report and does not wait for it. Never throws into the call it reports on.
function announceVerdict(start: () => Child): void {
  try {
    void drain(start()).catch(() => undefined)
  } catch {
    // the router is not told; the call is unaffected
  }
}

export const register: Register = (on) => {
  // A permission the engine asked (tool.check 'ask') in the main loop: remembered until its call ends, so the call's
  // verdict can be told to the router (tool.call below). The verdict itself is passed on unchanged.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask' && e.tool_use_id && !e.agentId && !UNREPORTED.has(e.tool)) rememberAsked(e.tool_use_id, e.tool, e.input)
    return verdict
  }).catch(($, e, next) => next(e)) // a failing check falls back to the engine's verdict

  // Every tool call: when it was asked (see tool.check), its verdict goes to the router: 'allowed' when the tool ran,
  // 'denied' when the call was refused. The result is returned unchanged.
  on('tool.call', async ($, e, next) => {
    if (UNREPORTED.has(e.tool)) return next(e)
    const report = (seen: Asked, verdict: 'allowed' | 'denied') => announceVerdict(() => $.process.spawn({
      argv: [NODE, hookOf($.plugin.root), 'PermResolved'],
      input: JSON.stringify({ tool_name: seen.tool, tool_input: seen.input, verdict }),
    }) as Child)
    let result: Awaited<ReturnType<typeof next>>
    try {
      result = await next(e)
    } catch (err) {
      const seen = takeAsked(e.tool_use_id)
      if (seen) report(seen, 'denied')
      throw err
    }
    const seen = takeAsked(e.tool_use_id)
    if (seen) report(seen, (result as { deny?: unknown }).deny === undefined ? 'allowed' : 'denied')
    return result
  }).catch(($, e, next) => (next.called ? { deny: 'Call refused: a plugin hook failed.' } : next(e)))

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    // The model's own question already reaches Telegram through the settings PermissionRequest hook, and a
    // subagent's question is not watched here: both take the normal path.
    if (next.origin.plugin === 'engine' || e.agentId) return next(e)
    const terminal = next(e)
    const cwd = await $.session.cwd().catch(() => undefined)
    const input = JSON.stringify({
      tool_name: 'AskUserQuestion',
      tool_input: { questions: e.questions },
      ...(cwd ? { cwd } : {}),
    })
    // The id ties this dialog to its Telegram message: the router removes the buttons when the terminal answers first.
    const raceId = crypto.randomUUID()
    const hook = hookOf($.plugin.root)
    const child = $.process.spawn({ argv: [NODE, hook, 'PermissionRequest', '--race', `--race-id=${raceId}`], input })
    return race(
      terminal,
      child as Child,
      (v) => ('answers' in v ? { result: { questions: e.questions, answers: v.answers } } : { deny: v.deny }),
      (settled) => announceResolved((ms) => $.clock.sleep(ms), () => $.process.spawn({
        argv: [NODE, hook, 'AskResolved', `--race-id=${raceId}`],
        input: JSON.stringify({ verdict: terminalVerdict(settled) }),
      }) as Child),
    )
  }).catch(($, e, next) => next(e)) // any bug in this hook falls back to the normal dialog
}
