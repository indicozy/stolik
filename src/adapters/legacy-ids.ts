// Ids as the stores wrote them before MIGRATION_V6: numbers on disk (plan 23 §4.2). The migration and the loaders of
// JSON values that still hold numbers use these rules. Pure, with no imports: the e2e and Telegram formats are written
// out here, so a later edit to store-ids.ts or the e2e module cannot change what the migration does.

const LEGACY_E2E_BASE = 1_000_000_000_000_000

const NUMERIC_TEXT = /^-?\d+$/
// Telegram and e2e ids keep their strict forms (a "tg:abc" was always dropped). Any other id is "<platform>:<opaque>":
// a lowercase platform word, then letters, digits and . _ : - (Discord "dc:g<guild>:l<channel>", "dc:<channel>:<msg>").
const STRICT_ID = /^(tg:-?\d+|e2e:\d+)$/
const PLATFORM_ID = /^[a-z][a-z0-9]{0,15}:[A-Za-z0-9._:-]{1,120}$/

// True for an id the stores keep: "<platform>:<opaque>" with a safe charset and length. The platform is not checked.
export function isWellFormedId(t: string): boolean {
  if (t.startsWith('tg:') || t.startsWith('e2e:')) return STRICT_ID.test(t)
  return PLATFORM_ID.test(t)
}

// A chat id. n <= -1e15 is the e2e chat -n - 1e15; any other non-zero number is a Telegram chat. Zero is no chat.
export function legacyChatId(n: number): string | null {
  if (!Number.isSafeInteger(n) || n === 0) return null
  if (n <= -LEGACY_E2E_BASE) return `e2e:${-n - LEGACY_E2E_BASE}`
  return `tg:${n}`
}

// A message or thread id. n > 0 is Telegram; n <= -1e15 is an e2e message. Any other number (zero or a negative one
// above -1e15) is a pre-0c-1 e2e leftover, which has no id now: null, so the caller drops it.
export function legacyMsgId(n: number): string | null {
  if (!Number.isSafeInteger(n)) return null
  if (n > 0) return `tg:${n}`
  if (n <= -LEGACY_E2E_BASE) return `e2e:${-n - LEGACY_E2E_BASE}`
  return null
}

// A stored id as a loader reads it. A string already in the new form is kept (null when it is not well formed). A
// number, or numeric text (a file or a settings value), takes `legacy`. Anything else is null.
export function storedId(v: unknown, legacy: (n: number) => string | null): string | null {
  if (typeof v === 'number') return legacy(v)
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (NUMERIC_TEXT.test(t)) return legacy(Number(t))
  return isWellFormedId(t) ? t : null
}
