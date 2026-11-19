// Decision table for inbound updates (plan 2.1): private / supergroup / other x owner / non-owner x message / tap x
// group id set / unset, plus bind, migration and member joins.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideChatEvent, decideInbound, isBindCommand, type InboundInput } from '../src/brain/inbound.ts'
import { tgChat } from "../src/adapters/chat/tg-ids.ts"

const OWNER = '4242'
const GROUP = -1001234567890
const GROUP_ID = tgChat(GROUP)
const DM_CHAT = tgChat(4242)
const OTHER_GROUP = tgChat(-1009999)
const BASIC_GROUP = tgChat(-55)
const NEW_GROUP_ID = tgChat(-1009876543210)

function input(over: Partial<InboundInput>): InboundInput {
  return { update: 'message', chatKind: 'dm', chatId: DM_CHAT, fromId: OWNER, ownerUserId: OWNER, groupId: null, text: 'hi', ...over }
}

type Row = { name: string; chatKind: ChatKind; chatId: string; fromOwner: boolean; update: 'message' | 'callback'; groupId: ChatId | null; want: string }

const TABLE: Row[] = [
  // DM mode (no group bound): today's behaviour.
  { name: 'DM mode, DM, owner, message', chatKind: 'dm', chatId: DM_CHAT, fromOwner: true, update: 'message', groupId: null, want: 'route' },
  { name: 'DM mode, DM, owner, tap', chatKind: 'dm', chatId: DM_CHAT, fromOwner: true, update: 'callback', groupId: null, want: 'route' },
  { name: 'DM mode, DM, other user, message', chatKind: 'dm', chatId: tgChat(999), fromOwner: false, update: 'message', groupId: null, want: 'ignore' },
  { name: 'DM mode, DM, other user, tap', chatKind: 'dm', chatId: tgChat(999), fromOwner: false, update: 'callback', groupId: null, want: 'ignore' },
  { name: 'DM mode, group, owner, message', chatKind: 'home', chatId: GROUP_ID, fromOwner: true, update: 'message', groupId: null, want: 'ignore' },
  { name: 'DM mode, group, owner, tap', chatKind: 'home', chatId: GROUP_ID, fromOwner: true, update: 'callback', groupId: null, want: 'ignore' },
  { name: 'DM mode, group, other user, message', chatKind: 'home', chatId: GROUP_ID, fromOwner: false, update: 'message', groupId: null, want: 'ignore' },
  { name: 'DM mode, basic group, owner, message', chatKind: 'other', chatId: BASIC_GROUP, fromOwner: true, update: 'message', groupId: null, want: 'ignore' },
  // Group mode (group bound).
  { name: 'group mode, DM, owner, message', chatKind: 'dm', chatId: DM_CHAT, fromOwner: true, update: 'message', groupId: GROUP_ID, want: 'use-group' },
  { name: 'group mode, DM, owner, tap', chatKind: 'dm', chatId: DM_CHAT, fromOwner: true, update: 'callback', groupId: GROUP_ID, want: 'use-group' },
  { name: 'group mode, DM, other user, message', chatKind: 'dm', chatId: tgChat(999), fromOwner: false, update: 'message', groupId: GROUP_ID, want: 'ignore' },
  { name: 'group mode, bound group, owner, message', chatKind: 'home', chatId: GROUP_ID, fromOwner: true, update: 'message', groupId: GROUP_ID, want: 'route' },
  { name: 'group mode, bound group, owner, tap', chatKind: 'home', chatId: GROUP_ID, fromOwner: true, update: 'callback', groupId: GROUP_ID, want: 'route' },
  { name: 'group mode, bound group, other user, message', chatKind: 'home', chatId: GROUP_ID, fromOwner: false, update: 'message', groupId: GROUP_ID, want: 'ignore' },
  { name: 'group mode, bound group, other user, tap', chatKind: 'home', chatId: GROUP_ID, fromOwner: false, update: 'callback', groupId: GROUP_ID, want: 'ignore' },
  { name: 'group mode, another supergroup, owner, message', chatKind: 'home', chatId: OTHER_GROUP, fromOwner: true, update: 'message', groupId: GROUP_ID, want: 'ignore' },
  { name: 'group mode, another supergroup, owner, tap', chatKind: 'home', chatId: OTHER_GROUP, fromOwner: true, update: 'callback', groupId: GROUP_ID, want: 'ignore' },
  { name: 'group mode, basic group, owner, message', chatKind: 'other', chatId: BASIC_GROUP, fromOwner: true, update: 'message', groupId: GROUP_ID, want: 'ignore' },
]

for (const row of TABLE) {
  test(`decideInbound: ${row.name} -> ${row.want}`, () => {
    const d = decideInbound(
      input({
        update: row.update,
        chatKind: row.chatKind,
        chatId: row.chatId,
        fromId: row.fromOwner ? OWNER : '999',
        groupId: row.groupId,
        text: row.update === 'message' ? 'hello' : undefined,
      }),
    )
    assert.equal(d.action, row.want)
  })
}

test('decideInbound: a DM in home mode is use-group (the link comes from the port, not the decision)', () => {
  assert.deepEqual(decideInbound(input({ groupId: GROUP_ID })), { action: 'use-group' })
})

test('decideInbound: /bind by the owner in any supergroup is a bind, bound or not', () => {
  assert.deepEqual(decideInbound(input({ chatKind: 'home', chatId: GROUP_ID, text: '/bind' })), { action: 'bind' })
  assert.deepEqual(decideInbound(input({ chatKind: 'home', chatId: OTHER_GROUP, text: '/bind', groupId: GROUP_ID })), { action: 'bind' })
  assert.deepEqual(decideInbound(input({ chatKind: 'home', chatId: GROUP_ID, text: '/bind@tg_bot' })), { action: 'bind' })
})

test('decideInbound: /bind from someone else, or in a DM or basic group, is ignored', () => {
  assert.deepEqual(decideInbound(input({ chatKind: 'home', chatId: GROUP_ID, fromId: '999', text: '/bind' })), { action: 'ignore' })
  assert.deepEqual(decideInbound(input({ chatKind: 'other', chatId: BASIC_GROUP, text: '/bind' })), { action: 'ignore' })
  assert.deepEqual(decideInbound(input({ chatKind: 'dm', text: '/bind' })), { action: 'route' })
})

test('decideInbound: a tap never binds (only a message does); an empty sender is ignored', () => {
  assert.deepEqual(decideInbound(input({ chatKind: 'home', chatId: GROUP_ID, update: 'callback', text: undefined })), { action: 'ignore' })
  assert.deepEqual(decideInbound(input({ fromId: '' })), { action: 'ignore' })
})

test('isBindCommand: /bind with optional bot name, not /binding', () => {
  assert.equal(isBindCommand('/bind'), true)
  assert.equal(isBindCommand('  /bind  '), true)
  assert.equal(isBindCommand('/bind@stolik_bot'), true)
  assert.equal(isBindCommand('/binding'), false)
  assert.equal(isBindCommand('bind'), false)
  assert.equal(isBindCommand(undefined), false)
})

test('decideChatEvent: a home move moves the id only when it is the bound home; other chats are ignored', () => {
  const ctx = { groupId: GROUP_ID }
  assert.deepEqual(decideChatEvent({ type: 'home-moved', from: GROUP_ID, to: NEW_GROUP_ID }, ctx), { action: 'set-group', groupId: NEW_GROUP_ID })
  assert.deepEqual(decideChatEvent({ type: 'home-moved', from: BASIC_GROUP, to: NEW_GROUP_ID }, ctx), { action: 'ignore' })
  assert.deepEqual(decideChatEvent({ type: 'home-moved', from: GROUP_ID, to: NEW_GROUP_ID }, { groupId: null }), { action: 'ignore' })
})

test('decideChatEvent: a stranger join raises one alert in the bound home only', () => {
  const join = (chat: typeof GROUP_ID, groupId: typeof GROUP_ID | null) =>
    decideChatEvent({ type: 'stranger-joined', chat, label: 'someone' }, { groupId })
  assert.deepEqual(join(GROUP_ID, GROUP_ID), { action: 'join-alert' })
  assert.deepEqual(join(OTHER_GROUP, GROUP_ID), { action: 'ignore' }, 'another chat')
  assert.deepEqual(join(GROUP_ID, null), { action: 'ignore' }, 'no alert before a home is bound')
})

test('decideChatEvent: the bot access state and unattributable posts apply to the bound home only', () => {
  const ctx = { groupId: GROUP_ID }
  assert.deepEqual(decideChatEvent({ type: 'access', chat: GROUP_ID, access: 'lost', reason: 'kicked' }, ctx), { action: 'access', access: 'lost', reason: 'kicked' })
  assert.deepEqual(decideChatEvent({ type: 'access', chat: GROUP_ID, access: 'ok', reason: 'creator' }, ctx), { action: 'access', access: 'ok', reason: 'creator' })
  assert.deepEqual(decideChatEvent({ type: 'access', chat: OTHER_GROUP, access: 'lost', reason: 'kicked' }, ctx), { action: 'ignore' })
  assert.deepEqual(decideChatEvent({ type: 'unattributable-post', chat: GROUP_ID }, ctx), { action: 'anonymous-notice' })
  assert.deepEqual(decideChatEvent({ type: 'unattributable-post', chat: OTHER_GROUP }, ctx), { action: 'ignore' })
})
