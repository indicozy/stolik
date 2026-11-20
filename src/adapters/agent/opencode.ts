// opencode agent backend (opencode backend, Task 5): one `opencode serve` per session, in its own tmux session (`oc-<project>`).
// Window 0 runs the server. Its stolik MCP child (the channel script in opencode mode) registers the session with the router,
// with the spawn token this backend gives it. Once the server answers /health, the backend creates the opencode session over
// HTTP, loads the stolik skill as its instructions and opens the TUI in a second tmux window. The owner's chat messages go in
// as prompts. Trust, transcripts and permissions stay with the Claude backend, so this one has none of them.
// Records (token, tmux name, port, password, opencode session id) are kept in <stateDir>/opencode-servers.json (0600), so a
// router restart can still route to a running server. The password is never in logs, error reasons or the start command.
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPO_DIR } from '../../config.ts'
import type { SessionKey } from '../../brain/sessions.ts'
import type { TranscriptMeta } from '../../brain/resume.ts'
import type { AgentBackend, AgentEvent, SocketConn, SocketHandler } from '../../ports.ts'
import { errMsg, warn } from '../../router/log.ts'
import { pidAlive } from '../platform/process.ts'
import { exactTarget, killTmuxSession, paneTail as tmuxPaneTail, paneTailLines, runTmux, startTmux, tmuxPanePid, type ServerLauncher, type StartupOutcome, type TmuxRun } from '../tmux.ts'
import { ocFetch, redact, type OcEndpoint } from './opencode-http.ts'

// The file of the running servers, in the state folder.
export const SERVERS_FILE = 'opencode-servers.json'
// /health is polled this often until the server answers, for at most this long.
const HEALTH_POLL_MS = 500
const HEALTH_TIMEOUT_MS = 30_000
// A watched startup looks at the pane this often.
const WATCH_POLL_MS = 500
// The stolik skill: Markdown with frontmatter; the body goes to the session as its instructions.
const SKILL_PATH = join(REPO_DIR, 'opencode', 'skills', 'stolik', 'SKILL.md')
// Put in front of every chat message: says where the answer goes.
export const OC_HEADER = "[stolik] Message from the owner's chat. Answer with the stolik reply tool.\n\n"

// One opencode server (one session). `sessionId` is null until the session is created.
export type OcServer = {
  token: string
  tmuxName: string
  port: number
  password: string
  sessionId: string | null
  dir: string
  agent: 'build' | 'plan'
}

export type OpencodeBackendOptions = {
  // The state folder (SERVERS_FILE lives here).
  stateDir: string
  // The model of new sessions, as provider/model, or null for opencode's own default.
  model: string | null
  // The router socket the session's channel reports to.
  socketPath: string
  // The built channel script (dist/channel.js), run by the serve as its stolik MCP server.
  channelScript: string
  opencodeBin?: string
  tmux?: TmuxRun
  fetchImpl?: typeof fetch
  // How the tmux server is started (default: the same launcher as the Claude sessions). Tests pass a plain one.
  launcher?: ServerLauncher
  // A chat message could not be delivered to a session: the router tells the owner.
  onDeliveryError: (key: SessionKey, reason: string) => void
  now?: () => number
}

// The instructions body of a SKILL.md: the text after its frontmatter block.
export function skillBody(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text)
  return (m ? text.slice(m[0].length) : text).trim()
}

// The agent a start runs: plan for `--agent plan`, else build.
export function agentOfArgs(args: readonly string[]): 'build' | 'plan' {
  const i = args.indexOf('--agent')
  return i >= 0 && args[i + 1] === 'plan' ? 'plan' : 'build'
}

// `provider/model` as the API wants it: the provider is the part before the first slash.
export function splitModel(model: string | null): { providerID: string; id: string } | null {
  if (model === null) return null
  const i = model.indexOf('/')
  return i < 0 ? null : { providerID: model.slice(0, i), id: model.slice(i + 1) }
}

// The files a message carries (its image or file), as opencode file parts.
export function attachments(meta: Record<string, string>): Array<{ uri: string }> {
  return [meta.image_path, meta.file_path].filter((p): p is string => typeof p === 'string' && p !== '').map((p) => ({ uri: pathToFileURL(p).href }))
}

function isServer(v: unknown): v is OcServer {
  const r = v as Partial<OcServer> | null
  return (
    typeof r === 'object' &&
    r !== null &&
    typeof r.token === 'string' &&
    typeof r.tmuxName === 'string' &&
    typeof r.port === 'number' &&
    typeof r.password === 'string' &&
    (r.sessionId === null || typeof r.sessionId === 'string') &&
    typeof r.dir === 'string' &&
    (r.agent === 'build' || r.agent === 'plan')
  )
}

// The saved servers. A missing file is none; a file that does not parse is reported without its text (it holds passwords).
function loadServers(file: string): OcServer[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  try {
    const v: unknown = JSON.parse(text)
    return Array.isArray(v) ? v.filter(isServer) : []
  } catch {
    warn('the opencode servers file does not parse: its sessions are not routed', 'opencode')
    return []
  }
}

// A free port on 127.0.0.1 (listen on 0, then close). The serve takes it a moment later.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

// A timer that does not keep the process alive on its own (the router has its own handles).
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })
}

export class OpencodeBackend implements AgentBackend {
  private readonly stateDir: string
  private readonly file: string
  private readonly model: string | null
  private readonly socketPath: string
  private readonly channelScript: string
  private readonly bin: string
  private readonly tmux: TmuxRun
  private readonly fetchImpl: typeof fetch
  private readonly launcher: ServerLauncher | undefined
  private readonly onDeliveryError: (key: SessionKey, reason: string) => void
  private readonly now: () => number
  private servers: OcServer[]
  // Session key -> its server, from bindToken (the spawn token the session registered with).
  private readonly bindings = new Map<SessionKey, OcServer>()
  // Session key -> the socket its channel registered on (isConnected).
  private readonly sessions = new Map<SessionKey, SocketConn>()

  constructor(opts: OpencodeBackendOptions) {
    this.stateDir = opts.stateDir
    this.file = join(opts.stateDir, SERVERS_FILE)
    this.model = opts.model
    this.socketPath = opts.socketPath
    this.channelScript = opts.channelScript
    this.bin = opts.opencodeBin ?? 'opencode'
    this.tmux = opts.tmux ?? runTmux
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.launcher = opts.launcher
    this.onDeliveryError = opts.onDeliveryError
    this.now = opts.now ?? Date.now
    this.servers = loadServers(this.file)
  }

  // The opencode backend has no socket of its own: its channels connect to the router socket.
  async start(_handler: SocketHandler): Promise<void> {}

  async stop(): Promise<void> {}

  onEvent(_fn: (e: AgentEvent) => void): void {}

  // Print-mode claude is the Claude backend's concern. A pid here is the opencode process, so a live one is interactive.
  isInteractive(pid: number | null): boolean {
    return pid === null || pidAlive(pid)
  }

  sweep(): void {}

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

  bindToken(key: SessionKey, spawnToken: string): void {
    const rec = this.servers.find((r) => r.token === spawnToken)
    if (rec) this.bindings.set(key, rec)
  }

  isConnected(key: SessionKey): boolean {
    return this.sessions.has(key)
  }

  // Posts the message as a prompt. True when the prompt was sent (or is being sent); a refused or failed post is reported
  // through onDeliveryError, once.
  sendToSession(key: SessionKey, content: string, meta: Record<string, string>): boolean {
    const rec = this.bindings.get(key)
    if (!rec || rec.sessionId === null) return false
    const files = attachments(meta)
    const body = { text: OC_HEADER + content, delivery: 'queue', ...(files.length > 0 ? { files } : {}) }
    const path = `/api/session/${encodeURIComponent(rec.sessionId)}/prompt`
    ocFetch(rec, 'POST', path, body, this.fetchImpl).then(
      (res) => {
        if (res.status < 200 || res.status >= 300) this.fail(key, `HTTP ${res.status}`)
      },
      (e: unknown) => this.fail(key, errMsg(e)),
    )
    return true
  }

  private fail(key: SessionKey, reason: string): void {
    try {
      this.onDeliveryError(key, reason)
    } catch {
      // The router's report failing must not fail the backend.
    }
  }

  // Starts the serve in a new tmux session and returns its name. The session is created and the TUI opened in the background
  // (see boot); the session registers through its stolik channel when the server runs it.
  async startSession(project: string, dir: string, extraArgs: readonly string[] = [], spawnToken?: string): Promise<string> {
    const port = await freePort()
    const password = randomBytes(24).toString('base64url')
    const token = spawnToken ?? randomBytes(16).toString('hex')
    const config = { mcp: { stolik: { type: 'local', command: [process.execPath, this.channelScript] } } }
    let name: string
    try {
      name = await startTmux(project, dir, [], this.tmux, token, this.launcher, {
        prefix: 'oc-',
        socket: this.socketPath,
        command: [this.bin, 'serve', '--hostname', '127.0.0.1', '--port', String(port)],
        env: ['STOLIK_AGENT=opencode', `OPENCODE_PASSWORD=${password}`, `OPENCODE_CONFIG_CONTENT=${JSON.stringify(config)}`],
      })
    } catch (e) {
      throw new Error(redact(errMsg(e), password))
    }
    const rec: OcServer = { token, tmuxName: name, port, password, sessionId: null, dir, agent: agentOfArgs(extraArgs) }
    this.servers.push(rec)
    this.save()
    void this.boot(rec, project)
    return name
  }

  // Waits for the server, creates its session, loads the skill and opens the TUI. A failure is logged; the session then never
  // registers, and the router's spawn timeout reports it.
  private async boot(rec: OcServer, project: string): Promise<void> {
    try {
      if (!(await this.waitHealthy(rec))) return
      const body: Record<string, unknown> = { title: project, agent: rec.agent, location: { directory: rec.dir } }
      const model = splitModel(this.model)
      if (model) body.model = model
      const created = await ocFetch(rec, 'POST', '/api/session', body, this.fetchImpl)
      const id: unknown = created.body?.data?.id
      if (created.status < 200 || created.status >= 300 || typeof id !== 'string') throw new Error(`session create: HTTP ${created.status}`)
      rec.sessionId = id
      this.save()
      const skill = skillBody(readFileSync(SKILL_PATH, 'utf8'))
      const put = await ocFetch(rec, 'PUT', `/api/experimental/session/${encodeURIComponent(id)}/instructions/entries/stolik`, { value: skill }, this.fetchImpl)
      if (put.status < 200 || put.status >= 300) throw new Error(`skill instructions: HTTP ${put.status}`)
      if (!this.servers.includes(rec)) return
      await this.openTui(rec)
    } catch (e) {
      warn(`opencode session ${rec.tmuxName} did not start: ${redact(errMsg(e), rec.password)}`, 'opencode')
    }
  }

  // True once /health answers. False when the server was stopped meanwhile. Throws after HEALTH_TIMEOUT_MS.
  private async waitHealthy(rec: OcServer): Promise<boolean> {
    const deadline = this.now() + HEALTH_TIMEOUT_MS
    for (;;) {
      if (!this.servers.includes(rec)) return false
      try {
        if ((await ocFetch(rec, 'GET', '/health', undefined, this.fetchImpl)).status === 200) return true
      } catch {
        // Not up yet: the next poll tries again.
      }
      if (this.now() >= deadline) throw new Error('the server did not answer /health in time')
      await sleep(HEALTH_POLL_MS)
    }
  }

  // The TUI, attached to the server and the session, in a second window of the same tmux session.
  private async openTui(rec: OcServer): Promise<void> {
    const r = await this.tmux('tmux', [
      'new-window',
      '-t',
      exactTarget(rec.tmuxName),
      '-e',
      `OPENCODE_PASSWORD=${rec.password}`,
      this.bin,
      '--server',
      `http://127.0.0.1:${rec.port}`,
      '--session',
      rec.sessionId ?? '',
      rec.dir,
    ])
    if (r.code !== 0) throw new Error(`tmux new-window failed: ${redact(r.stderr.trim() || String(r.code), rec.password)}`)
  }

  // Stops the session's server: interrupt its turn (errors ignored), kill its tmux session, forget its record.
  async killSession(name: string): Promise<void> {
    const rec = this.servers.find((r) => r.tmuxName === name)
    if (rec?.sessionId) {
      await ocFetch(rec, 'POST', `/api/session/${encodeURIComponent(rec.sessionId)}/interrupt`, undefined, this.fetchImpl).catch(() => {})
    }
    await killTmuxSession(name, this.tmux)
    if (rec) this.forget(rec)
  }

  private forget(rec: OcServer): void {
    this.servers = this.servers.filter((r) => r !== rec)
    for (const [key, bound] of this.bindings) if (bound === rec) this.bindings.delete(key)
    this.save()
  }

  panePid(name: string): Promise<number | null> {
    return tmuxPanePid(name, this.tmux)
  }

  async paneTail(name: string): Promise<string[]> {
    return this.redactPane(name, await tmuxPaneTail(name, this.tmux))
  }

  // Polls until the router sees the session register (done), the tmux session is gone (gone), or the time is up (timeout).
  // The dev-channels dialog of Claude Code does not exist here, so no key is pressed.
  async watchStartup(name: string, timeoutMs: number, isRegistered: () => boolean): Promise<StartupOutcome> {
    const deadline = this.now() + timeoutMs
    let pane: string[] = []
    while (this.now() < deadline) {
      await sleep(WATCH_POLL_MS)
      if (isRegistered()) return { kind: 'done' }
      const cap = await this.tmux('tmux', ['capture-pane', '-p', '-t', exactTarget(name)])
      if (cap.code !== 0) return { kind: 'gone', pane }
      pane = this.redactPane(name, paneTailLines(cap.stdout))
    }
    return { kind: 'timeout', pane }
  }

  // The pane lines with the password of that session removed (they go to the log when a start fails).
  private redactPane(name: string, lines: string[]): string[] {
    const rec = this.servers.find((r) => r.tmuxName === name)
    return rec ? lines.map((l) => redact(l, rec.password)) : lines
  }

  // The command a start runs, for forensics: the serve argv. The port is picked at start, and the password is never shown.
  startCommand(): string[] {
    return [this.bin, 'serve', '--hostname', '127.0.0.1', '--port', '<port>']
  }

  liveSessionIds(): Map<string, number> {
    return new Map()
  }

  async listTranscripts(): Promise<TranscriptMeta[]> {
    return []
  }

  isTrusted(): boolean {
    return false
  }

  trustedFolders(): string[] {
    return []
  }

  answerPermission(): boolean {
    return false
  }

  respondToAsk(): void {}

  // Writes the records (0600). A failed write is logged, not thrown: the servers keep running.
  private save(): void {
    try {
      mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
      writeFileSync(this.file, JSON.stringify(this.servers, null, 2), { mode: 0o600 })
      chmodSync(this.file, 0o600)
    } catch (e) {
      warn(`could not save the opencode servers file: ${errMsg(e)}`, 'opencode')
    }
  }
}
