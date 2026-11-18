// The Telegram adapter classifies service updates (chat connector step 0d): member joins, the bot's own rights, group
// migration and anonymous posts become neutral ChatEvents here, so the brain never reads a Telegram status. Driven
// through grammY's handleUpdate, so the real handlers and middleware run.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Telegram, botAccess } from '../src/adapters/chat/telegram.ts'
import type { ChatEvent } from '../src/brain/chat-types.ts'
import { tgChat } from '../src/adapters/chat/tg-ids.ts'

const OWNER = '111'
const GROUP = -1001
const BOT_USER = { id: 999, is_bot: true, first_name: 'bot', username: 'bot' }
const GROUP_CHAT = { id: GROUP, type: 'supergroup', title: 'g' }
const OWNER_USER = { id: 111, is_bot: false, first_name: 'owner' }

// An adapter whose updates are fed by hand. `botInfo` is set so grammY does not ask Telegram who the bot is.
function adapter() {
  const tg = new Telegram('123:TEST', OWNER, [], OWNER)
  const events: ChatEvent[] = []
  tg.onChatEvent(async (e) => { events.push(e) })
  const internal = tg as unknown as { bot: { botInfo: unknown; handleUpdate(u: unknown): Promise<void> } }
  internal.bot.botInfo = { ...BOT_USER, can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false }
  return { events, feed: (u: unknown) => internal.bot.handleUpdate(u) }
}

const myChatMember = (status: string, canManageTopics?: boolean) => ({
  update_id: 1,
  my_chat_member: {
    chat: GROUP_CHAT,
    from: OWNER_USER,
    date: 1,
    old_chat_member: { status: 'administrator', user: BOT_USER, can_manage_topics: true },
    new_chat_member: { status, user: BOT_USER, can_manage_topics: canManageTopics },
  },
})

const chatMember = (oldStatus: string, newStatus: string, user: { id: number; is_bot: boolean; first_name: string } = { id: 777, is_bot: false, first_name: 'stranger' }) => ({
  update_id: 2,
  chat_member: {
    chat: GROUP_CHAT,
    from: OWNER_USER,
    date: 1,
    old_chat_member: { status: oldStatus, user },
    new_chat_member: { status: newStatus, user },
  },
})

test('the bot can run the home only as creator, or as admin with Manage Topics', () => {
  assert.equal(botAccess('creator', false), 'ok')
  assert.equal(botAccess('administrator', true), 'ok')
  assert.equal(botAccess('administrator', false), 'lost', 'admin without topic rights')
  assert.equal(botAccess('member', false), 'lost')
  assert.equal(botAccess('restricted', true), 'lost')
  assert.equal(botAccess('left', false), 'lost')
  assert.equal(botAccess('kicked', false), 'lost')
})

test('my_chat_member becomes an access event with the platform status as the reason', async () => {
  const h = adapter()
  await h.feed(myChatMember('kicked'))
  await h.feed(myChatMember('administrator', true))
  await h.feed(myChatMember('administrator', false))
  assert.deepEqual(h.events, [
    { type: 'access', chat: tgChat(GROUP), access: 'lost', reason: 'kicked' },
    { type: 'access', chat: tgChat(GROUP), access: 'ok', reason: 'administrator' },
    { type: 'access', chat: tgChat(GROUP), access: 'lost', reason: 'administrator' },
  ])
})

test('a stranger joining raises a stranger-joined event; the owner, a bot, a leave and no change do not', async () => {
  const h = adapter()
  await h.feed(chatMember('left', 'member'))
  await h.feed(chatMember('kicked', 'administrator'))
  await h.feed(chatMember('left', 'member', OWNER_USER))
  await h.feed(chatMember('left', 'member', { id: 999, is_bot: true, first_name: 'bot' }))
  await h.feed(chatMember('member', 'member'))
  await h.feed(chatMember('member', 'left'))
  assert.deepEqual(h.events, [
    { type: 'stranger-joined', chat: tgChat(GROUP), label: 'stranger' },
    { type: 'stranger-joined', chat: tgChat(GROUP), label: 'stranger' },
  ])
})

test('a message posted as the group itself is an unattributable post', async () => {
  const h = adapter()
  await h.feed({
    update_id: 3,
    message: { message_id: 5, date: 1, chat: GROUP_CHAT, from: OWNER_USER, sender_chat: GROUP_CHAT, text: 'hi' },
  })
  assert.deepEqual(h.events, [{ type: 'unattributable-post', chat: tgChat(GROUP) }])
})

test('a group that became a supergroup reports home-moved from the old id to the new one', async () => {
  const h = adapter()
  await h.feed({
    update_id: 4,
    message: { message_id: 6, date: 1, chat: { id: -55, type: 'group', title: 'g' }, from: OWNER_USER, migrate_to_chat_id: GROUP },
  })
  assert.deepEqual(h.events, [{ type: 'home-moved', from: tgChat(-55), to: tgChat(GROUP) }])
})
