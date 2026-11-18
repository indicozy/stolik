// Chat connector step 0e, batch 2a: identity meta, the `!x` command reader, the Telegram direct send, wording. No network:
// the direct send gets a fetch fake.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCommandWord } from '../src/brain/commands.ts'
import { isCommandText, routeInbound, usageTo, helpText } from '../src/router/state.ts'
import { prepare } from '../src/router/deliver.ts'
import { parseSilentCommand } from '../src/brain/mute.ts'
import { parseNewCommand } from '../src/brain/topics.ts'
import { isTraceCommand } from '../src/brain/observe.ts'
import { isBindCommand } from '../src/brain/inbound.ts'
import { sendDirect } from '../src/adapters/chat/telegram-direct.ts'
import { TELEGRAM_CAPABILITIES } from '../src/adapters/chat/telegram.ts'
import { words } from '../src/brain/words.ts'
import { tgMsg, tgUser, tgChat } from '../src/adapters/chat/tg-ids.ts'
import type { Inbound } from '../src/brain/chat-types.ts'
import type { Router } from '../src/router/core.ts'

const ctx = { forwarded: false, attachment: false, replyTo: null, live: [] } as never

test('parseCommandWord reads /x and !x, the @bot form, and never a forwarded !x', () => {
  assert.deepEqual(parseCommandWord('/list'), { word: 'list', arg: '' })
  assert.deepEqual(parseCommandWord('!to  a b'), { word: 'to', arg: 'a b' })
  assert.deepEqual(parseCommandWord('!silent@tg_bot 30m'), { word: 'silent', arg: '30m' })
  assert.deepEqual(parseCommandWord('/new@tg_bot'), { word: 'new', arg: '' })
  assert.equal(parseCommandWord('!list', true), null)
  assert.deepEqual(parseCommandWord('/list', true), { word: 'list', arg: '' })
  assert.equal(parseCommandWord('!!!'), null)
  // The shape only: routing decides whether the word is a command (unknown words fall through to text).
  assert.equal(parseCommandWord('!important please')?.word, 'important')
  assert.equal(parseCommandWord('hello /list'), null)
  assert.equal(parseCommandWord('/listx@'), null)
})

test('each of the six command sites takes !x as well as /x', () => {
  assert.equal(isCommandText('!list'), true)
  assert.equal(isCommandText('/list'), true)
  assert.equal(isCommandText('!unknownword'), false)
  assert.equal(isCommandText('/unknownword'), false)
  assert.equal(isTraceCommand('!trace'), true)
  assert.equal(isTraceCommand('!trace', true), false)
  assert.equal(isTraceCommand('/trace', true), true)
  assert.equal(isBindCommand('!bind'), true)
  assert.equal(isBindCommand('!bind', true), false)
  assert.equal(isBindCommand('/bind@tg_bot'), true)
  assert.equal(isBindCommand('/binder'), false)
  assert.equal(parseNewCommand('!new  proj')?.body, 'proj')
  assert.equal(parseSilentCommand('!SILENT off')?.kind, 'off')
  const route = routeInbound('!list', 0, ctx)
  assert.equal(route.type, 'command')
  const fwd = routeInbound('!list', 0, { ...(ctx as object), forwarded: true } as never)
  assert.notEqual(fwd.type, 'command')
  // Unknown words fall through as text, with `/` as before.
  assert.notEqual(routeInbound('!nosuch', 0, ctx).type, 'command')
})

test('help and usage read the sigil and the words of the port', () => {
  const tg = helpText(words(TELEGRAM_CAPABILITIES))
  assert.match(tg, /^tg-bridge commands \(send them in General\):/)
  assert.match(tg, /\n\/list: live sessions/)
  const other = helpText({ ...words(TELEGRAM_CAPABILITIES), sigil: '!', lobby: 'server', home: 'server', thread: 'post' })
  assert.match(other, /^tg-bridge commands \(send them in server\):/)
  assert.match(other, /\n!list: live sessions/)
  assert.match(other, /Posts: one post per folder/)
  assert.equal(usageTo(), 'Usage: /to <name> <text>. <name> is a session name (see /list) or a project folder.')
  assert.equal(usageTo('!'), 'Usage: !to <name> <text>. <name> is a session name (see !list) or a project folder.')
})

function inbound(over: Partial<Inbound> = {}): Inbound {
  return {
    kind: 'text', messageId: tgMsg(7), text: 'hi', replyToId: null, replyToText: null, forwarded: false,
    from: 'indicozy', fromId: tgUser(42), chat: { kind: 'dm', id: tgChat(42), thread: null }, ...over,
  } as Inbound
}

function routerFor(over: Record<string, unknown> = {}): Router {
  return { ownerId: tgUser(42), ownerAlias: null, chatApp: 'telegram', ...over } as unknown as Router
}

test('identity meta: the owner id and the platform name for the live install; the alias when set', async () => {
  const live = await prepare(routerFor(), inbound(), 'hi')
  assert.ok(live)
  assert.equal(live.meta.user_id, 'tg:42')
  assert.equal(live.meta.user, 'indicozy')
  assert.equal(live.meta.chat_app, 'telegram')
  const aliased = await prepare(routerFor({ ownerAlias: 'owner' }), inbound(), 'hi')
  assert.equal(aliased?.meta.user, 'owner')
  assert.equal(aliased?.meta.user_id, 'tg:42')
})

test('identity meta: a forwarded owner message has no user_id (its text is someone else\'s)', async () => {
  const fwd = await prepare(routerFor(), inbound({ forwarded: true }), 'hi')
  assert.equal(fwd?.meta.forwarded, 'true')
  assert.equal(fwd?.meta.user_id, undefined)
  assert.equal(fwd?.meta.user, 'indicozy')
})

test('identity meta: an addon-made message (origin addon) has no user_id, even with the owner id; user is the addon name', async () => {
  const spawned = await prepare(routerFor({ ownerAlias: 'owner' }), inbound({ origin: 'addon', from: 'calendar-addon' }), 'hi')
  assert.ok(spawned)
  assert.equal(spawned.meta.user_id, undefined)
  assert.equal(spawned.meta.user, 'calendar-addon')
  assert.equal(spawned.meta.forwarded, undefined)
})

test('identity meta: no user_id for a sender that is not the paired owner (and before pairing)', async () => {
  const other = await prepare(routerFor(), inbound({ fromId: tgUser(99), from: 'stranger' }), 'hi')
  assert.equal(other?.meta.user_id, undefined)
  assert.equal(other?.meta.user, 'stranger')
  const unpaired = await prepare(routerFor({ ownerId: '' }), inbound(), 'hi')
  assert.equal(unpaired?.meta.user_id, undefined)
  assert.equal(unpaired?.meta.user, 'indicozy')
})

test('direct send: Markdown falls back to plain when Telegram refuses the HTML; tokens are tried in turn', async () => {
  const realFetch = globalThis.fetch
  const calls: Array<{ url: string; parse: string | null; text: string }> = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    const body = new URLSearchParams(String(init?.body))
    calls.push({ url: u, parse: body.get('parse_mode'), text: body.get('text') ?? '' })
    if (u.includes('/botGOOD')) return new Response(JSON.stringify({ ok: true }), { status: 200 })
    if (body.get('parse_mode') === 'HTML') return new Response(JSON.stringify({ ok: false, description: "Bad Request: can't parse entities" }), { status: 400 })
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as typeof fetch
  try {
    const err = await sendDirect({ tokens: ['BAD', 'GOOD'], chatId: '42' }, 'hello *world*', { project: 'proj', plain: false, silent: true })
    assert.equal(err, null)
    assert.ok(calls.some((c) => c.parse === 'HTML'))
    assert.ok(calls.some((c) => c.parse === null && c.text.startsWith('[proj]')))
    calls.length = 0
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, description: 'Forbidden: bot was blocked by the user' }), { status: 403 })) as typeof fetch
    assert.equal(await sendDirect({ tokens: ['X'], chatId: '42' }, 'x', { project: null, plain: true, silent: false }), 'Forbidden: bot was blocked by the user')
    assert.equal(await sendDirect({ tokens: [], chatId: '42' }, 'x', { project: null, plain: true, silent: false }), 'no token')
  } finally {
    globalThis.fetch = realFetch
  }
})
