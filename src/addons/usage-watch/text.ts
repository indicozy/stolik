// usage-watch, pure parts (plan 3.5): the checker's result, the quota reading, the alert text and the saved state.
// No I/O here; main.ts and job.ts do the I/O. Only percentages and counts are ever written to a message.

// The checker's JSON (check.py). `alerts` are finished sentences, each with percentages.
export type CheckResult = {
  window: string
  calls: number
  miss_share: number
  haiku_long_share: number
  haiku_calls: number
  alerts: string[]
}

// The weekly quota from quota-gate: percent used, and how many points it is ahead of the linear pace (above 0 is ahead).
export type Quota = { usedPct: number; aheadPoints: number }

// The quota alert fires only when the week runs more than this many points ahead of pace.
export const QUOTA_AHEAD_LIMIT = 10

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

// Validates the checker's stdout. Throws when a field is missing or of the wrong type.
export function parseCheck(raw: unknown): CheckResult {
  const r = (raw ?? {}) as Record<string, unknown>
  if (
    typeof r.window !== 'string' ||
    !isNum(r.calls) ||
    !isNum(r.miss_share) ||
    !isNum(r.haiku_long_share) ||
    !isNum(r.haiku_calls) ||
    !Array.isArray(r.alerts) ||
    !r.alerts.every((a) => typeof a === 'string')
  ) {
    throw new Error('the checker gave no usable result')
  }
  return {
    window: r.window,
    calls: r.calls,
    miss_share: r.miss_share,
    haiku_long_share: r.haiku_long_share,
    haiku_calls: r.haiku_calls,
    alerts: r.alerts as string[],
  }
}

// The weekly pacing from quota-gate's JSON, or null when any field is missing (the alert is then skipped).
export function parseQuota(raw: unknown): Quota | null {
  const weekly = (raw as { usage?: { weekly?: { used_pct?: unknown; pacing?: { used_minus_expected_pct?: unknown } } } } | null)
    ?.usage?.weekly
  const used = weekly?.used_pct
  const ahead = weekly?.pacing?.used_minus_expected_pct
  if (!isNum(used) || !isNum(ahead)) return null
  return { usedPct: used, aheadPoints: ahead }
}

// The quota alert, as a list (empty when the week is not far enough ahead of pace, or no quota was read).
export function quotaAlerts(q: Quota | null): string[] {
  if (q === null || q.aheadPoints <= QUOTA_AHEAD_LIMIT) return []
  return [`Weekly quota ${Math.round(q.usedPct)}% used, ${Math.round(q.aheadPoints)} points ahead of pace.`]
}

// The message for one day: a heading, one bullet per alert, and where to look. Null when there is nothing to say.
export function usageText(day: string, alerts: readonly string[]): string | null {
  if (alerts.length === 0) return null
  return [`Usage check for ${day}`, ...alerts.map((a) => `- ${a}`), 'Details: run the usage-audit skill.'].join('\n')
}

// The on-demand reply when no threshold is crossed.
export const noThresholdsText = (day: string): string => `No thresholds crossed for ${day}.`

// Saved state of the schedule: the run time of the last scheduled run done (epoch ms), or null.
export type UsageWatchState = { lastRunAt: number | null }

export function parseState(text: string): UsageWatchState {
  try {
    const raw = JSON.parse(text) as { lastRunAt?: unknown }
    if (isNum(raw.lastRunAt)) return { lastRunAt: raw.lastRunAt }
  } catch {
    // A missing or bad file reads as never run.
  }
  return { lastRunAt: null }
}

export function stateText(state: UsageWatchState): string {
  return JSON.stringify({ lastRunAt: state.lastRunAt })
}
