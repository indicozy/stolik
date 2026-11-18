// The Telegram part of `tg-bridge doctor` (plan 0e decision 7, inventory C): the bot's token and the bound group, checked
// through the Bot API. The doctor (cli/doctor.ts) runs it in the full scope only; the checks' ids and texts are the ones
// the doctor always printed, so a Telegram install's report does not change.
import { Bot } from 'grammy'
import type { ChatId } from '../../brain/chat-types.ts'
import type { Check } from '../../brain/observe.ts'
import { missingRights } from '../../brain/observe.ts'
import { tgNum } from './tg-ids.ts'

export type DoctorApi = {
  getMe(): Promise<{ id: number; username?: string }>
  getChat(chatId: number): Promise<{ type: string; is_forum?: boolean }>
  getChatMember(chatId: number, userId: number): Promise<{ status: string } & Record<string, unknown>>
}

// Network checks (full scope only): the token works; the bound group is a forum and the bot is an admin with the rights
// the router needs. Errors are redacted by the caller.
export async function checkTelegram(t: { api: DoctorApi; groupId: ChatId | null }): Promise<Check[]> {
  let me: { id: number; username?: string }
  try {
    me = await t.api.getMe()
  } catch (e) {
    return [{ id: 'token', title: 'bot token', status: 'fail', detail: `getMe failed: ${(e as Error).message}` }]
  }
  const out: Check[] = [{ id: 'token', title: 'bot token', status: 'ok', detail: me.username ? `@${me.username}` : 'valid' }]
  if (t.groupId === null) {
    out.push({ id: 'group', title: 'group', status: 'warn', detail: 'not bound (DM mode); /bind in the supergroup to use topics' })
    return out
  }
  try {
    // The DoctorApi is Telegram's own API: its chat ids are numbers.
    const chat = await t.api.getChat(tgNum(t.groupId))
    if (chat.type !== 'supergroup' || chat.is_forum !== true) {
      out.push({ id: 'group', title: 'group', status: 'fail', detail: 'the bound chat is not a forum (enable Topics in the group)' })
      return out
    }
    const member = await t.api.getChatMember(tgNum(t.groupId), me.id)
    const missing = missingRights(member)
    out.push(
      missing.length === 0
        ? { id: 'group', title: 'group', status: 'ok', detail: 'forum, bot is admin with topic, delete and pin rights' }
        : { id: 'group', title: 'group', status: 'fail', detail: `bot is missing: ${missing.join(', ')}` },
    )
  } catch (e) {
    out.push({ id: 'group', title: 'group', status: 'fail', detail: `group check failed: ${(e as Error).message}` })
  }
  return out
}

// The Bot API calls of the privacy checks (grammY's own shapes; the ids are numbers).
export type PrivacyApi = DoctorApi & {
  getChat(chatId: number): Promise<{ type: string; is_forum?: boolean; username?: string; join_by_request?: boolean; has_hidden_members?: boolean }>
  getChatMemberCount(chatId: number): Promise<number>
  getChatAdministrators(chatId: number, opts?: { return_bots?: boolean }): Promise<Array<{ user: { id: number; is_bot: boolean } }>>
}

// The privacy health checks (research/d1-brief.md decision 12) of the bound group: nobody but the owner and the bot can
// see or join it. Every finding is a warning with its fix on one line; none blocks. A call that fails is "not checked"
// (logged, never posted). Needs the owner's id to tell the owner from other admins; without it the admin check is not
// checked.
export async function checkTelegramPrivacy(t: { api: PrivacyApi; groupId: ChatId; ownerId: string | null }): Promise<Check[]> {
  const { api } = t
  const chatId = tgNum(t.groupId)
  const notChecked = (id: string, title: string, e: unknown): Check => ({
    id,
    title,
    status: 'warn',
    detail: `not checked: ${(e as Error).message}`,
    group: 'privacy',
  })
  let me: { id: number }
  let chat: Awaited<ReturnType<PrivacyApi['getChat']>>
  try {
    me = await api.getMe()
    chat = await api.getChat(chatId)
  } catch (e) {
    return [notChecked('public', 'group public', e), notChecked('members', 'group members', e), notChecked('admins', 'group admins', e)]
  }
  const out: Check[] = []
  out.push(
    chat.username
      ? { id: 'public', title: 'group public', status: 'warn', detail: `public: anyone can find it as @${chat.username}. fix: Group Info, Group type, make the group Private`, group: 'privacy' }
      : { id: 'public', title: 'group public', status: 'ok', detail: 'no public username', group: 'privacy' },
  )
  out.push({
    id: 'join-request',
    title: 'join by request',
    status: 'ok',
    detail: chat.join_by_request ? 'on: new members wait for an admin to approve them' : 'off (information)',
    group: 'privacy',
  })
  out.push({
    id: 'hidden-members',
    title: 'hidden members',
    status: 'ok',
    detail: chat.has_hidden_members ? 'on: the member list is hidden from non-admins (information)' : 'off (information)',
    group: 'privacy',
  })
  try {
    const n = await api.getChatMemberCount(chatId)
    out.push(
      n === 2
        ? { id: 'members', title: 'group members', status: 'ok', detail: '2 (the owner and the bot)', group: 'privacy' }
        : { id: 'members', title: 'group members', status: 'warn', detail: `${n} members; expected 2 (you and the bot). fix: remove the others, or use a group only you are in`, group: 'privacy' },
    )
  } catch (e) {
    out.push(notChecked('members', 'group members', e))
  }
  if (t.ownerId === null) {
    out.push({ id: 'admins', title: 'group admins', status: 'warn', detail: 'not checked: no owner is paired', group: 'privacy' })
    return out
  }
  try {
    // return_bots: other bots that are admins are listed too (the default leaves them out).
    const admins = await api.getChatAdministrators(chatId, { return_bots: true })
    const extra = admins.filter((a) => String(a.user.id) !== t.ownerId && a.user.id !== me.id)
    const bots = extra.filter((a) => a.user.is_bot).length
    out.push(
      extra.length === 0
        ? { id: 'admins', title: 'group admins', status: 'ok', detail: 'only the owner and the bot', group: 'privacy' }
        : {
            id: 'admins',
            title: 'group admins',
            status: 'warn',
            detail: `${extra.length} other admin${extra.length === 1 ? '' : 's'} (${bots} bot${bots === 1 ? '' : 's'}) can read the group. fix: Group Info, Administrators, remove them`,
            group: 'privacy',
          },
    )
  } catch (e) {
    out.push(notChecked('admins', 'group admins', e))
  }
  return out
}

// The bot's API and the bound group for the network checks (null in DM mode). Null when there is no token.
export function telegramFor(token: string | undefined, groupId: ChatId | null, ownerId: string | null = null): { api: PrivacyApi; groupId: ChatId | null; ownerId: string | null } | null {
  if (!token) return null
  const bot = new Bot(token)
  const api: PrivacyApi = {
    getMe: () => bot.api.getMe(),
    getChat: (id) => bot.api.getChat(id) as unknown as ReturnType<PrivacyApi['getChat']>,
    getChatMember: (id, uid) => bot.api.getChatMember(id, uid) as unknown as Promise<{ status: string } & Record<string, unknown>>,
    getChatMemberCount: (id) => bot.api.getChatMemberCount(id),
    getChatAdministrators: (id, opts) => bot.api.getChatAdministrators(id, opts) as unknown as ReturnType<PrivacyApi['getChatAdministrators']>,
  }
  return { api, groupId, ownerId }
}
