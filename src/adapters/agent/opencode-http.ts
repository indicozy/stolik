// A small client for one `opencode serve` (the opencode backend runs one per session). Basic auth as `opencode:<password>`,
// 5 s per request. A failure's text never carries the password.

export const OC_TIMEOUT_MS = 5_000

// The serve a request goes to: its port on 127.0.0.1 and its password.
export type OcEndpoint = { port: number; password: string }

// The status and the parsed JSON body (null when the body is empty or not JSON).
export type OcResponse = { status: number; body: any }

// One request to the serve. Resolves with any HTTP status; rejects on a network error or a timeout, with the cause's code or
// message (the password is removed from it).
export async function ocFetch(
  rec: OcEndpoint,
  method: string,
  path: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<OcResponse> {
  const headers: Record<string, string> = { authorization: basicAuth(rec.password) }
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(OC_TIMEOUT_MS) }
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  try {
    const res = await fetchImpl(`http://127.0.0.1:${rec.port}${path}`, init)
    const text = await res.text()
    return { status: res.status, body: parseBody(text) }
  } catch (e) {
    throw new Error(redact(errorText(e), rec.password))
  }
}

function basicAuth(password: string): string {
  return 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64')
}

function parseBody(text: string): unknown {
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// The cause's code (ECONNREFUSED) when there is one, else the message.
function errorText(e: unknown): string {
  const err = e as { message?: string; cause?: { code?: string; message?: string } }
  return err.cause?.code ?? err.cause?.message ?? err.message ?? 'request failed'
}

// Replaces every copy of the password in a text.
export function redact(text: string, password: string): string {
  return password === '' ? text : text.split(password).join('[redacted]')
}
