// The addon side of the NDJSON protocol (protocol.ts): answers the host's requests and makes its own. Stdout is the
// protocol channel, so the addon logs to stderr only.
import { encodeHostReply, encodeRequest, parseAddonLine } from '../../addons-host/protocol.ts'

export type HostRequestHandler = (op: string, payload: Record<string, unknown>) => Promise<unknown>

type Waiting = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export class AddonClient {
  private seq = 0
  private readonly waiting = new Map<number, Waiting>()
  private buf = ''
  private readonly out: { write(s: string): unknown }
  private readonly handle: HostRequestHandler

  constructor(out: { write(s: string): unknown }, handle: HostRequestHandler) {
    this.out = out
    this.handle = handle
  }

  // Feeds stdin text in. Lines are complete NDJSON records; a partial line waits for the rest.
  input(chunk: string): void {
    this.buf += chunk
    let i: number
    while ((i = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 1)
      if (line.trim() !== '') this.onLine(line)
    }
  }

  // Asks the host something (send, folders, spawn, usage, quota). Rejects on an error reply or after `timeoutMs`.
  request(op: string, payload: Record<string, unknown>, timeoutMs = 60_000): Promise<unknown> {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error(`the host did not answer ${op} in ${Math.round(timeoutMs / 1000)} s`))
      }, timeoutMs)
      this.waiting.set(id, { resolve, reject, timer })
      this.out.write(encodeRequest(id, op, payload))
    })
  }

  private onLine(line: string): void {
    const parsed = parseAddonLine(line)
    if (!parsed) return
    if (parsed.kind === 'reply') {
      const w = this.waiting.get(parsed.reply.id)
      if (!w) return
      this.waiting.delete(parsed.reply.id)
      clearTimeout(w.timer)
      if (parsed.reply.ok) w.resolve(parsed.reply.result)
      else w.reject(new Error(parsed.reply.error))
      return
    }
    // A host call (prefix, thread, callback). Its answer is written back with the same id.
    const { id, op, payload } = parsed
    // A synchronous throw in the handler becomes an error reply too; the addon keeps running.
    Promise.resolve()
      .then(() => this.handle(op, payload))
      .then(
      (result) => this.out.write(encodeHostReply(id, { ok: true, result })),
      (err: unknown) => this.out.write(encodeHostReply(id, { ok: false, error: err instanceof Error ? err.message : String(err) })),
    )
  }
}
