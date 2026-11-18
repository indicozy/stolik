// The Discord part of `tg-bridge doctor` (batch D2): the bot token, the bound lobby and the stolik folder categories, checked
// through the REST API. The privacy checks (discord-privacy.ts, Message Content intent included) run beside it. Loaded by
// cli/doctor.ts only when chat.app is 'discord'. Errors are redacted by the caller.
import type { Check } from '../../brain/observe.ts'
import type { DcRest } from './discord.ts'
import { BRIDGE_PERMS, fetchChannelPerms, LOBBY_PERMS, missingPerms } from './discord-perms.ts'
import { folderCategoryKind } from './discord-map.ts'

export type DoctorRest = Pick<DcRest, 'get' | 'post'>
export type DoctorHome = { guildId: string; lobbyId: string } | null

export async function checkDiscord(t: { rest: DoctorRest; home: DoctorHome }): Promise<Check[]> {
  const { rest } = t
  let me: { id: string; username?: string }
  try {
    me = (await rest.get('/users/@me')) as { id: string; username?: string }
  } catch (e) {
    return [{ id: 'token', title: 'bot token', status: 'fail', detail: `GET /users/@me failed: ${(e as Error).message}` }]
  }
  const out: Check[] = [{ id: 'token', title: 'bot token', status: 'ok', detail: me.username ? `@${me.username}` : 'valid' }]

  if (t.home === null) {
    out.push({ id: 'group', title: 'group', status: 'warn', detail: 'not bound (DM mode); send !bind in a text channel of your server' })
    return out
  }
  const { guildId, lobbyId } = t.home

  try {
    const ch = (await rest.get(`/channels/${lobbyId}`)) as { type?: number; guild_id?: string }
    if (ch.type !== 0 || ch.guild_id !== guildId) {
      out.push({ id: 'group', title: 'group', status: 'fail', detail: 'the bound lobby is not a text channel of the bound server' })
    } else {
      const missing = missingPerms(await fetchChannelPerms(rest, guildId, lobbyId, me.id), LOBBY_PERMS)
      out.push(
        missing.length === 0
          ? { id: 'group', title: 'group', status: 'ok', detail: 'lobby text channel; bot can read, post and attach files' }
          : { id: 'group', title: 'group', status: 'fail', detail: `bot is missing in the lobby: ${missing.join(', ')}` },
      )
    }
  } catch (e) {
    out.push({ id: 'group', title: 'group', status: 'fail', detail: `lobby check failed: ${(e as Error).message}` })
  }

  try {
    const channels = (await rest.get(`/guilds/${guildId}/channels`)) as Array<{ id: string; type: number; name?: string }>
    const cats = channels.filter((c) => c.type === 4 && folderCategoryKind(c.name) === 'active')
    const idle = channels.filter((c) => c.type === 4 && folderCategoryKind(c.name) === 'idle')
    if (cats.length === 0) {
      out.push({
        id: 'folders',
        title: 'folder categories',
        status: 'warn',
        detail: 'no stolik category yet (the bot creates it with the first folder; it needs Manage Channels)',
      })
    } else {
      // The bot makes and moves folder channels under the first active category: its rights there decide.
      const first = cats[0]!
      const missing = missingPerms(await fetchChannelPerms(rest, guildId, first.id, me.id), BRIDGE_PERMS)
      const names = `${cats.length} active${idle.length > 0 ? `, ${idle.length} idle` : ''}`
      out.push(
        missing.length === 0
          ? { id: 'folders', title: 'folder categories', status: 'ok', detail: `${names} (stolik); bot can create and move folder channels` }
          : { id: 'folders', title: 'folder categories', status: 'fail', detail: `bot is missing under stolik: ${missing.join(', ')}` },
      )
    }
  } catch (e) {
    out.push({ id: 'folders', title: 'folder categories', status: 'fail', detail: `folder check failed: ${(e as Error).message}` })
  }
  return out
}

// The REST client and the bound home for the checks (null when there is no token). Does not connect the gateway.
export async function discordFor(token: string | undefined, home: DoctorHome): Promise<{ rest: DoctorRest; home: DoctorHome } | null> {
  if (!token) return null
  const { createDiscordClient } = await import('./discord.ts')
  const client = await createDiscordClient(token)
  return { rest: client.rest, home }
}
