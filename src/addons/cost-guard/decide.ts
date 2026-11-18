// cost-guard's decision and its texts (pure). A message to a session whose prompt cache has expired re-reads the whole
// history uncached, about 10-15x a normal turn, so it is held for the owner to choose.

// Thresholds. A session under BIG_CTX tokens is cheap to re-read; a cache younger than CACHE_TTL_MIN is still warm.
export const BIG_CTX = 100_000
export const CACHE_TTL_MIN = 60
// After "Send anyway", the session's follow-up messages go through for this long.
export const RELEASE_WINDOW_MIN = 10

const MIN = 60_000

export type Decision = { hold: false; reason: string } | { hold: true; reason: string; idleMs: number; contextTokens: number }

export type DecideInput = {
  backendSessionId: string | null
  analysis: { contextTokens: number; lastAt: number } | null
  now: number
  // When the owner last released a message of this session (epoch ms), or undefined.
  releasedAt: number | undefined
}

// Holds only when every condition holds: the session id is known, its transcript analysis is usable, the context is at least
// BIG_CTX, the last turn is at least CACHE_TTL_MIN old, and the owner did not release this session in the last
// RELEASE_WINDOW_MIN minutes.
export function decide(input: DecideInput): Decision {
  const pass = (reason: string): Decision => ({ hold: false, reason })
  if (input.backendSessionId === null) return pass('no session id')
  if (input.analysis === null) return pass('no usable transcript')
  const { contextTokens, lastAt } = input.analysis
  if (contextTokens < BIG_CTX) return pass('context is small')
  const idleMs = input.now - lastAt
  if (idleMs < CACHE_TTL_MIN * MIN) return pass('cache is still warm')
  if (input.releasedAt !== undefined && input.now - input.releasedAt < RELEASE_WINDOW_MIN * MIN) return pass('released recently')
  return { hold: true, reason: 'cache expired', idleMs, contextTokens }
}

// "2h 05m", or "9m" under an hour.
export function fmtIdle(ms: number): string {
  const totalMin = Math.floor(ms / MIN)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

// "154k" for 154 000 tokens.
export function fmtContext(tokens: number): string {
  return `${Math.floor(tokens / 1000)}k`
}

// The notice in General for a held message. The second line is added when the quota could be read.
export function holdNotice(p: {
  name: string
  idleMs: number
  contextTokens: number
  week?: { usedPct: number; pacePct: number }
}): string {
  const first = `⏸ Held: ${p.name}'s cache expired (idle ${fmtIdle(p.idleMs)}, context ${fmtContext(p.contextTokens)}). ` +
    'Sending now re-reads the whole history uncached, about 10-15x a normal turn.'
  if (!p.week) return first
  return `${first}\nWeek: ${p.week.usedPct}% used, pace ${p.week.pacePct}%.`
}

// The first prompt of a new session started from a held message. It points at the old transcript, so the agent can read
// the parts it needs.
export function newSessionPrompt(transcript: string | null, text: string): string {
  const head = transcript
    ? `Continuing from an earlier session in this folder (transcript: ${transcript}; read only the parts you need, never the whole file).`
    : 'Continuing from an earlier session in this folder.'
  return `${head}\n\nThe owner's message:\n${text}`
}
