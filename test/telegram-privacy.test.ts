// Telegram privacy health checks (decision 12) with a fake Bot API: each check passes and fails with its fix text.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkTelegramPrivacy, type PrivacyApi } from '../src/adapters/chat/telegram-doctor.ts'
import { tgChat } from '../src/adapters/chat/tg-ids.ts'

const OWNER = '42'
const BOT = 7

type Chat = { type: string; is_forum?: boolean; username?: string; join_by_request?: boolean; has_hidden_members?: boolean }
type Admin = { user: { id: number; is_bot: boolean } }

// The fake API. Overrides replace one method; the admin call records its options.
function api(over: Partial<{ chat: Chat; count: number | Error; admins: Admin[] | Error }> = {}) {
  const seen: Array<{ admins: unknown }> = []
  const a: PrivacyApi = {
    getMe: async () => ({ id: BOT }),
    getChat: async () => over.chat ?? { type: 'supergroup', is_forum: true },
    getChatMember: async () => ({ status: 'administrator' }),
    getChatMemberCount: async () => {
      if (over.count instanceof Error) throw over.count
      return over.count ?? 2
    },
    getChatAdministrators: async (_id, opts) => {
      seen.push({ admins: opts })
      if (over.admins instanceof Error) throw over.admins
      return over.admins ?? [{ user: { id: Number(OWNER), is_bot: false } }, { user: { id: BOT, is_bot: true } }]
    },
  }
  return { a, seen }
}

const run = (o: Parameters<typeof api>[0] = {}, ownerId: string | null = OWNER) => {
  const { a, seen } = api(o)
  return checkTelegramPrivacy({ api: a, groupId: tgChat(-100), ownerId }).then((checks) => ({ checks, seen }))
}
const byId = (checks: Array<{ id: string }>, id: string) => checks.find((c) => c.id === id)!

test('a private group of the owner and the bot passes every finding check', async () => {
  const { checks, seen } = await run()
  assert.equal(byId(checks, 'public').status, 'ok')
  assert.equal(byId(checks, 'members').status, 'ok')
  assert.equal(byId(checks, 'admins').status, 'ok')
  assert.ok(checks.every((c) => c.group === 'privacy'))
  assert.deepEqual(seen, [{ admins: { return_bots: true } }], 'other bots are listed too')
})

test('a public username warns with the fix', async () => {
  const pub = byId((await run({ chat: { type: 'supergroup', is_forum: true, username: 'somegroup' } })).checks, 'public')
  assert.equal(pub.status, 'warn')
  assert.match(pub.detail, /@somegroup/)
  assert.match(pub.detail, /Group type, make the group Private/)
})

test('join by request and hidden members are information, never a warning', async () => {
  const { checks } = await run({ chat: { type: 'supergroup', is_forum: true, join_by_request: true, has_hidden_members: true } })
  assert.equal(byId(checks, 'join-request').status, 'ok')
  assert.match(byId(checks, 'join-request').detail, /approve/)
  assert.equal(byId(checks, 'hidden-members').status, 'ok')
})

test('more than two members warns with the fix', async () => {
  const members = byId((await run({ count: 4 })).checks, 'members')
  assert.equal(members.status, 'warn')
  assert.match(members.detail, /4 members.*remove the others/)
})

test('another admin, or another bot, warns with the fix and the count', async () => {
  const { checks } = await run({
    admins: [
      { user: { id: Number(OWNER), is_bot: false } },
      { user: { id: BOT, is_bot: true } },
      { user: { id: 555, is_bot: true } },
      { user: { id: 556, is_bot: false } },
    ],
  })
  const admins = byId(checks, 'admins')
  assert.equal(admins.status, 'warn')
  assert.match(admins.detail, /2 other admins \(1 bot\)/)
  assert.match(admins.detail, /Administrators, remove them/)
})

test('without a paired owner the admin check is "not checked"', async () => {
  const admins = byId((await run({}, null)).checks, 'admins')
  assert.equal(admins.status, 'warn')
  assert.match(admins.detail, /^not checked: no owner/)
})

test('a failed call is "not checked" and never a finding', async () => {
  const { checks } = await run({ count: new Error('Bad Gateway'), admins: new Error('Forbidden') })
  assert.ok(byId(checks, 'members').detail.startsWith('not checked'))
  assert.ok(byId(checks, 'admins').detail.startsWith('not checked'))
})

test('a failed getChat marks the group checks as not checked', async () => {
  const { a } = api()
  a.getChat = async () => {
    throw new Error('chat not found')
  }
  const checks = await checkTelegramPrivacy({ api: a, groupId: tgChat(-100), ownerId: OWNER })
  assert.deepEqual(checks.map((c) => c.status), ['warn', 'warn', 'warn'])
  assert.ok(checks.every((c) => c.detail.startsWith('not checked')))
})
