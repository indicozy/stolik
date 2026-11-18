// Usage-watch addon entry point (plan 3.5). Once a day, from 04:00 local, it runs the usage analyzer (usage-audit skill),
// checks the day before and sends one message to General only when a threshold is crossed. `/usagecheck` runs the same
// check for yesterday and always answers. Stdout is the protocol channel: children never write to it, and logs go to stderr.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STATE_DIR } from '../../config.ts'
import { addDays, dayPeriod, dueRuns, localDayOf, type Period } from '../../brain/schedule.ts'
import { startAddon, type AddonPeer } from '../sdk.ts'
import { usageMessage, type UsageWatchDeps } from './job.ts'
import { noThresholdsText, parseCheck, parseQuota, parseState, stateText, type CheckResult, type Quota } from './text.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOME = homedir()
const AUDIT_SCRIPT = join(HOME, '.claude', 'skills', 'usage-audit', 'scripts', 'run.sh')
const QUOTA_SCRIPT = join(HOME, '.claude', 'skills', 'quota-gate', 'scripts', 'quota-gate')
const AUDIT_CACHE = join(HOME, '.cache', 'usage-audit')
const LOCAL_BIN = join(HOME, '.local', 'bin')
// run.sh polls for up to 4 minutes per call. A call that runs longer than this is killed.
const AUDIT_CALL_MS = 6 * 60_000
// The analyzer needs about 5 minutes. After the first call, run.sh --wait is repeated at most this many times.
const MAX_WAITS = 6
const CHECK_MS = 5 * 60_000
const QUOTA_MS = 60_000
const stateDir = join(STATE_DIR, 'usage-watch')
const stateFile = join(stateDir, 'state.json')

const log = (msg: string): void => {
  process.stderr.write(`usage-watch: ${msg}\n`)
}
const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// run.sh calls `ai-resources`, which lives in ~/.local/bin.
const childEnv = (): NodeJS.ProcessEnv => ({ ...process.env, PATH: `${LOCAL_BIN}:${process.env.PATH ?? ''}` })

// Runs the analyzer script with its stdout discarded (its summary is never forwarded) and resolves with the exit code.
// Resolves on 'exit', not 'close': the analyzer keeps running in the background after run.sh returns.
function runDiscard(cmd: string, args: string[], timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: childEnv(), stdio: 'ignore' })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${cmd} ran longer than ${Math.round(timeoutMs / 1000)} s`))
    }, timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

// Runs a command and collects its stdout. Resolves with the exit code and the text.
function runCapture(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: childEnv(), stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      out += d
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${cmd} ran longer than ${Math.round(timeoutMs / 1000)} s`))
    }, timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: out })
    })
  })
}

// Makes sure today's analyzer has finished and returns its report path. Exit 0 is done, 3 is still running (wait again),
// 1 is a failure. The day is read before the first call, because run.sh writes to that day's folder.
async function runAudit(): Promise<string> {
  const dir = join(AUDIT_CACHE, localDayOf(new Date()))
  let code = await runDiscard(AUDIT_SCRIPT, [], AUDIT_CALL_MS)
  for (let waits = 0; code === 3 && waits < MAX_WAITS; waits++) {
    code = await runDiscard(AUDIT_SCRIPT, ['--wait'], AUDIT_CALL_MS)
  }
  if (code !== 0) throw new Error(`usage-audit did not finish (exit ${code ?? 'none'}); its log is in ${join(dir, 'an.log')}`)
  const report = join(dir, 'report.json')
  if (!existsSync(report)) throw new Error('usage-audit wrote no report.json')
  return report
}

// The checker (check.py, next to this file) on one period. Its stdout is the JSON result.
async function check(report: string, period: Period): Promise<CheckResult> {
  const args = ['-I', join(HERE, 'check.py'), '--report', report, '--from', period.from, '--days', String(period.days)]
  const r = await runCapture('python3', args, CHECK_MS)
  if (r.code !== 0) throw new Error(`the checker exited ${r.code ?? 'none'}`)
  return parseCheck(JSON.parse(r.stdout))
}

// The weekly quota pacing. Null on any failure (the quota alert is then skipped). quota-gate exits non-zero when it refuses,
// so its exit code is not checked; only its JSON is read.
async function quota(): Promise<Quota | null> {
  try {
    const r = await runCapture(QUOTA_SCRIPT, ['--weekly-min=0'], QUOTA_MS)
    return parseQuota(JSON.parse(r.stdout))
  } catch (e) {
    log(`quota not read: ${reason(e)}`)
    return null
  }
}

// The deps of one pass. The analyzer is waited for once per pass, however many catch-up runs the pass makes.
function depsForPass(): UsageWatchDeps {
  let audit: Promise<string> | null = null
  return {
    runAudit: () => (audit ??= runAudit()),
    check,
    quota,
  }
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

const send = (peer: AddonPeer, text: string): Promise<unknown> => peer.request('send', { text })

// One pass at a time, shared by the schedule and the command.
let busy = false

// Scheduled runs due now. Each run is checked and sent only when a threshold is crossed. A failed run is logged to stderr
// only (no message) and counts as done. The state is saved after each run. The analyzer is started only when a run is due.
async function scheduledPass(peer: AddonPeer): Promise<void> {
  if (busy) return
  const runs = dueRuns('daily', loadState().lastRunAt, Date.now())
  if (runs.length === 0) return
  busy = true
  try {
    const deps = depsForPass()
    for (const run of runs) {
      try {
        const text = await usageMessage(deps, run.period)
        if (text !== null) await send(peer, text)
      } catch (e) {
        log(`scheduled check ${run.period.name} failed: ${reason(e)}`)
      }
      try {
        saveState(run.runAt)
      } catch (e) {
        log(`state not saved: ${reason(e)}`)
      }
    }
  } finally {
    busy = false
  }
}

// `/usagecheck`: the same check for yesterday. It always sends an answer: the alerts, or "No thresholds crossed". A failure
// is reported without the child's output (the log has the details).
async function onDemand(peer: AddonPeer): Promise<void> {
  busy = true
  const period = dayPeriod(addDays(localDayOf(new Date()), -1))
  try {
    const text = (await usageMessage(depsForPass(), period)) ?? noThresholdsText(period.name)
    await send(peer, text)
  } catch (e) {
    log(`check ${period.name} failed: ${reason(e)}`)
    await send(peer, `Usage check for ${period.name} failed. See the usage-watch log.`).catch(() => {})
  } finally {
    busy = false
  }
}

startAddon((peer) => ({
  command: async () => {
    if (busy) return { reply: 'A usage check is already running. Try again in a few minutes.' }
    void onDemand(peer)
    return { handled: true }
  },
  tick: async () => {
    void scheduledPass(peer)
    return { started: true }
  },
}))
