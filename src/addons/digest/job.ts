// Digest job (plan 3.4): reads the period's chat lines, asks the local model for the summary, adds the cost line and
// returns the file text. The I/O comes in through `DigestDeps`, so the flow is tested with fakes (test/digest-job.test.ts).
import { dueRuns, type Period, type Run, type Schedule } from '../../brain/schedule.ts'
import { buildPrompt, buildTranscript, costLine, digestFile, MAX_TRANSCRIPT_CHARS, type CostTotals, type DigestLine } from './text.ts'

export type DigestDeps = {
  // Chat-log lines of `days` local days from `from`, oldest first (router `chatlog` request).
  readChat(from: string, days: number): Promise<DigestLine[]>
  // Mode-run cost totals (router `costs` request), or null when they cannot be read.
  costs(): Promise<CostTotals | null>
  // The local model's answer to one prompt (ml-worker `generate`).
  generate(prompt: string): Promise<string>
  // Writes the digest file for a period (`<logRoot>/digest/<name>.md`).
  write(name: string, text: string): void
  now(): number
}

// Makes the digest of one period and writes its file. Returns the file text. Throws when the model gives nothing.
export async function makeDigest(deps: DigestDeps, period: Period): Promise<string> {
  const lines = await deps.readChat(period.from, period.days)
  const multiDay = period.days > 1
  const transcript = buildTranscript(lines, multiDay, MAX_TRANSCRIPT_CHARS)
  let body: string
  if (transcript.included === 0) {
    body = 'No messages in this period.'
  } else {
    const answer = await deps.generate(buildPrompt(period, transcript))
    if (answer.trim() === '') throw new Error('the model gave an empty answer')
    body = answer
  }
  const cost = costLine(await deps.costs().catch(() => null))
  const text = digestFile(period, body, cost)
  deps.write(period.name, text)
  return text
}

// Scheduled runs due now (dueRuns), each made and then handed to `deliver`. A failed run is reported through `fail` and
// still counts as done (so a broken model is not retried every tick). `onRunDone` is called with the run time after each
// run (after its deliver or fail), so the caller can save its state per run. Returns the run times that were done.
export async function runDue(
  deps: DigestDeps,
  schedule: Schedule,
  lastRunAt: number | null,
  deliver: (text: string) => Promise<void>,
  fail: (period: Period, reason: string) => Promise<void>,
  onRunDone?: (runAt: number) => void,
): Promise<number[]> {
  const done: number[] = []
  const runs: Run[] = dueRuns(schedule, lastRunAt, deps.now())
  for (const run of runs) {
    try {
      await deliver(await makeDigest(deps, run.period))
    } catch (e) {
      await fail(run.period, e instanceof Error ? e.message : String(e))
    }
    done.push(run.runAt)
    onRunDone?.(run.runAt)
  }
  return done
}
