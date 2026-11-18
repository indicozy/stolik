// Discord privacy health checks (decision 12): application and server facts, with a fake REST. Every check passes and
// fails with its fix text; a failed read is "not checked" (a warning that the router never posts).
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkDiscordApp, checkDiscordPrivacy, checkDiscordServer, memberCount } from '../src/adapters/chat/discord-privacy.ts'

type Routes = Record<string, unknown>
type Call = { route: string; query: string | null }

// A fake REST: a route maps to its reply, or to an Error to throw. Unknown routes throw 404. Records every call.
function fakeRest(routes: Routes, calls: Call[] = []) {
  return {
    calls,
    get: async (route: string, o?: { query?: URLSearchParams }) => {
      calls.push({ route, query: o?.query ? o.query.toString() : null })
      const v = routes[route]
      if (v instanceof Error) throw v
      if (v === undefined) throw new Error(`404 ${route}`)
      return v
    },
  }
}

// Guild 7, lobby channel 5, category 8 named stolik with folder channel 9 under it. @everyone is role 7 with `everyone`
// permissions (default: none, so strangers cannot view). `count` is approximate_member_count. Overwrites apply to the lobby
// and the category; the folder inherits the category's @everyone overwrite when it has none of its own.
function rig(opts: { count?: number; everyone?: string; lobbyOw?: unknown[]; forumOw?: unknown[]; over?: Routes } = {}): Routes {
  return {
    '/applications/@me': { bot_public: false, flags: 1 << 18 },
    '/guilds/7': {
      id: '7',
      owner_id: '99',
      approximate_member_count: opts.count ?? 2,
      roles: [{ id: '7', permissions: opts.everyone ?? '0' }],
    },
    '/channels/5': { id: '5', name: 'bridge', type: 0, permission_overwrites: opts.lobbyOw ?? [] },
    '/guilds/7/channels': [
      { id: '8', type: 4, name: 'stolik', permission_overwrites: opts.forumOw ?? [] },
      { id: '9', type: 0, name: 'app', parent_id: '8', permission_overwrites: [] },
    ],
    ...opts.over,
  }
}

const home = { guildId: '7', lobbyId: '5' }
const VIEW = '1024'
const denyView = [{ id: '7', type: 0, allow: '0', deny: VIEW }]
const allowView = [{ id: '7', type: 0, allow: VIEW, deny: '0' }]
const byId = (checks: Array<{ id: string }>, id: string) => checks.find((c) => c.id === id)!

test('bot_public false passes; true warns with the fix', async () => {
  const pass = await checkDiscordApp(fakeRest({ '/applications/@me': { bot_public: false, flags: 1 << 18 } }))
  assert.equal(byId(pass, 'public').status, 'ok')
  const fail = await checkDiscordApp(fakeRest({ '/applications/@me': { bot_public: true, flags: 1 << 18 } }))
  const pub = byId(fail, 'public')
  assert.equal(pub.status, 'warn')
  assert.equal(pub.group, 'privacy')
  assert.match(pub.detail, /Developer Portal.*Public Bot off/)
})

test('application read failure: both app checks are "not checked" warnings', async () => {
  const checks = await checkDiscordApp(fakeRest({ '/applications/@me': new Error('503 Service Unavailable') }))
  assert.deepEqual(checks.map((c) => [c.id, c.status]), [['public', 'warn'], ['intent', 'warn']])
  assert.ok(checks.every((c) => c.detail.startsWith('not checked')))
})

test('a server of two (owner and bot) passes the member count', async () => {
  const checks = await checkDiscordServer(fakeRest(rig({ count: 2 })), home)
  assert.equal(byId(checks, 'members').status, 'ok')
  assert.equal(byId(checks, 'visibility').status, 'ok')
})

test('more members warn with the fix text', async () => {
  const members = byId(await checkDiscordServer(fakeRest(rig({ count: 5 })), home), 'members')
  assert.equal(members.status, 'warn')
  assert.match(members.detail, /5 members.*remove the others/)
})

test('@everyone can view the lobby with more than two members: the lobby is named with the fix', async () => {
  const checks = await checkDiscordServer(fakeRest(rig({ count: 3, everyone: VIEW })), home)
  const vis = byId(checks, 'visibility')
  assert.equal(vis.status, 'warn')
  assert.match(vis.detail, /#bridge, category stolik, #app/)
  assert.match(vis.detail, /deny View Channel for @everyone/)
})

test('an overwrite that denies View Channel to @everyone clears the finding', async () => {
  const checks = await checkDiscordServer(fakeRest(rig({ count: 3, everyone: VIEW, lobbyOw: denyView, forumOw: denyView })), home)
  assert.equal(byId(checks, 'visibility').status, 'ok')
})

test('an overwrite that allows View Channel exposes a channel whose @everyone role cannot see it', async () => {
  const checks = await checkDiscordServer(fakeRest(rig({ count: 4, lobbyOw: allowView })), home)
  const vis = byId(checks, 'visibility')
  assert.equal(vis.status, 'warn')
  assert.match(vis.detail, /#bridge/)
  assert.doesNotMatch(vis.detail, /stolik/)
})

test('Administrator on @everyone exposes every channel', async () => {
  const checks = await checkDiscordServer(fakeRest(rig({ count: 3, everyone: '8' })), home)
  assert.match(byId(checks, 'visibility').detail, /#bridge, category stolik, #app/)
})

test('a missing member count is "not checked"', async () => {
  const over = { '/guilds/7': { id: '7', owner_id: '99', roles: [{ id: '7', permissions: '0' }] } }
  const checks = await checkDiscordServer(fakeRest(rig({ over })), home)
  const members = byId(checks, 'members')
  assert.equal(members.status, 'warn')
  assert.match(members.detail, /^not checked/)
})

test('a failed server read is "not checked" for members and visibility, and invites stay not checked', async () => {
  const checks = await checkDiscordServer(fakeRest({ '/guilds/7': new Error('403 Forbidden') }), home)
  assert.ok(byId(checks, 'members').detail.startsWith('not checked'))
  assert.ok(byId(checks, 'visibility').detail.startsWith('not checked'))
  assert.match(byId(checks, 'invites').detail, /not checked.*Manage Server/)
})

test('invites are always shown as not checked', async () => {
  const checks = await checkDiscordServer(fakeRest(rig()), home)
  assert.equal(byId(checks, 'invites').status, 'warn')
  assert.ok(byId(checks, 'invites').detail.startsWith('not checked'))
})

test('memberCount asks for with_counts as a query, not in the route', async () => {
  const calls: Call[] = []
  const n = await memberCount(fakeRest(rig({ count: 4 }), calls), '7')
  assert.equal(n, 4)
  assert.deepEqual(calls, [{ route: '/guilds/7', query: 'with_counts=true' }])
})

test('checkDiscordPrivacy without a home runs the application checks only', async () => {
  const checks = await checkDiscordPrivacy({ rest: fakeRest(rig()), home: null })
  assert.deepEqual(checks.map((c) => c.id), ['public', 'intent'])
})
