// NDJSON wire format between the host and an addon (the whisper worker's framing). The host writes one request per
// line on the addon's stdin: {"id":N,"op":"...","payload":{...}}. The addon answers on stdout, one line per request:
// {"id":N,"result":...} or {"id":N,"error":"..."}. Anything else on stdout is ignored (stderr is logged).
export const MAX_LINE_CHARS = 1 << 20

// Splits a byte stream into complete lines. A partial line waits for its newline; several lines in one chunk all come out.
export class LineFramer {
  private buf = ''

  // The complete, non-blank lines in the data so far. Throws when an unfinished line grows past MAX_LINE_CHARS.
  push(chunk: string): string[] {
    this.buf += chunk
    const out: string[] = []
    let i: number
    while ((i = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 1)
      if (line.trim() !== '') out.push(line)
    }
    if (this.buf.length > MAX_LINE_CHARS) throw new Error('addon wrote a line longer than 1 MB')
    return out
  }
}

export type Reply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string }

// Parses one stdout line. Null for anything that is not a reply with a numeric id.
export function parseReply(line: string): Reply | null {
  let msg: unknown
  try {
    msg = JSON.parse(line)
  } catch {
    return null
  }
  if (!msg || typeof msg !== 'object') return null
  const m = msg as Record<string, unknown>
  if (typeof m.id !== 'number' || !Number.isInteger(m.id)) return null
  if (typeof m.error === 'string') return { id: m.id, ok: false, error: m.error.slice(0, 500) }
  if ('result' in m) return { id: m.id, ok: true, result: m.result ?? null }
  return null
}

export function encodeRequest(id: number, op: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ id, op, payload }) + '\n'
}

// Addon-initiated requests (protocol 2). An addon writes {"id":N,"op":"...","payload":{...}} on stdout; the
// host answers on the addon's stdin with {"id":N,"result":...} or {"id":N,"error":"..."}. A line with an `op` is a
// request; a line with `result` or `error` is a reply to one of the host's calls.
export type AddonRequest = { kind: 'request'; id: number; op: string; payload: Record<string, unknown> }
export type AddonLine = { kind: 'reply'; reply: Reply } | AddonRequest

// Classifies one stdout line from an addon. Null for anything else (ignored by the host, logged at debug).
export function parseAddonLine(line: string): AddonLine | null {
  const reply = parseReply(line)
  if (reply) return { kind: 'reply', reply }
  let msg: unknown
  try {
    msg = JSON.parse(line)
  } catch {
    return null
  }
  if (!msg || typeof msg !== 'object') return null
  const m = msg as Record<string, unknown>
  if (typeof m.id !== 'number' || !Number.isInteger(m.id)) return null
  if (typeof m.op !== 'string' || m.op === '') return null
  const payload = m.payload && typeof m.payload === 'object' && !Array.isArray(m.payload) ? (m.payload as Record<string, unknown>) : {}
  return { kind: 'request', id: m.id, op: m.op, payload }
}

export function encodeHostReply(id: number, outcome: { ok: true; result: unknown } | { ok: false; error: string }): string {
  return JSON.stringify(outcome.ok ? { id, result: outcome.result ?? null } : { id, error: outcome.error.slice(0, 500) }) + '\n'
}

// Addon-to-addon calls (plan 3.1): an addon asks the host to call another addon it declares in `requires`. The request
// is one line on the addon's stdout: {"id":N,"request":"call","addon":"ml-worker","op":"transcribe","payload":{...},
// "timeoutMs":N}. The host answers on the addon's stdin with {"id":N,"result":...} or {"id":N,"error":"..."}. The
// `request: "call"` field tells it apart from the host requests above (which carry only `op`); check it first.
export type AddonCallRequest = { id: number; addon: string; op: string; payload: Record<string, unknown>; timeoutMs: number | null }

export function parseAddonCall(line: string): AddonCallRequest | null {
  let msg: unknown
  try {
    msg = JSON.parse(line)
  } catch {
    return null
  }
  if (!msg || typeof msg !== 'object') return null
  const m = msg as Record<string, unknown>
  if (m.request !== 'call' || typeof m.id !== 'number' || !Number.isInteger(m.id)) return null
  if (typeof m.addon !== 'string' || typeof m.op !== 'string') return null
  const payload = m.payload && typeof m.payload === 'object' && !Array.isArray(m.payload) ? (m.payload as Record<string, unknown>) : {}
  const timeoutMs = typeof m.timeoutMs === 'number' && Number.isFinite(m.timeoutMs) ? m.timeoutMs : null
  return { id: m.id, addon: m.addon, op: m.op, payload, timeoutMs }
}

export function encodeCallReply(id: number, outcome: { result: unknown } | { error: string }): string {
  return JSON.stringify({ id, ...outcome }) + '\n'
}
