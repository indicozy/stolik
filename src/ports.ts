// Ports: the interfaces the router brain (core.ts today, src/brain/ later) calls. Interfaces only, no behaviour.
// Each method mirrors a call core.ts makes today on the current implementation (telegram.ts, presence.ts,
// stt.ts, spawn.ts, resume.ts, server.ts, log.ts, claudepid.ts, and the state files). Adapters
// implement these in later phases (plan S5-S10), so brain code can be unit-tested with fakes and no network.
// Types are imported from the current modules; they move with their adapters.
import type { AskDecision, Kind } from './adapters/channel/protocol.ts'
import type { PermissionDetails, Rows, SessionKey } from './router/state.ts'
import type { TranscriptMeta } from './brain/resume.ts'
import type { ChatLine, ChatTarget } from './brain/chatlog.ts'
import type { TopicRec } from './brain/topics.ts'
import type { NotifyLevel } from './brain/notify-level.ts'
import type { Mutes } from './brain/mute.ts'
import type { IdleAlert, IdleState } from './brain/away.ts'
import type { UsageRecord } from './brain/usage.ts'
import type { ChatId, MessageId, ThreadId } from './brain/chat-types.ts'
import type { StartupOutcome } from './adapters/tmux.ts'

// ---------- Agent backend ----------

// A connection to a local client (channel server, hook, tg-notify, ctl). The framing and the socket stay in the
// adapter; the brain only sends objects and ends the connection.
export interface SocketConn {
  send(msg: object): void
  end(): void
  readonly destroyed: boolean
}

// What the backend hands the brain for each raw socket message and each closed connection. These are the protocol
// messages of src/adapters/channel/protocol.ts (see the comment block at the top of claude-code.ts).
export interface SocketHandler {
  message(conn: SocketConn, msg: any): void
  close(conn: SocketConn): void
}

// One thing an agent session reports to the brain. The Claude Code backend maps its hooks and channel messages to
// these; the names say what happened in the session, not which hook fired.
export type AgentEvent =
  // A session connected (its channel registered) or was seen through its hooks. `pid` is null when unknown.
  | { type: 'session-connected'; key: SessionKey; cwd: string; pid: number | null; hasChannel: boolean }
  // The session's connection closed (the process ended, or the channel dropped).
  | { type: 'session-closed'; key: SessionKey }
  // The user sent a prompt into the session (from the terminal or from the bot).
  | { type: 'user-prompted'; key: SessionKey }
  // A turn finished. `lastMessage` is the agent's final text, when the backend has it.
  | { type: 'turn-ended'; key: SessionKey; stopHookActive: boolean; lastMessage: string | null }
  // The session is waiting for something: a tool approval, an AskUserQuestion, or a plan approval.
  | { type: 'needs-approval'; key: SessionKey; requestId: string; details: PermissionDetails }
  // A question or plan waits on the user; `askId` is answered through `respondToAsk`.
  | { type: 'ask'; key: SessionKey; askId: string; tool: 'AskUserQuestion' | 'ExitPlanMode'; toolInput: unknown }
  // The session sent a reply on its channel, or a notification (waiting for input, etc.).
  | { type: 'reply'; key: SessionKey; text: string; files: string[]; kind: Kind }
  | { type: 'notification'; key: SessionKey; notificationType: string | undefined; message: string | null }

// The one agent interface. Core sees only this; Claude Code specifics (channel MCP, hooks, tmux, `claude -p`, the
// ~/.claude layout) stay behind it.
export interface AgentBackend {
  // Subscribes to agent events. The brain registers one handler at start. (Not emitted yet: today every event
  // still arrives as a raw socket message through `start`, see claude-code.ts.)
  onEvent(fn: (e: AgentEvent) => void): void
  // Opens the local socket and routes its messages to `handler`. Stops it (and closes its connections) on `stop`.
  start(handler: SocketHandler): Promise<void>
  stop(): Promise<void>
  // Whether a pid is an interactive claude session (not `claude -p`). A null pid counts as interactive.
  isInteractive(pid: number | null): boolean
  // Housekeeping: forgets cached process facts for pids that are gone.
  sweep(): void
  // Connection bookkeeping: a registered channel is attached to its session key. `detachSession` returns the key
  // whose connection was this one (null if none); `dropSession` forgets a session's connection.
  attachSession(key: SessionKey, conn: SocketConn): void
  detachSession(conn: SocketConn): SessionKey | null
  dropSession(key: SessionKey): void
  isConnected(key: SessionKey): boolean
  // Delivers an inbound user message to a connected session. Returns false when the session is not connected.
  sendToSession(key: SessionKey, content: string, meta: Record<string, string>): boolean
  // Answers a tool approval relayed from Telegram. Returns false when the session is not connected.
  answerPermission(key: SessionKey, requestId: string, behavior: 'allow' | 'deny'): boolean
  // Ends a PermissionRequest hook's pending ask on its connection. A decision answers it; no decision (null)
  // releases it to the terminal dialog.
  respondToAsk(conn: SocketConn, decision: AskDecision | null): void
  // Starts a new session in `dir` (router-started, in tmux). Returns the tmux session name. `spawnToken` is handed to the
  // session, which echoes it when it registers (see spawn.ts).
  startSession(project: string, dir: string, extraArgs?: readonly string[], spawnToken?: string): Promise<string>
  // The command line startSession runs, for forensics (optional: a backend that cannot show it omits it).
  startCommand?(project: string, dir: string, extraArgs: readonly string[]): string[]
  // Watches a starting session's startup dialog until it registers, its tmux session disappears, or `timeoutMs` passes.
  // `onMiss` is called once when the pane names the development channels but the dialog matcher does not see the dialog.
  watchStartup(name: string, timeoutMs: number, isRegistered: () => boolean, onMiss?: (pane: string[]) => void): Promise<StartupOutcome>
  // The last lines of a session's pane (for the log when a start fails). Empty when the session is gone.
  paneTail(name: string): Promise<string[]>
  // Stops a router-started session (its tmux session). Failures are ignored.
  killSession(name: string): Promise<void>
  // The pid of the session's pane process, or null.
  panePid(name: string): Promise<number | null>
  // Session ids of the interactive sessions running now, with their pids.
  liveSessionIds(): Map<string, number>
  // Ended and live transcripts the backend can resume, newest first (raw, before the brain's pure list logic).
  listTranscripts(): Promise<TranscriptMeta[]>
  // Whether the agent trusts a folder (so a session may start there without the trust dialog).
  isTrusted(realFolder: string): boolean
  // Folders the agent trusts, absolute paths.
  trustedFolders(): string[]
}

// ---------- ML worker ----------

// Local models behind addons (voice in Phase 3). Today only transcription exists (stt/worker.py).
export interface MlPort {
  // Speech to text for a local audio file.
  transcribe(path: string): Promise<string>
  // Voice-cleanup text transform. Not used by core yet (Phase 3, addon ml-worker).
  clean(text: string): Promise<string>
  // Free text generation. Not used by core yet (Phase 3, digest).
  generate(prompt: string, maxChars?: number): Promise<string>
  // Stops the worker and frees its memory.
  close(): void
}

// ---------- Storage ----------

// What the router keeps between runs: the message map, the lock flag, the boot id, the group id and the topics
// (SQLite, `tg-bridge.db`), and the notes inbox, attachments and Telegram inbox folder (files). SqliteStore implements
// it (src/adapters/store-sqlite.ts); JsonStore (store-json.ts) is the file-only version kept for tests and legacy reads.
export interface StorePort {
  // The message map as JSON text, or '' when none is saved.
  readMsgMap(): string
  writeMsgMap(json: string): void
  // The router lock (`tg-bridge-ctl lock`): survives a restart.
  isLocked(): boolean
  setLocked(on: boolean): void
  // The model `/model` set for new sessions the bot starts, or null when none is set (the config value or Claude Code's
  // default applies then). Survives a restart. Null clears it.
  defaultModel(): string | null
  setDefaultModel(model: string | null): void
  // The boot id saved at the last start, or null when none. Used to tell a reboot from a router restart.
  readLastBootId(): string | null
  writeBootId(bootId: string): void
  // The bound supergroup's id, or null in DM mode. Set by /bind and by a group migration; the start-up config value
  // is used when none is stored.
  readGroupId(): ChatId | null
  writeGroupId(id: ChatId): void
  // Forum topic records as JSON text, or '' when none is saved (src/brain/topics.ts parses them).
  readTopics(): string
  writeTopics(json: string): void
  // Folder-topic mutes (spec 24, src/brain/mute.ts) as JSON text, or '' when none is saved. Survives a restart.
  readMutes(): string
  writeMutes(json: string): void
  // Messages the bot sent with a keyboard that may still be live, as JSON text (`[{messageId, dm}]`), or '' when none
  // is saved. The router strips these keyboards at start, since their handlers died with the last process.
  readLiveButtons?(): string
  writeLiveButtons?(json: string): void
  // Appends one entry to the notes inbox (the entry already has its heading and newlines).
  appendNote(entry: string): void
  // Copies a received file into the attachments folder under `fileName` and returns the final path (the name is
  // changed when it is taken).
  saveAttachment(src: string, fileName: string): Promise<string>
  // Path of a file in the Telegram inbox folder (downloads land here before they are routed).
  inboxPath(fileName: string): string
  // Where a new attachment with this name goes (creates the attachments folder), and whether that name is taken.
  attachmentPath(fileName: string): string
  attachmentExists(fileName: string): boolean
  // Outbound ledger entries of one session, oldest first. Appended in one transaction. The SQLite store keeps them in
  // `outbound_ledger`; the JSON store keeps them in memory only (lost on restart).
  listLedger(sessionKey: SessionKey): LedgerRecord[]
  appendLedger(entries: readonly LedgerRecord[]): void
  // Deletes the ledger rows stamped before `olderThanMs` (epoch ms); returns how many were deleted.
  pruneOutboundLedger(olderThanMs: number): number
  // Human-readable notices produced while opening (for example a damaged database that was moved aside). Empty on a
  // normal start.
  readonly startupNotices: string[]
  // The privacy findings last posted to the owner (a JSON text; '' when none). Kept so an unchanged state is not re-posted.
  readPrivacyReported(): string
  writePrivacyReported(text: string): void
}

// ---------- Platform ----------

// What the machine says: idle time, lock state, processes, files and the boot. The away rule (AWAY_IDLE_MS and
// /away, /here) is applied by the brain on these facts (plan S3); `isAway` is the composed answer core uses today.
// Implemented by the Linux adapters (plan S10: X11 or logind, /proc).
export type ResourceMode = 'desk' | 'away'

export interface PlatformPort {
  // Milliseconds since the last keypress, or null when it cannot be read (no X display, script failed).
  idleMs(): Promise<number | null>
  // True while the screen is locked.
  isLocked(): Promise<boolean>
  // The composed away answer: override, lock, idle threshold, /here suppression. Cached briefly by the adapter.
  // True for idle and for unknown (the idle source is down): relays that must not be lost use this.
  isAway(): Promise<boolean>
  // The tri-state answer: active, idle (away) or unknown (idle source down past its hold). Asks use only 'idle'.
  awayState(): Promise<IdleState>
  // The owner's desk or away mode from ~/.config/ai-resources/mode (away only when the file says so; desk otherwise).
  resourceMode(): Promise<ResourceMode>
  // The one-shot idle-source alert ('down' or 'up') raised by the last reads, cleared when taken; null when none.
  takeIdleAlert(): IdleAlert | null
  // Override state behind /away and /here.
  setAway(): void
  setHere(now: number): void
  // Whether a process exists (a permission error counts as alive).
  pidAlive(pid: number): boolean
  // The argv of a process, or null when it cannot be read.
  processArgv(pid: number): string[] | null
  // The start time of a process (with its pid it identifies the process), or null when unreadable.
  processStart(pid: number): string | null
  // The parent pid of a process, or null when unreadable.
  parentPid(pid: number): number | null
  // The direct children of a pid, or null when the process table cannot be read.
  childPids(pid: number): number[] | null
  // Every descendant of a pid with its argv (depth first), or null when any of them cannot be read. Idle detection uses it.
  descendants(pid: number): Array<{ pid: number; argv: string[] }> | null
  // The executable name of a process, or null when unreadable.
  processName(pid: number): string | null
  // Sends a signal; false when it fails (no such process, or no permission).
  signal(pid: number, sig: 'SIGTERM' | 'SIGKILL'): boolean
  // The terminal window that hosts only this claude session (pid), or null. Read it before the claude process is killed.
  terminalWindowPid(claudePid: number): number | null
  // Kernel boot id, and seconds since boot (null when unreadable).
  bootId(): string
  uptimeSeconds(): number | null
  // Real path of a path, or null when it does not exist.
  realpath(path: string): string | null
  // Whether a path is a directory (false when it does not exist).
  isDirectory(path: string): boolean
  // File facts, or null when the path does not exist.
  fileInfo(path: string): { isFile: boolean; size: number } | null
  // Pins the router to these CPUs (plan machine rules). No caller in the router yet.
  pinCpus(cpus: readonly number[]): void
}

// ---------- Logging ----------

// Stderr lines (journald captures them). Never pass secrets or message bodies here.
export interface Logger {
  log(msg: string): void
  debug(msg: string): void
  // Warnings and errors reach the Logs topic (src/router/logs-topic.ts). Optional: without them a warning is a log line.
  warn?(msg: string, component?: string): void
  error?(msg: string, component?: string): void
}

// ---------- Trace map (design §Observability) ----------

// A Telegram message the router sent (`out`) or received (`in`), with the trace id of the flow that made or handled it.
export type TraceRecord = { messageId: MessageId; dir: 'in' | 'out'; trace: string; at: number }

// ---------- Time ----------

// The brain's clock. Tests pass a fake; the router passes the real one.
export interface Clock {
  // Epoch milliseconds.
  now(): number
  // Current local date (notes stamps).
  date(): Date
  // Timers. Handles are opaque to the brain.
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  setRepeating(fn: () => void, ms: number): unknown
}

// ---------- Audit ----------

// Append-only audit trail (JSON lines). Callers pass metadata only: session names, lengths, kinds, never bodies or
// tokens. Implemented by the file audit log (router/log.ts today).
export interface Audit {
  event(fields: Record<string, string | number | boolean>): void
}

// ---------- Database (SQLite, plan S9) ----------

// Records for the tables of `tg-bridge.db`. Only the fields the store keeps; the Session type stays in the brain.
export type SessionRecord = {
  key: SessionKey
  name: string
  project: string
  cwd: string
  pid: number | null
  hasChannel: boolean
  connected: boolean
  spawned: boolean
  lastActive: number
  backendSessionId: string | null
}
// A forum topic, in the brain's shape (src/brain/topics.ts).
export type TopicRecord = TopicRec
export type LedgerRecord = {
  sessionKey: SessionKey
  key: string
  bodyKey: string
  source: string
  at: number
  messageIds: MessageId[]
}
export type RouterDecisionRecord = { at: number; chosen: string | null; confidence: number | null; outcome: string }

// The structured state kept in SQLite. Every method is one logical write; a method that writes several rows does it in
// one transaction. SqliteStore (src/adapters/store-sqlite.ts) implements this together with StorePort.
export interface DbStorePort {
  listSessions(): SessionRecord[]
  upsertSession(s: SessionRecord): void
  deleteSession(key: SessionKey): void
  // Replaces all session rows in one transaction (the registry is written as a whole).
  replaceSessions(list: readonly SessionRecord[]): void

  listTopics(): TopicRecord[]
  upsertTopic(t: TopicRecord): void
  deleteThread(threadId: ThreadId): void

  // The forum thread a mode (quick, read, web, ...) posts into.
  getModeThread(mode: string): ThreadId | null
  setModeThread(mode: string, threadId: ThreadId): void

  getAddonSetting(addon: string, key: string): string | null
  setAddonSetting(addon: string, key: string, value: string): void

  // The trace map: Telegram message ids to trace ids, kept 7 days (pruned by the router's sweep).
  recordTrace(r: TraceRecord): void
  tracesForMessage(messageId: MessageId): TraceRecord[]
  pruneTraces(beforeMs: number): void

  // Newest first, at most `limit`.
  listRouterDecisions(limit: number): RouterDecisionRecord[]
  appendRouterDecision(d: RouterDecisionRecord): void

  // Mode-run usage (src/brain/usage.ts). `listUsage` returns the records at or after `sinceMs`, oldest first.
  // `pruneUsage` drops the records before `beforeMs`, then keeps only the newest `keep`.
  addUsage(u: UsageRecord): void
  listUsage(sinceMs: number): UsageRecord[]
  pruneUsage(beforeMs: number, keep: number): void

  close(): void
}

// ---------- Chat log (design §4.11) ----------

// The chat log: one line per message in each direction, with its target. Files live under the log root (config
// `logRoot`). Implemented by src/adapters/files.ts. Nothing here throws into the router.
export interface ChatLogPort {
  // Appends a line to the monthly JSONL file and to the Markdown file of its day.
  append(line: ChatLine): void
  // A reserved file for an incoming attachment at time `ts` (epoch ms): the absolute path to download to, and the path
  // relative to the log root that the log lines carry. Null when the folder cannot be made.
  attachmentPath(name: string, ts: number): { path: string; rel: string } | null
  // The last `n` lines of one target, oldest first.
  recentExchanges(target: ChatTarget, n: number): ChatLine[]
}

// ---------- Addons (plan 2.9) ----------

// The addon host as the router sees it. Addons are separate programs (src/addons-host/); the router only asks for
// the General-chat replies they give and for the /addons menu. `general` runs before a plain General message is
// routed, and only when an addon's prefix or command matches it.
export type AddonInfo = {
  name: string
  version: string
  enabled: boolean
  running: boolean
  // Short human status: "running", "off", "restarting in 5 s", "disabled after crashes", "invalid manifest", ...
  status: string
  provides: string[]
  // Restarts after crashes since the router started, and the reason of the last crash (for /debug).
  restarts?: number
  lastError?: string | null

  // A user folder ignored because a built-in has its name (it is listed for the owner, and cannot be turned on).
  shadowed?: boolean
}

// An installed addon that declares a prefix word or a command, for the "comes from the X addon, which is off" notice.
export type DeclaringAddon = { name: string; enabled: boolean; running: boolean; status: string }
// A built-in addon (shipped with tg-bridge): its declared access and requirements, and whether the owner chose it before.
export type BuiltinAddon = {
  name: string
  version: string
  enabled: boolean
  choice: boolean
  access: string[]
  requires: string[]
  provides: string[]
}
// What the route point (the router addon) is asked: the owner's plain message, the live sessions and the trusted folders.
export type RoutePayload = {
  text: string
  sessions: Array<{ name: string; folder: string; lastActiveAt: number }>
  folders: Array<{ name: string; path: string }>
}
// The route point's answer. `target` null means no choice; the router uses its buttons.
export type RouteAnswer = {
  target: { kind: 'session'; name: string } | { kind: 'new'; folder: string } | null
  confidence: number
  reason: string
}

export interface AddonsPort {
  start(): Promise<void>
  // Called first on shutdown, before any await: addons that exit from here on are stopping, not crashed.
  beginStop?(): void
  stop(): Promise<void>
  // Installed addons, re-read from disk, in name order.
  list(): AddonInfo[]
  // The installed addon that declares `word` as a prefix or a command, enabled or not; null when none does.
  declaring?(kind: 'prefix' | 'command', word: string): DeclaringAddon | null
  // The built-in addons (shipped with tg-bridge), in name order.
  builtins?(): BuiltinAddon[]
  // The one-time built-ins offer: whether it was made, and marking it made (kept in the store).
  builtinsOffered?(): boolean
  markBuiltinsOffered?(): void
  // Calls an addon op and waits for its answer (for /debug: the ML worker's status). Rejects when it is not running.
  query?(addon: string, op: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
  // The route point: the router addon's answer for a plain message, or null (no addon, refused, failed, or silent).
  route?(payload: RoutePayload): Promise<(RouteAnswer & { addon: string }) | null>
  // Enables (starts) or disables (stops) an addon. Returns null on success, else the reason it was refused.
  setEnabled(name: string, on: boolean): Promise<string | null>
  // The reply text of the addon whose prefix or command matches a General message, or null when none does. '' means
  // the addon answers later by itself. `messageId` is the owner's message id.
  // `file`, when given, is asked for only once an addon has matched: its fields (a local file path) go with the call.
  general(text: string, messageId?: MessageId, file?: () => Promise<Record<string, unknown> | null>): Promise<string | null>
  // Optional extensions: a swipe-reply to an addon's message (true when an addon took it), and a tap on an addon's
  // button (its toast, or null).
  reply?(text: string, replyTo: MessageId, messageId: MessageId): Promise<boolean>
  callback?(addon: string, data: string, messageId?: MessageId): Promise<{ toast?: string } | null>
  // Text for a voice or audio file from the first media addon that takes it (plan 3.2); null when none does.
  media(file: { kind: string; size: number; mime: string; path: string }): Promise<{ addon: string; text: string } | null>
  // The text after the text filters (voice cleanup, plan 3.3). `unpolished` is true when a filter gave up and kept the raw text.
  cleanText(text: string, ctx: { sessionNames: string[] }): Promise<{ text: string; unpolished: boolean }>
  // The gate point (cost-guard): asks each running gate provider in turn whether to hold a message to a session. The
  // addon that holds it is returned; null when none holds it (or every one failed or timed out: fail open).
  gate?(payload: Record<string, unknown>): Promise<{ addon: string } | null>
  // Whether `name` is an installed addon (the gate skips an addon's own prompts, which are sent under its name). No I/O.
  isAddon?(name: string): boolean
}
