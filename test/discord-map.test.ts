// Discord's pure mapping (research/d1-brief.md, batch D1a): capabilities, ChatRef cases of decision 3, inbound kinds,
// forwards, replies, button rows, escaping and allowed_mentions, the error table by RESTJSONErrorCodes name, and the
// lazy-load rule of decision 1 (the Telegram path never loads @discordjs/* or discord-api-types).
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  ChannelType,
  MessageFlags,
  MessageReferenceType,
  MessageType,
  RESTJSONErrorCodes,
  type GatewayMessageCreateDispatchData,
} from 'discord-api-types/v10'
import { ChatError, type ChatRef } from '../src/brain/chat-types.ts'
import {
  DC_BUTTONS,
  DISCORD_CAPABILITIES,
  chatRefOf,
  folderCategoryKind,
  folderChannelName,
  contentOf,
  editBody,
  inboundOf,
  messageBody,
  rowsToComponents,
  toChatError,
  type ChannelLookup,
  type HomeBinding,
} from '../src/adapters/chat/discord-map.ts'

const OWNER = '100000000000000001'
const GUILD = '200000000000000002'
const LOBBY = '300000000000000003'
const TEXT = '700000000000000007'
const DM = '800000000000000008'
const MSG = '1000000000000000123'
const BINDING: HomeBinding = { guildId: GUILD, lobbyId: LOBBY }
const CAT = '410000000000000001'
const IDLE = '410000000000000002'
const CAT2 = '410000000000000003'
const NOTES = '410000000000000004'
const GENERAL = '410000000000000005'
const OTHER_GUILD_CAT = '410000000000000006'
const FOLDER = '420000000000000001'
const FOLDER_IDLE = '420000000000000002'
const FOLDER_CAT2 = '420000000000000003'
const FOLDER_NOTES = '420000000000000004'
const FOLDER_GENERAL = '420000000000000005'
const FOLDER_OTHER_GUILD = '420000000000000006'
const ANNOUNCE = '420000000000000007'
const FORUM = '430000000000000001'
const OLD_POST = '430000000000000002'
const THREAD_IN_FOLDER = '430000000000000003'
const VOICE_IN_CAT = '440000000000000001'
const HOME_CHAT = { kind: 'home', id: `dc:g${GUILD}:l${LOBBY}`, thread: null } as ChatRef

const cat = (name: string, guildId: string | null = GUILD) => ({ type: ChannelType.GuildCategory, parentId: null, guildId, name })
const text = (parentId: string | null, guildId: string | null = GUILD) => ({ type: ChannelType.GuildText, parentId, guildId, name: 'c' })

// A channel index for the fixtures above: the bound lobby, the stolik categories and their folders, and the traps
// (owner categories with near names, a folder in another guild, the old forum and its post, a thread in a folder).
const INDEX = new Map<string, { type: ChannelType; parentId: string | null; guildId: string | null; name?: string | null }>([
  [LOBBY, text(null)],
  [CAT, cat('stolik')],
  [IDLE, cat('stolik-idle')],
  [CAT2, cat('stolik 2')],
  [NOTES, cat('stolik-notes')],
  [GENERAL, cat('general')],
  [OTHER_GUILD_CAT, cat('stolik', '999000000000000009')],
  [FOLDER, text(CAT)],
  [FOLDER_IDLE, text(IDLE)],
  [FOLDER_CAT2, text(CAT2)],
  [FOLDER_NOTES, text(NOTES)],
  [FOLDER_GENERAL, text(GENERAL)],
  [FOLDER_OTHER_GUILD, text(OTHER_GUILD_CAT, '999000000000000009')],
  [ANNOUNCE, { type: ChannelType.GuildAnnouncement, parentId: CAT, guildId: GUILD, name: 'a' }],
  [FORUM, { type: ChannelType.GuildForum, parentId: null, guildId: GUILD, name: 'sessions' }],
  [OLD_POST, { type: ChannelType.PublicThread, parentId: FORUM, guildId: GUILD }],
  [THREAD_IN_FOLDER, { type: ChannelType.PublicThread, parentId: FOLDER, guildId: GUILD }],
  [VOICE_IN_CAT, { type: ChannelType.GuildVoice, parentId: CAT, guildId: GUILD, name: 'v' }],
  ['410000000000000099', { type: ChannelType.GuildText, parentId: '410000000000000098', guildId: GUILD, name: 'orphan' }],
])
const lookup = (id: string) => INDEX.get(id)

function msg(over: Record<string, unknown> = {}): GatewayMessageCreateDispatchData {
  return {
    id: MSG,
    channel_id: LOBBY,
    guild_id: GUILD,
    author: { id: OWNER, username: 'owner', global_name: 'Owner Name', bot: false, discriminator: '0', avatar: null },
    content: 'hello',
    type: MessageType.Default,
    attachments: [],
    flags: 0,
    ...over,
  } as unknown as GatewayMessageCreateDispatchData
}

test('capabilities: Discord values and limits (decision 4, batch D4: folder channels)', () => {
  const c = DISCORD_CAPABILITIES
  assert.equal(c.platform, 'dc')
  assert.equal(c.names.thread, 'channel')
  assert.deepEqual(c.threads, { kind: 'channel', maxNameChars: 100, rename: true, close: true, delete: true })
  assert.equal(c.text.maxChars, 2000)
  assert.equal(c.files.maxUploadBytes, 20 * 1024 * 1024)
  assert.equal(c.forwardMarker, true)
})

test('folderCategoryKind: the exact stolik names only (owner categories and "stolik 1" are not the bridge\'s)', () => {
  const table: Array<[string | null | undefined, 'active' | 'idle' | null]> = [
    ['stolik', 'active'], ['stolik 2', 'active'], ['stolik 10', 'active'], ['stolik-idle', 'idle'], ['stolik-idle 3', 'idle'],
    ['stolik 1', null], ['stolik-idle 1', null], ['stolik-notes', null], ['Stolik', null], ['stolik  2', null], ['stolik2', null],
    ['general', null], ['', null], [null, null], [undefined, null],
  ]
  for (const [name, want] of table) assert.equal(folderCategoryKind(name), want, JSON.stringify(name))
})

test('folderChannelName: lowercase, separators to dashes, letters kept, dashes tidy, 100 characters, fallback folder', () => {
  const table: Array<[string, string]> = [
    ['parent/basename', 'parent-basename'], ['My.App', 'my-app'], ['🛠 Logs', 'logs'], ['Проект Один', 'проект-один'],
    ['  --a--b--  ', 'a-b'], ['🛠', 'folder'], ['', 'folder'], ['x_y', 'x_y'], ['a/b c.d', 'a-b-c-d'], ['Café', 'café'],
  ]
  for (const [raw, want] of table) assert.equal(folderChannelName(raw), want, JSON.stringify(raw))
  assert.equal(folderChannelName('a'.repeat(150)).length, 100)
  assert.equal(folderChannelName('x'.repeat(99) + ' y'), 'x'.repeat(99), 'a cut that ends in a dash drops it')
})

test('chatRefOf: the full table of folder cases (decision 5; table-tested, batch D4)', () => {
  const cases: Array<[string, Record<string, unknown>, HomeBinding | null, ChatRef]> = [
    ['a DM has no guild_id', { channel_id: DM, guild_id: undefined }, BINDING, { kind: 'dm', id: `dc:d${DM}` as ChatRef['id'], thread: null }],
    ['the bound lobby is home, no thread', { channel_id: LOBBY }, BINDING, HOME_CHAT],
    ['a folder under stolik is home with the folder as thread', { channel_id: FOLDER }, BINDING, { kind: 'home', id: HOME_CHAT.id, thread: `dc:${FOLDER}` as ChatRef['thread'] }],
    ['a folder under stolik-idle is home with the folder as thread', { channel_id: FOLDER_IDLE }, BINDING, { kind: 'home', id: HOME_CHAT.id, thread: `dc:${FOLDER_IDLE}` as ChatRef['thread'] }],
    ['a folder under stolik 2 is home with the folder as thread', { channel_id: FOLDER_CAT2 }, BINDING, { kind: 'home', id: HOME_CHAT.id, thread: `dc:${FOLDER_CAT2}` as ChatRef['thread'] }],
    ['a folder moved from stolik to stolik-idle still maps to its folder', { channel_id: FOLDER }, BINDING, { kind: 'home', id: HOME_CHAT.id, thread: `dc:${FOLDER}` as ChatRef['thread'] }],
    ['a text channel under stolik-notes (an owner category) is another channel', { channel_id: FOLDER_NOTES }, BINDING, { kind: 'home', id: `dc:g${GUILD}:l${FOLDER_NOTES}` as ChatRef['id'], thread: null }],
    ['a text channel under general is another channel', { channel_id: FOLDER_GENERAL }, BINDING, { kind: 'home', id: `dc:g${GUILD}:l${FOLDER_GENERAL}` as ChatRef['id'], thread: null }],
    ['a folder-looking channel in another guild is its own chat', { channel_id: FOLDER_OTHER_GUILD, guild_id: '999000000000000009' }, BINDING, { kind: 'home', id: `dc:g999000000000000009:l${FOLDER_OTHER_GUILD}` as ChatRef['id'], thread: null }],
    ['a folder while unbound is its own chat (no thread)', { channel_id: FOLDER }, null, { kind: 'home', id: `dc:g${GUILD}:l${FOLDER}` as ChatRef['id'], thread: null }],
    ['a text channel with no category is its own chat (so !bind works there)', { channel_id: '410000000000000099' }, BINDING, { kind: 'home', id: `dc:g${GUILD}:l410000000000000099` as ChatRef['id'], thread: null }],
    ['an announcement channel under stolik is its own chat, not a folder', { channel_id: ANNOUNCE }, BINDING, { kind: 'home', id: `dc:g${GUILD}:l${ANNOUNCE}` as ChatRef['id'], thread: null }],
    ['a voice channel under stolik is other', { channel_id: VOICE_IN_CAT }, BINDING, { kind: 'other', id: `dc:g${GUILD}:l${VOICE_IN_CAT}` as ChatRef['id'], thread: null }],
    ['an old forum post is other (its thread id is stale)', { channel_id: OLD_POST }, BINDING, { kind: 'other', id: `dc:g${GUILD}:l${OLD_POST}` as ChatRef['id'], thread: null }],
    ['a thread under a folder is other', { channel_id: THREAD_IN_FOLDER }, BINDING, { kind: 'other', id: `dc:g${GUILD}:l${THREAD_IN_FOLDER}` as ChatRef['id'], thread: null }],
    ['a folder whose category is unknown to the index is its own chat', { channel_id: '410000000000000099' }, BINDING, { kind: 'home', id: `dc:g${GUILD}:l410000000000000099` as ChatRef['id'], thread: null }],
    ['the lobby id in another guild is not the lobby', { channel_id: LOBBY, guild_id: '999000000000000009' }, BINDING, { kind: 'home', id: `dc:g999000000000000009:l${LOBBY}` as ChatRef['id'], thread: null }],
    ['a channel the index does not know is other (the adapter fetches it first)', { channel_id: '900000000000000009' }, BINDING, { kind: 'other', id: `dc:g${GUILD}:l900000000000000009` as ChatRef['id'], thread: null }],
  ]
  for (const [name, m, binding, want] of cases) {
    const guild = 'guild_id' in m ? (m.guild_id as string | undefined) : GUILD
    const got = chatRefOf({ channel_id: String(m.channel_id), guild_id: guild }, binding, lookup)
    assert.deepEqual(got, want, name)
  }
  // A folder moved between categories: the index changes, the mapping follows it.
  const moved = new Map(INDEX)
  moved.set(FOLDER, text(IDLE))
  assert.deepEqual(chatRefOf({ channel_id: FOLDER, guild_id: GUILD }, BINDING, (id) => moved.get(id)), { kind: 'home', id: HOME_CHAT.id, thread: `dc:${FOLDER}` as ChatRef['thread'] })
  // A folder dragged out of the stolik categories: it is an ordinary text channel now.
  moved.set(FOLDER, text(GENERAL))
  assert.deepEqual(chatRefOf({ channel_id: FOLDER, guild_id: GUILD }, BINDING, (id) => moved.get(id)), { kind: 'home', id: `dc:g${GUILD}:l${FOLDER}` as ChatRef['id'], thread: null })
  void MSG
})

test('inbound: plain text, owner only, system messages ignored', () => {
  const got = inboundOf(msg(), HOME_CHAT, OWNER)
  assert.deepEqual(got, {
    kind: 'text',
    messageId: `dc:${LOBBY}:${MSG}`,
    text: 'hello',
    replyToId: null,
    replyToText: null,
    forwarded: false,
    from: 'Owner Name',
    fromId: `dc:${OWNER}`,
    chat: HOME_CHAT,
  })
  assert.equal(inboundOf(msg({ author: { id: OWNER, username: 'owner', bot: false } }), HOME_CHAT, OWNER)?.from, 'owner')
  assert.equal(inboundOf(msg({ author: { id: OWNER, username: 'owner', global_name: null } }), HOME_CHAT, OWNER)?.from, 'owner')
  // Not the owner, a bot, or a webhook: nothing reaches the brain from this function.
  assert.equal(inboundOf(msg({ author: { id: '111', username: 'x' } }), HOME_CHAT, OWNER), null)
  assert.equal(inboundOf(msg({ author: { id: OWNER, username: 'owner', bot: true } }), HOME_CHAT, OWNER), null)
  assert.equal(inboundOf(msg({ webhook_id: '123' }), HOME_CHAT, OWNER), null)
  assert.equal(inboundOf(msg({ type: MessageType.GuildMemberJoin }), HOME_CHAT, OWNER), null)
  assert.equal(inboundOf(msg({ type: MessageType.ThreadCreated }), HOME_CHAT, OWNER), null)
  assert.equal(inboundOf(msg({ type: MessageType.Reply }), HOME_CHAT, OWNER)?.kind, 'text')
})

const att = (over: Record<string, unknown>) => ({ id: '900', filename: 'f.bin', size: 10, url: 'https://cdn.example/f', content_type: 'application/octet-stream', ...over })

test('inbound: attachment kinds by MIME, voice by flag, albums keep every file in order', () => {
  const kindOfOne = (a: Record<string, unknown>, flags = 0) => inboundOf(msg({ content: 'cap', attachments: [att(a)], flags }), HOME_CHAT, OWNER)
  assert.equal(kindOfOne({ content_type: 'image/png' })?.kind, 'photo')
  assert.equal(kindOfOne({ content_type: 'audio/mpeg' })?.kind, 'audio')
  assert.equal(kindOfOne({ content_type: 'video/mp4' })?.kind, 'video')
  assert.equal(kindOfOne({ content_type: 'application/pdf' })?.kind, 'document')
  assert.equal(kindOfOne({ content_type: undefined }, 0)?.kind, 'document')
  assert.equal(kindOfOne({ content_type: 'audio/ogg' }, MessageFlags.IsVoiceMessage)?.kind, 'voice')
  const one = kindOfOne({ content_type: 'image/png', filename: 'a.png', size: 42, url: 'https://cdn.example/a.png' })!
  assert.equal(one.text, 'cap')
  assert.equal(one.fileRef, 'https://cdn.example/a.png')
  assert.equal(one.fileName, 'a.png')
  assert.equal(one.fileSize, 42)
  assert.equal(one.album, undefined)

  const album = inboundOf(
    msg({
      content: 'three',
      attachments: [att({ id: '1', content_type: 'image/jpeg', url: 'u1', filename: '1.jpg' }), att({ id: '2', content_type: 'image/png', url: 'u2', filename: '2.png' }), att({ id: '3', content_type: 'application/zip', url: 'u3', filename: '3.zip' })],
    }),
    HOME_CHAT,
    OWNER,
  )!
  assert.equal(album.kind, 'photo')
  assert.equal(album.fileRef, 'u1')
  assert.deepEqual(album.album?.map((i) => [i.kind, i.fileRef, i.fileName]), [['photo', 'u1', '1.jpg'], ['photo', 'u2', '2.png'], ['document', 'u3', '3.zip']])
})

test('inbound: a sticker-only message is unsupported with its label', () => {
  const got = inboundOf(msg({ content: '', sticker_items: [{ id: '5', name: 'x', format_type: 1 }] }), HOME_CHAT, OWNER)!
  assert.equal(got.kind, 'unsupported')
  assert.equal(got.label, 'sticker')
})

test('inbound: a reply has replyToId and the quoted text; a forward takes the snapshot text and files', () => {
  const reply = inboundOf(
    msg({
      content: 'answer',
      message_reference: { type: MessageReferenceType.Default, message_id: '999000000000000001', channel_id: LOBBY },
      referenced_message: { content: 'question' },
    }),
    HOME_CHAT,
    OWNER,
  )!
  assert.equal(reply.replyToId, `dc:${LOBBY}:999000000000000001`)
  assert.equal(reply.replyToText, 'question')
  assert.equal(reply.forwarded, false)

  // A reply whose target was deleted: the id stays, the quote is null.
  const orphan = inboundOf(msg({ message_reference: { message_id: '999000000000000002' } }), HOME_CHAT, OWNER)!
  assert.equal(orphan.replyToId, `dc:${LOBBY}:999000000000000002`)
  assert.equal(orphan.replyToText, null)

  const fwd = inboundOf(
    msg({
      content: '',
      message_reference: { type: MessageReferenceType.Forward, message_id: '999000000000000003', channel_id: TEXT },
      message_snapshots: [
        { message: { content: 'forwarded words', attachments: [att({ content_type: 'image/png', url: 'fu', filename: 'p.png' })], type: 0, flags: 0, mention_roles: [], mentions: [], embeds: [], components: [], timestamp: '' } },
      ],
    }),
    HOME_CHAT,
    OWNER,
  )!
  assert.equal(fwd.forwarded, true)
  assert.equal(fwd.replyToId, null)
  assert.equal(fwd.text, 'forwarded words')
  assert.equal(fwd.kind, 'photo')
  assert.equal(fwd.fileRef, 'fu')
})

test('buttons: rows become action rows with the router data as custom_id; limits and duplicates throw', () => {
  const rows = [
    [{ text: 'Allow', data: 'perm:1:allow' }, { text: 'Deny', data: 'perm:1:deny' }],
    [{ text: 'More', data: 'more' }],
  ]
  assert.deepEqual(rowsToComponents(rows), [
    { type: 1, components: [{ type: 2, style: 2, label: 'Allow', custom_id: 'perm:1:allow' }, { type: 2, style: 2, label: 'Deny', custom_id: 'perm:1:deny' }] },
    { type: 1, components: [{ type: 2, style: 2, label: 'More', custom_id: 'more' }] },
  ])
  assert.deepEqual(rowsToComponents([]), [])
  // Exactly at the limits: 5 rows of 5 buttons, 80-character labels, 100-byte payloads.
  const full = Array.from({ length: 5 }, (_, r) => Array.from({ length: 5 }, (_, c) => ({ text: 'x'.repeat(80), data: `r${r}c${c}`.padEnd(100, 'p') })))
  assert.equal(rowsToComponents(full).length, 5)
  const btn = (text: string, data: string) => [[{ text, data }]]
  assert.throws(() => rowsToComponents(Array.from({ length: 6 }, (_, i) => [{ text: 'a', data: `d${i}` }])), /too many button rows/)
  assert.throws(() => rowsToComponents([Array.from({ length: 6 }, (_, i) => ({ text: 'a', data: `d${i}` }))]), /buttons/)
  assert.throws(() => rowsToComponents([[]]), /buttons/)
  assert.throws(() => rowsToComponents(btn('x'.repeat(81), 'd')), /label/)
  assert.throws(() => rowsToComponents(btn('', 'd')), /label/)
  assert.throws(() => rowsToComponents(btn('a', 'p'.repeat(101))), /payload/)
  assert.throws(() => rowsToComponents(btn('a', '')), /payload/)
  // The payload limit counts bytes: 50 two-byte characters are 100 bytes (fine), 51 are 102 (refused).
  assert.equal(rowsToComponents(btn('a', 'é'.repeat(50))).length, 1)
  assert.throws(() => rowsToComponents(btn('a', 'é'.repeat(51))), /payload/)
  assert.throws(() => rowsToComponents([[{ text: 'a', data: 'same' }], [{ text: 'b', data: 'same' }]]), /duplicate/)
  assert.equal(DC_BUTTONS.maxPerRow, 5)
})

test('text: router text is escaped, agent markdown goes as written, mentions are never parsed', () => {
  // Inline markers are escaped; heading, list and number markers only where a line starts.
  assert.equal(contentOf('*a* _b_ # h `c` - item 1. x'), '\\*a\\* \\_b\\_ # h \\`c\\` - item 1. x')
  assert.equal(contentOf('# h\n- item\n1. x'), '\\# h\n\\- item\n1\\. x')
  assert.equal(contentOf('*bold* [x](y)', 'markdown'), '*bold* [x](y)')
  assert.equal(contentOf('plain 2000 ok'.padEnd(2000, '.')).length, 2000)
  // The limit is checked after escaping: "*a" repeated 1000 times is 2000 characters raw, but escaping adds more.
  assert.equal(contentOf('x'.repeat(2000)).length, 2000)
  assert.throws(() => contentOf('*a'.repeat(1000)), (e: unknown) => e instanceof ChatError && e.kind === 'too-long')
  assert.throws(() => contentOf('x'.repeat(2001), 'markdown'), (e: unknown) => e instanceof ChatError && e.kind === 'too-long')
})

test('messageBody: allowed_mentions is empty, silent sets SUPPRESS_NOTIFICATIONS, a reply references its message', () => {
  const body = messageBody('@everyone hi', { replyTo: { channelId: LOBBY, messageId: MSG }, silent: true, rows: [[{ text: 'Ok', data: 'ok' }]] })
  assert.deepEqual(body.allowed_mentions, { parse: [] })
  assert.equal(body.flags, MessageFlags.SuppressNotifications)
  assert.deepEqual(body.message_reference, { message_id: MSG, channel_id: LOBBY, fail_if_not_exists: false })
  assert.equal(body.components?.length, 1)
  assert.equal(body.content, '@everyone hi') // no escaping needed: allowed_mentions is what stops the ping
  const plain = messageBody('hi')
  assert.deepEqual(plain, { content: 'hi', allowed_mentions: { parse: [] } })
  assert.deepEqual(editBody('x', { rows: [] }), { content: 'x', allowed_mentions: { parse: [] }, components: [] })
  assert.equal(editBody('x', { rows: [[{ text: 'a', data: 'b' }]] }).components?.length, 1)
})

test('errors: codes come from RESTJSONErrorCodes by name (decision 8)', () => {
  const byCode = (name: keyof typeof RESTJSONErrorCodes, extra: Record<string, unknown> = {}) =>
    toChatError({ code: RESTJSONErrorCodes[name], status: 400, message: name, ...extra })
  const table: Array<[keyof typeof RESTJSONErrorCodes, string]> = [
    ['UnknownMessage', 'not-found'],
    ['UnknownInteraction', 'not-found'],
    ['MissingAccess', 'access-lost'],
    ['MissingPermissions', 'access-lost'],
    ['InvalidActionOnArchivedThread', 'thread-closed'],
    ['ThreadLocked', 'thread-closed'],
    ['RequestEntityTooLarge', 'too-long'],
    ['InvalidFormBodyOrContentType', 'other'],
    ['CannotSendAnEmptyMessage', 'other'],
    ['UnknownEmoji', 'other'],
  ]
  for (const [name, kind] of table) {
    const e = byCode(name)
    assert.equal(e.kind, kind, name)
    assert.equal(e.transient, false, name)
    assert.equal(e.status, 400)
  }
  // An unknown channel is a thread gone for a thread target, not-found otherwise.
  assert.equal(byCode('UnknownChannel').kind, 'not-found')
  assert.equal(toChatError({ code: RESTJSONErrorCodes.UnknownChannel, status: 404 }, { thread: true }).kind, 'thread-closed')
  assert.equal(toChatError({ code: RESTJSONErrorCodes.UnknownChannel, status: 404 }, { thread: false }).kind, 'not-found')
})

test('errors: 429 is rate-limited with the wait in ms; 5xx and network errors are transient', () => {
  const r = toChatError({ status: 429, code: 0, rawError: { code: 0, message: 'slow', retry_after: 1.5 }, message: 'slow' })
  assert.equal(r.kind, 'rate-limited')
  assert.equal(r.retryAfterMs, 1500)
  assert.equal(r.transient, false)
  // A RateLimitError from @discordjs/rest carries its wait in ms.
  assert.equal(toChatError({ status: 429, retryAfter: 2000, message: 'x' }).retryAfterMs, 2000)
  assert.equal(toChatError({ status: 429, message: 'x' }).retryAfterMs, undefined)
  const server = toChatError({ status: 503, code: 0, message: 'down' })
  assert.equal(server.kind, 'other')
  assert.equal(server.transient, true)
  assert.equal(toChatError({ code: 'ECONNRESET', message: 'socket' }).transient, true)
  assert.equal(toChatError(Object.assign(new Error('aborted'), { name: 'AbortError' })).transient, true)
  assert.equal(toChatError(new Error('plain')).transient, false)
  const inner = new ChatError('not-found', 'x')
  assert.equal(toChatError(inner), inner)
})

test('the Telegram path never loads @discordjs/* or discord-api-types; the Discord mapping does (decision 1)', () => {
  const probe = `
    import { registerHooks } from 'node:module'
    const seen = []
    registerHooks({ resolve(specifier, context, nextResolve) { const r = nextResolve(specifier, context); seen.push(r.url); return r } })
    await import(process.argv[1])
    process.stdout.write(JSON.stringify(seen))
  `
  const run = (mod: string) => {
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', probe, mod], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return JSON.parse(r.stdout) as string[]
  }
  const telegram = run(new URL('../src/adapters/chat/telegram.ts', import.meta.url).href)
  assert.ok(telegram.length > 10, 'the probe saw the Telegram import graph')
  const discordLoaded = (urls: string[]) => urls.filter((u) => /\/node_modules\/(@discordjs\/|discord-api-types\/)/.test(u))
  assert.deepEqual(discordLoaded(telegram), [])
  // The control: the same probe does see the Discord packages when the Discord mapping is imported.
  assert.ok(discordLoaded(run(new URL('../src/adapters/chat/discord-map.ts', import.meta.url).href)).length > 0)
})
