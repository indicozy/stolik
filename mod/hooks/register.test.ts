import { expect, test } from 'claude-code/testing'
import { announceResolved, parseVerdict, race, register, terminalVerdict } from './register'

type Child = Parameters<typeof race>[1]
type Stop = { killed: boolean }

const HOOK_LINE = (decision: object) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }) + '\n'

// A child that printed `stdout` and exited with `code`.
function finished(stdout: string, code: number | null): Child {
  async function* pieces() {
    if (stdout) yield { stream: 'stdout' as const, text: stdout }
  }
  return Object.assign(pieces(), { result: Promise.resolve({ code, signal: null }) }) as unknown as Child
}

// A child that never ends on its own; `return()` (the engine ending the loop, which kills it) is recorded.
function running(stop: Stop): Child {
  const it = {
    [Symbol.asyncIterator]: () => it,
    next: () => new Promise(() => {}),
    return: async () => {
      stop.killed = true
      return { done: true, value: undefined }
    },
    result: new Promise(() => {}),
  }
  return it as unknown as Child
}

type Out = { answers?: Record<string, string>; deny?: string }
const toResult = (v: { answers: Record<string, string> } | { deny: string }): Out =>
  'answers' in v ? { answers: v.answers } : { deny: v.deny }

test('parseVerdict reads an allow with answers, a deny, and nothing else', () => {
  const allow = HOOK_LINE({ behavior: 'allow', updatedInput: { questions: [], answers: { 'Ok?': 'Yes' } } })
  expect(parseVerdict(allow, 0)).toEqual({ answers: { 'Ok?': 'Yes' } })
  expect(parseVerdict(HOOK_LINE({ behavior: 'deny', message: 'no' }), 0)).toEqual({ deny: 'Dismissed from Telegram.' })
  expect(parseVerdict('', 0)).toBeNull()
  expect(parseVerdict('not json\n' + allow, 0)).toEqual({ answers: { 'Ok?': 'Yes' } })
  expect(parseVerdict(allow, 1)).toBeNull()
  expect(parseVerdict(HOOK_LINE({ behavior: 'allow', updatedInput: {} }), 0)).toBeNull()
})

test('a Telegram answer wins and its answers are returned', async () => {
  const never = new Promise<Out>(() => {})
  const answer = HOOK_LINE({ behavior: 'allow', updatedInput: { answers: { 'Send?': "Don't send" } } })
  const got = await race(never, finished(answer, 0), toResult)
  expect(got).toEqual({ answers: { 'Send?': "Don't send" } })
})

test('empty hook output leaves the terminal dialog in charge', async () => {
  const got = await race(Promise.resolve<Out>({ answers: { 'Send?': 'Send anyway' } }), finished('', 0), toResult)
  expect(got).toEqual({ answers: { 'Send?': 'Send anyway' } })
})

test('a terminal answer first returns it and stops the Telegram child', async () => {
  const stop = { killed: false }
  const got = await race(Promise.resolve<Out>({ answers: { 'Send?': 'Send anyway' } }), running(stop), toResult)
  expect(got).toEqual({ answers: { 'Send?': 'Send anyway' } })
  expect(stop.killed).toBe(true)
})

test('a terminal rejection stops the child and is rethrown', async () => {
  const stop = { killed: false }
  let message = ''
  try {
    await race(Promise.reject<Out>(new Error('dismissed')), running(stop), toResult)
  } catch (err) {
    message = (err as Error).message
  }
  expect(message).toBe('dismissed')
  expect(stop.killed).toBe(true)
})

test('an engine-origin question passes straight through to the terminal', async ($, on) => {
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ result: { questions: [], answers: { 'Q?': 'Yes' } } }) as never)
  on('process.spawn', async function* () {})
  const r = (await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)) as { result?: { answers?: unknown } }
  expect(r.result?.answers).toEqual({ 'Q?': 'Yes' })
})

test('terminalVerdict: the answer labels joined, denied for a non-answer, dismissed for a rejection', () => {
  expect(terminalVerdict({ ok: true, value: { result: { questions: [], answers: { 'Send?': 'Send anyway', 'Why?': 'cost' } } } })).toBe('Send anyway, cost')
  expect(terminalVerdict({ ok: true, value: { deny: 'no' } })).toBe('denied')
  expect(terminalVerdict({ ok: false, error: new Error('dismissed') })).toBe('dismissed')
})

test('when the terminal wins, onTerminalWin runs before the Telegram child is stopped, with the terminal result', async () => {
  const stop = { killed: false }
  let killedAtNotice: boolean | null = null
  let seen: unknown = null
  const terminalResult = { result: { questions: [], answers: { 'Send?': 'Send anyway' } } }
  const got = await race(
    Promise.resolve(terminalResult),
    running(stop),
    () => terminalResult,
    async (settled) => {
      killedAtNotice = stop.killed
      seen = terminalVerdict(settled)
    },
  )
  expect(got).toEqual(terminalResult)
  expect(killedAtNotice).toBe(false)
  expect(seen).toBe('Send anyway')
  expect(stop.killed).toBe(true)
})

test('a failing onTerminalWin does not change the terminal answer', async () => {
  const stop = { killed: false }
  const got = await race(Promise.resolve<Out>({ answers: { 'Send?': 'Send anyway' } }), running(stop), toResult, async () => {
    throw new Error('router down')
  })
  expect(got).toEqual({ answers: { 'Send?': 'Send anyway' } })
  expect(stop.killed).toBe(true)
})

test('when Telegram wins, onTerminalWin is not called', async () => {
  let called = false
  const answer = HOOK_LINE({ behavior: 'allow', updatedInput: { answers: { 'Send?': 'Hold' } } })
  await race(new Promise<Out>(() => {}), finished(answer, 0), toResult, async () => {
    called = true
  })
  expect(called).toBe(false)
})

test('announceResolved starts the AskResolved child and waits for it; a start that throws is swallowed', async () => {
  const never = () => new Promise<void>(() => {})
  let started = 0
  await announceResolved(never, () => {
    started++
    return finished('', 0)
  })
  expect(started).toBe(1)
  await announceResolved(never, () => {
    throw new Error('spawn failed')
  })
})

test('announceResolved gives up after its cap when the hook never ends', async () => {
  const stop = { killed: false }
  await announceResolved(() => Promise.resolve(), () => running(stop))
  expect(stop.killed).toBe(false)
})

// The hooks register() declares, captured by pattern and matcher, with their .catch fallbacks.
type Entry = { pattern: string; matcher?: unknown; hook: (...a: any[]) => any; fallback?: (...a: any[]) => any }
function loaded(): Entry[] {
  const entries: Entry[] = []
  const on = (pattern: string, ...rest: unknown[]) => {
    const entry: Entry = { pattern, matcher: rest.length > 1 ? rest[0] : undefined, hook: rest[rest.length - 1] as Entry['hook'] }
    entries.push(entry)
    return { catch: (fallback: Entry['hook']) => ((entry.fallback = fallback), undefined) }
  }
  register(on as never, {} as never)
  return entries
}
const hookFor = (entries: Entry[], pattern: string, matcher?: unknown) =>
  entries.find((e) => e.pattern === pattern && (matcher === undefined ? e.matcher === undefined : JSON.stringify(e.matcher) === JSON.stringify(matcher)))!

// The $ the hooks use: a spawn that records its arguments and returns a child that ends at once.
function fakeDollar(spawned: Array<{ argv: string[]; input: string }>) {
  return {
    plugin: { root: '/plugins/tg/mod' },
    process: {
      spawn: (opts: { argv: string[]; input: string }) => {
        spawned.push(opts)
        return Object.assign((async function* () {})(), { result: Promise.resolve({ code: 0, signal: null }) })
      },
    },
  }
}
const verdictsOf = (spawned: Array<{ argv: string[]; input: string }>) => spawned.map((s) => JSON.parse(s.input).verdict)

test('a call the engine asked (tool.check ask) that ran: PermResolved is spawned with allowed, and the result passes through', async () => {
  const entries = loaded()
  const check = hookFor(entries, 'tool.check')
  const call = hookFor(entries, 'tool.call')
  const spawned: Array<{ argv: string[]; input: string }> = []
  const $ = fakeDollar(spawned)
  const verdict = { decision: 'ask' }
  expect(await check.hook($, { tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'run-1' }, () => verdict)).toEqual(verdict)
  const result = { result: { stdout: 'ok' } }
  expect(await call.hook($, { tool: 'Bash', tool_use_id: 'run-1', command: 'ls' }, async () => result)).toBe(result)
  expect(spawned.length).toBe(1)
  expect(spawned[0]!.argv).toEqual(['/home/user/.asdf/installs/nodejs/24.5.0/bin/node', '/plugins/tg/mod/../dist/hook.js', 'PermResolved'])
  expect(JSON.parse(spawned[0]!.input)).toEqual({ tool_name: 'Bash', tool_input: { command: 'ls' }, verdict: 'allowed' })
})

test('a refused call (tool.call answers deny) that was asked: PermResolved is spawned with denied, and the deny passes through', async () => {
  const entries = loaded()
  const spawned: Array<{ argv: string[]; input: string }> = []
  const $ = fakeDollar(spawned)
  await hookFor(entries, 'tool.check').hook($, { tool: 'Bash', input: { command: 'rm x' }, tool_use_id: 'deny-1' }, () => ({ decision: 'ask' }))
  const refused = { deny: 'Denied from the terminal.' }
  expect(await hookFor(entries, 'tool.call').hook($, { tool: 'Bash', tool_use_id: 'deny-1', command: 'rm x' }, async () => refused)).toBe(refused)
  expect(verdictsOf(spawned)).toEqual(['denied'])
})

test('a call that threw while asked: PermResolved is spawned with denied, and the rejection is rethrown', async () => {
  const entries = loaded()
  const spawned: Array<{ argv: string[]; input: string }> = []
  const $ = fakeDollar(spawned)
  await hookFor(entries, 'tool.check').hook($, { tool: 'Bash', input: { command: 'rm y' }, tool_use_id: 'throw-1' }, () => ({ decision: 'ask' }))
  let message = ''
  try {
    await hookFor(entries, 'tool.call').hook($, { tool: 'Bash', tool_use_id: 'throw-1', command: 'rm y' }, async () => {
      throw new Error('refused by the engine')
    })
  } catch (err) {
    message = (err as Error).message
  }
  expect(message).toBe('refused by the engine')
  expect(verdictsOf(spawned)).toEqual(['denied'])
})

test('a call that was never asked (tool.check allow, or no check at all): nothing is spawned', async () => {
  const entries = loaded()
  const spawned: Array<{ argv: string[]; input: string }> = []
  const $ = fakeDollar(spawned)
  await hookFor(entries, 'tool.check').hook($, { tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'quiet-1' }, () => ({ decision: 'allow' }))
  await hookFor(entries, 'tool.call').hook($, { tool: 'Bash', tool_use_id: 'quiet-1', command: 'ls' }, async () => ({ result: {} }))
  await hookFor(entries, 'tool.call').hook($, { tool: 'Bash', tool_use_id: 'quiet-2', command: 'ls' }, async () => ({ result: {} }))
  expect(spawned.length).toBe(0)
})

test('a subagent ask (agentId set) and AskUserQuestion are not remembered or reported', async () => {
  const entries = loaded()
  const spawned: Array<{ argv: string[]; input: string }> = []
  const $ = fakeDollar(spawned)
  const check = hookFor(entries, 'tool.check')
  await check.hook($, { tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'sub-1', agentId: 'agent-7' }, () => ({ decision: 'ask' }))
  await hookFor(entries, 'tool.call').hook($, { tool: 'Bash', tool_use_id: 'sub-1', command: 'ls' }, async () => ({ result: {} }))
  await check.hook($, { tool: 'AskUserQuestion', input: {}, tool_use_id: 'ask-1' }, () => ({ decision: 'ask' }))
  await hookFor(entries, 'tool.call').hook($, { tool: 'AskUserQuestion', tool_use_id: 'ask-1', questions: [] }, async () => ({ result: {} }))
  expect(spawned.length).toBe(0)
})

test('a failing PermResolved start never reaches the call; the call result is still returned', async () => {
  const entries = loaded()
  const $ = { plugin: { root: '/plugins/tg/mod' }, process: { spawn: () => { throw new Error('no node') } } }
  await hookFor(entries, 'tool.check').hook($, { tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'boom-1' }, () => ({ decision: 'ask' }))
  const result = { result: { ok: true } }
  expect(await hookFor(entries, 'tool.call').hook($, { tool: 'Bash', tool_use_id: 'boom-1', command: 'ls' }, async () => result)).toBe(result)
})
