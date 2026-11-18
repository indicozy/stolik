// Usage-watch job (plan 3.5): runs the analyzer, checks its report for one period and builds the message. The I/O comes in
// through `UsageWatchDeps`, so the flow is tested with fakes (test/usage-watch-job.test.ts).
import type { Period } from '../../brain/schedule.ts'
import { quotaAlerts, usageText, type CheckResult, type Quota } from './text.ts'

export type UsageWatchDeps = {
  // Makes sure the analyzer has finished and returns the path of its report.json.
  runAudit(): Promise<string>
  // The checker's result for one period, on that report.
  check(report: string, period: Period): Promise<CheckResult>
  // The weekly quota pacing, or null when it cannot be read.
  quota(): Promise<Quota | null>
}

// The message for one period, or null when no threshold is crossed (null means nothing is sent). A quota that cannot be
// read is ignored; a failed audit or check throws.
export async function usageMessage(deps: UsageWatchDeps, period: Period): Promise<string | null> {
  const report = await deps.runAudit()
  const result = await deps.check(report, period)
  const quota = await deps.quota().catch(() => null)
  return usageText(period.name, [...result.alerts, ...quotaAlerts(quota)])
}
