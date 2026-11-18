// Usage-watch job with fakes (plan 3.5): the message for one period, the quota alert and the text format.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { usageMessage, type UsageWatchDeps } from '../src/addons/usage-watch/job.ts'
import { noThresholdsText, parseCheck, parseQuota, parseState, quotaAlerts, stateText, usageText, type CheckResult } from '../src/addons/usage-watch/text.ts'

const PERIOD = { name: '2026-11-16', from: '2026-11-16', days: 1 }

const MISS = "Cache misses after idle gaps: 7.2% of yesterday's usage (limit 5%). /compact or /clear with a handoff before leaving a big session; keep subagent waits under 4 min."
const HAIKU =
  'Haiku subagents: 61.0% of calls over 100k context (5x tier). Split long jobs into fresh subagents; tail logs instead of reading them.'

const quotaJson = (usedPct: number, ahead: number) => ({
  usage: { weekly: { used_pct: usedPct, pacing: { used_minus_expected_pct: ahead } } },
})

// Fakes: the analyzer gives a report path, the checker gives the given alerts, the quota gives the given reading.
function fakes(opts: { alerts?: string[]; quota?: 'none' | 'fail' | { usedPct: number; aheadPoints: number }; audit?: 'fail' | 'ok'; check?: 'fail' } = {}) {
  const calls: string[] = []
  const deps: UsageWatchDeps = {
    runAudit: async () => {
      calls.push('audit')
      if (opts.audit === 'fail') throw new Error('usage-audit did not finish')
      return '/cache/2026-11-17/report.json'
    },
    check: async (report, period) => {
      calls.push(`check ${report} ${period.from} ${period.days}`)
      if (opts.check === 'fail') throw new Error('the checker exited 1')
      return { window: '2026-11-16..2026-11-16', calls: 40, miss_share: 0, haiku_long_share: 0, haiku_calls: 0, alerts: opts.alerts ?? [] } as CheckResult
    },
    quota: async () => {
      calls.push('quota')
      if (opts.quota === 'fail') throw new Error('quota-gate died')
      if (opts.quota === 'none' || opts.quota === undefined) return null
      return opts.quota
    },
  }
  return { deps, calls }
}

test('no alerts and a quota that is not ahead: nothing to send (null)', async () => {
  const w = fakes({ alerts: [], quota: { usedPct: 40, aheadPoints: 3 } })
  assert.equal(await usageMessage(w.deps, PERIOD), null)
})

test('the audit runs first, then the checker gets the report and the period', async () => {
  const w = fakes({ alerts: [] })
  await usageMessage(w.deps, PERIOD)
  assert.deepEqual(w.calls.slice(0, 2), ['audit', 'check /cache/2026-11-17/report.json 2026-11-16 1'])
})

test('a cache-miss alert is sent with the heading and the details line', async () => {
  const w = fakes({ alerts: [MISS] })
  const text = await usageMessage(w.deps, PERIOD)
  assert.equal(text, `Usage check for 2026-11-16\n- ${MISS}\nDetails: run the usage-audit skill.`)
})

test('a Haiku alert is sent with its bullet', async () => {
  const w = fakes({ alerts: [HAIKU] })
  const text = await usageMessage(w.deps, PERIOD)
  assert.match(text!, /^Usage check for 2026-11-16\n- Haiku subagents: 61\.0% of calls over 100k context/)
})

test('both checker alerts come in one message, one bullet each, in checker order', async () => {
  const w = fakes({ alerts: [MISS, HAIKU] })
  const lines = (await usageMessage(w.deps, PERIOD))!.split('\n')
  assert.deepEqual(lines, ['Usage check for 2026-11-16', `- ${MISS}`, `- ${HAIKU}`, 'Details: run the usage-audit skill.'])
})

test('a weekly quota more than 10 points ahead of pace adds its alert', async () => {
  const w = fakes({ alerts: [], quota: { usedPct: 59, aheadPoints: 22.44 } })
  const text = await usageMessage(w.deps, PERIOD)
  assert.equal(text, 'Usage check for 2026-11-16\n- Weekly quota 59% used, 22 points ahead of pace.\nDetails: run the usage-audit skill.')
})

test('a quota exactly 10 points ahead does not alert', async () => {
  const w = fakes({ alerts: [], quota: { usedPct: 50, aheadPoints: 10 } })
  assert.equal(await usageMessage(w.deps, PERIOD), null)
})

test('a quota that is behind pace does not alert', async () => {
  const w = fakes({ alerts: [], quota: { usedPct: 20, aheadPoints: -15 } })
  assert.equal(await usageMessage(w.deps, PERIOD), null)
})

test('a quota that cannot be read is ignored: the checker alerts still go out', async () => {
  const w = fakes({ alerts: [MISS], quota: 'fail' })
  const text = await usageMessage(w.deps, PERIOD)
  assert.match(text!, /^Usage check for 2026-11-16\n- Cache misses/)
  assert.doesNotMatch(text!, /quota/)
})

test('a null quota with no alerts is nothing to send', async () => {
  const w = fakes({ alerts: [], quota: 'none' })
  assert.equal(await usageMessage(w.deps, PERIOD), null)
})

test('a failed audit or check throws, so the caller can log it', async () => {
  await assert.rejects(usageMessage(fakes({ audit: 'fail' }).deps, PERIOD), /did not finish/)
  await assert.rejects(usageMessage(fakes({ check: 'fail' }).deps, PERIOD), /checker exited 1/)
})

test('the on-demand reply when clean says so for that day', () => {
  assert.equal(noThresholdsText('2026-11-16'), 'No thresholds crossed for 2026-11-16.')
})

test('usageText is null for no alerts and never invents a heading without bullets', () => {
  assert.equal(usageText('2026-11-16', []), null)
})

test('the quota alert rounds the percent and the points', () => {
  assert.deepEqual(quotaAlerts({ usedPct: 59.4, aheadPoints: 22.6 }), ['Weekly quota 59% used, 23 points ahead of pace.'])
  assert.deepEqual(quotaAlerts(null), [])
})

test('parseQuota reads the weekly pacing and rejects a missing field', () => {
  assert.deepEqual(parseQuota(quotaJson(59, 22.44)), { usedPct: 59, aheadPoints: 22.44 })
  assert.equal(parseQuota({ usage: { weekly: { used_pct: 59 } } }), null)
  assert.equal(parseQuota(null), null)
  assert.equal(parseQuota('not json object'), null)
})

test('parseCheck accepts the checker output and rejects a bad one', () => {
  const ok = { window: '2026-11-16..2026-11-16', calls: 3, miss_share: 0, haiku_long_share: 0, haiku_calls: 0, alerts: [] }
  assert.deepEqual(parseCheck(ok), ok)
  assert.throws(() => parseCheck({ ...ok, alerts: [1] }), /no usable result/)
  assert.throws(() => parseCheck({ ...ok, calls: '3' }), /no usable result/)
  assert.throws(() => parseCheck(null), /no usable result/)
})

test('the saved state reads back and a bad file means never run', () => {
  assert.deepEqual(parseState(stateText({ lastRunAt: 1234 })), { lastRunAt: 1234 })
  assert.deepEqual(parseState('{not json'), { lastRunAt: null })
  assert.deepEqual(parseState('{}'), { lastRunAt: null })
})
