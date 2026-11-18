// The bot's effective permissions in one channel (plan 23 §2, batch D2). Discord computes them from the server's roles
// and the channel's overwrites; this file does the same sum over the REST objects, so the adapter's start-up check and
// the doctor read one rule. Pure except fetchChannelPerms, which only calls the REST client it is given. The bits are
// written out (not imported from discord-api-types) so that the Telegram path can load this file without the library.

// Discord's permission bits (discord-api-types PermissionFlagsBits).
const PERM = {
  Administrator: 8n,
  ManageChannels: 16n,
  AddReactions: 64n,
  ReadMessageHistory: 65536n,
  ViewChannel: 1024n,
  SendMessages: 2048n,
  AttachFiles: 32768n,
  SendVoiceMessages: 1n << 46n,
} as const

// What the bridge needs in the bound lobby (a text channel): the replies, the reactions and the files.
export const LOBBY_PERMS: Array<[string, bigint]> = [
  ['View Channel', PERM.ViewChannel],
  ['Send Messages', PERM.SendMessages],
  ['Read Message History', PERM.ReadMessageHistory],
  ['Add Reactions', PERM.AddReactions],
  ['Attach Files', PERM.AttachFiles],
]
// What the folder channels need on top of the lobby set: creating and moving channels (Manage Channels), and voice notes.
export const FOLDER_EXTRA_PERMS: Array<[string, bigint]> = [
  ['Manage Channels', PERM.ManageChannels],
  ['Send Voice Messages', PERM.SendVoiceMessages],
]
// Every right the bridge asks for (decision 8). The invite link carries this integer.
export const BRIDGE_PERMS: Array<[string, bigint]> = [...LOBBY_PERMS, ...FOLDER_EXTRA_PERMS]
export const BRIDGE_PERMS_INTEGER: bigint = BRIDGE_PERMS.reduce((acc, [, bit]) => acc | bit, 0n)
// The bits written on the overwrites the adapter makes for the bot and the owner in each folder channel and category.
export const FOLDER_ALLOW_BITS: bigint = BRIDGE_PERMS_INTEGER
// The @everyone deny on every folder channel and category: nobody but the owner and the bot sees them.
export const EVERYONE_DENY_BITS: bigint = PERM.ViewChannel

const ALL = (1n << 64n) - 1n

export type PermRole = { id: string; permissions: string }
export type PermOverwrite = { id: string; type: number; allow: string; deny: string }
export type PermGuild = { id: string; owner_id: string; roles: PermRole[] }
export type PermChannel = { id: string; permission_overwrites?: PermOverwrite[] }

// The effective permissions of member `userId` (with `memberRoles`) in `channel`. Follows Discord's order: the guild
// owner and ADMINISTRATOR have everything; else the @everyone role and the member's roles, then the @everyone overwrite,
// the role overwrites (all at once), and the member overwrite.
export function effectivePerms(guild: PermGuild, memberRoles: string[], channel: PermChannel, userId: string): bigint {
  if (guild.owner_id === userId) return ALL
  const roleById = new Map(guild.roles.map((r) => [r.id, BigInt(r.permissions)] as const))
  let base = roleById.get(guild.id) ?? 0n
  for (const id of memberRoles) base |= roleById.get(id) ?? 0n
  if ((base & PERM.Administrator) === PERM.Administrator) return ALL
  const overwrites = channel.permission_overwrites ?? []
  const everyone = overwrites.find((o) => o.id === guild.id)
  if (everyone) base = (base & ~BigInt(everyone.deny)) | BigInt(everyone.allow)
  let allow = 0n
  let deny = 0n
  for (const o of overwrites) {
    if (o.type === 0 && memberRoles.includes(o.id)) {
      allow |= BigInt(o.allow)
      deny |= BigInt(o.deny)
    }
  }
  base = (base & ~deny) | allow
  const member = overwrites.find((o) => o.type === 1 && o.id === userId)
  if (member) base = (base & ~BigInt(member.deny)) | BigInt(member.allow)
  return base
}


// Whether strangers can see a channel: the @everyone role (its id is the guild's id) with its overwrite in the channel.
// Administrator on @everyone gives everyone every permission. Used by the privacy checks (discord-privacy.ts).
export function everyoneCanView(guild: PermGuild, channel: PermChannel): boolean {
  const role = guild.roles.find((r) => r.id === guild.id)
  let base = BigInt(role?.permissions ?? '0')
  if ((base & PERM.Administrator) === PERM.Administrator) return true
  const everyone = (channel.permission_overwrites ?? []).find((o) => o.type === 0 && o.id === guild.id)
  if (everyone) base = (base & ~BigInt(everyone.deny)) | BigInt(everyone.allow)
  return (base & PERM.ViewChannel) === PERM.ViewChannel
}

// The names of the wanted permissions that `have` lacks, in the table's order.
export function missingPerms(have: bigint, need: Array<[string, bigint]>): string[] {
  return need.filter(([, bit]) => (have & bit) !== bit).map(([name]) => name)
}

// The bot's effective permissions in a channel of a guild, read with three REST calls. `rest.get` is the adapter's REST.
export async function fetchChannelPerms(
  rest: { get(route: string): Promise<unknown> },
  guildId: string,
  channelId: string,
  botId: string,
): Promise<bigint> {
  const guild = (await rest.get(`/guilds/${guildId}`)) as PermGuild
  const member = (await rest.get(`/guilds/${guildId}/members/${botId}`)) as { roles: string[] }
  const channel = (await rest.get(`/channels/${channelId}`)) as PermChannel
  return effectivePerms(guild, member.roles ?? [], channel, botId)
}
