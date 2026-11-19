// Marker files for permission prompts waiting on the router (plan 1.2). While a prompt of a Claude session is pending,
// the router keeps an empty file named after that session's Claude pid in `pending/`, beside the router socket. The
// PostToolUse shell guard (bin/tg-posttool-hook) reads the same folder: no marker, no forwarding. Keep the two in step.
//
// The folder is derived from the socket path, not from XDG_RUNTIME_DIR (finding 17). The router passes its socket to every
// session it starts (STOLIK_SOCKET, src/adapters/tmux.ts), so the hook's environment resolves the same folder as the router.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SOCKET_PATH } from '../../config.ts'

// `pending/` beside the router socket.
export function pendingDir(socketPath: string = SOCKET_PATH): string {
  return join(dirname(socketPath), 'pending')
}

export function markerPath(pid: number, dir: string = pendingDir()): string {
  return join(dir, String(pid))
}

// Creates the marker (and its folder, mode 0700). Idempotent.
export function setPendingMarker(pid: number, dir: string = pendingDir()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(markerPath(pid, dir), '', { mode: 0o600 })
}

// Removes the marker. Missing is fine.
export function clearPendingMarker(pid: number, dir: string = pendingDir()): void {
  rmSync(markerPath(pid, dir), { force: true })
}
