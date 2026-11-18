// Router group mode (plan 2.1): /bind stores the supergroup, a group migration moves its id, and a join by anyone
// but the owner or the bot raises one alert in General (no kick).
import type { Inbound } from '../../brain/chat-types.ts'
import type { ChatEvent, ChatId, MessageId } from '../../brain/chat-types.ts'
import { decideChatEvent } from '../../brain/inbound.ts'
import { errMsg } from '../log.ts'
import { say } from '../send.ts'
import { offerBuiltins } from './builtins.ts'
import { inboundTarget } from '../topics.ts'
import { logSessionOut, syncPendingMarker } from '../approvals.ts'
import { APPROVAL_EXPIRED_TEXT } from '../state.ts'
import { ASK_BACK_TEXT } from '../shared.ts'
import { releaseAsk } from './ask.ts'
import type { Router } from '../core.ts'

export const BIND_TEXT =
  'Bound. This supergroup is the bot\'s home: each folder gets its own topic here. ' +
  'The bot needs admin rights with Manage Topics and Delete Messages.'
// The bind reply, per chat app (the rights each app needs differ).
export function bindText(chatApp: string): string {
  if (chatApp === 'discord') {
    return (
      'Bound. This channel is the bot\'s lobby. Each folder gets its own text channel under the stolik category of this server. ' +
      'The bot needs View Channel, Send Messages, Read Message History, Add Reactions, Attach Files, Manage Channels and ' +
      'Send Voice Messages (the invite link sets them).'
    )
  }
  return BIND_TEXT
}
export const ANONYMOUS_TEXT =
  'A message in the group was posted as the group (you are an anonymous admin), so the bot could not tell it was yours and ignored it. ' +
  'To write from your account, turn off "Remain anonymous" for your admin role in the group settings.'
export const JOIN_ALERT_TEXT =
  'A new member joined the group. The bot did not remove them; remove them in Telegram if you did not expect this.'

// Sets the bound group in the router, the adapter (where sends go) and the store (kept across restarts).
export function setGroupId(router: Router, id: ChatId): void {
  router.groupId = id
  router.chat.setHome(id)
  try {
    router.store.writeGroupId(id)
  } catch (e) {
    router.logger.log(`group id not saved: ${(e as Error).message}`)
  }
}

// /bind sent in a supergroup by the owner (decideInbound returns 'bind' only for that).
export async function bindGroup(router: Router, m: Inbound): Promise<void> {
  setGroupId(router, m.chat.id)
  router.audit.event({ event: 'bind' })
  router.logger.log('group bound')
  void router.logsTopic?.ensure()
  expireDmPrompts(router)
  await say(router, bindText(router.chatApp), m.messageId, inboundTarget(router, m))
  await offerBuiltins(router)
}

// Approvals and questions still waiting in the DM (sent before the group was bound) are closed: their answers would
// now belong to the group's topics, so the prompt ends and the terminal takes over.
export function expireDmPrompts(router: Router): void {
  for (const [id, p] of [...router.pending]) {
    // A prompt still in flight has no message yet, so it is not in the DM.
    if (p.messageId === null || router.chat.isDm?.(p.messageId) !== true) continue
    router.pending.delete(id)
    syncPendingMarker(router, p.session.pid)
    router.chat.editText(p.messageId, `${p.text}\n\n${APPROVAL_EXPIRED_TEXT}`, null).catch(() => {})
    logSessionOut(router, p.session, { dm: true }, 'expired', APPROVAL_EXPIRED_TEXT, p.messageId)
  }
  for (const a of [...router.asks.values()]) {
    const last = lastId(a)
    if (last !== null && router.chat.isDm?.(last) === true) releaseAsk(router, a, ASK_BACK_TEXT, 'released')
  }
}

// The ask's last message, null when it has none.
function lastId(a: { messageIds: readonly MessageId[] }): MessageId | null {
  return a.messageIds[a.messageIds.length - 1] ?? null
}

// The bot lost its rights in the group (removed, left, demoted, or without Manage Topics, or Telegram refused a send).
// Output goes to the DM until the rights return. Told once.
export function onAccessLost(router: Router, reason: string): void {
  if (!router.groupAccess) return
  router.groupAccess = false
  router.audit.event({ event: 'group_access', access: 'lost' })
  router.logger.log(`group access lost (${reason}); output goes to the DM`)
  const fix = router.chatApp === 'discord' ? 'give the bot the permissions named above' : 'give the bot admin with Manage Topics and Delete Messages'
  say(router, `The bot can no longer run the group (${reason}). Session output goes to this chat until its rights return: ${fix}.`, undefined, { dm: true })
    .catch((e) => router.logger.log(`access notice failed: ${errMsg(e)}`))
}

function onAccessBack(router: Router): void {
  if (router.groupAccess) return
  router.groupAccess = true
  router.audit.event({ event: 'group_access', access: 'ok' })
  router.logger.log('group access back; output goes to the topics')
  void say(router, 'The bot has its rights in the group again. Session output goes back to the topics.', undefined, { dm: true })
}

export async function onChatEvent(router: Router, e: ChatEvent): Promise<void> {
  const d = decideChatEvent(e, { groupId: router.groupId })
  if (d.action === 'set-group') {
    setGroupId(router, d.groupId)
    router.audit.event({ event: 'group_migrated' })
    router.logger.log(`group migrated; stored id is now ${d.groupId}`)
    return
  }
  if (d.action === 'join-alert') {
    router.audit.event({ event: 'member_joined' })
    await say(router, JOIN_ALERT_TEXT)
    return
  }
  if (d.action === 'access') {
    if (d.access === 'ok') onAccessBack(router)
    else onAccessLost(router, d.reason)
    return
  }
  if (d.action === 'anonymous-notice' && !router.anonymousNoticed) {
    router.anonymousNoticed = true
    router.audit.event({ event: 'anonymous_post' })
    await say(router, ANONYMOUS_TEXT)
  }
}
