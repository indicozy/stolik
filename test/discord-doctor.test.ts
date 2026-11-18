// Discord doctor (batch D2, folders in batch D4): token, Message Content intent, lobby and stolik categories, with a fake REST.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkDiscord } from '../src/adapters/chat/discord-doctor.ts'
import { checkDiscordApp } from '../src/adapters/chat/discord-privacy.ts'

type Routes = Record<string, unknown>

// A fake REST: a route maps to its reply, or to an Error to throw. Unknown routes throw 404.
function fakeRest(routes: Routes) {
  return {
    get: async (route: string) => {
      const v = routes[route]
      if (v instanceof Error) throw v
      if (v === undefined) throw new Error(`404 ${route}`)
      return v
    },
    post: async () => ({}),
  }
}

// Guild 7 with @everyone permissions `guildPerms` ('8' is Administrator, so every check passes).
function rig(over: Routes = {}, guildPerms = '8'): Routes {
  return {
    '/users/@me': { id: '1', username: 'bridge' },
    '/applications/@me': { flags: 1 << 18 },
    '/channels/5': { type: 0, guild_id: '7' },
    '/guilds/7': { id: '7', owner_id: '99', roles: [{ id: '7', permissions: guildPerms }] },
    '/guilds/7/members/1': { roles: [] },
    '/guilds/7/channels': [{ id: '8', type: 4, name: 'stolik' }],
    '/channels/8': { id: '8', type: 4 },
    ...over,
  }
}

const home = { guildId: '7', lobbyId: '5' }

test('token fails when GET /users/@me throws', async () => {
  const checks = await checkDiscord({ rest: fakeRest({ '/users/@me': new Error('401 Unauthorized') }), home })
  assert.equal(checks.length, 1)
  assert.equal(checks[0]!.id, 'token')
  assert.equal(checks[0]!.status, 'fail')
  assert.match(checks[0]!.detail, /401 Unauthorized/)
})

test('token ok shows the bot name', async () => {
  const checks = await checkDiscord({ rest: fakeRest(rig()), home })
  assert.equal(checks[0]!.status, 'ok')
  assert.equal(checks[0]!.detail, '@bridge')
})

test('Message Content intent (privacy group): flag 0 warns with the fix, 1<<18 and 1<<19 pass', async () => {
  const intent = async (flags: number) => {
    const checks = await checkDiscordApp(fakeRest(rig({ '/applications/@me': { flags } })))
    return checks.find((c) => c.id === 'intent')!
  }
  const off = await intent(0)
  assert.equal(off.status, 'warn')
  assert.equal(off.group, 'privacy')
  assert.match(off.detail, /Developer Portal.*Message Content Intent/)
  assert.equal((await intent(1 << 18)).status, 'ok')
  assert.equal((await intent(1 << 19)).status, 'ok')
})

test('a lobby missing Attach Files names the permission', async () => {
  // @everyone without Attach Files (32768): 1024 + 2048 + 65536 + 64.
  const checks = await checkDiscord({ rest: fakeRest(rig({}, '68672')), home })
  const group = checks.find((c) => c.id === 'group')!
  assert.equal(group.status, 'fail')
  assert.match(group.detail, /Attach Files/)
})

test('a missing stolik category is a warning (the bot creates it)', async () => {
  const checks = await checkDiscord({ rest: fakeRest(rig({ '/guilds/7/channels': [] })), home })
  const folders = checks.find((c) => c.id === 'folders')!
  assert.equal(folders.status, 'warn')
  assert.match(folders.detail, /Manage Channels/)
})

test('no home is a warning', async () => {
  const checks = await checkDiscord({ rest: fakeRest(rig()), home: null })
  const group = checks.find((c) => c.id === 'group')!
  assert.equal(group.status, 'warn')
  assert.match(group.detail, /!bind/)
})

test('all checks pass with administrator rights and the stolik category present', async () => {
  const checks = await checkDiscord({ rest: fakeRest(rig()), home })
  assert.deepEqual(
    checks.map((c) => [c.id, c.status]),
    [
      ['token', 'ok'],
      ['group', 'ok'],
      ['folders', 'ok'],
    ],
  )
})
