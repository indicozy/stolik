import { createServer, type Server, type Socket } from 'node:net'
import { chmodSync, existsSync, statSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { SOCKET_PATH } from '../../config.ts'
import { LineConn } from './ipc.ts'
import { AlreadyRunningError, socketAnswers } from '../instance-lock.ts'
import { gateMessage, peerPidOf } from './peer.ts'

const trackedSockets = new WeakMap<Server, Set<Socket>>()
// A connection that sends nothing for this long is closed. One-shot clients (hooks, tg-notify, ctl) send at once.
const FIRST_MESSAGE_MS = 10_000

// Closes the listener and destroys every open client socket first. server.close() alone waits for
// connections to end, which can stall shutdown behind idle channel servers.
export function closeSocketServer(server: Server): Promise<void> {
  const sockets = trackedSockets.get(server)
  if (sockets) for (const s of sockets) s.destroy()
  return new Promise((resolve) => server.close(() => resolve()))
}

// Unix socket for local clients (channel servers, hooks, tg-notify, stolik-ctl). NDJSON per connection.
// Refuses to start if the socket's directory is not owned by the current user, or if another router answers on the
// socket (AlreadyRunningError; the socket file is left alone). A socket file with no listener is stale and replaced.
//
// Peer checks (finding 14): on Linux each connection's pid is read with `ss` (peer.ts). A message whose claudePid is not
// the caller or one of its parents, or whose claudePid is not a positive integer, is dropped. `ctl unlock` from inside a
// Claude session is refused. Where the peer pid cannot be read (macOS, or a failed lookup) these checks are skipped and
// the socket file's mode (0600, below) is the only guard.
//
// Messages of one connection are dispatched in order, after the peer is known. The close callback waits for them.
export function startSocketServer(
  onMessage: (conn: LineConn, msg: any) => void,
  onClose: (conn: LineConn) => void,
  socketPath: string = SOCKET_PATH,
  opts: { onDrop?: (reason: string) => void } = {},
): Promise<Server> {
  const dir = dirname(socketPath)
  const st = statSync(dir)
  if (st.uid !== process.getuid?.()) {
    throw new Error(`refusing to start: ${dir} is not owned by the current user`)
  }
  if (Buffer.byteLength(socketPath) > 107) {
    return Promise.reject(new Error(`socket path too long for a unix socket (${socketPath.length} chars): set STOLIK_SOCKET`))
  }
  return socketAnswers(socketPath).then((live) => {
    if (live) {
      throw new AlreadyRunningError(`another stolik router is answering on the socket ${socketPath}. Stop it first, then start this one.`)
    }
    if (existsSync(socketPath)) unlinkSync(socketPath)
    const drop = opts.onDrop ?? ((reason: string) => process.stderr.write(`stolik socket: dropped: ${reason}\n`))
    const sockets = new Set<Socket>()
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.on('error', () => {})
      const peer = peerPidOf(socket)
      const idle = setTimeout(() => socket.destroy(), FIRST_MESSAGE_MS)
      const conn = new LineConn(socket, { onDrop: drop })
      let chain: Promise<void> = Promise.resolve()
      conn.onMessage((msg) => {
        clearTimeout(idle)
        chain = chain
          .then(async () => {
            const gate = gateMessage(msg, await peer)
            if (!gate.ok) {
              drop(gate.reason)
              if (gate.reply) conn.send(gate.reply)
              return
            }
            onMessage(conn, msg)
          })
          .catch(() => {})
      })
      socket.on('close', () => {
        clearTimeout(idle)
        sockets.delete(socket)
        void chain.then(() => onClose(conn))
      })
    })
    trackedSockets.set(server, sockets)
    return new Promise<Server>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        // Owner-only. This is the whole guard where the peer pid cannot be read (macOS, or an ss failure): only this
        // user's processes can connect, and the peer checks above then run only where they can be made.
        try {
          chmodSync(socketPath, 0o600)
        } catch (e) {
          reject(e)
          return
        }
        resolve(server)
      })
    })
  })
}
