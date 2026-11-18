// Declared-access filter: the only place a payload leaves the host for an addon (plan 2.9). Keys the manifest does
// not declare are removed; keys no one has listed in KEY_ACCESS are removed too.
import { KEY_ACCESS, hasAccess, type Manifest } from './manifest.ts'

export function filterPayload(
  payload: Record<string, unknown>,
  manifest: Pick<Manifest, 'access'>,
): { payload: Record<string, unknown>; dropped: string[] } {
  const out: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const [key, value] of Object.entries(payload)) {
    if (!Object.prototype.hasOwnProperty.call(KEY_ACCESS, key)) {
      dropped.push(key)
      continue
    }
    const field = KEY_ACCESS[key]
    if (field === null || hasAccess(manifest, field)) out[key] = value
    else dropped.push(key)
  }
  return { payload: out, dropped }
}
