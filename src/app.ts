// Composition root (plan S11): reads config, builds every adapter and hands them to the router as ports. Nothing
// else builds an adapter. `src/router/main.ts` calls buildRouter and runs the result.
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { INBOX_DIR, NOTES_DIR, REPO_DIR, SOCKET_PATH, STATE_DIR, chatLogRoot, currentTgConfig, gpuEnv, pinned, tgConfigDir, type Config } from './config.ts'
import { Router } from './router/core.ts'
import { ROUTER_COMMANDS } from './router/state.ts'
import { audit, configureLog, error as logError, log, debug, warn as logWarn, writeAddonLog } from './router/log.ts'
import { AddonHost } from './addons-host/host.ts'
import { DbAddonSettings } from './addons-host/settings.ts'
import { ClaudeCodeBackend } from './adapters/agent/claude-code.ts'
import { OpencodeBackend, resolveOpencodeBin } from './adapters/agent/opencode.ts'
import { FilesChatLog, readChatDays } from './adapters/files.ts'
import { SqliteStore } from './adapters/store-sqlite.ts'
import { Stt } from './adapters/stt.ts'
import { Telegram } from './adapters/chat/telegram.ts'
import { checkTelegramPrivacy, telegramFor } from './adapters/chat/telegram-doctor.ts'
import { QueuedChat } from './adapters/chat/queued.ts'
import { OutboundQueues } from './brain/outbound-queue.ts'
import { createPlatform } from './adapters/platform/index.ts'
import type { Clock } from './ports.ts'
import { AddonBridge } from './router/addon-bridge.ts'
import { QuotaCache, type QuotaStatus } from './brain/usage.ts'
import { readQuotaGate } from './adapters/quota-gate.ts'
import { quotaGatePath } from './brain/modes.ts'
import { E2e, e2eEnabled } from './router/e2e.ts'
import type { ChatId, ChatPort, ThreadId, UserId } from './brain/chat-types.ts'
import { tgUserOf } from './adapters/chat/tg-ids.ts'
import { dcUser } from './adapters/chat/dc-ids.ts'
// The Discord adapter is imported by a dynamic import, only when chat.app is "discord" (see buildRouter): a Telegram
// install never loads @discordjs/* or the Discord mapping. The type below is erased at run time.
import type { Discord } from './adapters/chat/discord.ts'
import { fromDbChat } from './adapters/store-ids.ts'
import { legacyMsgId, storedId } from './adapters/legacy-ids.ts'
import { LogsTopic, type LogsThreadStore } from './router/logs-topic.ts'
import { TracedChat } from './router/traced-chat.ts'
import { claudeVersion, writeForensics } from './router/forensics.ts'
import { buildDoctorDeps, runChecks } from './cli/doctor.ts'
import type { DebugMl } from './brain/observe.ts'
import { currentTrace, newTraceId, runTraced } from './brain/observe.ts'
import type { DebugExtras } from './router/handlers/debug.ts'
import { killTmuxSession } from './adapters/tmux.ts'
import { PairingControl } from './router/pairing-control.ts'

// The brain's clock: real timers and the wall clock. Each timer runs its callback in a trace: the flow that set it, or a
// new trace for a repeating timer (design §Observability).
const systemClock: Clock = {
  now: () => Date.now(),
  date: () => new Date(),
  setTimer: (fn, ms) => setTimeout(() => runTraced(currentTrace() ?? newTraceId(), fn), ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setRepeating: (fn, ms) => setInterval(() => runTraced(newTraceId(), fn), ms),
}

// The Logs topic's thread id is kept as an addon setting under the router's own scope (no table of its own).
const LOGS_SCOPE = '_router'
const LOGS_KEY = 'logs-thread'

// The package version and the git commit of this checkout, read once (for /debug).
function buildInfo(): { version: string; gitSha: string | null } {
  let version = 'unknown'
  try {
    version = (JSON.parse(readFileSync(join(REPO_DIR, 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown'
  } catch {
    // The report shows "unknown".
  }
  let gitSha: string | null = null
  try {
    gitSha = execFileSync('git', ['-C', REPO_DIR, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', timeout: 5_000 }).trim() || null
  } catch {
    // Not a git checkout: no commit shown.
  }
  return { version, gitSha }
}

// The ML worker's models and the VRAM of the configured GPU (for /debug). Never throws.
function mlStatus(addons: AddonHost, gpu: { cudaVisibleDevices: string } | null): Promise<DebugMl> {
  return new Promise<DebugMl>((resolve) => {
    addons
      .query('ml-worker', 'status', {}, 5_000)
      .then(async (st) => {
        const s = st as { models?: Array<{ name: string; loaded: boolean; device: string | null; unloadInSec: number | null }> }
        const index = gpu?.cudaVisibleDevices.split(',')[0] ?? null
        resolve({ ok: true, gpu: index, vram: index === null ? null : await vramOf(index), models: s.models ?? [] })
      })
      .catch((e: Error) => resolve({ ok: false, reason: /no addon named/.test(e.message) ? 'not installed' : `not running (${e.message.slice(0, 120)})` }))
  })
}

// Used and total memory of the GPU at nvidia-smi index `index`, in MiB. Null when it cannot be read.
function vramOf(index: string): Promise<{ usedMiB: number; totalMiB: number } | null> {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['-i', index, '--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'], { timeout: 10_000 }, (err, stdout) => {
      if (err) return resolve(null)
      const [used, total] = String(stdout).trim().split(',').map((x) => Number(x.trim()))
      resolve(Number.isFinite(used) && Number.isFinite(total) ? { usedMiB: used, totalMiB: total } : null)
    })
  })
}

// The Discord adapter over the real client (@discordjs/*, loaded here and nowhere else). Its owner and secrets are set here.
async function newDiscord(token: string, ownerId: string | null, secrets: string[]): Promise<Discord> {
  const { Discord: DiscordAdapter, createDiscordClient } = await import('./adapters/chat/discord.ts')
  const client = await createDiscordClient(token)
  return new DiscordAdapter(client, { ownerId, secrets })
}

export async function buildRouter(cfg: Config): Promise<Router> {
  const home = homedir()
  const oldTokens = cfg.oldToken ? [cfg.oldToken] : []
  const secrets = [cfg.token, ...oldTokens].filter((s) => s.length > 0)
  const tg = currentTgConfig()
  // chat.app "discord": the Discord adapter; otherwise Telegram (the e2e driver and the bot API stay as they were).
  const dcCfg = cfg.discord ?? null
  // The owner's user id (config.ts resolveTelegramOwner): null on a fresh install, until the owner pairs. On Discord it is
  // the raw snowflake (the adapter compares bare ids); the router's form is dc:<snowflake>.
  const ownerUserId = dcCfg ? dcCfg.ownerUserId : cfg.ownerUserId
  // The start-up home: chat.discord.homeId ("dc:g<guild>:l<lobby>") or chat.telegram.homeId ("tg:<n>", as a number) or the
  // old groupId. The store's id still wins.
  const startGroupId = tg.chat?.telegram?.homeId ? Number(tg.chat.telegram.homeId.slice(3)) : tg.groupId
  const startHome: ChatId | null = dcCfg ? (dcCfg.homeId as ChatId | null) : fromDbChat(startGroupId)
  // The E2E driver is on only when the router runs with STOLIK_E2E=1 (docs/e2e.md). Off, nothing below changes.
  const e2e = e2eEnabled() ? new E2e() : null
  // The store (SQLite, the v3 state folder) holds the structured state; the notes inbox and attachments stay files.
  const store = new SqliteStore({ stateDir: STATE_DIR, inboxDir: INBOX_DIR, notesDir: NOTES_DIR })
  // Logs: the level, the redaction list and the sink (warnings and errors to the Logs topic) are set before anything logs.
  const logThread: LogsThreadStore = {
    get: () => {
      const v = store.getAddonSetting(LOGS_SCOPE, LOGS_KEY)
      return v === null ? null : (storedId(v, legacyMsgId) as ThreadId | null)
    },
    set: (id) => store.setAddonSetting(LOGS_SCOPE, LOGS_KEY, id),
  }
  // The config's group id is a number on disk (store-ids decodes it); the store's value is already an id.
  const groupIdNow = (): ChatId | null => store.readGroupId() ?? startHome
  // The chat adapter: Telegram, or Discord (chat.app "discord"). The queued adapter (rate limit, priority), then the trace
  // decorator (message ids to traces, HTTP errors).
  const telegram: Telegram | null = dcCfg ? null : new Telegram(cfg.token, cfg.chatId, oldTokens, ownerUserId, e2e)
  const discord: Discord | null = dcCfg ? await newDiscord(cfg.token, dcCfg.ownerUserId, secrets) : null
  const port: ChatPort = (telegram ?? discord)!
  const queues = new OutboundQueues(systemClock, port.capabilities.rate)
  const queued = new QueuedChat(port, dcCfg ? '' : cfg.chatId, queues, (msg) => log(msg))
  const chat = new TracedChat(queued, store)
  // The Logs topic posts through the traced decorator; its own sends are quiet, so a failure there is not reported again.
  const logsTopic = new LogsTopic({ chat, store: logThread, enabled: tg.logsTopic, groupId: groupIdNow, clock: systemClock })
  configureLog({ level: tg.logLevel, secrets, sink: (r) => logsTopic.report(r) })
  if (e2e) log('e2e driver enabled (STOLIK_E2E=1): the router socket accepts injected messages and taps')
  const machine = tg
  const configDir = tgConfigDir()
  // Quota and usage (plan 2.8): the quota-gate reading is cached; mode runs and /usage use the same bridge.
  const quota = new QuotaCache(() => readQuotaGate(quotaGatePath(home), (f, a) => pinned(machine, f, a)), () => Date.now())
  const bridge = new AddonBridge({
    db: store,
    weeklyLimitPct: machine.weeklyLimitPct,
    quota: () => quota.get(),
    now: () => Date.now(),
    readChat: (from, days) => readChatDays(chatLogRoot(tg, home), from, days),
  })
  // Addons: the built-in folder (dist/addons: compiled code + manifests, read-only) and the user's folder (<config dir>/addons).
  const addons = new AddonHost({
    addonsDir: join(configDir, 'addons'),
    builtinDir: join(REPO_DIR, 'dist', 'addons'),
    settings: new DbAddonSettings(store),
    clock: systemClock,
    logger: { log, debug, warn: (m, c) => logWarn(m, c), error: (m, c) => logError(m, c) },
    alert: (text) => void chat.sendText(text).catch(() => {}),
    pin: (file, args) => pinned(machine, file, args),
    reservedCommands: [...ROUTER_COMMANDS, 'to'],
    env: gpuEnv(machine),
    requests: (addon, op, payload) => bridge.request(addon, op, payload),
    addonLog: (name, level, msg) => writeAddonLog(name, level, msg),
  })
  const info = buildInfo()
  // The chat's privacy checks at start (decision 12): Discord reads its bound server, Telegram its bound group. Off in the
  // e2e driver, which makes no network calls.
  const chatPrivacy = e2e
    ? undefined
    : dcCfg
      ? () => discord!.privacyChecks()
      : async () => {
          const g = groupIdNow()
          const tg = g === null ? null : telegramFor(cfg.token, g, ownerUserId)
          return tg === null || g === null ? [] : checkTelegramPrivacy({ ...tg, groupId: g })
        }
  // The opencode backend: one `opencode serve` per session. A message it cannot deliver is reported in the session's topic.
  const opencode = new OpencodeBackend({
    stateDir: STATE_DIR,
    model: tg.opencodeModel,
    socketPath: SOCKET_PATH,
    channelScript: join(REPO_DIR, 'dist', 'channel.js'),
    opencodeBin: resolveOpencodeBin(process.env, home, existsSync),
    onDeliveryError: (key, reason) => void router.reportDeliveryError(key, reason).catch(() => {}),
  })
  const router = new Router({
    // Before pairing nobody matches '' (see brain/approvals.ts isOwnerUser).
    ownerId: ownerUserId === null ? ('' as UserId) : dcCfg ? dcUser(ownerUserId) : tgUserOf(ownerUserId),
    ownerAlias: tg.chat?.ownerAlias ?? null,
    chatApp: dcCfg ? 'discord' : (tg.chat?.app ?? 'telegram'),
    groupId: startHome,
    // Redacted from every outbound text.
    secrets,
    home,
    socketPath: SOCKET_PATH,
    chat,
    store,
    platform: createPlatform(tg),
    agent: new ClaudeCodeBackend(home),
    agents: { opencode },
    ml: new Stt(),
    clock: systemClock,
    audit: { event: audit },
    logger: { log, debug, warn: (m, c) => logWarn(m, c), error: (m, c) => logError(m, c) },
    chatLog: new FilesChatLog(chatLogRoot(tg, home), (msg) => log(msg)),
    addons,
    usage: bridge,
    e2e: e2e ?? undefined,
    traces: store,
    logsTopic,
    forensics: (req) =>
      writeForensics(
        { dir: join(STATE_DIR, 'forensics'), now: () => new Date(), secrets, env: process.env, claudeVersion },
        req,
      ),
    debugExtras: async (): Promise<DebugExtras> => {
      const depths = queues.depths()
      const queueLabels: Record<string, number> = {}
      for (const [chat, n] of Object.entries(depths)) {
        const label = chat === cfg.chatId ? 'dm' : 'group'
        queueLabels[label] = (queueLabels[label] ?? 0) + n
      }
      const weekly = await quota.get().catch(() => null as QuotaStatus | null)
      return {
        version: info.version,
        gitSha: info.gitSha,
        queues: queueLabels,
        ml: await mlStatus(addons, machine.gpu),
        quota: weekly ? { weeklyUsedPct: weekly.weeklyUsedPct, aheadBy: weekly.aheadBy } : null,
      }
    },
    startupChecks: async () => {
      const settings = new DbAddonSettings(store)
      const facts = { isAddonEnabled: (name: string) => settings.isEnabled(name), groupId: groupIdNow }
      return runChecks({ ...buildDoctorDeps(facts), chatPrivacy }, 'startup')
    },
    routerAutoStart: tg.routerAutoStart,
    startWhenNoSession: tg.startWhenNoSession,
    idleCloseMinutes: tg.idleCloseMinutes,
    askDelay: tg.askDelay,
    claudeModel: tg.claudeModel,
    defaultAgent: tg.defaultAgent,
    // Fail closed: an unknown quota refuses an auto-start (the router asks before it starts anything by itself).
    quotaRefusal: () => bridge.quotaRefusal(),
    // An opencode session is stopped by its backend (its server is interrupted and its record forgotten); others by tmux.
    stopSession: async (name) => {
      if (opencode.ownsTmux(name)) {
        await opencode.killSession(name)
        return true
      }
      return killTmuxSession(name)
    },
  })
  // Pairing (plan 0e): the adapter hands private texts from non-owners to the pairing control; a confirmed sender becomes
  // the owner here and in the adapter, with no restart.
  const pairing = new PairingControl(STATE_DIR, (userId) => {
    if (discord) {
      // Discord: the owner's snowflake; the DM channel is opened on the first DM send.
      discord.setOwnerUserId(userId)
      router.ownerId = dcUser(userId)
      return
    }
    telegram!.setOwnerUserId(userId)
    // A private chat's id is the user's id: DM sends go there from now on.
    telegram!.setDmChat(userId)
    queued.setDmChat(userId)
    router.ownerId = tgUserOf(userId)
  })
  if (discord) discord.setPairing(pairing.hook())
  else telegram!.setPairing(pairing.hook())
  router.pairing = pairing
  bridge.attach(router)
  // Schedule points (the digest): the host ticks the due ones once a minute; each addon says how often it wants one.
  systemClock.setRepeating(() => void addons.tickSchedules().catch(() => {}), 60_000)
  return router
}
