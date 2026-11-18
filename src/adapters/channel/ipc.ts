import { createConnection, type Socket } from 'node:net'
import { SOCKET_PATH } from '../../config.ts'

// Longest line accepted (in characters). Longer input closes the connection: no valid message is that large (finding 13).
export const MAX_LINE_CHARS = 1_000_000

export type LineOptions = { maxLine?: number; onDrop?: (reason: string) => void }

// Newline-delimited JSON over a socket. Lines that do not parse are dropped and reported through `onDrop`. A line over
// `maxLine` characters is dropped and the socket is closed. Each chunk is scanned from the offset where the last scan
// stopped, so a long line is not rescanned from its start on every chunk.
export class LineConn {
  readonly socket: Socket
  private buf = ''
  // Characters at the start of buf already known to hold no newline.
  private scanned = 0
  private closed = false
  private cbs: Array<(msg: any) => void> = []
  private readonly maxLine: number
  private readonly onDrop: (reason: string) => void

  constructor(socket: Socket, opts: LineOptions = {}) {
    this.socket = socket
    this.maxLine = opts.maxLine ?? MAX_LINE_CHARS
    this.onDrop = opts.onDrop ?? (() => {})
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => this.onChunk(chunk))
  }

  private onChunk(chunk: string): void {
    if (this.closed) return
    this.buf += chunk
    let start = 0
    let idx = this.buf.indexOf('\n', this.scanned)
    while (idx !== -1 && !this.closed) {
      this.handleLine(this.buf.slice(start, idx))
      start = idx + 1
      idx = this.buf.indexOf('\n', start)
    }
    this.buf = this.buf.slice(start)
    this.scanned = this.buf.length
    if (!this.closed && this.buf.length > this.maxLine) this.tooLong()
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    if (line.length > this.maxLine) return this.tooLong()
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      this.onDrop(`unparsable line (${line.length} characters)`)
      return
    }
    for (const cb of this.cbs) cb(msg)
  }

  private tooLong(): void {
    this.closed = true
    this.buf = ''
    this.scanned = 0
    this.onDrop(`line over ${this.maxLine} characters: connection closed`)
    this.socket.destroy()
  }

  send(obj: unknown): void {
    this.socket.write(JSON.stringify(obj) + '\n')
  }

  onMessage(cb: (msg: any) => void): void {
    this.cbs.push(cb)
  }
}

// Connects to SOCKET_PATH, sends one object, resolves with the first reply object, then closes.
// Resolves null on ENOENT/ECONNREFUSED/timeout/any error. Never rejects. Callers that wait for a
// decision (the PermissionRequest hook) pass a long timeout.
export function request(obj: unknown, timeoutMs: number): Promise<any | null> {
  return new Promise((resolve) => {
    let settled = false
    const socket = createConnection(SOCKET_PATH)
    const finish = (value: any | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    socket.on('error', () => finish(null))
    socket.on('close', () => finish(null))
    const conn = new LineConn(socket)
    conn.onMessage((msg) => finish(msg))
    socket.on('connect', () => conn.send(obj))
  })
}

export function oneShot(obj: unknown, timeoutMs = 1500): Promise<any | null> {
  return request(obj, timeoutMs)
}
