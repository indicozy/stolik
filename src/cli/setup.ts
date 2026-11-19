// `stolik setup` (plan P3, design §5.1 and §6.2). Interactive. Every prompt and line of output goes through the
// injected deps, so tests answer with fakes and use temp paths. The token is never printed. This makes no Telegram
// calls: the group id is learned later from /bind (design §6.2).
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { TELEGRAM_GROUP_STEPS, type PairingDriver } from '../adapters/chat/telegram-setup.ts'
import { DISCORD_BIND_STEPS, discordInviteUrl, fetchClientId } from '../adapters/chat/discord-setup.ts'
import { formatMlPlan, llamaBuildPlan, mlInstallPlan, type MlSetupDeps } from './ml-setup.ts'
import { NPX_SERVICE_MESSAGE } from './install-location.ts'
import { runMigration } from './migrate.ts'

// BotFather tokens: "<bot id>:<secret>". The secret is letters, digits, "_" and "-".
export const TOKEN_RE = /^\d+:[A-Za-z0-9_-]{20,}$/
export const OWNER_RE = /^\d+$/

export type SetupPaths = {
  // The secrets file (secrets, chmod 600): ~/.config/stolik.env, or STOLIK_ENV_FILE when set (config.ts envFilePath).
  envFile: string
  // $XDG_CONFIG_HOME/stolik/config.json (machine config, merged, unknown keys kept).
  configFile: string
  // <repo>/plugin, the folder for `/plugin marketplace add`.
  pluginDir: string
  // The node that runs setup. Recorded as nodePath so the plugin launcher uses the same node (bin/tg-plugin-node).
  nodePath: string
  // True when this copy runs from the npx cache: the service step then says to install the package globally first.
  npxInstall?: boolean
}

export type SetupDeps = {
  // The flags given to `stolik setup` (parseSetupArgs). Absent: the defaults.
  options?: SetupOptions
  // The pairing (telegram-setup.ts makeTelegramPairing, or discord-setup.ts makeDiscordPairing). Absent: the owner id is
  // typed instead.
  pairing?: PairingDriver
  // Discord only: the client id for the invite link. Absent: read with fetchClientId.
  discord?: { clientId(token: string): Promise<string> }
  // Visible prompt. Resolves with the line typed ('' when stdin closed).
  ask(question: string): Promise<string>
  // Hidden prompt (no echo). Same resolution.
  askSecret(question: string): Promise<string>
  out(line: string): void
  paths: SetupPaths
  // The optional ML worker step (step 5). Absent: the step is not offered.
  ml?: MlSetupDeps
  // The one-time copy of the old tg-bridge settings (cli/migrate.ts), run first. Absent: no migration (tests).
  migration?: { home: string; env: NodeJS.ProcessEnv; isOldRunning: () => Promise<boolean> }
}

// Value of KEY in KEY=VALUE text (the last line wins), or null when absent or empty.
export function readEnvValue(text: string, key: string): string | null {
  let found: string | null = null
  const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*?)\\s*$`)
  for (const raw of text.split('\n')) {
    const m = re.exec(raw)
    if (m) found = m[1].replace(/^(["'])(.*)\1$/, '$2')
  }
  return found ? found : null
}

// Value of STOLIK_TOKEN in KEY=VALUE text, or null when absent or empty.
export function readEnvToken(text: string): string | null {
  return readEnvValue(text, 'STOLIK_TOKEN')
}

// Sets KEY in KEY=VALUE text: replaces every such line, or appends one. Other lines stay as they are.
export function mergeEnvKey(text: string, key: string, value: string): string {
  const body = text.replace(/\n+$/, '')
  const lines = body === '' ? [] : body.split('\n')
  const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`)
  let found = false
  const out = lines.map((line) => {
    if (re.test(line)) {
      found = true
      return `${key}=${value}`
    }
    return line
  })
  if (!found) out.push(`${key}=${value}`)
  return out.join('\n') + '\n'
}

// Sets STOLIK_TOKEN in KEY=VALUE text (see mergeEnvKey).
export function mergeEnvToken(text: string, token: string): string {
  return mergeEnvKey(text, 'STOLIK_TOKEN', token)
}

// Shallow merge of the keys setup owns over the existing config object. Keys setup does not own are kept as they are.
export function mergeConfig(existing: Record<string, unknown>, updates: Record<string, unknown>): Record<string, unknown> {
  return { ...existing, ...updates }
}

// The file a write to `path` really lands in: symlinks are followed, so a symlinked env or config file stays a symlink
// and its target gets the new contents. A dangling link is followed by hand (its target may not exist yet).
function writeTarget(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    // missing, or a dangling link: follow the links one step at a time
  }
  let cur = path
  for (let i = 0; i < 40; i++) {
    let isLink: boolean
    try {
      isLink = lstatSync(cur).isSymbolicLink()
    } catch {
      return cur
    }
    if (!isLink) return cur
    cur = resolve(dirname(cur), readlinkSync(cur))
  }
  throw new Error(`too many symbolic links: ${path}`)
}

// Writes a file in one step: a temp file made with the final mode, then a rename into the target. A secret is never left
// world-readable, and the temp file is removed when the write fails.
export function writeFileAtomic(path: string, text: string, mode: number): void {
  const target = writeTarget(path)
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  let done = false
  try {
    writeFileSync(tmp, text, { mode })
    chmodSync(tmp, mode)
    renameSync(tmp, target)
    done = true
  } finally {
    if (!done) rmSync(tmp, { force: true })
  }
}

// Reads a JSON object from a file; a missing file gives {}. Throws (naming the file) when the file is not a JSON object,
// so setup never overwrites a config it cannot read.
export function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`${path} is not valid JSON; fix or move it, then run setup again`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${path} must hold a JSON object`)
  return raw as Record<string, unknown>
}

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

export type SetupOptions = {
  // The chat app (--chat): telegram (default) or discord (not available yet).
  chat?: string
  // --pair: pair again even though an owner is saved.
  pair?: boolean
  // --owner-id <n>: the owner id without pairing (non-interactive, tests).
  ownerId?: string
}

// Reads the setup flags. Returns a message on a bad flag.
export function parseSetupArgs(args: string[]): SetupOptions | string {
  const opts: SetupOptions = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--pair') opts.pair = true
    else if (a === '--chat' || a === '--owner-id') {
      const v = args[i + 1]
      if (v === undefined || v.startsWith('--')) return `${a} needs a value`
      i++
      if (a === '--chat') opts.chat = v
      else opts.ownerId = v
    } else return `unknown option: ${a}`
  }
  return opts
}

// The owner already saved, from any of the three places (chat.telegram.ownerUserId, the top-level ownerUserId, TG_CHAT).
export function savedOwner(existingEnv: string, existingConfig: Record<string, unknown>): string | null {
  const chat = existingConfig.chat as { telegram?: { ownerUserId?: unknown } } | undefined
  const fromChat = chat?.telegram?.ownerUserId
  if (typeof fromChat === 'string' && fromChat !== '') return fromChat
  if (typeof existingConfig.ownerUserId === 'string' && existingConfig.ownerUserId !== '') return existingConfig.ownerUserId
  return readEnvValue(existingEnv, 'TG_CHAT')
}

// Runs the interactive setup. Returns the process exit code.
export async function runSetup(deps: SetupDeps): Promise<number> {
  const { paths, out } = deps
  const opts = deps.options ?? {}
  // Setup must not create fresh files next to an un-migrated old install, so a refused migration stops it.
  if (deps.migration) {
    const migrated = await runMigration({ ...deps.migration, log: out })
    if (migrated.refused) {
      out(migrated.refused)
      return 1
    }
  }
  const chat = opts.chat ?? 'telegram'
  if (chat === 'discord') return runDiscordSetup(deps)
  if (chat !== 'telegram') {
    out(`error: unknown chat app "${chat}" (telegram or discord)`)
    return 1
  }
  out('stolik setup')
  out('')
  out('1. Bot token. Create a bot with @BotFather (send /newbot) and paste its token here.')
  out('   The token is written to ' + paths.envFile + ' (chmod 600) and is not shown again.')

  let existingEnv: string
  let existingConfig: Record<string, unknown>
  try {
    existingEnv = readText(paths.envFile)
    existingConfig = readJsonObject(paths.configFile)
  } catch (e) {
    out(`error: ${(e as Error).message}`)
    return 1
  }
  const haveToken = readEnvToken(existingEnv) !== null

  const typed = (await deps.askSecret(haveToken ? 'Bot token [Enter keeps the saved one]: ' : 'Bot token: ')).trim()
  let token: string | null = null
  if (typed === '') {
    if (!haveToken) {
      out('error: no token given; run setup again')
      return 1
    }
  } else if (!TOKEN_RE.test(typed)) {
    out('error: that does not look like a bot token (digits, a colon, then letters and digits)')
    return 1
  } else {
    token = typed
  }
  const botToken = token ?? readEnvToken(existingEnv)

  // The owner. A saved owner is never asked again unless --pair is given: an upgraded install keeps its owner as it is.
  out('')
  const saved = savedOwner(existingEnv, existingConfig)
  let owner: string | null = null
  if (opts.ownerId !== undefined) {
    if (!OWNER_RE.test(opts.ownerId)) {
      out('error: the owner user id must be digits only')
      return 1
    }
    owner = opts.ownerId
  } else if (saved !== null && !opts.pair) {
    out(`2. owner already paired (id ${saved}). Run stolik setup --pair to pair again.`)
  } else if (deps.pairing && botToken !== null) {
    out('2. Owner. Pairing links the bot to your Telegram account.')
    const begun = await deps.pairing.begin(botToken)
    out(`   Send this code to ${begun.bot || 'your bot'} in a private chat (not a group): ${begun.code}`)
    out('   It works once, for 5 minutes. After 5 wrong codes it stops.')
    out('   Waiting for the code...')
    const res = await deps.pairing.wait(botToken)
    if (!res.ok) {
      out(`error: ${res.error}`)
      return 1
    }
    const who = [res.candidate.name, res.candidate.username ? `@${res.candidate.username}` : ''].filter(Boolean).join(' ')
    out(`   Code received from ${who || 'an account'} (user id ${res.candidate.userId}).`)
    const yes = YES_RE.test((await deps.ask('   Is this you? [y/N]: ')).trim())
    await deps.pairing.confirm(res.candidate.userId, yes)
    if (!yes) {
      out('   not saved. Run stolik setup --pair to pair again.')
      return 1
    }
    owner = res.candidate.userId
  } else {
    out('2. Your Telegram user id: the number of your own account (digits only). Messages from anyone else are ignored.')
    const ownerTyped = (await deps.ask(saved ? `Owner user id [${saved}]: ` : 'Owner user id: ')).trim()
    const typedOwner = ownerTyped === '' ? saved : ownerTyped
    if (typedOwner === null || !OWNER_RE.test(typedOwner)) {
      out('error: the owner user id must be digits only')
      return 1
    }
    owner = typedOwner
  }

  // TG_CHAT is the chat the router talks to before /bind: the owner's private chat, whose id is the owner's user id.
  // It follows a new owner; otherwise an existing TG_CHAT is kept as it is.
  let envText = token !== null ? mergeEnvToken(existingEnv, token) : existingEnv
  const ownerChanged = owner !== null && owner !== saved
  if (owner !== null && (ownerChanged || readEnvValue(envText, 'TG_CHAT') === null)) envText = mergeEnvKey(envText, 'TG_CHAT', owner)
  writeFileAtomic(paths.envFile, envText, 0o600)
  const updates: Record<string, unknown> = { nodePath: paths.nodePath }
  if (owner !== null) {
    const oldChat = (existingConfig.chat ?? {}) as Record<string, unknown>
    const oldTelegram = (oldChat.telegram ?? {}) as Record<string, unknown>
    updates.chat = { ...oldChat, app: oldChat.app ?? 'telegram', telegram: { ...oldTelegram, ownerUserId: owner } }
  }
  const config = mergeConfig(existingConfig, updates)
  writeFileAtomic(paths.configFile, JSON.stringify(config, null, 2) + '\n', 0o644)
  out('')
  out(`saved: ${paths.envFile} (${token !== null ? 'token, ' : ''}${owner !== null ? 'TG_CHAT, ' : ''}), ${paths.configFile} (${owner !== null ? 'chat.telegram.ownerUserId, ' : ''}nodePath)`)

  out('')
  out('3. ' + TELEGRAM_GROUP_STEPS.join('\n'))

  out('')
  out('4. Claude Code plugin. In Claude Code, run:')
  out(`     /plugin marketplace add ${paths.pluginDir}`)
  out('     /plugin install stolik@indicozy')
  out('   Start sessions with the channel on, then confirm the development-channels prompt once:')
  out('     claude --dangerously-load-development-channels plugin:stolik@indicozy')

  let code = 0
  if (deps.ml) code = await mlStep(deps, deps.ml)

  out('')
  if (paths.npxInstall) out('   ' + NPX_SERVICE_MESSAGE)
  out('6. Service. Run the router in your logon session with: stolik service install --start')
  return code
}

const YES_RE = /^y(es)?$/i

// `setup --chat discord`: the bot token into the env file, the invite link, the owner by DM pairing, and chat.app
// 'discord' in the config. The token is never printed.
export async function runDiscordSetup(deps: SetupDeps): Promise<number> {
  const { paths, out } = deps
  const opts = deps.options ?? {}
  out('stolik setup (Discord)')
  out('')
  for (const line of DISCORD_BIND_STEPS) out(line.startsWith('   ') ? line : '  ' + line)
  out('')

  let existingEnv: string
  let existingConfig: Record<string, unknown>
  try {
    existingEnv = readText(paths.envFile)
    existingConfig = readJsonObject(paths.configFile)
  } catch (e) {
    out(`error: ${(e as Error).message}`)
    return 1
  }
  const haveToken = readEnvValue(existingEnv, 'DISCORD_BOT_TOKEN') !== null
  const typed = (await deps.askSecret(haveToken ? 'Bot token [Enter keeps the saved one]: ' : 'Bot token: ')).trim()
  let token: string | null = null
  if (typed === '') {
    if (!haveToken) {
      out('error: no token given; run setup again')
      return 1
    }
  } else if (!DISCORD_TOKEN_RE.test(typed)) {
    out('error: that does not look like a bot token (no spaces, at least 50 characters)')
    return 1
  } else {
    token = typed
  }
  const botToken = token ?? readEnvValue(existingEnv, 'DISCORD_BOT_TOKEN')

  // The invite link needs the client id; a failed read prints the error and the manual step.
  if (botToken !== null) {
    try {
      const clientId = deps.discord ? await deps.discord.clientId(botToken) : await fetchClientId(botToken)
      out('')
      out(`Invite link (step b): ${discordInviteUrl(clientId)}`)
    } catch (e) {
      out('')
      out(`could not read the client id: ${redactToken((e as Error).message, botToken)}`)
      out('Find the Application ID under General Information in the Developer Portal, then open')
      out('  https://discord.com/oauth2/authorize?client_id=<Application ID>&permissions=70695161793616&scope=bot%20applications.commands')
    }
  }

  const oldChat = (existingConfig.chat ?? {}) as Record<string, unknown>
  const oldDiscord = (oldChat.discord ?? {}) as Record<string, unknown>
  const savedDc = typeof oldDiscord.ownerUserId === 'string' && oldDiscord.ownerUserId !== '' ? oldDiscord.ownerUserId : null

  out('')
  let owner: string | null = null
  if (opts.ownerId !== undefined) {
    if (!OWNER_RE.test(opts.ownerId)) {
      out('error: the owner user id must be digits only')
      return 1
    }
    owner = opts.ownerId
  } else if (savedDc !== null && !opts.pair) {
    out(`3. owner already paired (id ${savedDc}). Run stolik setup --chat discord --pair to pair again.`)
  } else if (deps.pairing && botToken !== null) {
    out('3. Owner. Pairing links the bot to your Discord account.')
    const begun = await deps.pairing.begin(botToken)
    out(`   Send this code to ${begun.bot || 'your bot'} in a direct message (the bot must share a server with you): ${begun.code}`)
    out('   It works once, for 5 minutes. After 5 wrong codes it stops.')
    out('   Waiting for the code...')
    const res = await deps.pairing.wait(botToken)
    if (!res.ok) {
      out(`error: ${res.error}`)
      return 1
    }
    const who = [res.candidate.name, res.candidate.username ? `@${res.candidate.username}` : ''].filter(Boolean).join(' ')
    out(`   Code received from ${who || 'an account'} (user id ${res.candidate.userId}).`)
    const yes = YES_RE.test((await deps.ask('   Is this you? [y/N]: ')).trim())
    await deps.pairing.confirm(res.candidate.userId, yes)
    if (!yes) {
      out('   not saved. Run stolik setup --chat discord --pair to pair again.')
      return 1
    }
    owner = res.candidate.userId
  } else {
    out('3. Your Discord user id: the snowflake of your own account (digits only). Messages from anyone else are ignored.')
    const ownerTyped = (await deps.ask(savedDc ? `Owner user id [${savedDc}]: ` : 'Owner user id: ')).trim()
    const typedOwner = ownerTyped === '' ? savedDc : ownerTyped
    if (typedOwner === null || !OWNER_RE.test(typedOwner)) {
      out('error: the owner user id must be digits only')
      return 1
    }
    owner = typedOwner
  }

  const envText = token !== null ? mergeEnvKey(existingEnv, 'DISCORD_BOT_TOKEN', token) : existingEnv
  writeFileAtomic(paths.envFile, envText, 0o600)
  const discordSection = owner !== null ? { ...oldDiscord, ownerUserId: owner } : oldDiscord
  const updates: Record<string, unknown> = {
    nodePath: paths.nodePath,
    chat: { ...oldChat, app: 'discord', discord: discordSection },
  }
  const config = mergeConfig(existingConfig, updates)
  writeFileAtomic(paths.configFile, JSON.stringify(config, null, 2) + '\n', 0o644)
  out('')
  out(`saved: ${paths.envFile} (${token !== null ? 'DISCORD_BOT_TOKEN, ' : ''}${owner !== null ? 'owner, ' : ''}), ${paths.configFile} (chat.app, ${owner !== null ? 'chat.discord.ownerUserId, ' : ''}nodePath)`)

  out('')
  out('4. Lobby. In a text channel of your server, send !bind (or /bind). That channel becomes the lobby.')
  out('')
  out('5. Claude Code plugin. In Claude Code, run:')
  out(`     /plugin marketplace add ${paths.pluginDir}`)
  out('     /plugin install stolik@indicozy')
  out('   Start sessions with the channel on, then confirm the development-channels prompt once:')
  out('     claude --dangerously-load-development-channels plugin:stolik@indicozy')

  let code = 0
  if (deps.ml) code = await mlStep(deps, deps.ml, 6)

  out('')
  if (paths.npxInstall) out('   ' + NPX_SERVICE_MESSAGE)
  out('7. Service. Run the router in your logon session with: stolik service install --start')
  return code
}

// A loose check for a Discord bot token: no spaces, at least 50 characters.
export const DISCORD_TOKEN_RE = /^\S{50,}$/

function redactToken(text: string, token: string): string {
  return token ? text.split(token).join('[token]') : text
}

// Step `step` (5 for Telegram setup, 6 for Discord, which has one more step before it), optional: creates ml/.venv and
// installs ml/requirements.txt. Two questions, both default no. The commands and the CUDA environment are printed before
// anything runs. An existing ml/.venv is reused, never removed. Returns 1 when asked and the install failed, so the caller
// can exit non-zero; the rest of setup has already been saved.
export async function mlStep(deps: SetupDeps, ml: MlSetupDeps, step = 5): Promise<number> {
  const { out } = deps
  out('')
  out(`${step}. ML worker (optional). Local speech-to-text, voice cleanup and digests run from ml/.venv.`)
  out('   Models download on first use. Without it, the voice, voice-cleanup and digest addons stay off.')
  if (!YES_RE.test((await deps.ask('   Set up ml/.venv now? [y/N]: ')).trim())) {
    out('   skipped. Run setup again to add it later.')
    return 0
  }
  const build = llamaBuildPlan(ml.tools())
  const plan = mlInstallPlan({
    root: ml.root,
    venv: ml.venvState(),
    uv: ml.uv,
    build,
    requirementsExists: ml.requirementsExists(),
  })
  if (!plan.ok) {
    out(`   error: ${plan.reason}`)
    return 1
  }
  for (const line of formatMlPlan(plan, build)) out(line)
  if (!YES_RE.test((await deps.ask('   Run these commands? [y/N]: ')).trim())) {
    out('   not run.')
    return 0
  }
  for (const step of plan.steps) {
    out(`   ${step.label}`)
    const status = await ml.run(step)
    if (status !== 0) {
      out(`   error: exit ${status}. Fix the cause and run setup again; ml/.venv is kept as it is.`)
      return 1
    }
  }
  out(`   ready: ${plan.venv}`)
  return 0
}
