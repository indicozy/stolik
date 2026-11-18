// Digest addon entry point (plan 3.4). Answers `/digest [YYYY-MM-DD]` in General and runs the owner's schedule (daily or
// weekly, from config `digestSchedule`; default on request only). The chat log and the cost totals come from the router
// through host requests; the summary comes from the ml-worker addon. Stdout is the protocol channel; logs go to stderr.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STATE_DIR, chatLogRoot, currentTgConfig } from '../../config.ts'
import type { Period } from '../../brain/schedule.ts'
import { startAddon, type AddonPeer } from '../sdk.ts'
import { makeDigest, runDue, type DigestDeps } from './job.ts'
import { MAX_OUTPUT_TOKENS, parseDigestArg, parseState, scheduleOf, stateText, type CostTotals, type DigestLine } from './text.ts'

const cfg = currentTgConfig()
const schedule = scheduleOf(cfg.digestSchedule)
const digestDir = join(chatLogRoot(cfg), 'digest')
const stateDir = join(STATE_DIR, 'digest')
const stateFile = join(stateDir, 'state.json')
// The ml-worker call can wait for a model load on the CPU; the host caps a relayed call at five minutes.
const GENERATE_TIMEOUT_MS = 280_000

const log = (msg: string): void => {
  process.stderr.write(`digest: ${msg}\n`)
}

function loadState() {
  try {
    return parseState(readFileSync(stateFile, 'utf8'))
  } catch {
    return parseState('')
  }
}

// Atomic write (temp file, then rename).
function saveState(lastRunAt: number): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const tmp = stateFile + '.tmp'
  writeFileSync(tmp, stateText({ lastRunAt }), { mode: 0o600 })
  renameSync(tmp, stateFile)
}

function depsFor(peer: AddonPeer): DigestDeps {
  return {
    readChat: async (from, days) => {
      const r = (await peer.request('chatlog', { from, days })) as { lines?: DigestLine[] } | null
      return Array.isArray(r?.lines) ? r.lines : []
    },
    costs: async () => {
      try {
        return (await peer.request('costs', {})) as CostTotals
      } catch (e) {
        log(`costs not read: ${e instanceof Error ? e.message : String(e)}`)
        return null
      }
    },
    generate: async (prompt) => {
      const r = (await peer.call('ml-worker', 'generate', { text: prompt, maxTokens: MAX_OUTPUT_TOKENS }, GENERATE_TIMEOUT_MS)) as {
        text?: unknown
      } | null
      if (typeof r?.text !== 'string') throw new Error('ml-worker gave no text')
      return r.text
    },
    write: (name, text) => {
      mkdirSync(digestDir, { recursive: true, mode: 0o700 })
      writeFileSync(join(digestDir, `${name}.md`), text, { mode: 0o600 })
    },
    now: () => Date.now(),
  }
}

const send = (peer: AddonPeer, text: string): Promise<unknown> => peer.request('send', { text })

// `/digest` for one day: the saved file when there is one, otherwise a fresh one. Sent to General either way.
async function sendDay(peer: AddonPeer, period: Period): Promise<void> {
  const deps = depsFor(peer)
  try {
    const path = join(digestDir, `${period.name}.md`)
    const text = existsSync(path) ? readFileSync(path, 'utf8') : await makeDigest(deps, period)
    await send(peer, text)
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    log(`digest ${period.name} failed: ${reason}`)
    await send(peer, `Digest for ${period.name} failed: ${reason}`).catch(() => {})
  }
}

let running = false

// Scheduled runs: made, saved and sent to General. Only one pass at a time. The state is saved after each run (a
// failed run counts as done, as in runDue), so a crash mid-catch-up does not repeat the runs that finished.
async function scheduledPass(peer: AddonPeer): Promise<boolean> {
  if (running) return false
  running = true
  try {
    const last = loadState().lastRunAt
    const now = Date.now()
    const done = await runDue(
      { ...depsFor(peer), now: () => now },
      schedule,
      last,
      async (text) => {
        await send(peer, text)
      },
      async (period, reason) => {
        log(`scheduled digest ${period.name} failed: ${reason}`)
        await send(peer, `Digest for ${period.name} failed: ${reason}. Send /digest ${period.name} to try again.`).catch(() => {})
      },
      (runAt) => {
        try {
          saveState(runAt)
        } catch (e) {
          log(`digest state not saved: ${e instanceof Error ? e.message : String(e)}`)
        }
      },
    )
    return done.length > 0
  } finally {
    running = false
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

startAddon((peer) => ({
  command: async (payload) => {
    const arg = parseDigestArg(str(payload.text), new Date())
    if (!arg.ok) return { reply: arg.reason }
    void sendDay(peer, arg.period)
    return { handled: true }
  },
  tick: async () => {
    if (schedule === 'request') return { started: false }
    void scheduledPass(peer)
    return { started: true }
  },
}))
