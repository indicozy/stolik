// The modes addon's logic with fakes for the host, the CLI, the hook shell and the clock (plan 2.11): answers, footers,
// buttons, Continue, Upgrade, swipe-reply threads, the quota gate, usage records, the semaphore and its waiting cap, the
// hook self-test, and the per-run policy files.
import './helpers/isolate.ts'
import { tgMsg } from '../src/adapters/chat/tg-ids.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ThreadMap, dropSecretLines, estimateCostUsd, hookOutput, modesCwd, type ModeName } from '../src/brain/modes.ts'
import { Semaphore } from '../src/brain/concurrency.ts'
import { ModesService, MAX_WAITERS, TOO_MANY_WAITING, HOOK_OFF, type ServiceDeps } from '../src/addons/modes/service.ts'
import type { RawRun } from '../src/addons/modes/run.ts'
import { ISOLATED_ROOT } from './helpers/isolate.ts'

const SID = '1ad1ce43-2b77-4566-a349-25c65eaa004d'
const HOME = '/home/u'
const LOG_ROOT = '/logs/telegram'
const NOTES = '/notes'
const TRUSTED = [
  { name: 'master', path: '/home/u/Documents/projects/master' },
  { name: 'other', path: '/home/u/Documents/projects/other' },
]
// The hook's answer to the self-test when it works: a deny JSON with a reason (selfTestPasses checks this exact form).
const HOOK_PASS = hookOutput({ allow: false, reason: 'refused in the self-test' })

type Req = { op: string; payload: Record<string, unknown> }
type During = { files: string[]; policy: Record<string, unknown> | null }

function answer(over: Record<string, unknown> = {}): RawRun {
  const body = { subtype: 'success', is_error: false, result: 'the answer', session_id: SID, num_turns: 2, total_cost_usd: 0.04, permission_denials: [], ...over }
  return { stdout: JSON.stringify(body), stderr: '', code: 0, timedOut: false, durationMs: 12_000 }
}

type HarnessOpts = {
  quota?: () => unknown
  folders?: Array<{ name: string; path: string }>
  spawnOk?: boolean
  hookSafe?: boolean
}

async function harness(opts: HarnessOpts = {}) {
  const reqs: Req[] = []
  const runs: Array<{ args: string[]; timeoutMs: number; cwd: string; during: During }> = []
  const responders: Array<() => RawRun | Promise<RawRun>> = []
  const hookCalls: Array<{ command: string; stdin: string }> = []
  const logs: string[] = []
  const stateDir = mkdtempSync(join(ISOLATED_ROOT, 'modes-state-'))
  const hooksDir = join(stateDir, 'hooks')
  let mid = 100
  let key = 0
  const threads = new ThreadMap()
  const semaphore = new Semaphore(3)

  // What the hooks folder holds during a run: the names, and the policy JSON (not the settings file).
  const snapshot = (): During => {
    const files = existsSync(hooksDir) ? readdirSync(hooksDir).sort() : []
    const name = files.find((f) => f.endsWith('.json') && !f.endsWith('.settings.json'))
    return { files, policy: name ? (JSON.parse(readFileSync(join(hooksDir, name), 'utf8')) as Record<string, unknown>) : null }
  }

  const deps: ServiceDeps = {
    request: async (op, payload) => {
      reqs.push({ op, payload })
      if (op === 'send') {
        const parts = Array.isArray(payload.text) ? payload.text : [payload.text]
        return { messageIds: parts.map(() => `tg:${++mid}`) }
      }
      if (op === 'quota') return opts.quota ? await opts.quota() : { refuse: false }
      if (op === 'folders') return { folders: opts.folders ?? [] }
      if (op === 'spawn') return opts.spawnOk === false ? { ok: false, error: 'not trusted yet' } : { ok: true }
      if (op === 'usage') return { ok: true }
      throw new Error(`unexpected ${op}`)
    },
    run: async (args, timeoutMs, cwd) => {
      runs.push({ args, timeoutMs, cwd, during: snapshot() })
      const next = responders.shift()
      return next ? next() : answer()
    },
    hookCommand: (mode: ModeName, policyPath: string) => `hook ${mode} ${policyPath}`,
    runHook: async (command, stdin) => {
      hookCalls.push({ command, stdin })
      return opts.hookSafe === false ? '' : HOOK_PASS
    },
    stateDir,
    logRoot: LOG_ROOT,
    notesDir: NOTES,
    now: () => 1_000,
    home: HOME,
    threads,
    saveThreads: () => {},
    // Keys come out as 'aaaaaaaa', 'bbbbbbbb', ... in order.
    newKey: () => String.fromCharCode(97 + key++).repeat(8),
    semaphore,
    log: (m) => logs.push(m),
  }
  const svc = new ModesService(deps)
  await svc.selfTest()
  const sent = () => reqs.filter((r) => r.op === 'send').map((r) => r.payload)
  const usage = () => reqs.filter((r) => r.op === 'usage').map((r) => r.payload)
  const quotaCalls = () => reqs.filter((r) => r.op === 'quota').length
  return { svc, reqs, runs, responders, threads, sent, usage, quotaCalls, semaphore, logs, hookCalls, stateDir, hooksDir }
}

type H = Awaited<ReturnType<typeof harness>>

// The footer the service adds to every answer (cost and seconds of the default answer fixture).
function footerOf(_h: H): string {
  return '· $0.04 · 12 s'
}

// Lets the background work finish: the service answers first and runs in the background.
async function settle(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setImmediate(r))
  assert.ok(cond(), `settled: ${label}`)
}

// A promise the test resolves by hand, to hold a background step open.
function gate(): { wait: Promise<unknown>; open: (v: unknown) => void } {
  let open!: (v: unknown) => void
  const wait = new Promise((r) => {
    open = r
  })
  return { wait, open }
}

test('quick: a prefix is handled at once, runs haiku with no tools in the neutral folder, and answers with the footer and no buttons', async () => {
  const h = await harness()
  const r = await h.svc.onPrefix({ word: 'quick', text: 'what is 2+2?', messageId: 'tg:7' })
  assert.deepEqual(r, { handled: true })
  await settle(() => h.sent().length === 1, 'answer')
  assert.deepEqual(h.runs[0].args.slice(0, 8), ['-p', '--model', 'haiku', '--output-format', 'json', '--strict-mcp-config', '--tools', ''])
  assert.equal(h.runs[0].args.at(-1), 'what is 2+2?')
  assert.equal(h.runs[0].timeoutMs, 60_000)
  assert.deepEqual(h.sent()[0], { text: 'the answer\n\n· $0.04 · 12 s', replyTo: 'tg:7' })
  assert.deepEqual(h.usage()[0], { mode: 'quick', costUsd: 0.04, durationMs: 12_000, outcome: 'answer' })
  assert.equal(h.threads.size, 1, 'the answer is a thread for swipe-replies')
})

test('an empty question or a dash start is answered, not run', async () => {
  const h = await harness()
  assert.match((await h.svc.onPrefix({ word: 'read', text: '   ' })).reply ?? '', /Write the question after the colon/)
  assert.match((await h.svc.onPrefix({ word: 'web', text: '-rf' })).reply ?? '', /cannot start with a dash/)
  assert.equal(h.runs.length, 0)
})

test('read: the answer has an Upgrade button, runs in the master project, and the thread entry keeps the key', async () => {
  const h = await harness()
  await h.svc.onPrefix({ word: 'check', text: 'disk?', messageId: 'tg:7' })
  await settle(() => h.sent().length === 1, 'answer')
  const msg = h.sent()[0]
  assert.deepEqual(msg.rows, [[{ text: 'Upgrade', data: 'u:aaaaaaaa' }]])
  assert.equal(h.runs[0].timeoutMs, 300_000)
  assert.equal(h.runs[0].cwd, modesCwd(HOME))
  const entry = h.threads.get(tgMsg(101))
  assert.ok(entry)
  assert.equal(entry.mode, 'read')
  assert.equal(entry.question, 'disk?')
  assert.equal(entry.answer, 'the answer')
})

test('a run that hits its limit gets Continue (and Upgrade for read); a timeout says so and records the estimate', async () => {
  const h = await harness()
  h.responders.push(() => answer({ subtype: 'error_max_turns', is_error: true, result: 'half way' }))
  await h.svc.onPrefix({ word: 'read', text: 'big question', messageId: 'tg:7' })
  await settle(() => h.sent().length === 1, 'limit answer')
  assert.match(h.sent()[0].text as string, /^half way/)
  assert.deepEqual(h.sent()[0].rows, [[{ text: 'Continue', data: 'c:aaaaaaaa' }, { text: 'Upgrade', data: 'u:aaaaaaaa' }]])
  assert.equal(h.threads.get(tgMsg(101))?.partial, true)

  h.responders.push(() => ({ stdout: '', stderr: '', code: null, timedOut: true, durationMs: 300_000 }))
  await h.svc.onPrefix({ word: 'web', text: 'slow', messageId: 'tg:8' })
  await settle(() => h.sent().some((s) => /cut off/.test(String(s.text))), 'timeout note')
  assert.equal(h.usage().at(-1)?.outcome, 'error')
  assert.equal(h.usage().at(-1)?.costUsd, estimateCostUsd('web', 300_000), 'a timed-out run records the estimate, not 0')
  assert.ok((h.usage().at(-1)?.costUsd as number) > 0)
})

test('a CLI error is shown as "Could not answer", and its cost is recorded', async () => {
  const h = await harness()
  h.responders.push(() => answer({ subtype: 'error_during_execution', is_error: true, result: 'auth failed', total_cost_usd: 0.07 }))
  await h.svc.onPrefix({ word: 'quick', text: 'x', messageId: 'tg:7' })
  await settle(() => h.sent().length === 1, 'error note')
  assert.equal(h.sent()[0].text, 'Could not answer: auth failed')
  assert.deepEqual(h.usage()[0], { mode: 'quick', costUsd: 0.07, durationMs: 12_000, outcome: 'error' })
  assert.equal(h.threads.size, 0)
})

test('the quota gate refuses a run, and an unreadable quota refuses too (fail closed)', async () => {
  const refused = await harness({ quota: () => ({ refuse: true, reason: 'the weekly quota is at 99% (limit 99%)' }) })
  const r = await refused.svc.onPrefix({ word: 'quick', text: 'x' })
  assert.equal(r.reply, 'Modes are paused: the weekly quota is at 99% (limit 99%).')
  assert.equal(refused.runs.length, 0)

  const broken = await harness({ quota: () => { throw new Error('router is down') } })
  const r2 = await broken.svc.onPrefix({ word: 'quick', text: 'x' })
  assert.match(r2.reply ?? '', /could not be checked \(router is down\)/)
  assert.equal(broken.runs.length, 0)
})

test('the quota answer must say refuse === false to allow: missing, a string, or null refuses', async () => {
  for (const answerValue of [{}, { refuse: 'false' }, { refuse: 0 }, null, { reason: 'x' }]) {
    const h = await harness({ quota: () => answerValue })
    const r = await h.svc.onPrefix({ word: 'quick', text: 'x' })
    assert.equal(r.reply, 'Modes are paused: the quota could not be read.', JSON.stringify(answerValue))
    assert.equal(h.runs.length, 0)
  }
  const ok = await harness({ quota: () => ({ refuse: false }) })
  assert.deepEqual(await ok.svc.onPrefix({ word: 'quick', text: 'x' }), { handled: true })
  await settle(() => ok.sent().length === 1, 'allowed run answers')
})

test('a swipe-reply to an answer continues its session with --resume; an unknown message is not ours', async () => {
  const h = await harness()
  await h.svc.onPrefix({ word: 'quick', text: 'first', messageId: 'tg:7' })
  await settle(() => h.sent().length === 1, 'first answer')
  h.responders.push(() => answer({ result: 'second answer', total_cost_usd: 0.01 }))
  const r = await h.svc.onReply({ text: 'and in French?', replyTo: 'tg:101', messageId: 'tg:120' })
  assert.deepEqual(r, { handled: true })
  await settle(() => h.sent().length === 2, 'second answer')
  const args = h.runs[1].args
  assert.deepEqual(args.slice(-6), ['--append-system-prompt', args[args.indexOf('--append-system-prompt') + 1], '--resume', SID, '--', 'and in French?'])
  assert.equal(h.sent()[1].replyTo, 'tg:120')
  assert.equal(h.threads.get(tgMsg(102))?.sessionId, SID)
  assert.deepEqual(await h.svc.onReply({ text: 'hi', replyTo: 'tg:999', messageId: 'tg:121' }), { handled: false })
})

test('a swipe-reply is handled at once: the thread call resolves before its quota check does', async () => {
  let block: Promise<unknown> | null = null
  const h = await harness({ quota: () => block ?? { refuse: false } })
  await h.svc.onPrefix({ word: 'quick', text: 'first', messageId: 'tg:7' })
  await settle(() => h.sent().length === 1, 'first answer')

  const held = gate()
  block = held.wait
  const before = h.quotaCalls()
  const r = await h.svc.onReply({ text: 'more', replyTo: 'tg:101', messageId: 'tg:120' })
  assert.deepEqual(r, { handled: true })
  assert.equal(h.quotaCalls(), before + 1, 'the quota check has started in the background')
  assert.equal(h.runs.length, 1, 'the follow-up has not run while its quota check is pending')

  h.responders.push(() => answer({ result: 'follow-up' }))
  held.open({ refuse: false })
  await settle(() => h.sent().length === 2, 'follow-up answer after the quota check')
  assert.equal(h.sent()[1].replyTo, 'tg:120')
})

test('a swipe-reply with no text asks for the message, in the background', async () => {
  const h = await harness()
  await h.svc.onPrefix({ word: 'quick', text: 'first', messageId: 'tg:7' })
  await settle(() => h.sent().length === 1, 'first answer')
  assert.deepEqual(await h.svc.onReply({ text: '  ', replyTo: 'tg:101', messageId: 'tg:121' }), { handled: true })
  await settle(() => h.sent().length === 2, 'asked')
  assert.deepEqual(h.sent()[1], { text: 'Write the follow-up as a message.', replyTo: 'tg:121' })
  assert.equal(h.runs.length, 1)
})

test('Continue resumes a limit run with fresh limits and posts a new answer', async () => {
  const h = await harness()
  h.responders.push(() => answer({ subtype: 'error_max_turns', is_error: true, result: 'half' }))
  await h.svc.onPrefix({ word: 'read', text: 'long', messageId: 'tg:7' })
  await settle(() => h.sent().length === 1, 'limit')
  h.responders.push(() => answer({ result: 'the rest' }))
  const toast = await h.svc.onCallback({ data: 'c:aaaaaaaa', messageId: 'tg:101' })
  assert.deepEqual(toast, { toast: 'Continuing.' })
  await settle(() => h.sent().length === 2, 'continued')
  assert.ok(h.runs[1].args.includes('--resume'))
  assert.equal(h.runs[1].args.at(-1), 'Continue.')
  assert.equal(h.runs[1].timeoutMs, 300_000)
  assert.equal(h.sent()[1].replyTo, 'tg:101')
})

test('Continue answers its toast before the quota check resolves', async () => {
  let block: Promise<unknown> | null = null
  const h = await harness({ quota: () => block ?? { refuse: false } })
  h.responders.push(() => answer({ subtype: 'error_max_turns', is_error: true, result: 'half' }))
  await h.svc.onPrefix({ word: 'read', text: 'long', messageId: 'tg:7' })
  await settle(() => h.sent().length === 1, 'limit')

  const held = gate()
  block = held.wait
  const toast = await h.svc.onCallback({ data: 'c:aaaaaaaa', messageId: 'tg:101' })
  assert.deepEqual(toast, { toast: 'Continuing.' })
  assert.equal(h.runs.length, 1, 'the continuation waits for its quota check')
  h.responders.push(() => answer({ result: 'the rest' }))
  held.open({ refuse: false })
  await settle(() => h.sent().length === 2, 'continued after the quota check')
})

test('an old Continue button says it is too old', async () => {
  const h = await harness()
  assert.deepEqual(await h.svc.onCallback({ data: 'c:ffffffff', messageId: 'tg:1' }), { toast: 'That answer is too old. Ask again.' })
  assert.deepEqual(await h.svc.onCallback({ data: 'zz', messageId: 'tg:1' }), { toast: 'Unknown button.' })
})

test('Upgrade offers the folders (master first), and a pick starts a full session with the question and answer', async () => {
  const h = await harness({ folders: TRUSTED })
  await h.svc.onPrefix({ word: 'read', text: 'disk?', messageId: 'tg:7' })
  await settle(() => h.sent().length === 1, 'answer')
  const up = await h.svc.onCallback({ data: 'u:aaaaaaaa', messageId: 'tg:101' })
  assert.deepEqual(up, { toast: 'Pick a folder.' })
  await settle(() => h.sent().length === 2, 'picker')
  const picker = h.sent()[1]
  assert.deepEqual(picker.rows, [[{ text: 'master', data: 'p:aaaaaaaa:0' }], [{ text: 'other', data: 'p:aaaaaaaa:1' }]])

  const pick = await h.svc.onCallback({ data: 'p:aaaaaaaa:1', messageId: 'tg:105' })
  assert.deepEqual(pick, { toast: 'Starting.' })
  await settle(() => h.reqs.some((r) => r.op === 'spawn'), 'spawn')
  const spawn = h.reqs.find((r) => r.op === 'spawn')
  assert.equal(spawn?.payload.dir, '/home/u/Documents/projects/other')
  assert.match(String(spawn?.payload.prompt), /Question: disk\?/)
  assert.match(String(spawn?.payload.prompt), /Answer given: the answer/)
  assert.equal(spawn?.payload.messageId, 'tg:105')
  await settle(() => /Starting a full session in other/.test(String(h.sent().at(-1)?.text)), 'start note')
})

test('Upgrade asks the quota gate before it spawns: a refusal stops the spawn', async () => {
  let refuse = false
  const h = await harness({ folders: TRUSTED, quota: () => (refuse ? { refuse: true, reason: 'the quota is at its limit' } : { refuse: false }) })
  await h.svc.onPrefix({ word: 'read', text: 'disk?', messageId: 'tg:7' })
  await settle(() => h.sent().length === 1, 'answer')
  await h.svc.onCallback({ data: 'u:aaaaaaaa', messageId: 'tg:101' })
  await settle(() => h.sent().length === 2, 'picker')

  refuse = true
  const before = h.quotaCalls()
  assert.deepEqual(await h.svc.onCallback({ data: 'p:aaaaaaaa:0', messageId: 'tg:105' }), { toast: 'Starting.' })
  await settle(() => h.sent().length === 3, 'refusal note')
  assert.equal(h.quotaCalls(), before + 1, 'the quota was asked before the spawn')
  assert.equal(h.reqs.filter((r) => r.op === 'spawn').length, 0)
  assert.equal(h.sent()[2].text, 'Modes are paused: the quota is at its limit.')
})

test('a folder the router refuses is reported, not started', async () => {
  const h = await harness({ folders: [{ name: 'x', path: '/x' }], spawnOk: false })
  await h.svc.onPrefix({ word: 'read', text: 'q', messageId: 'tg:7' })
  await settle(() => h.sent().length === 1, 'answer')
  assert.deepEqual(await h.svc.onCallback({ data: 'p:aaaaaaaa:0', messageId: 'tg:9' }), { toast: 'Starting.' })
  await settle(() => /Could not start x: not trusted yet/.test(String(h.sent().at(-1)?.text)), 'refusal reported')
})

test('a pick that is too old, or a folder index out of range, is reported in the background', async () => {
  const h = await harness({ folders: TRUSTED })
  assert.deepEqual(await h.svc.onCallback({ data: 'p:ffffffff:0', messageId: 'tg:9' }), { toast: 'That choice is too old. Ask again.' })
  await h.svc.onPrefix({ word: 'read', text: 'q', messageId: 'tg:7' })
  await settle(() => h.sent().length === 1, 'answer')
  assert.deepEqual(await h.svc.onCallback({ data: 'p:aaaaaaaa:7', messageId: 'tg:9' }), { toast: 'Starting.' })
  await settle(() => h.sent().length === 2, 'out of range reported')
  assert.equal(h.sent()[1].text, 'That choice is too old. Ask again.')
  assert.equal(h.reqs.filter((r) => r.op === 'spawn').length, 0)
})

test('the semaphore: a fourth run waits with a note, and starts when a slot frees', async () => {
  const h = await harness()
  const holds = [await h.semaphore.acquire(), await h.semaphore.acquire(), await h.semaphore.acquire()]
  await h.svc.onPrefix({ word: 'quick', text: 'waits', messageId: 'tg:7' })
  assert.match(String(h.sent()[0].text), /^⏳ waiting: 3 mode runs are already going/)
  assert.equal(h.runs.length, 0, 'not started yet')
  holds[0]()
  await settle(() => h.runs.length === 1, 'started after a slot freed')
  holds.slice(1).forEach((release) => release())
})

test('waiters are capped: the 11th run is refused with a message and not queued', async () => {
  const h = await harness()
  const holds = [await h.semaphore.acquire(), await h.semaphore.acquire(), await h.semaphore.acquire()]
  for (let i = 0; i < MAX_WAITERS; i++) {
    assert.deepEqual(await h.svc.onPrefix({ word: 'quick', text: `q${i}`, messageId: 'tg:200' + i }), { handled: true })
  }
  assert.equal(h.semaphore.waiting, MAX_WAITERS)
  const eleventh = await h.svc.onPrefix({ word: 'quick', text: 'q-too-many', messageId: 'tg:300' })
  assert.equal(eleventh.reply, TOO_MANY_WAITING)
  assert.equal(TOO_MANY_WAITING, 'Too many mode runs are waiting. Try again later.')
  assert.equal(h.semaphore.waiting, MAX_WAITERS, 'the refused run is not queued')
  holds.forEach((release) => release())
  await settle(() => h.usage().length === MAX_WAITERS, 'the queued runs finish')
  assert.equal(h.runs.length, MAX_WAITERS)
})

test('a run that waited for a slot checks the quota again once it holds the permit', async () => {
  let refuse = false
  const h = await harness({ quota: () => (refuse ? { refuse: true, reason: 'the quota is at its limit' } : { refuse: false }) })
  const holds = [await h.semaphore.acquire(), await h.semaphore.acquire(), await h.semaphore.acquire()]
  await h.svc.onPrefix({ word: 'quick', text: 'waits', messageId: 'tg:7' })
  assert.equal(h.quotaCalls(), 1, 'the check before queueing')
  refuse = true
  holds[0]()
  await settle(() => h.quotaCalls() === 2, 'the check after the permit')
  await settle(() => h.sent().length === 2, 'refusal sent')
  assert.equal(h.runs.length, 0, 'the quota refused: no run')
  assert.equal(h.sent()[1].text, 'Modes are paused: the quota is at its limit.')
  holds.slice(1).forEach((release) => release())
})

test('the usage record is sent for each run', async () => {
  const h = await harness()
  await h.svc.onPrefix({ word: 'web', text: 'news', messageId: 'tg:7' })
  await settle(() => h.usage().length === 1, 'usage')
  assert.deepEqual(h.usage()[0], { mode: 'web', costUsd: 0.04, durationMs: 12_000, outcome: 'answer' })
})

test('the hook self-test: read and web are refused while it fails, and quick still runs', async () => {
  const h = await harness({ hookSafe: false })
  assert.ok(h.logs.some((l) => /self-test FAILED/.test(l)))
  assert.equal((await h.svc.onPrefix({ word: 'read', text: 'disk?' })).reply, HOOK_OFF)
  assert.equal((await h.svc.onPrefix({ word: 'web', text: 'news' })).reply, HOOK_OFF)
  assert.equal(h.runs.length, 0)
  assert.deepEqual(await h.svc.onPrefix({ word: 'quick', text: 'x', messageId: 'tg:7' }), { handled: true })
  await settle(() => h.sent().length === 1, 'quick answer')
  assert.equal(h.runs.length, 1)
})

test('the hook self-test runs the hook on the known secret read, with the read policy', async () => {
  const h = await harness()
  assert.equal(h.hookCalls.length, 1)
  assert.match(h.hookCalls[0].command, /^hook read /)
  assert.deepEqual(JSON.parse(h.hookCalls[0].stdin), {
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: '/proc/self/environ' },
  })
  assert.ok(h.logs.some((l) => /self-test passed/.test(l)))
  assert.deepEqual(readdirSync(h.hooksDir), [], 'the self-test removes its policy file')
})

test('quick and web run in the neutral folder, read in the master project', async () => {
  const h = await harness()
  const neutral = join(h.stateDir, 'neutral')
  await h.svc.onPrefix({ word: 'quick', text: 'a', messageId: 'tg:7' })
  await settle(() => h.runs.length === 1, 'quick ran')
  await h.svc.onPrefix({ word: 'web', text: 'b', messageId: 'tg:8' })
  await settle(() => h.runs.length === 2, 'web ran')
  await h.svc.onPrefix({ word: 'read', text: 'c', messageId: 'tg:9' })
  await settle(() => h.runs.length === 3, 'read ran')
  assert.equal(h.runs[0].cwd, neutral)
  assert.equal(h.runs[1].cwd, neutral)
  assert.notEqual(h.runs[0].cwd, modesCwd(HOME))
  assert.equal(h.runs[2].cwd, modesCwd(HOME))
  assert.equal(existsSync(neutral), true)
  assert.deepEqual(readdirSync(neutral), [], 'the neutral folder stays empty')
})

test('the read policy carries the roots (chat log, notes, trusted folders), and the web policy the hosts of the question', async () => {
  const h = await harness({ folders: TRUSTED })
  await h.svc.onPrefix({ word: 'check', text: 'disk?', messageId: 'tg:7' })
  await settle(() => h.sent().length === 1, 'read answer')
  const read = h.runs[0].during.policy as Record<string, unknown>
  assert.equal(read.mode, 'read')
  assert.equal(read.home, HOME)
  assert.equal(read.cwd, modesCwd(HOME))
  const roots = read.roots as string[]
  assert.ok(roots.includes(LOG_ROOT), `chat log root in ${roots}`)
  assert.ok(roots.includes(NOTES), `notes in ${roots}`)
  assert.ok(roots.includes(TRUSTED[1].path), `trusted folder in ${roots}`)

  await h.svc.onPrefix({ word: 'search', text: 'news on https://example.org/page', messageId: 'tg:8' })
  await settle(() => h.sent().length === 2, 'web answer')
  const web = h.runs[1].during.policy as Record<string, unknown>
  assert.equal(web.mode, 'web')
  assert.equal(web.cwd, join(h.stateDir, 'neutral'))
  assert.deepEqual(web.roots, [])
  assert.ok((web.webHosts as string[]).includes('example.org'))
  assert.equal(web.auditFile, join(h.stateDir, 'web-audit.log'))
  assert.match(String(web.webLog), /\.web\.log$/)
})

test('the policy and settings files exist during a run and are gone after it', async () => {
  const h = await harness()
  await h.svc.onPrefix({ word: 'web', text: 'news', messageId: 'tg:7' })
  await settle(() => h.sent().length === 1, 'web answer')
  const during = h.runs[0].during.files
  assert.equal(during.length, 2, `policy and settings during the run: ${during}`)
  assert.ok(during.some((f) => f.endsWith('.settings.json')))
  assert.deepEqual(readdirSync(h.hooksDir), [], 'nothing is left after the run')
})

test('an answer whose every line names a secret path says it was withheld, not that it had no text', async () => {
  const raw = 'I cannot list ~/.ssh for you.'
  assert.equal(dropSecretLines(raw), '', 'the fixture is dropped as a whole')
  const h = await harness()
  h.responders.push(() => answer({ result: raw }))
  await h.svc.onPrefix({ word: 'read', text: 'list ssh', messageId: 'tg:8' })
  await settle(() => h.sent().length === 1, 'answer')
  const body = String(h.sent()[0].text)
  assert.match(body, /^The answer named a secret path or file, so it was withheld\.\n\n/)
  assert.ok(!body.includes('.ssh'))
})

test('the answer text goes through dropSecretLines; the footer does not', async () => {
  const raw = 'Here is the answer.\nIt reads /home/u/.ssh/id_ed25519 for the key.'
  assert.notEqual(dropSecretLines(raw), raw, 'the fixture is a secret line the filter drops')
  const h = await harness()
  h.responders.push(() => answer({ result: raw }))
  await h.svc.onPrefix({ word: 'read', text: 'env?', messageId: 'tg:7' })
  await settle(() => h.sent().length === 1, 'answer')
  const body = String(h.sent()[0].text)
  assert.equal(body, `${dropSecretLines(raw)}\n\n· $0.04 · 12 s`)
  assert.ok(!body.includes('.ssh'))
  const entry = h.threads.get(tgMsg(101))
  assert.equal(entry?.answer, dropSecretLines(raw), 'the stored answer is the filtered one')
})

// A read run whose hook refused the given denied calls (the hook appends one `tool<TAB>folder` line per refusal to the
// policy's denied log), then answers with `body`.
function readWithDenials(h: H, lines: string[], body: Record<string, unknown>): () => RawRun {
  return () => {
    const name = readdirSync(h.hooksDir).find((f) => f.endsWith('.json') && !f.endsWith('.settings.json'))
    const policy = JSON.parse(readFileSync(join(h.hooksDir, String(name)), 'utf8')) as { deniedLog: string }
    for (const l of lines) appendFileSync(policy.deniedLog, l + '\n')
    return answer(body)
  }
}

test('read: a withheld answer says how many calls the read-mode guard refused, and each refusal is a warning by folder', async () => {
  const h = await harness()
  h.responders.push(readWithDenials(h, ['Read\t~/.ssh', 'Grep\t~/.aws', 'Bash\t-'], { result: 'I cannot list ~/.ssh for you.' }))
  await h.svc.onPrefix({ word: 'read', text: 'list ssh', messageId: 'tg:8' })
  await settle(() => h.sent().length === 1, 'answer')
  assert.equal(String(h.sent()[0].text), 'The answer named a secret path or file, so it was withheld. The read-mode guard refused 3 file reads.\n\n' + footerOf(h))
  assert.ok(h.logs.includes('warning: read-mode guard refused Read in ~/.ssh'))
  assert.ok(h.logs.includes('warning: read-mode guard refused Grep in ~/.aws'))
  assert.ok(h.logs.includes('warning: read-mode guard refused Bash'))
  assert.ok(!h.logs.some((l) => /id_rsa|\.env/.test(l)), 'no file name is logged')
})

test('read: one refusal reads in the singular; no refusals keeps the plain withheld message', async () => {
  const h = await harness()
  h.responders.push(readWithDenials(h, ['Read\t~/.ssh'], { result: 'I cannot list ~/.ssh for you.' }))
  h.responders.push(() => answer({ result: 'I cannot list ~/.ssh for you.' }))
  await h.svc.onPrefix({ word: 'read', text: 'list ssh', messageId: 'tg:8' })
  await settle(() => h.sent().length === 1, 'first answer')
  assert.match(String(h.sent()[0].text), /The read-mode guard refused 1 file read\.\n\n/)
  await h.svc.onPrefix({ word: 'read', text: 'list ssh again', messageId: 'tg:9' })
  await settle(() => h.sent().length === 2, 'second answer')
  assert.equal(String(h.sent()[1].text), 'The answer named a secret path or file, so it was withheld.\n\n' + footerOf(h))
})

test('read: refusals are logged even when the answer is not withheld', async () => {
  const h = await harness()
  h.responders.push(readWithDenials(h, ['Read\t~/.ssh'], { result: 'The disk is 40% full.' }))
  await h.svc.onPrefix({ word: 'check', text: 'disk?', messageId: 'tg:7' })
  await settle(() => h.sent().length === 1, 'answer')
  assert.equal(String(h.sent()[0].text).startsWith('The disk is 40% full.'), true, 'the answer is sent as it is')
  assert.ok(h.logs.includes('warning: read-mode guard refused Read in ~/.ssh'))
})
