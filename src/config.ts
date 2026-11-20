import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

// The Telegram settings the router runs with. ownerUserId is null on a fresh install until the owner pairs (see
// brain/pairing.ts): the router then starts in pairing-only mode and answers nobody.
// On chat.app "discord" the token is DISCORD_BOT_TOKEN, the owner and the home are the chat.discord values (raw snowflakes,
// and "dc:g<guild>:l<lobby>"), and `ownerUserId` and `chatId` are unused (null and '').
export type Config = {
  token: string
  chatId: string
  oldToken?: string
  ownerUserId: string | null
  discord?: { ownerUserId: string | null; homeId: string | null }
}

// A config problem the owner has to fix. The message starts with "config error:" and names the file or setting.
// main.ts exits EXIT_CONFIG (78) on it.
export class ConfigError extends Error {
  constructor(detail: string) {
    super(`config error: ${detail}`)
    this.name = 'ConfigError'
  }
}

// Parse KEY=VALUE lines. Ignores blank lines and # comments, strips optional surrounding quotes.
function parseEnvFile(path: string): Record<string, string> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '')
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

// `~/x` expanded with the home folder; anything else unchanged.
export function expandHome(path: string, home: string = homedir()): string {
  return path.startsWith('~/') ? join(home, path.slice(2)) : path
}

// The secrets file. STOLIK_ENV_FILE (a trial instance beside the old bot) wins over ~/.config/stolik.env.
// The override must be an absolute path or start with ~/; anything else throws, naming the variable.
export function envFilePath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const override = env.STOLIK_ENV_FILE
  if (!override) return join(home, '.config', 'stolik.env')
  if (!isAbsolute(override) && !override.startsWith('~/')) {
    throw new ConfigError(`STOLIK_ENV_FILE must be an absolute path or start with ~/: ${override}`)
  }
  return expandHome(override, home)
}

// The Telegram owner: the user id of the owner's own account, which is also the number of their private chat with the
// bot. One rule, in this order: chat.telegram.ownerUserId, then the top-level ownerUserId (older configs), then TG_CHAT
// (secrets file, then telegram-notify.env). Null when none is set: a fresh install, before pairing.
export function resolveTelegramOwner(tg: TgConfig, bridgeChat: string | undefined, notifyChat: string | undefined): string | null {
  return tg.chat?.telegram?.ownerUserId ?? tg.ownerUserId ?? (bridgeChat || notifyChat || null)
}

// Throws ConfigError when the token is missing. The chat id is TG_CHAT (secrets file, then telegram-notify.env), else the
// owner's user id: in a private chat they are the same number. A missing owner is not an error (pairing-only mode).
export function loadConfig(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): Config {
  const envFile = envFilePath(env, home)
  const bridge = parseEnvFile(envFile)
  const notifyPath = join(home, '.config', 'telegram-notify.env')
  const notify = parseEnvFile(notifyPath)
  const token = bridge.STOLIK_TOKEN
  const cfgPath = tgConfigPath(env, home)
  const tg = loadTgConfig(cfgPath)
  if (tg.chat?.app === 'discord') {
    const discordToken = bridge.DISCORD_BOT_TOKEN
    if (!discordToken) throw new ConfigError(`DISCORD_BOT_TOKEN missing from ${envFile}`)
    return {
      token: discordToken,
      chatId: '',
      ownerUserId: null,
      discord: { ownerUserId: tg.chat.discord?.ownerUserId ?? null, homeId: tg.chat.discord?.homeId ?? null },
    }
  }
  const ownerUserId = resolveTelegramOwner(tg, bridge.TG_CHAT, notify.TG_CHAT)
  const chatId = bridge.TG_CHAT || notify.TG_CHAT || ownerUserId || ''
  if (!token) throw new ConfigError(`STOLIK_TOKEN missing from ${envFile}`)
  const config: Config = { token, chatId, ownerUserId }
  if (notify.TG_TOKEN) config.oldToken = notify.TG_TOKEN
  return config
}

const uid = process.getuid?.() ?? 0

// The v3 state folder: $XDG_STATE_HOME/stolik (default ~/.local/state/stolik). The old v2 folder
// (OLD_STATE_DIR) is never written by v3: the old bot and rollback use it.
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const xdg = env.XDG_STATE_HOME
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, '.local', 'state')
  return join(base, 'stolik')
}

// The v2 state folder (~/.local/state/tg-bridge). Not migration-only: the workers report (addons/workers/report.ts)
// reads it for helper processes, and scripts/migrate-to-v3.ts reads it. The v3 router never writes it.
export const OLD_STATE_DIR = join(homedir(), '.local', 'state', 'tg-bridge')

// The legacy tg-bridge locations, read only by the stolik migration (cli/migrate.ts). Functions of (home, env) so tests
// can use a temp home.
export function legacyEnvFile(home: string = homedir()): string {
  return join(home, '.config', 'tg-bridge.env')
}
export function legacyConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const xdg = env.XDG_CONFIG_HOME
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, '.config'), 'tg-bridge')
}
export function legacyStateDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const xdg = env.XDG_STATE_HOME
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, '.local', 'state'), 'tg-bridge-v3')
}

// legacy tg-bridge name, read only by the migration
export const LEGACY_ENV_FILE = legacyEnvFile()
// legacy tg-bridge name, read only by the migration
export const LEGACY_CONFIG_DIR = legacyConfigDir()
// legacy tg-bridge name, read only by the migration
export const LEGACY_STATE_DIR = legacyStateDir()
// legacy tg-bridge name, read only by the migration
export const LEGACY_DB_NAME = 'tg-bridge.db'
// legacy tg-bridge name, read only by the migration
export const LEGACY_ENV_PREFIX = 'TG_BRIDGE_'
// legacy tg-bridge name, read only by the migration
export const LEGACY_UNIT = 'tg-bridge.service'

export const INBOX_DIR = join(homedir(), '.cache', 'stolik', 'inbox')
// Notes saved from "note" messages (outside git, permanent). See router/notes.ts.
export const NOTES_DIR = join(homedir(), 'Documents', 'notes')
// Works from both src/config.ts and dist/config.js: the repo root is one level above either folder.
export const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---------- optional machine config (~/.config/stolik/config.json) ----------
// Machine specifics only. Secrets stay in ~/.config/stolik.env. The file is optional: a missing file, a missing key or
// null gives the neutral default. All keys (design §5.2, plan P1):
//   groupId        number | null   private supergroup with Topics; null = DM mode (default null). /bind wins at run time.
//   ownerUserId    "<digits>"|null Telegram user id of the owner; others are ignored (default null). Without TG_CHAT it is also the chat id.
//   logRoot        string          chat-log folder, absolute or ~/ (default ~/Documents/notes/telegram).
//   presence       "logind"|"x11"  idle and lock backend (default logind).
//   cpuAffinity    "8-19" | null   CPU list for spawned heavy work via taskset (default null = no pinning).
//   nice           0-19 | null     nice level for spawned heavy work (default null = no nice).
//   gpu            object | null   { cudaVisibleDevices, cudaDeviceOrder } for the ML worker (default null = CPU only).
//   weeklyLimitPct 1-100           weekly Claude quota limit in percent (default 99).
//   routerAutoStart "confirm"|"auto"|"off"  what a plain General message may do by itself (default "confirm"). "confirm":
//                                  a name or the model only offers one-tap buttons. "auto": a folder whose name leads the
//                                  message (for example "imgtune: ...") starts at once (quota permitting, one per 5 min).
//                                  "off": the route addon is never asked and names are not matched.
//   startWhenNoSession boolean     with no live session at all, a plain General message that is not a reply starts a session
//                                  by itself (a folder named or picked by the route addon, quota permitting), and a message in
//                                  a folder topic with no live session in that folder starts one there (default true).
//                                  false: the buttons and "No live session" text as before. routerAutoStart "off" wins.
//   digestSchedule "request"|"daily"|"weekly"  when the digest is made and sent (default "request": only on /digest).
//   nodePath       string | null   absolute path of the node that ran `stolik setup`; the plugin launcher prefers it
//                                  (plan P3). Null = use node from PATH.
//   stateDir       string | null   v3 state folder, absolute or ~/ (default $XDG_STATE_HOME/stolik).
//   socketPath     string | null   router socket, absolute or ~/ (default $XDG_RUNTIME_DIR/stolik.sock).
//   logLevel       debug|info|warn|error  lowest level kept in the logs (default info; see docs/design-v3.md Observability).
//   logsTopic      boolean         post warnings and errors to the "🛠 Logs" topic of the group (default true).
//   socketPath     string | null   router socket, absolute or ~/ (default: defaultSocketPath).
//   shutdownTimeoutMs integer > 0  hard limit for the router's shutdown, in ms (default 10000).
//   askDelay       {desk,away}     seconds (integers 0-3600) before a permission dialog of a plugin (AskUserQuestion, raced
//                                  against the terminal) is sent to Telegram: desk 60 (only if still unanswered), away 0 (at once).
//   claudeModel    string | null  model new sessions started by the bot get, as `--model <name>` (default null = Claude
//                                  Code's own default). `/model` in the bot overrides it. Running sessions keep theirs.
//   defaultAgent   "claude"|"opencode"  agent a new session the bot starts runs (default "claude"). Running sessions keep theirs.
//   opencodeModel  string | null   model for opencode sessions, as provider/model (for example "openrouter/qwen/qwen3-coder").
//                                  Default null: opencode's own default.
//   idleCloseMinutes integer 0-1440 minutes a session may sit idle before the router closes it (default 60; 0 = never).
//                                  Five minutes before, the topic gets a warning with a [Keep open] button. A session is closed only
//                                  when no busy check fails (a running command, a turn in progress, a scheduled wake-up, an unreadable
//                                  process tree or transcript): any check that cannot run keeps it open.

const CPU_LIST_RE = /^\d+(-\d+)?(,\d+(-\d+)?)*$/
export const DEFAULT_LOG_ROOT = '~/Documents/notes/telegram'
export const DEFAULT_WEEKLY_LIMIT_PCT = 99
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000
export const DEFAULT_ASK_DELAY = { desk: 60, away: 0 }
// Every range in the list ascends ("8-19" yes, "19-8" no). Single CPUs always pass.
const cpuRangesAscend = (s: string): boolean =>
  s.split(',').every((part) => {
    const [a, b] = part.split('-').map(Number)
    return b === undefined || a <= b
  })
const CUDA_LIST_RE = /^(\d+(,\d+)*)?$/
// A model name as Claude Code takes it after --model (an alias such as "sonnet" or a full id). It may not start with a
// dash, so it can never be read as another flag.
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$/
// An opencode model as provider/model (the provider part and the model part, which may hold further slashes).
export const OPENCODE_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._:/-]+$/

// The chat section (plan 5.1, inventory A). `app` picks the chat app; only telegram runs today. chat.telegram.homeId is the
// group id as "tg:<n>" (the store's home id still wins at run time, as groupId does).
export const CHAT_APPS = ['telegram', 'discord'] as const
export const ChatSchema = z
  .object({
    app: z.enum(CHAT_APPS).default('telegram'),
    ownerAlias: z.string().min(1).nullable().default(null),
    // Discord (plan 23): the owner's user snowflake (digits, kept as a string) and the bound home "dc:g<guild>:l<lobby>".
    discord: z
      .object({
        ownerUserId: z.string().regex(/^\d+$/, 'must be a numeric Discord user id (a snowflake, as a string)').nullable().default(null),
        homeId: z.string().regex(/^dc:g\d+:l\d+$/, 'must be "dc:g<guild>:l<channel>"').nullable().default(null),
      })
      .strict()
      .optional(),
    telegram: z
      .object({
        ownerUserId: z.string().regex(/^\d+$/, 'must be a numeric Telegram user id').nullable().default(null),
        homeId: z.string().regex(/^tg:-?\d+$/, 'must be "tg:<chat id>"').nullable().default(null),
      })
      .strict()
      .optional(),
  })
  .strict()

export type ChatConfig = z.infer<typeof ChatSchema>

export const TgConfigSchema = z
  .object({
    // The private supergroup with Topics (plan 2.1). Null or absent: DM mode. /bind stores the id at run time and
    // wins over this start-up value.
    groupId: z.number().int().nullable().default(null),
    // The owner's Telegram user id; messages and taps from anyone else are ignored. Absent: the DM chat id (TG_CHAT),
    // or this id as the chat id when TG_CHAT is not set (see loadConfig).
    ownerUserId: z.string().regex(/^\d+$/, 'must be a numeric Telegram user id').nullable().default(null),
    presence: z.enum(['x11', 'logind']).default('logind'),
    cpuAffinity: z
      .string()
      .regex(CPU_LIST_RE, 'must be a CPU list such as "8-19" or "0,2,8-10"')
      .refine(cpuRangesAscend, 'ranges must ascend, such as "8-19" (not "19-8")')
      .nullable()
      .default(null),
    nice: z.number().int().min(0).max(19).nullable().default(null),
    gpu: z
      .object({
        cudaVisibleDevices: z.string().regex(CUDA_LIST_RE, 'must be a comma list of device indexes such as "1"'),
        cudaDeviceOrder: z.enum(['PCI_BUS_ID', 'FASTEST_FIRST']),
      })
      .strict()
      .nullable()
      .default(null),
    // When the digest addon makes and sends its digest: "request" (only on /digest, the default), "daily" (04:00 local,
    // the day before) or "weekly" (Monday 04:00, the week before). Plan 3.4.
    digestSchedule: z.enum(['request', 'daily', 'weekly']).default('request'),
    // Weekly quota at which modes refuse (design §4.9). Percent, 1 to 100.
    weeklyLimitPct: z.number().int().min(1).max(100).default(DEFAULT_WEEKLY_LIMIT_PCT),
    // What a plain General message may do by itself (design §4.4): "confirm" (default), "auto" or "off".
    routerAutoStart: z.enum(['confirm', 'auto', 'off']).default('confirm'),
    // With no live session, a plain message that is not a reply starts one by itself (route.ts, inbound.ts topics). Default on.
    startWhenNoSession: z.boolean().default(true),
    // Minutes a session may sit idle before the router closes it (idle close, docs/design-v3.md §4.1). 0 turns it off.
    idleCloseMinutes: z.number().int().min(0).max(1440).default(60),
    // The node binary the plugin hooks and channel run with (bin/tg-plugin-node). Written by `stolik setup`.
    nodePath: z
      .string()
      .min(1)
      .refine((s) => s.startsWith('/'), 'must be an absolute path')
      .nullable()
      .default(null),
    // Folder of the chat log (log/, the daily Markdown files, attachments/). Absolute or starting with ~/.
    logRoot: z
      .string()
      .min(1)
      .refine((s) => s.startsWith('/') || s.startsWith('~/'), 'must be an absolute path or start with ~/')
      .default(DEFAULT_LOG_ROOT),
    // The v3 state folder (stolik.db, audit.log). Absolute or ~/. Null: $XDG_STATE_HOME/stolik.
    stateDir: z
      .string()
      .min(1)
      .refine((s) => s.startsWith('/') || s.startsWith('~/'), 'must be an absolute path or start with ~/')
      .nullable()
      .default(null),
    // The router's socket. Absolute or ~/. Null: defaultSocketPath(). STOLIK_SOCKET still wins.
    socketPath: z
      .string()
      .min(1)
      .refine((s) => s.startsWith('/') || s.startsWith('~/'), 'must be an absolute path or start with ~/')
      .nullable()
      .default(null),
    // Lowest level written to the journal and <stateDir>/logs/router.jsonl (debug, info, warn, error). `/debug on`
    // lowers it to debug for a while. Warnings and errors reach the Logs topic whatever this is.
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    // The "🛠 Logs" forum topic in the bound group, where warnings and errors are posted (rate-limited). false: no topic.
    logsTopic: z.boolean().default(true),
    // The hard limit for the router's shutdown (router/core.ts shutdownRouter), in milliseconds.
    shutdownTimeoutMs: z.number().int().positive().default(DEFAULT_SHUTDOWN_TIMEOUT_MS),
    // Seconds a raced plugin dialog waits before it is sent to Telegram, by the owner's desk or away mode (router/handlers/ask.ts).
    askDelay: z
      .object({
        desk: z.number().int().min(0).max(3600).default(DEFAULT_ASK_DELAY.desk),
        away: z.number().int().min(0).max(3600).default(DEFAULT_ASK_DELAY.away),
      })
      .strict()
      .default(DEFAULT_ASK_DELAY),
    // The model for new sessions the bot starts (`--model`). Null: Claude Code's own default.
    claudeModel: z
      .string()
      .regex(MODEL_RE, 'must be a model name such as "sonnet" or "claude-opus-4-1" (letters, digits, . _ : [ ] -; not starting with -)')
      .nullable()
      .default(null),
    // The agent a new session the bot starts runs: Claude Code or opencode. Running sessions keep theirs.
    defaultAgent: z.enum(['claude', 'opencode']).default('claude'),
    // The model for opencode sessions, as provider/model. Null: opencode's own default.
    opencodeModel: z
      .string()
      .regex(OPENCODE_MODEL_RE, 'must be provider/model, such as "openrouter/qwen/qwen3-coder" (letters, digits, . _ - and / : after the first /)')
      .nullable()
      .default(null),
    // The chat section (see ChatSchema). Absent in every config written before v3 chat support.
    chat: ChatSchema.optional(),
  })
  .strict()

export type TgConfig = z.infer<typeof TgConfigSchema>

// The chat-log folder with ~/ expanded (home is a parameter for tests).
export function chatLogRoot(cfg: Pick<TgConfig, 'logRoot'>, home: string = homedir()): string {
  return cfg.logRoot.startsWith('~/') ? join(home, cfg.logRoot.slice(2)) : cfg.logRoot
}

// Validates a parsed JSON value. Throws an Error naming each bad field.
export function parseTgConfig(raw: unknown): TgConfig {
  const r = TgConfigSchema.safeParse(raw)
  if (r.success) return r.data
  throw new Error(r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '))
}

// $XDG_CONFIG_HOME/stolik, or ~/.config/stolik. A relative XDG_CONFIG_HOME is ignored.
export function tgConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const xdg = env.XDG_CONFIG_HOME
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, '.config')
  return join(base, 'stolik')
}

// $XDG_CONFIG_HOME/stolik/config.json, or ~/.config/stolik/config.json. A relative XDG_CONFIG_HOME is ignored.
export function tgConfigPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(tgConfigDir(env, home), 'config.json')
}

// Reads and validates the config file. A missing file gives the defaults; a bad file throws a ConfigError naming the file.
export function loadTgConfig(path: string = tgConfigPath()): TgConfig {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return parseTgConfig({})
    throw new ConfigError(`cannot read ${path}: ${(e as Error).message}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new ConfigError(`${path} is not valid JSON: ${(e as Error).message}`)
  }
  try {
    return parseTgConfig(raw)
  } catch (e) {
    throw new ConfigError(`${path}: ${(e as Error).message}`)
  }
}

let cachedTgConfig: TgConfig | null = null

// The config for this process, loaded once. The router reads it at startup, so a bad file stops it there.
export function currentTgConfig(): TgConfig {
  cachedTgConfig ??= loadTgConfig()
  return cachedTgConfig
}

// The router socket when neither STOLIK_SOCKET nor config `socketPath` is set. The channel server and tg-claude apply
// the same rule (keep them in step). Linux: $XDG_RUNTIME_DIR/stolik.sock, or /run/user/<uid>/stolik.sock without it.
// Elsewhere with XDG_RUNTIME_DIR: the same file under it. Elsewhere without: <v3 state folder>/router.sock, unless that
// path is over 100 bytes (macOS sun_path is 104 with the NUL); then $TMPDIR/stolik-<uid>.sock (/tmp when TMPDIR is unset).
export function defaultSocketPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  const xdg = env.XDG_RUNTIME_DIR
  if (platform === 'linux') return join(xdg || `/run/user/${uid}`, 'stolik.sock')
  if (xdg) return join(xdg, 'stolik.sock')
  const path = join(defaultStateDir(env, home), 'router.sock')
  if (Buffer.byteLength(path) <= 100) return path
  const tmp = (env.TMPDIR || '/tmp').replace(/\/+$/, '')
  return `${tmp}/stolik-${uid}.sock`
}

// The path settings for STATE_DIR and SOCKET_PATH below, read when this module loads. A bad file must not crash every
// importer (channel server, notify, ipc, hook, addons), so the defaults are used here and the failure stays in
// currentTgConfig(), which the router and the CLI call on demand: they throw the ConfigError and exit EXIT_CONFIG (78).
function pathSettingsAtLoad(): TgConfig {
  try {
    return currentTgConfig()
  } catch {
    return parseTgConfig({})
  }
}
const pathSettings = pathSettingsAtLoad()

// Where the router keeps its database and audit log. Config `stateDir` wins over the XDG default.
export const STATE_DIR: string = pathSettings.stateDir !== null ? expandHome(pathSettings.stateDir) : defaultStateDir()
// The router socket. STOLIK_SOCKET (tests, a trial instance) wins over config `socketPath`, which wins over the default.
export const SOCKET_PATH: string =
  process.env.STOLIK_SOCKET ?? (pathSettings.socketPath !== null ? expandHome(pathSettings.socketPath) : defaultSocketPath())

// argv prefix that pins heavy work (design §5.2): `nice -n N` and/or `taskset -c LIST`. Empty when neither is set.
export function pinPrefix(cfg: Pick<TgConfig, 'nice' | 'cpuAffinity'>): string[] {
  const out: string[] = []
  if (cfg.nice !== null) out.push('nice', '-n', String(cfg.nice))
  if (cfg.cpuAffinity !== null) out.push('taskset', '-c', cfg.cpuAffinity)
  return out
}

// The file and argv to run `cmd args` under the configured pinning.
export function pinned(cfg: Pick<TgConfig, 'nice' | 'cpuAffinity'>, cmd: string, args: readonly string[]): { file: string; args: string[] } {
  const prefix = pinPrefix(cfg)
  if (prefix.length === 0) return { file: cmd, args: [...args] }
  return { file: prefix[0], args: [...prefix.slice(1), cmd, ...args] }
}

// Environment for GPU work. With no gpu config the worker is kept on CPU (CUDA_VISIBLE_DEVICES empty).
export function gpuEnv(cfg: Pick<TgConfig, 'gpu'>): Record<string, string> {
  if (cfg.gpu === null) return { CUDA_VISIBLE_DEVICES: '' }
  return { CUDA_DEVICE_ORDER: cfg.gpu.cudaDeviceOrder, CUDA_VISIBLE_DEVICES: cfg.gpu.cudaVisibleDevices }
}
