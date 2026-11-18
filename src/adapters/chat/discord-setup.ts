// The Discord part of `tg-bridge setup --chat discord` (batch D2): the bind steps, the invite URL, the client id, and the
// pairing driver. Pairing reuses brain/pairing.ts. With a router running, the router owns the gateway and answers the
// `pair` ctl command; with none, setup connects its own gateway and reads the owner's DM. Nothing here loads
// discord-api-types: the gateway intents are numbers.
import { existsSync, readFileSync } from 'node:fs'
import { attemptPairing, PAIR_TTL_MS, readPairing, startPairing } from '../../brain/pairing.ts'
import type { PairCandidate } from '../../router/pairing-control.ts'
import { oneShot } from '../channel/ipc.ts'
import { routerLockHeld } from '../instance-lock.ts'
import type { DcRest, DiscordClient } from './discord.ts'
import type { PairingDriver, PairResult } from './telegram-setup.ts'
import { parseDcChat } from './dc-ids.ts'
import { BRIDGE_PERMS_INTEGER } from './discord-perms.ts'

// The steps the owner follows (text as shown in setup).
export const DISCORD_BIND_STEPS: string[] = [
  'Bot. (a) In the Discord Developer Portal, New Application, then Bot, then Reset Token, and copy the token (it is',
  '   shown once; setup asks for it next). Under Bot, turn Message Content Intent on. Keep Public Bot OFF.',
  'Invite. (b) Open the invite link setup prints and add the bot to your server (needs Manage Server).',
  'Lobby. (c) In a text channel of that server, send !bind (or /bind). The bot answers and that channel becomes the',
  '   lobby. The bot makes one text channel per folder under a category named stolik (idle folders go to stolik-idle).',
  'Pair. (d) Send the pairing code to the bot in a direct message (the bot must share a server with you).',
]

// Gateway intents: DirectMessages (1 << 12) and MessageContent (1 << 15, privileged). Numbers, so this file does not load
// discord-api-types.
const PAIR_INTENTS = 4096 | 32768

const CLIENT_ID_RE = /^\d+$/

// The OAuth2 invite link for the bot. The permissions integer is the bridge's needs (BRIDGE_PERMS_INTEGER, discord-perms.ts).
export function discordInviteUrl(clientId: string): string {
  if (!CLIENT_ID_RE.test(clientId)) throw new Error(`not a Discord client id: ${JSON.stringify(clientId)}`)
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=${BRIDGE_PERMS_INTEGER}&scope=bot%20applications.commands`
}

// The application's id (the client id) from GET /applications/@me. Without `rest`, a REST client is made from the token.
export async function fetchClientId(token: string, rest?: Pick<DcRest, 'get'>): Promise<string> {
  const api = rest ?? (await loadClient(token, undefined)).rest
  const app = (await api.get('/applications/@me')) as { id?: unknown }
  if (typeof app.id !== 'string' || !CLIENT_ID_RE.test(app.id)) throw new Error('the reply has no application id')
  return app.id
}

export type GatewayFactory = (token: string, intents?: number) => Promise<DiscordClient>

async function loadClient(token: string, intents: number | undefined): Promise<DiscordClient> {
  const { createDiscordClient } = await import('./discord.ts')
  return createDiscordClient(token, intents)
}

const EXPIRED = 'the pairing code expired; run setup --pair again'

export type ChatSettings = { app: string; token: string | null; ownerId: string | null; homeId: string | null }

// The chat settings tg-notify and the doctor read: the app, the Discord token (env file), the owner and the home (config
// file). Never throws: a missing or unreadable file gives the defaults. Ids are raw strings, never numbers. Pure over the
// two texts when called with `envText` and `configText` (see readChatSettings for the files).
export function chatSettingsOf(envText: string, config: Record<string, unknown>): ChatSettings {
  const chat = (config.chat ?? {}) as { app?: unknown; discord?: { ownerUserId?: unknown; homeId?: unknown } }
  const dc = chat.discord ?? {}
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
  return {
    app: typeof chat.app === 'string' ? chat.app : 'telegram',
    token: readEnvLine(envText, 'DISCORD_BOT_TOKEN'),
    ownerId: str(dc.ownerUserId),
    homeId: str(dc.homeId),
  }
}

export function readChatSettings(envFile: string, configFile: string): ChatSettings {
  const none: ChatSettings = { app: 'telegram', token: null, ownerId: null, homeId: null }
  try {
    const envText = existsSync(envFile) ? readFileSync(envFile, 'utf8') : ''
    const config = existsSync(configFile) ? (JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>) : {}
    return chatSettingsOf(envText, config && typeof config === 'object' ? config : {})
  } catch {
    return none
  }
}

// Value of KEY in KEY=VALUE text (the last line wins), or null. Quotes are removed.
function readEnvLine(text: string, key: string): string | null {
  let found: string | null = null
  const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*?)\\s*$`)
  for (const raw of text.split('\n')) {
    const m = re.exec(raw)
    if (m) found = m[1]!.replace(/^(["'])(.*)\1$/, '$2')
  }
  return found ? found : null
}

// The home id of a config's Discord section as lobby and guild, or null when unset or malformed.
export function discordHome(homeId: string | null): { guildId: string; lobbyId: string } | null {
  if (homeId === null) return null
  try {
    const { guildId, channelId } = parseDcChat(homeId)
    return { guildId, lobbyId: channelId }
  } catch {
    return null
  }
}

// A pairing driver for the real setup: the router path or the gateway path, chosen at wait(). `gateway` is injectable
// for tests (the default loads @discordjs/* through createDiscordClient).
export function makeDiscordPairing(
  paths: { stateDir: string; socketPath: string },
  gateway: GatewayFactory = loadClient,
): PairingDriver {
  return {
    async begin(token) {
      const code = startPairing(paths.stateDir, 'discord')
      let bot = ''
      try {
        const client = await gateway(token, undefined)
        const me = (await client.rest.get('/users/@me')) as { username?: string }
        bot = me.username ? `@${me.username}` : ''
      } catch {
        // The name is for the owner's convenience only; the code works without it.
      }
      return { code, bot }
    },
    async wait(token) {
      if (routerLockHeld(paths.stateDir)) {
        const reply = await oneShot({ t: 'ctl', cmd: 'pair' }, PAIR_TTL_MS + 10_000)
        if (!reply) return { ok: false, error: 'the router is running but did not answer; stop it or try again' }
        if (reply.ok === true && reply.pair) return { ok: true, candidate: reply.pair as PairCandidate }
        return { ok: false, error: typeof reply.error === 'string' ? reply.error : 'pairing failed' }
      }
      return pollOwnDm(token, paths.stateDir, gateway)
    },
    async confirm(userId, yes) {
      if (!routerLockHeld(paths.stateDir)) return
      await oneShot({ t: 'ctl', cmd: 'pair_confirm', userId, yes }, 5_000)
    },
  }
}

// Setup listens for the owner's DM while the code is active. Ends on paired, expired, locked, or a connect failure.
export async function pollOwnDm(token: string, stateDir: string, gateway: GatewayFactory = loadClient): Promise<PairResult> {
  let client: DiscordClient
  try {
    client = await gateway(token, PAIR_INTENTS)
  } catch (e) {
    return { ok: false, error: `cannot start the Discord client: ${redact((e as Error).message, token)}` }
  }
  return new Promise<PairResult>((resolve) => {
    let done = false
    let timer: ReturnType<typeof setInterval> | null = null
    const finish = async (res: PairResult): Promise<void> => {
      if (done) return
      done = true
      if (timer !== null) clearInterval(timer)
      await client.gateway.destroy().catch(() => {})
      resolve(res)
    }
    timer = setInterval(() => {
      const p = readPairing(stateDir)
      if (p === null || p.expiresAt <= Date.now()) void finish({ ok: false, error: EXPIRED })
    }, 1000)
    client.gateway.on('MESSAGE_CREATE', async (data) => {
      if (done) return
      const m = data as DmMessage
      // Only direct messages from people: no guild messages (guild_id), no bots.
      if (m.guild_id !== undefined || m.author?.bot === true || typeof m.content !== 'string') return
      const verdict = attemptPairing(stateDir, m.content)
      if (verdict === 'paired') {
        await client.rest.post(`/channels/${m.channel_id}/messages`, { body: { content: 'Paired.' } }).catch(() => {})
        const name = m.author.global_name ?? m.author.username
        await finish({ ok: true, candidate: { userId: m.author.id, name, username: m.author.username ?? null } })
      } else if (verdict === 'expired' || verdict === 'locked') {
        await finish({
          ok: false,
          error: verdict === 'locked' ? 'too many wrong codes: pairing is locked; run setup --pair again' : EXPIRED,
        })
      }
    })
    client.gateway.connect().catch((e: unknown) => {
      const msg = redact((e as Error)?.message ?? String(e), token)
      const intent = /4014/.test(msg)
        ? 'Message Content intent is off: turn it on under Bot in the Developer Portal'
        : msg
      void finish({ ok: false, error: `cannot connect to Discord: ${intent}` })
    })
  })
}

type DmMessage = {
  channel_id: string
  guild_id?: string
  content?: unknown
  author: { id: string; username: string; global_name?: string | null; bot?: boolean }
}

function redact(text: string, token: string): string {
  return token ? text.split(token).join('[token]') : text
}
