// Review round (v3 fix-tg): the Telegram adapter. Where edits and reactions go, file sends (GIF, large image, a photo
// Telegram refuses), keyboard tracking, the order of inbound handling, and albums.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GrammyError } from 'grammy'
import type { MessageId } from '../src/brain/chat-types.ts'
import { KeyedSerial, Telegram, UPLOAD_TIMEOUT_S, API_TIMEOUT_S, PHOTO_MAX_BYTES, joinAlbum } from '../src/adapters/chat/telegram.ts'
import type { Inbound } from '../src/brain/chat-types.ts'
import { ISOLATED_ROOT } from './helpers/isolate.ts'
import { tgChat, tgMsg, tgUser } from '../src/adapters/chat/tg-ids.ts'

type Call = { method: string; args: unknown[] }

// An adapter whose Bot API calls are recorded instead of sent. `photoError` makes sendPhoto fail with that error.
function adapter(opts: { photoError?: unknown } = {}) {
  const tg = new Telegram('123:TEST', '111', [], '111')
  const calls: Call[] = []
  const keyboardLists: Array<Array<{ messageId: MessageId; dm: boolean }>> = []
  let nextId = 500
  const rec = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args })
    if (method === 'sendPhoto' && opts.photoError) throw opts.photoError
    return { message_id: nextId++ }
  }
  const api = {
    sendMessage: rec('sendMessage'),
    sendDocument: rec('sendDocument'),
    sendPhoto: rec('sendPhoto'),
    editMessageText: rec('editMessageText'),
    editMessageReplyMarkup: rec('editMessageReplyMarkup'),
    setMessageReaction: rec('setMessageReaction'),
  }
  const internal = tg as unknown as { bot: { api: unknown }; uploads: unknown }
  internal.bot.api = api
  internal.uploads = api
  tg.setHome(tgChat(-1001))
  tg.onLiveButtons((list) => keyboardLists.push(list))
  return { tg, calls, keyboardLists }
}

const chatOf = (c: Call) => c.args[0]

test('an edit goes to the chat its message was sent to (the DM stays the DM after a bind)', async () => {
  const { tg, calls } = adapter()
  const dmId = await tg.sendText('to the DM', { dm: true })
  const groupId = await tg.sendText('to the group')
  await tg.editText(dmId, 'edited', null)
  await tg.editRows(groupId, 'edited', [])
  const edits = calls.filter((c) => c.method === 'editMessageText')
  assert.equal(chatOf(edits[0]), '111', 'the DM message is edited in the DM')
  assert.equal(chatOf(edits[1]), '-1001', 'the group message is edited in the group')
  assert.equal(tg.isDm(dmId), true)
  assert.equal(tg.isDm(groupId), false)
})

test('a reaction goes to the chat of its message too', async () => {
  const { tg, calls } = adapter()
  const id = await tg.sendText('x', { dm: true })
  await tg.react(id, '👀')
  assert.equal(chatOf(calls.at(-1) as Call), '111')
})

test('keyboards are tracked: a message with buttons is listed; removing them unlists it', async () => {
  const { tg, keyboardLists } = adapter()
  const id = await tg.sendText('pick', { rows: [[{ text: 'a', data: 'x' }]] })
  assert.deepEqual(keyboardLists.at(-1), [{ messageId: id, dm: false }])
  await tg.editRows(id, 'picked', [])
  assert.deepEqual(keyboardLists.at(-1), [])
})

test('clearButtons removes the markup in the message\'s chat, using the given chat when the message is not remembered', async () => {
  const { tg, calls } = adapter()
  await tg.clearButtons(tgMsg(77), { dm: true })
  const c = calls.find((x) => x.method === 'editMessageReplyMarkup') as Call
  assert.equal(chatOf(c), '111')
  assert.equal(c.args[1], 77)
})

test('a GIF goes as a document, not a photo', async () => {
  const { tg, calls } = adapter()
  const dir = join(ISOLATED_ROOT, 'uploads-gif')
  mkdirSync(dir, { recursive: true })
  const gif = join(dir, 'anim.gif')
  writeFileSync(gif, 'GIF89a')
  await tg.sendFile(gif, true)
  assert.deepEqual(calls.map((c) => c.method), ['sendDocument'])
})

test('an image over Telegram\'s photo limit goes as a document', async () => {
  const { tg, calls } = adapter()
  const dir = join(ISOLATED_ROOT, 'uploads-big')
  mkdirSync(dir, { recursive: true })
  const big = join(dir, 'big.png')
  writeFileSync(big, 'x')
  truncateSync(big, PHOTO_MAX_BYTES + 1)
  await tg.sendFile(big, true)
  assert.deepEqual(calls.map((c) => c.method), ['sendDocument'])
})

test('a photo Telegram refuses (400) is sent as a document instead', async () => {
  const refused = new GrammyError('Call failed', { ok: false, error_code: 400, description: 'Bad Request: IMAGE_PROCESS_FAILED' }, 'sendPhoto', {})
  const { tg, calls } = adapter({ photoError: refused })
  const dir = join(ISOLATED_ROOT, 'uploads-odd')
  mkdirSync(dir, { recursive: true })
  const odd = join(dir, 'odd.png')
  writeFileSync(odd, 'x')
  const id = await tg.sendFile(odd, true)
  assert.deepEqual(calls.map((c) => c.method), ['sendPhoto', 'sendDocument'])
  assert.equal(typeof id, 'string')
})

test('a photo refused for another reason is an error, not a silent document', async () => {
  const { tg } = adapter({ photoError: new Error('network down') })
  const dir = join(ISOLATED_ROOT, 'uploads-err')
  mkdirSync(dir, { recursive: true })
  const f = join(dir, 'p.png')
  writeFileSync(f, 'x')
  await assert.rejects(tg.sendFile(f, true), /network down/)
})

test('timeouts: a normal call is bounded at 30 s; an upload has a longer bound', () => {
  assert.equal(API_TIMEOUT_S, 30)
  assert.ok(UPLOAD_TIMEOUT_S >= 300)
})

test('inbound handling per chat and topic runs in order; other keys do not wait', async () => {
  const s = new KeyedSerial()
  const log: string[] = []
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const a = s.run('chat|', async () => {
    await gate
    log.push('a')
  })
  const b = s.run('chat|', async () => {
    log.push('b')
  })
  await s.run('other|', async () => {
    log.push('other')
  })
  assert.deepEqual(log, ['other'], 'a different chat is not held up')
  release()
  await Promise.all([a, b])
  assert.deepEqual(log, ['other', 'a', 'b'])
})

test('a failing inbound job does not stop the next one of its key', async () => {
  const s = new KeyedSerial()
  const log: string[] = []
  await s.run('k', async () => {
    throw new Error('boom')
  }).catch(() => {})
  await s.run('k', async () => {
    log.push('next')
  })
  assert.deepEqual(log, ['next'])
})

function msg(over: Partial<Inbound>): Inbound {
  return { kind: 'photo', messageId: tgMsg(0), text: '', replyToId: null, replyToText: null, forwarded: false, from: 'me', fromId: tgUser(111), ...over }
}

test('an album is one inbound: every file in order, and the first caption found', () => {
  const j = joinAlbum([
    msg({ messageId: tgMsg(12), fileRef: 'p2' }),
    msg({ messageId: tgMsg(11), fileRef: 'p1', text: 'the caption' }),
  ])
  assert.equal(j.messageId, tgMsg(11))
  assert.equal(j.text, 'the caption')
  assert.deepEqual(j.album?.map((a) => [a.messageId, a.fileRef]), [[tgMsg(11), 'p1'], [tgMsg(12), 'p2']])
})
