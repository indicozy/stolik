// Addon side of the NDJSON protocol (src/addons-host/protocol.ts), for addons that answer the host and also call other
// addons through it (plan 3.1). Pure apart from the write function it is given; main.ts of each addon wires stdin and
// stdout with startAddon. Logs go to stderr only.
import { createInterface } from 'node:readline'
import { encodeCallReply, encodeRequest } from '../addons-host/protocol.ts'

export type Handler = (payload: Record<string, unknown>) => Promise<unknown>

export const RELAY_CALL_TIMEOUT_MS = 120_000

type Waiting = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export class AddonPeer {
  private seq = 0
  private readonly waiting = new Map<number, Waiting>()
  private readonly write: (line: string) => void
  private readonly handlers: Record<string, Handler>

  constructor(write: (line: string) => void, handlers: Record<string, Handler>) {
    this.write = write
    this.handlers = handlers
  }

  // One line from the host. A line with an `op` is a request to serve; any other line with an id answers a call of ours.
  receive(line: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object' || typeof msg.id !== 'number') return
    if (typeof msg.op === 'string') {
      void this.serve(msg.id, msg.op, (msg.payload as Record<string, unknown>) ?? {})
      return
    }
    const w = this.waiting.get(msg.id)
    if (!w) return
    this.waiting.delete(msg.id)
    clearTimeout(w.timer)
    if (typeof msg.error === 'string') w.reject(new Error(msg.error))
    else w.resolve(msg.result ?? null)
  }

  // Calls another addon through the host. The host refuses unless that addon is in this addon's `requires`.
  call(addon: string, op: string, payload: Record<string, unknown>, timeoutMs = RELAY_CALL_TIMEOUT_MS): Promise<unknown> {
    const id = ++this.seq
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error(`${addon} did not answer ${op} in time`))
      }, timeoutMs + 5_000)
      this.waiting.set(id, { resolve, reject, timer })
      this.write(JSON.stringify({ id, request: 'call', addon, op, payload, timeoutMs }) + '\n')
    })
  }

  // Asks the host for something (protocol 2 requests: send, chatlog, costs). The host answers on stdin with the same id.
  request(op: string, payload: Record<string, unknown>, timeoutMs = 60_000): Promise<unknown> {
    const id = ++this.seq
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error(`the host did not answer ${op} in ${Math.round(timeoutMs / 1000)} s`))
      }, timeoutMs)
      this.waiting.set(id, { resolve, reject, timer })
      this.write(encodeRequest(id, op, payload))
    })
  }

  private async serve(id: number, op: string, payload: Record<string, unknown>): Promise<void> {
    const handler = this.handlers[op]
    if (!handler) {
      this.write(encodeCallReply(id, { error: `this addon does not handle ${op}` }))
      return
    }
    try {
      this.write(encodeCallReply(id, { result: await handler(payload) }))
    } catch (e) {
      this.write(encodeCallReply(id, { error: e instanceof Error ? e.message : String(e) }))
    }
  }
}

// Starts an addon on this process's stdin and stdout. `makeHandlers` gets the peer, so handlers can call other addons.
// The handler table is filled in after the peer exists, and the peer reads it when a request comes in.
// When stdin ends the router is gone (it closed the pipe, or died), so the addon exits with 0 and never outlives it.
export function startAddon(makeHandlers: (peer: AddonPeer) => Record<string, Handler>): AddonPeer {
  const table: Record<string, Handler> = {}
  const peer = new AddonPeer((line) => process.stdout.write(line), table)
  Object.assign(table, makeHandlers(peer))
  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => peer.receive(line))
  lines.on('close', () => process.exit(0))
  return peer
}
