// Router (brain): the coordinator. It holds the state the handlers share and wires Telegram and socket events to the
// handler modules: src/router/handlers/* (events), send.ts, deliver.ts and spawn.ts (flows), shared.ts (types and
// constants). The decisions live in those modules. The adapters are built by src/app.ts and arrive through
// RouterDeps; this file imports no adapter module at run time.
import type { PairingControl } from './pairing-control.ts'
import type { AddonsPort, AgentBackend, Audit, ChatLogPort, Clock, Logger, MlPort, PlatformPort, SocketConn, SocketHandler, StorePort } from '../ports.ts'
import type { ChatId, ChatPort, MessageId, ThreadId, UserId } from '../brain/chat-types.ts'
import { BOT_COMMANDS } from '../brain/commands.ts'
import type { ChatTrace } from '../brain/chatlog.ts'
import type { UsagePort } from './addon-bridge.ts'
import { newTraceId, runTraced, traceFromPayload, warnOrLog, type Check } from '../brain/observe.ts'
import type { TraceSink } from './traced-chat.ts'
import type { LogsTopic } from './logs-topic.ts'
import type { ForensicsRequest } from './forensics.ts'
import type { DebugExtras } from './handlers/debug.ts'
import { MsgMap, Registry, RateLimiter, loadMsgMap, type Session } from './state.ts'
import { RoutePendingStore, type RouterAutoStart } from '../brain/route.ts'
import {
  SWEEP_MS, type PendingAsk, type PendingPerm, type PendingResume, type RecentPerm, type RoutePending, type SpawnQueue,
} from './shared.ts'
import { onSocket, onSocketClose } from './handlers/socket.ts'
import { onCallback } from './handlers/callbacks.ts'
import { onInbound } from './handlers/inbound.ts'
import { onChatEvent } from './handlers/group.ts'
import { announceBoot, stripStaleKeyboards, sweep } from './handlers/timers.ts'
import { onAccessLost } from './handlers/group.ts'
import { offerBuiltins } from './handlers/builtins.ts'
import { TOPIC_RECONNECT_GRACE_MS, closeOrphanTopics } from './topics.ts'
import { attachLedger, saveNow } from './send.ts'
import { startLedgerPrune } from './outbound.ts'
import { errMsg } from './log.ts'
import { clearStaleMarkers, closeOpenApprovals } from './restart.ts'
import { parseTopics, type TopicRec } from '../brain/topics.ts'
import { parseMutes, type Mutes } from '../brain/mute.ts'
import { isThreadMuted, withTopicMute } from './mute.ts'
import type { SessionKey } from '../brain/sessions.ts'
import type { IdleVerdict } from '../brain/idle.ts'
import type { E2e } from './e2e.ts'
import { Holds } from './gate.ts'
import { ButtonTokens } from '../addons-host/tokens.ts'
import type { IdleWarning } from './shared.ts'

// Everything the router reaches outside itself. src/app.ts builds the real adapters and passes them in.
export type RouterDeps = {
  // The owner's Telegram user id (the chat id of the private chat with the bot).
  ownerId: UserId
  // The chat.ownerAlias of the config: the `user` the session sees for the owner. Null: the sender's platform name.
  ownerAlias?: string | null
  // The chat app the router runs on (chat.app): the `chat_app` the session sees. Telegram today.
  chatApp?: string
  // The start-up group id from the config (plan 2.1). The stored id (set by /bind) wins. Null: DM mode.
  groupId?: ChatId | null
  // Strings redacted from everything sent to Telegram (the bot token and any old token).
  secrets: string[]
  // The owner's home folder: attachment and path checks.
  home: string
  // Named in the start-up log line only.
  socketPath: string
  chat: ChatPort
  store: StorePort
  platform: PlatformPort
  agent: AgentBackend
  ml: Pick<MlPort, 'transcribe' | 'close'>
  clock: Clock
  audit: Audit
  logger: Logger
  // Optional: without it nothing is logged and downloads land in the Telegram inbox (tests run this way).
  chatLog?: ChatLogPort
  // Addons (plan 2.9). Optional: without it the router behaves as before.
  addons?: AddonsPort
  // `/usage` text (plan 2.8). Optional: without it /usage says it is not set up.
  usage?: UsagePort
  // The E2E driver (docs/e2e.md). Set only when the router runs with STOLIK_E2E=1; the socket refuses e2e messages otherwise.
  e2e?: E2e
  // Observability (design §Observability). All optional: without them the router behaves as before.
  // The trace map (Telegram message id to trace id; kept 7 days).
  traces?: TraceSink
  // The Logs topic: warnings and errors are posted there (the log sink is installed by app.ts).
  logsTopic?: LogsTopic
  // Writes the forensics file of a failed start; returns its path (null when it could not be written).
  forensics?: (req: ForensicsRequest) => Promise<string | null>
  // What /debug needs from the composition root (queues, ML worker, quota, version).
  debugExtras?: () => Promise<DebugExtras>
  // The doctor checks that do not touch the network, run at start-up (failures go to the Logs topic).
  startupChecks?: () => Promise<Check[]>
  // What a plain message may do by itself (config routerAutoStart). Default "confirm".
  routerAutoStart?: RouterAutoStart
  // With no live session, a plain message that is not a reply may start one (config startWhenNoSession). Default true.
  startWhenNoSession?: boolean
  // Seconds a raced plugin dialog waits before it goes to Telegram, per desk or away mode (config askDelay). Default 60 / 0.
  askDelay?: { desk: number; away: number }
  // The config `claudeModel`: the model new bot-started sessions get when `/model` set none. Null: Claude Code's default.
  claudeModel?: string | null
  // The quota gate before an auto-start: null when the quota allows it, else the reason. Absent: refused (fail closed).
  quotaRefusal?: () => Promise<string | null>
  // Stops a tmux session by its name (Stop it on an auto-started session). Absent: nothing is stopped.
  stopSession?: (name: string) => Promise<boolean>
  // Minutes a session may sit idle before it is closed (config idleCloseMinutes). 0: never. Default 60.
  idleCloseMinutes?: number
}

export class Router {
  // Shared state. Public because the handler modules read and update it; nothing else should.
  // Each claimed session gets its outbound ledger attached (idempotent), so rows persisted before a restart are read
  // back before the first Stop-forward or requested-dedupe check. Sessions keyed by a cwd (no pid) keep that key, so they
  // are attached on their first send instead (their key is not a pid key; see brain/sessions.ts).
  readonly registry = new Registry((s) => {
    if (!(typeof s.key === 'string' && s.key.startsWith('cwd:'))) attachLedger(this, s)
  })
  msgMap: MsgMap = new MsgMap()
  readonly chat: ChatPort
  readonly store: StorePort
  readonly platform: PlatformPort
  readonly agent: AgentBackend
  readonly ml: Pick<MlPort, 'transcribe' | 'close'>
  readonly clock: Clock
  readonly audit: Audit
  readonly logger: Logger
  readonly chatLog: ChatLogPort | null
  // What is learned about each incoming message while it is handled (see handlers/inbound.ts). Keyed by message id.
  readonly chatTrace = new Map<MessageId, ChatTrace>()
  readonly addons: AddonsPort | undefined
  // The addons' button data behind their `ax:<token>` buttons (addons-host/tokens.ts). In memory: a restart strips them.
  readonly addonButtons: ButtonTokens
  // Messages an addon holds to a session before delivery (the gate point, gate.ts). Keyed by Telegram message id.
  readonly holds = new Holds()
  readonly usage: UsagePort | undefined
  readonly routerAutoStart: RouterAutoStart
  readonly askDelay: { desk: number; away: number }
  readonly startWhenNoSession: boolean
  // Set when stop() begins: asks still waiting for their delay then send nothing.
  stopping = false
  // The config `claudeModel` (see RouterDeps.claudeModel). The store's `/model` setting takes precedence (spawn.ts).
  readonly configModel: string | null
  // Asked before an auto-start (see RouterDeps.quotaRefusal). Public so the handlers and tests can call it.
  quotaRefusal: () => Promise<string | null> = async () => 'the quota is not known'
  // Stops a tmux session (see RouterDeps.stopSession). Public so tests can replace it.
  stopSession: (name: string) => Promise<boolean> = async () => false
  // The idle close limit in minutes (see RouterDeps.idleCloseMinutes). 0 turns the idle sweep off.
  readonly idleCloseMinutes: number
  // Sessions being closed (closeSession). Kept until the session leaves the registry, so a second close or a new idle
  // warning cannot start while the process is still dying.
  readonly closing = new Set<SessionKey>()
  // The idle warning posted per session, waiting for the close or for activity (see close.ts).
  readonly idleWarned = new Map<SessionKey, IdleWarning>()
  // The idle verdict of a session whose transcript was last read, keyed by its transcript mtime (see idleCheck in close.ts).
  readonly transcriptVerdict = new Map<SessionKey, { backendSessionId: string | null; mtime: number; verdict: IdleVerdict }>()
  // When the last auto-start was made (-Infinity: none yet). Shared by every auto-start of this router.
  lastAutoStartAt = -Infinity
  // The E2E driver state, or null (the normal case: the driver is off).
  readonly e2e: E2e | null
  readonly secrets: string[]
  // The owner's Telegram user id.
  // The owner's Telegram user id, or '' before pairing (nobody matches it then). Changed only by a confirmed pairing.
  ownerId: UserId
  // The chat.ownerAlias (see RouterDeps.ownerAlias) and the chat app name the session sees in its channel meta.
  readonly ownerAlias: string | null
  readonly chatApp: string
  // False until the owner pairs (ownerId is ''): then nothing is sent to a chat, and only the pairing code gets in.
  get paired(): boolean {
    return (this.ownerId as string) !== ''
  }
  // The pairing control (router/pairing-control.ts), or null: set by the composition root.
  pairing: PairingControl | null = null
  // The bound supergroup, or null in DM mode (set at start from the store or the config, and by /bind).
  groupId: ChatId | null = null
  readonly configGroupId: ChatId | null
  // Forum topic records of the sessions (plan 2.2). Kept in the store as JSON.
  topics: TopicRec[] = []
  // Folder-topic mutes (spec 24): cwd -> until (null: until /silent off). Kept in the store as JSON (src/brain/mute.ts).
  mutes: Mutes = {}
  // The topic work in progress for each folder (cwd), as a promise that settles when the work does. Work for a folder
  // waits for the one before it (see inFolderLane in topics.ts), so a folder never gets two topics.
  readonly topicsCreating = new Map<string, Promise<void>>()
  readonly home: string
  readonly socketPath: string
  readonly limiter = new RateLimiter()
  readonly routePending = new RoutePendingStore<RoutePending>()
  // The socket connection each registered channel session uses, for its socket messages. Delivery is the backend's.
  readonly connSession = new Map<SocketConn, Session>()
  readonly pending = new Map<string, PendingPerm>()
  readonly spawns = new Map<string, SpawnQueue>()
  // Spawn tokens of starts that timed out and were stopped: a register that still echoes one is counted as spawned.
  readonly retiredSpawns = new Map<string, { real: string; at: number }>()
  readonly asks = new Map<string, PendingAsk>()
  // Permission messages whose prompt ended without a seen verdict (see RecentPerm); pruned by age and count.
  readonly recentPerms: RecentPerm[] = []
  // Raced dialogs the terminal answered (raceId -> verdict) while their ask was still in its askDelay wait: onAsk never
  // sends them. Entries are pruned after RACE_RESOLVED_TTL_MS.
  readonly raceResolved = new Map<string, string>()
  readonly resumes = new Map<string, PendingResume>()
  // Transcript ids being resumed right now: a second tap must not start a second process on the same transcript.
  readonly resumingIds = new Set<string>()
  locked = false
  lockNotified = false
  saveTimer: unknown = null
  sweepTimer: unknown = null
  orphanTimer: unknown = null
  // Whether the bot can run the bound group. False after it was removed, left, demoted or lost Manage Topics: session
  // output then goes to the DM (see groupMode in topics.ts).
  groupAccess = true
  // The anonymous-admin notice was given (once per run).
  anonymousNoticed = false
  // Set once the reconnect grace is over: the periodic sweep checks for orphan topics from then on.
  orphanChecksOn = false
  // Edits already answered with "edits are not forwarded" (by message id).
  readonly noticedEdits = new Set<MessageId>()
  bootStarted = false
  bootTimer: unknown = null
  // The trace map is pruned once an hour (sweep).
  lastTracePrune = 0
  // The tmux session of each router-started session (for /debug), by session key.
  readonly tmuxBySession = new Map<SessionKey, string>()
  // The queue of the instance a bare `/new` started in a folder topic (by thread id), until a message reaches it. Without
  // it the topic's next plain message would go to the session that wrote last there, which is the old one. The queue is
  // set as soon as the start is queued (SpawnOptions.onQueued), so a message during the tmux start already finds it.
  readonly topicNext = new Map<ThreadId, { real: string; q: SpawnQueue }>()
  readonly traces: TraceSink | null
  readonly logsTopic: LogsTopic | null
  readonly forensics: ((req: ForensicsRequest) => Promise<string | null>) | null
  readonly debugExtras: (() => Promise<DebugExtras>) | null
  readonly startupChecks: (() => Promise<Check[]>) | null

  constructor(deps: RouterDeps) {
    this.secrets = deps.secrets
    this.ownerId = deps.ownerId
    this.ownerAlias = deps.ownerAlias ?? null
    this.chatApp = deps.chatApp ?? 'telegram'
    this.configGroupId = deps.groupId ?? null
    this.home = deps.home
    this.socketPath = deps.socketPath
    // Every send the router makes goes through the mute choke point (src/router/mute.ts): outside the traced decorator.
    this.chat = withTopicMute(deps.chat, (threadId) => isThreadMuted(this, threadId))
    this.store = deps.store
    this.platform = deps.platform
    this.agent = deps.agent
    this.ml = deps.ml
    this.clock = deps.clock
    this.audit = deps.audit
    this.logger = deps.logger
    this.chatLog = deps.chatLog ?? null
    this.addons = deps.addons
    this.addonButtons = new ButtonTokens(() => this.clock.now())
    this.usage = deps.usage
    this.e2e = deps.e2e ?? null
    this.traces = deps.traces ?? null
    this.logsTopic = deps.logsTopic ?? null
    this.forensics = deps.forensics ?? null
    this.debugExtras = deps.debugExtras ?? null
    this.startupChecks = deps.startupChecks ?? null
    this.routerAutoStart = deps.routerAutoStart ?? 'confirm'
    this.askDelay = deps.askDelay ?? { desk: 60, away: 0 }
    this.startWhenNoSession = deps.startWhenNoSession ?? true
    this.configModel = deps.claudeModel ?? null
    if (deps.quotaRefusal) this.quotaRefusal = deps.quotaRefusal
    if (deps.stopSession) this.stopSession = deps.stopSession
    this.idleCloseMinutes = deps.idleCloseMinutes ?? 60
  }


  async start(): Promise<void> {
    // Outbound ledger rows older than two days go at start, then every six hours (unref'd timer).
    startLedgerPrune(this.store, () => this.clock.now(), (msg) => this.logger.log(msg))
    // No prompt is pending in a new router, so markers left by the previous one are stale (see restart.ts).
    const stale = clearStaleMarkers()
    if (stale > 0) this.logger.log(`removed ${stale} stale pending marker(s)`)
    this.msgMap = loadMsgMap(this.store.readMsgMap())
    this.locked = this.store.isLocked()
    this.topics = parseTopics(this.store.readTopics())
    this.mutes = parseMutes(this.store.readMutes())
    this.groupId = this.store.readGroupId() ?? this.configGroupId
    this.chat.setHome(this.groupId)
    // Every entry point starts a flow with its own trace id (design §Observability): the logs and audit lines written
    // while it runs carry that id.
    this.chat.onInbound((m) => runTraced(newTraceId(), () => onInbound(this, m)))
    this.chat.onButton((c) => runTraced(newTraceId(), () => onCallback(this, c)))
    this.chat.onChatEvent((e) => runTraced(newTraceId(), () => onChatEvent(this, e)))
    this.chat.onStarted(() => {
      this.chat.setCommands?.(BOT_COMMANDS)
      runTraced(newTraceId(), () => announceBoot(this))
    })
    this.chat.onAccessError?.((reason) => runTraced(newTraceId(), () => onAccessLost(this, reason)))
    // Stale keyboards from the last run are stripped (their handlers are gone). The new ones are saved as they come.
    stripStaleKeyboards(this)
    this.chat.onLiveButtons?.((list) => {
      try {
        this.store.writeLiveButtons?.(JSON.stringify(list.map((x) => ({ messageId: x.messageId, dm: x.dm }))))
      } catch (e) {
        this.logger.log(`keyboards not saved: ${(e as Error).message}`)
      }
    })
    const socket: SocketHandler = {
      message: (conn, msg) => runTraced(traceFromPayload(msg?.trace) ?? newTraceId(), () => onSocket(this, conn, msg)),
      close: (conn) => onSocketClose(this, conn),
    }
    await this.agent.start(socket)
    await this.addons?.start()
    this.chat.start()
    // The built-ins offer on the first start in DM mode (once; not when the owner chose an addon before).
    if (this.groupId === null) await offerBuiltins(this, { dmStart: true })
    this.orphanTimer = this.clock.setTimer(() => void closeOrphanTopics(this), TOPIC_RECONNECT_GRACE_MS)
    this.sweepTimer = this.clock.setRepeating(() => sweep(this), SWEEP_MS)
    this.logger.log(`router ready, socket ${this.socketPath}${this.locked ? ' (LOCKED)' : ''}`)
    if (!this.paired) this.logger.log('not paired yet: run stolik setup; nothing is sent until the owner pairs')
    void this.logsTopic?.ensure()
    void this.runStartupChecks()
  }

  // The doctor's checks that need no network, run once at start. Failures and warnings are logged, and the Logs topic
  // gets them. A failing check never stops the router.
  async runStartupChecks(): Promise<void> {
    // Start-up notices from the store (a corrupt database moved aside): each one to the owner, once.
    if (!this.paired && this.store.startupNotices.length > 0) {
      this.logger.log(`${this.store.startupNotices.length} start-up notice(s) not sent: not paired yet`)
    }
    for (const notice of this.paired ? this.store.startupNotices : []) {
      await this.chat.sendText(notice).catch((e: unknown) => this.logger.log(`startup notice not sent: ${errMsg(e)}`))
    }
    if (!this.startupChecks) return
    try {
      const checks = await this.startupChecks()
      let bad = 0
      for (const c of checks) {
        if (c.status === 'ok') continue
        bad++
        const msg = `doctor: ${c.title}: ${c.detail}`
        // Privacy findings are logged as plain lines: the Logs topic gets them through the owner's report, once.
        if (c.group === 'privacy') this.logger.log(msg)
        else if (c.status === 'fail') this.logger.error ? this.logger.error(msg, 'doctor') : this.logger.log(msg)
        else warnOrLog(this.logger, msg, 'doctor')
      }
      this.logger.log(bad === 0 ? 'doctor: start-up checks passed' : `doctor: ${bad} start-up check${bad === 1 ? '' : 's'} need attention (stolik doctor for details)`)
      await this.reportPrivacy(checks.filter((c) => c.group === 'privacy'))
    } catch (e) {
      warnOrLog(this.logger, `doctor: start-up checks did not run: ${e instanceof Error ? e.message : String(e)}`, 'doctor')
    }
  }

  // The privacy findings (decision 12): a finding is a warning that is not a "not checked" (those are only logged). The
  // owner gets one message per change in the set of findings, not one per start: the set is kept in the store
  // (`privacy-reported`). An empty set clears it, so a recurrence is posted again. Nothing is posted before the owner pairs.
  async reportPrivacy(checks: Check[]): Promise<void> {
    const findings = checks
      .filter((c) => c.status === 'warn' && !c.detail.startsWith('not checked'))
      .map((c) => ({ id: c.id, title: c.title, detail: c.detail }))
      .sort((a, b) => a.id.localeCompare(b.id))
    const key = findings.length === 0 ? '' : JSON.stringify(findings)
    const stored = this.store.readPrivacyReported()
    if (key === stored) return
    if (findings.length === 0) {
      this.store.writePrivacyReported('')
      this.logger.log('privacy: the chat is private (no findings)')
      return
    }
    if (!this.paired) {
      this.logger.log(`privacy: ${findings.length} finding(s) not posted: not paired yet`)
      return
    }
    const text = [
      'Privacy check: someone other than you may be able to see the bridge chat. Each line names the fix:',
      ...findings.map((f) => `- ${f.title}: ${f.detail}`),
    ].join('\n')
    try {
      await this.chat.sendText(text)
      this.store.writePrivacyReported(key)
    } catch (e: unknown) {
      this.logger.log(`privacy report not sent: ${errMsg(e)}`)
    }
  }

  // Shutdown, in this order: (1) save the message map, and tell the open prompts that the answer is at the desk (urgent
  // edits, waited for up to the drain deadline); (2) stop intake: Telegram polling, then the channel sockets; (3) drain
  // the urgent outbound sends until the deadline, which is half of `budgetMs` from the start; (4) stop the ML worker and
  // the addons, and wait for the addon processes to exit (SIGKILL after a grace period); (5) save again and close the
  // store. The caller releases the router lock after this resolves (shutdownRouter).
  async stop(budgetMs = 10_000): Promise<void> {
    this.stopping = true
    const deadline = this.clock.now() + Math.floor(budgetMs / 2)
    saveNow(this)
    // From here on an addon's exit is an intended stop, not a crash (see AddonHost.beginStop).
    this.addons?.beginStop?.()
    // Open approval prompts say the answer is at the desk (their buttons would otherwise outlive the router). The edits
    // are urgent, so they go out ahead of the normal queue; the wait is bounded by the drain deadline.
    await this.withinDeadline(closeOpenApprovals(this), deadline)
    // Stop polling first: aborting the long poll leaves unconfirmed updates on Telegram's side, so the
    // next router instance receives them instead of them being lost during the restart.
    await this.chat.stop().catch((e: unknown) => this.logger.log(`telegram stop: ${errMsg(e)}`))
    if (this.sweepTimer) this.clock.clearTimer(this.sweepTimer)
    if (this.orphanTimer) this.clock.clearTimer(this.orphanTimer)
    if (this.bootTimer) this.clock.clearTimer(this.bootTimer)
    for (const q of this.spawns.values()) this.clock.clearTimer(q.timer)
    try {
      await this.agent.stop()
    } catch (e) {
      this.logger.log(`agent stop: ${errMsg(e)}`)
    }
    // Telegram adapters that queue sends (QueuedChat) drain their urgent sends for the time left; the others have
    // nothing to drain.
    if (this.chat.drain) {
      const left = Math.max(0, deadline - this.clock.now())
      await this.chat.drain(left).catch((e: unknown) => this.logger.log(`outbound drain: ${errMsg(e)}`))
    }
    this.ml.close()
    try {
      await this.addons?.stop()
    } catch (e) {
      this.logger.log(`addons stop: ${errMsg(e)}`)
    }
    if (this.saveTimer) this.clock.clearTimer(this.saveTimer)
    saveNow(this)
    // The store has no close() on StorePort; the SQLite adapter has one (WAL checkpoint and close).
    const closable = this.store as { close?: () => void }
    try {
      closable.close?.()
    } catch (e) {
      this.logger.log(`store close: ${errMsg(e)}`)
    }
  }
  // Resolves when `p` does or at the deadline (clock time), whichever comes first. Past the deadline the stop goes on; the
  // sends `p` queued stay in the queue (the drain decides what still goes out).
  private withinDeadline(p: Promise<void>, deadline: number): Promise<void> {
    const left = deadline - this.clock.now()
    if (left <= 0) return Promise.resolve()
    let timer: unknown = null
    const cut = new Promise<void>((resolve) => {
      timer = this.clock.setTimer(resolve, left)
    })
    return Promise.race([p, cut]).finally(() => {
      if (timer !== null) this.clock.clearTimer(timer)
    })
  }
}

// What SIGTERM and SIGINT run (main.ts): Router.stop() within timeoutMs, then the lock is released, then exit 0. The hard
// timer is a plain timer (never unref'd), so it fires even when stop() never settles; it releases the lock and exits too.
export async function shutdownRouter(
  router: Router,
  opts: { timeoutMs: number; release: () => void; exit: (code: number) => void },
): Promise<void> {
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    opts.release()
  }
  const timer = setTimeout(() => {
    router.logger.log(`shutdown did not finish within ${opts.timeoutMs} ms: exiting`)
    release()
    opts.exit(0)
  }, opts.timeoutMs)
  try {
    await router.stop(opts.timeoutMs)
  } catch (e) {
    router.logger.log(`shutdown: ${errMsg(e)}`)
  }
  clearTimeout(timer)
  release()
  opts.exit(0)
}
