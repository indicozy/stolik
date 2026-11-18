// Reads the weekly quota through the quota-gate script (plan 2.8), pinned like the other heavy work. Returns null when
// the script gives no usable answer; the caller treats that as an unknown quota.
import { execFile } from 'node:child_process'
import { parseQuotaGate, type QuotaStatus } from '../brain/usage.ts'

export type PinFn = (file: string, args: string[]) => { file: string; args: string[] }

export function readQuotaGate(script: string, pin: PinFn, timeoutMs = 60_000): Promise<QuotaStatus | null> {
  const p = pin(script, ['--weekly-min=0'])
  return new Promise((resolve) => {
    execFile(p.file, p.args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      // quota-gate may exit non-zero and still print its JSON; the JSON is what counts.
      if (err && !stdout) return resolve(null)
      resolve(parseQuotaGate(String(stdout)))
    })
  })
}
