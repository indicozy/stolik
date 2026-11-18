// Discord setup (batch D2): the invite link, the client id, the DM pairing driver with a fake gateway, and the setup
// branch with fake prompts and temp files.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discordInviteUrl, fetchClientId, makeDiscordPairing, DISCORD_BIND_STEPS, chatSettingsOf } from '../src/adapters/chat/discord-setup.ts'
import { startPairing, PAIR_TTL_MS } from '../src/brain/pairing.ts'
import { runSetup, type SetupDeps, type SetupPaths } from '../src/cli/setup.ts'

type Handler = (data: unknown) => void | Promise<void>

// A fake client: REST calls are recorded; the gateway emits `messages` on connect, in order.
function fakeClient(messages: unknown[], posts: Array<{ route: string; body: unknown }>) {
  const handlers: Record<string, Handler> = {}
  return {
    rest: {
      get: async (route: string) => (route === '/users/@me' ? { id: '1', username: 'bot' } : {}),
      post: async (route: string, o?: { body?: unknown }) => {
        posts.push({ route, body: o?.body })
        return {}
      },
      patch: async () => ({}),
      put: async () => ({}),
      delete: async () => ({}),
    },
    gateway: {
      on(event: string, fn: Handler) {
        handlers[event] = fn
      },
      async connect() {
        setImmediate(async () => {
          for (const m of messages) await handlers.MESSAGE_CREATE?.(m)
        })
      },
      async destroy() {},
    },
  }
}

const dm = (content: string, id = '42', extra: Record<string, unknown> = {}) => ({
  id: '900',
  channel_id: '9',
  content,
  author: { id, username: 'me', global_name: 'Me Name', bot: false },
  ...extra,
})

test('invite URL carries the client id and the permissions', () => {
  const url = discordInviteUrl('123456789')
  assert.ok(url.includes('client_id=123456789'))
  assert.ok(url.includes('permissions=70368744279120'))
  assert.ok(url.includes('scope=bot%20applications.commands'))
})

test('invite URL rejects a client id that is not digits', () => {
  assert.throws(() => discordInviteUrl('abc'), /not a Discord client id/)
  assert.throws(() => discordInviteUrl('12 34'), /not a Discord client id/)
  assert.throws(() => discordInviteUrl(''), /not a Discord client id/)
})

test('fetchClientId reads the application id', async () => {
  const rest = { get: async (route: string) => (route === '/applications/@me' ? { id: '555' } : {}) }
  assert.equal(await fetchClientId('tok', rest as never), '555')
  const bad = { get: async () => ({}) }
  await assert.rejects(fetchClientId('tok', bad as never), /no application id/)
})

test('bind steps mention the invite, !bind and the pairing', () => {
  const text = DISCORD_BIND_STEPS.join('\n')
  assert.match(text, /!bind/)
  assert.match(text, /Message Content Intent/)
  assert.match(text, /direct message/)
})

test('chat settings read the owner, home and token without numbers', () => {
  const s = chatSettingsOf('DISCORD_BOT_TOKEN="abc"\n', { chat: { app: 'discord', discord: { ownerUserId: '42', homeId: 'dc:g1:l2' } } })
  assert.deepEqual(s, { app: 'discord', token: 'abc', ownerId: '42', homeId: 'dc:g1:l2' })
  assert.equal(chatSettingsOf('', {}).app, 'telegram')
})

test('DM pairing: ignores bot and guild messages and a wrong code, then pairs', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dc-setup-'))
  try {
    const posts: Array<{ route: string; body: unknown }> = []
    const messages = [
      dm('ignored', '77', { author: { id: '77', username: 'bot', bot: true } }),
      dm('ignored too', '78', { guild_id: '5' }),
      dm('000000'),
    ]
    let code = ''
    const factory = async (token: string) => {
      void token
      return fakeClient(messages.map((m) => m), posts) as never
    }
    const driver = makeDiscordPairing({ stateDir, socketPath: join(stateDir, 'sock') }, factory as never)
    const begun = await driver.begin('tok')
    code = begun.code
    messages.push(dm(code))
    const res = await driver.wait('tok')
    assert.equal(res.ok, true)
    if (res.ok) {
      assert.equal(res.candidate.userId, '42')
      assert.equal(res.candidate.name, 'Me Name')
    }
    assert.ok(posts.some((p) => p.route === '/channels/9/messages' && (p.body as { content: string }).content === 'Paired.'))
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('DM pairing: an expired code gives ok false', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dc-setup-'))
  try {
    startPairing(stateDir, 'discord', Date.now() - PAIR_TTL_MS - 1000, '123456')
    const posts: Array<{ route: string; body: unknown }> = []
    const factory = async () => fakeClient([dm('123456')], posts) as never
    const driver = makeDiscordPairing({ stateDir, socketPath: join(stateDir, 'sock') }, factory as never)
    const res = await driver.wait('tok')
    assert.equal(res.ok, false)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('setup branch writes the token, owner and app, and never prints the token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dc-setup-run-'))
  try {
    const token = 'MTIzNDU2.' + 'a'.repeat(60)
    const paths: SetupPaths = {
      envFile: join(dir, 'tg-bridge.env'),
      configFile: join(dir, 'config.json'),
      pluginDir: join(dir, 'plugin'),
      nodePath: process.execPath,
    }
    const lines: string[] = []
    const confirmed: Array<{ userId: string; yes: boolean }> = []
    const deps: SetupDeps = {
      options: { chat: 'discord' },
      paths,
      out: (l) => lines.push(l),
      ask: async () => 'y',
      askSecret: async () => token,
      discord: { clientId: async () => '999' },
      pairing: {
        begin: async () => ({ code: 'ABC123', bot: '@bridge' }),
        wait: async () => ({ ok: true, candidate: { userId: '42', name: 'Me', username: 'me' } }),
        confirm: async (userId, yes) => {
          confirmed.push({ userId, yes })
        },
      },
    }
    const code = await runSetup(deps)
    assert.equal(code, 0)
    assert.deepEqual(confirmed, [{ userId: '42', yes: true }])
    const env = readFileSync(paths.envFile, 'utf8')
    assert.match(env, /^DISCORD_BOT_TOKEN=/m)
    const cfg = JSON.parse(readFileSync(paths.configFile, 'utf8'))
    assert.equal(cfg.chat.app, 'discord')
    assert.equal(cfg.chat.discord.ownerUserId, '42')
    assert.equal(typeof cfg.chat.discord.ownerUserId, 'string')
    const output = lines.join('\n')
    assert.ok(!output.includes(token), 'output must not contain the token')
    assert.ok(output.includes('https://discord.com/oauth2/authorize?client_id=999'))
    assert.ok(existsSync(paths.envFile))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
