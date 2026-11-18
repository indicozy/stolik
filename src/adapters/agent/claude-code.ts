// Claude Code agent backend (plan S11): implements AgentBackend over the channel socket, tmux, transcripts, the
// folder-trust record in ~/.claude.json, and the interactive-process check.
//
// What still bypasses the AgentBackend interface (kept on the socket path, see the design §3.3 "Later" items):
// - Event delivery: channel and hook messages reach the router as raw protocol messages (register, reply,
//   permission_request, hook, notify, ctl, ask), through SocketHandler. Their meaning (the hook names, the reply and
//   ask result shapes, the session registration rules) is read by the router, not by an event type. AgentEvent and
//   onEvent are declared but not emitted yet.
// - Hook payload fields (session_id, stop_hook_active, last_assistant_message, notification_type) are parsed in the
//   router.
// - The development-channels dialog answer lives in tmux.ts; the router only asks the backend to watch startup.
// - The `--resume <id>` argument is built by the router; the backend passes extra argv through unchanged.
// - Router-facing user text still says "Claude Code" in a few places (renamed in plan S12).
import { readFileSync } from 'node:fs'
import type { Server } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SessionKey } from '../../brain/sessions.ts'
import type { TranscriptMeta } from '../../brain/resume.ts'
import { hasTrustAccepted, trustedDirs } from '../../router/state.ts'
import type { AgentBackend, AgentEvent, SocketConn, SocketHandler } from '../../ports.ts'
import type { AskDecision, AskResult } from '../channel/protocol.ts'
import { LineConn } from '../channel/ipc.ts'
import { closeSocketServer, startSocketServer } from '../channel/server.ts'
import { isInteractiveClaude, pidAlive, readCmdline } from '../platform/process.ts'
import { killTmuxSession, paneTail, startTmux, tmuxNameFor, tmuxNewSessionArgs, tmuxPanePid, watchDevChannelsDialog, type StartupOutcome } from '../tmux.ts'
import { liveSessions, scanTranscripts } from '../transcripts.ts'

// ~/.claude.json, read only. Missing or unreadable gives null (no trusted folders).
function readClaudeJson(home: string): unknown {
  try {
    return JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))
  } catch {
    return null
  }
}

// A channel socket seen through the SocketConn port. One wrapper per LineConn, so identity checks still work.
class LineSocket implements SocketConn {
  readonly line: LineConn

  constructor(line: LineConn) {
    this.line = line
  }

  send(msg: object): void {
    this.line.send(msg)
  }

  end(): void {
    this.line.socket.end()
  }

  get destroyed(): boolean {
    return this.line.socket.destroyed
  }
}

export class ClaudeCodeBackend implements AgentBackend {
  private readonly home: string
  private readonly wrappers = new WeakMap<LineConn, SocketConn>()
  private readonly sessions = new Map<SessionKey, SocketConn>()
  private readonly interactiveCache = new Map<number, boolean>()
  private readonly listeners: Array<(e: AgentEvent) => void> = []
  private server: Server | null = null

  constructor(home: string = homedir()) {
    this.home = home
  }

  onEvent(fn: (e: AgentEvent) => void): void {
    this.listeners.push(fn)
  }

  async start(handler: SocketHandler): Promise<void> {
    this.server = await startSocketServer(
      (line, msg) => handler.message(this.wrap(line), msg),
      (line) => handler.close(this.wrap(line)),
    )
  }

  async stop(): Promise<void> {
    if (this.server) await closeSocketServer(this.server)
    this.server = null
  }

  // Pids with no readable cmdline count as interactive. Only successful reads are cached.
  isInteractive(pid: number | null): boolean {
    if (pid === null) return true
    const hit = this.interactiveCache.get(pid)
    if (hit !== undefined) return hit
    const argv = readCmdline(pid)
    if (!argv) return true
    const interactive = isInteractiveClaude(argv)
    this.interactiveCache.set(pid, interactive)
    return interactive
  }

  sweep(): void {
    for (const pid of [...this.interactiveCache.keys()]) {
      if (!pidAlive(pid)) this.interactiveCache.delete(pid)
    }
  }

  attachSession(key: SessionKey, conn: SocketConn): void {
    this.sessions.set(key, conn)
  }

  detachSession(conn: SocketConn): SessionKey | null {
    for (const [key, c] of this.sessions) {
      if (c === conn) {
        this.sessions.delete(key)
        return key
      }
    }
    return null
  }

  dropSession(key: SessionKey): void {
    this.sessions.delete(key)
  }

  isConnected(key: SessionKey): boolean {
    return this.sessions.has(key)
  }

  sendToSession(key: SessionKey, content: string, meta: Record<string, string>): boolean {
    const conn = this.sessions.get(key)
    if (!conn) return false
    conn.send({ t: 'inbound', content, meta })
    return true
  }

  answerPermission(key: SessionKey, requestId: string, behavior: 'allow' | 'deny'): boolean {
    const conn = this.sessions.get(key)
    if (!conn) return false
    conn.send({ t: 'permission', request_id: requestId, behavior })
    return true
  }

  respondToAsk(conn: SocketConn, decision: AskDecision | null): void {
    if (conn.destroyed) return
    const res: AskResult = decision ? { t: 'ask_result', decision } : { t: 'ask_result' }
    conn.send(res)
    conn.end()
  }

  startSession(project: string, dir: string, extraArgs: readonly string[] = [], spawnToken?: string): Promise<string> {
    return startTmux(project, dir, extraArgs, undefined, spawnToken ?? null)
  }

  // The command line startSession runs (forensics): tmux new-session with the launcher and its arguments.
  startCommand(project: string, dir: string, extraArgs: readonly string[] = []): string[] {
    return ['tmux', ...tmuxNewSessionArgs(tmuxNameFor(project), dir, extraArgs)]
  }

  async killSession(name: string): Promise<void> {
    await killTmuxSession(name)
  }

  panePid(name: string): Promise<number | null> {
    return tmuxPanePid(name)
  }

  watchStartup(name: string, timeoutMs: number, isRegistered: () => boolean, onMiss?: (pane: string[]) => void): Promise<StartupOutcome> {
    return watchDevChannelsDialog(name, timeoutMs, isRegistered, { onMiss })
  }

  paneTail(name: string): Promise<string[]> {
    return paneTail(name)
  }

  liveSessionIds(): Map<string, number> {
    return liveSessions()
  }

  listTranscripts(): Promise<TranscriptMeta[]> {
    return scanTranscripts()
  }

  isTrusted(realFolder: string): boolean {
    return hasTrustAccepted(readClaudeJson(this.home), realFolder)
  }

  trustedFolders(): string[] {
    return trustedDirs(readClaudeJson(this.home))
  }

  private wrap(line: LineConn): SocketConn {
    let sc = this.wrappers.get(line)
    if (!sc) {
      sc = new LineSocket(line)
      this.wrappers.set(line, sc)
    }
    return sc
  }
}
