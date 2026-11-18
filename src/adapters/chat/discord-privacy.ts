// The privacy health checks of the Discord adapter (research/d1-brief.md decision 12): can anyone but the owner and the
// bot see the bridge's chat? Every check is a warning with its fix on one line; none blocks anything. Run by the doctor
// (both scopes) and by the router at start through the adapter. The REST client is the adapter's (or the doctor's), so
// the checks run on fakes in tests. Invites are not listed (that needs Manage Server): the check says so.
import type { Check } from '../../brain/observe.ts'
import { everyoneCanView, type PermChannel, type PermGuild, type PermOverwrite } from './discord-perms.ts'
import { folderCategoryKind } from './discord-map.ts'

export type PrivacyRest = { get(route: string, o?: { query?: URLSearchParams }): Promise<unknown> }
export type PrivacyHome = { guildId: string; lobbyId: string } | null

const CATEGORY_TYPE = 4
const TEXT_TYPE = 0
const INTENT_MESSAGE_CONTENT = 1 << 18
const INTENT_MESSAGE_CONTENT_LIMITED = 1 << 19
const WITH_COUNTS = new URLSearchParams({ with_counts: 'true' })
const INVITES_NOT_CHECKED =
  'not checked: listing server invites needs Manage Server; in Server Settings, Invites, remove any invite you do not know'

const priv = (c: Omit<Check, 'group'>): Check => ({ ...c, group: 'privacy' })
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// The member count of a server (the bot counts as a member), or null when Discord does not report it.
export async function memberCount(rest: PrivacyRest, guildId: string): Promise<number | null> {
  const g = (await rest.get(`/guilds/${guildId}`, { query: WITH_COUNTS })) as { approximate_member_count?: number }
  return typeof g.approximate_member_count === 'number' ? g.approximate_member_count : null
}

// The application's checks: the bot is not public, and the Message Content intent is on. Needs no bound server.
export async function checkDiscordApp(rest: PrivacyRest): Promise<Check[]> {
  let app: { bot_public?: boolean; flags?: number }
  try {
    app = (await rest.get('/applications/@me')) as { bot_public?: boolean; flags?: number }
  } catch (e) {
    return [
      priv({ id: 'public', title: 'bot public', status: 'warn', detail: `not checked: could not read the app: ${errText(e)}` }),
      priv({ id: 'intent', title: 'Message Content intent', status: 'warn', detail: `not checked: could not read the app: ${errText(e)}` }),
    ]
  }
  const pub =
    app.bot_public === true
      ? priv({ id: 'public', title: 'bot public', status: 'warn', detail: 'public: anyone can add the bot to their server. fix: Developer Portal, your app, Bot, turn Public Bot off' })
      : app.bot_public === false
        ? priv({ id: 'public', title: 'bot public', status: 'ok', detail: 'private: only its owner can add it' })
        : priv({ id: 'public', title: 'bot public', status: 'warn', detail: 'not checked: Discord did not report bot_public' })
  const flags = app.flags ?? 0
  const intentOn = (flags & INTENT_MESSAGE_CONTENT) !== 0 || (flags & INTENT_MESSAGE_CONTENT_LIMITED) !== 0
  const intent = intentOn
    ? priv({ id: 'intent', title: 'Message Content intent', status: 'ok', detail: 'on' })
    : priv({ id: 'intent', title: 'Message Content intent', status: 'warn', detail: 'off: the bot cannot read messages. fix: Developer Portal, your app, Bot, turn on Message Content Intent' })
  return [pub, intent]
}

// Whether @everyone can see a channel. A channel without its own @everyone overwrite inherits its category's (Discord's
// sync), so the category's overwrite counts when the channel has none.
export function visibleToEveryone(guild: PermGuild, channel: PermChannel, parent: PermChannel | null): boolean {
  const own = channel.permission_overwrites ?? []
  const inherited: PermOverwrite[] =
    own.some((o) => o.id === guild.id) || parent === null ? [] : (parent.permission_overwrites ?? []).filter((o) => o.id === guild.id)
  return everyoneCanView(guild, { id: channel.id, permission_overwrites: [...own, ...inherited] })
}

// The bound server's checks: its member count (the owner and the bot are two), and whether @everyone can see the lobby
// and any folder (the stolik categories and the channels under them; named only when the count is above two). Invites
// are listed as not checked.
export async function checkDiscordServer(rest: PrivacyRest, home: { guildId: string; lobbyId: string }): Promise<Check[]> {
  const out: Check[] = []
  let guild: PermGuild & { approximate_member_count?: number }
  let lobby: PermChannel & { name?: string }
  let channels: Array<PermChannel & { type: number; name?: string; parent_id?: string | null }>
  try {
    guild = (await rest.get(`/guilds/${home.guildId}`, { query: WITH_COUNTS })) as typeof guild
    lobby = (await rest.get(`/channels/${home.lobbyId}`)) as typeof lobby
    channels = (await rest.get(`/guilds/${home.guildId}/channels`)) as typeof channels
  } catch (e) {
    const why = `not checked: ${errText(e)}`
    return [
      priv({ id: 'members', title: 'server members', status: 'warn', detail: why }),
      priv({ id: 'visibility', title: 'channel visibility', status: 'warn', detail: why }),
      priv({ id: 'invites', title: 'server invites', status: 'warn', detail: INVITES_NOT_CHECKED }),
    ]
  }
  const n = typeof guild.approximate_member_count === 'number' ? guild.approximate_member_count : null
  if (n === null) out.push(priv({ id: 'members', title: 'server members', status: 'warn', detail: 'not checked: Discord did not report the member count' }))
  else if (n <= 2) out.push(priv({ id: 'members', title: 'server members', status: 'ok', detail: `${n} (the owner and the bot)` }))
  else
    out.push(
      priv({
        id: 'members',
        title: 'server members',
        status: 'warn',
        detail: `${n} members; expected 2 (you and the bot). fix: remove the others, or use a server only you are in`,
      }),
    )

  const categories = channels.filter((c) => c.type === CATEGORY_TYPE && folderCategoryKind(c.name) !== null)
  const visible: string[] = []
  if (visibleToEveryone(guild, lobby, null)) visible.push(`#${lobby.name ?? 'lobby'}`)
  for (const cat of categories) {
    if (visibleToEveryone(guild, cat, null)) visible.push(`category ${cat.name}`)
  }
  for (const c of channels) {
    if (c.type !== TEXT_TYPE || c.parent_id === null || c.parent_id === undefined) continue
    const parent = categories.find((k) => k.id === c.parent_id)
    if (parent && visibleToEveryone(guild, c, parent)) visible.push(`#${c.name ?? 'folder'}`)
  }
  if (n !== null && n > 2 && visible.length > 0) {
    out.push(
      priv({
        id: 'visibility',
        title: 'channel visibility',
        status: 'warn',
        detail: `${visible.join(', ')} can be seen by @everyone while the server has ${n} members. fix: in each channel, Edit Channel, Permissions, deny View Channel for @everyone`,
      }),
    )
  } else {
    out.push(priv({ id: 'visibility', title: 'channel visibility', status: 'ok', detail: visible.length === 0 ? 'not visible to @everyone' : 'only the owner and the bot are in the server' }))
  }
  out.push(priv({ id: 'invites', title: 'server invites', status: 'warn', detail: INVITES_NOT_CHECKED }))
  return out
}

// All the Discord privacy checks for the given home (the server part only when a home is bound).
export async function checkDiscordPrivacy(t: { rest: PrivacyRest; home: PrivacyHome }): Promise<Check[]> {
  const app = await checkDiscordApp(t.rest)
  return t.home === null ? app : [...app, ...(await checkDiscordServer(t.rest, t.home))]
}
