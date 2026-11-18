// The Telegram adapter's pure helpers. The sender gate and the chat decisions are tested in brain-inbound.test.ts;
// the grammY wiring itself needs a real bot and is checked on the test group (plan 2.1 verify).
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GrammyError } from 'grammy'
import { Telegram, chatRef, fromId } from '../src/adapters/chat/telegram.ts'
import { tgChat, tgThread, tgUser, tgMsg } from '../src/adapters/chat/tg-ids.ts'

test('chatRef: private chat, supergroup and other chats map to their kind, id as a string', () => {
  assert.deepEqual(chatRef({ type: 'private', id: 4242 }), { kind: 'dm', id: tgChat(4242), thread: null })
  assert.deepEqual(chatRef({ type: 'supergroup', id: -1001234 }), { kind: 'home', id: tgChat(-1001234), thread: null })
  assert.deepEqual(chatRef({ type: 'group', id: -55 }), { kind: 'other', id: tgChat(-55), thread: null })
  assert.deepEqual(chatRef({ type: 'channel', id: -1002 }), { kind: 'other', id: tgChat(-1002), thread: null })
})

test('chatRef: a forum topic message carries its thread; General (no topic flag) carries none', () => {
  const chat = { type: 'supergroup', id: -1001234 }
  assert.equal(chatRef(chat, { is_topic_message: true, message_thread_id: 77 }).thread, tgThread(77))
  assert.equal(chatRef(chat, { message_thread_id: 1 }).thread, null)
  assert.equal(chatRef(chat, { is_topic_message: false, message_thread_id: 1 }).thread, null)
})

test('fromId: user id becomes its tg: id, missing sender becomes empty', () => {
  assert.equal(fromId(4242), tgUser(4242))
  assert.equal(fromId(0), tgUser(0))
  assert.equal(fromId(undefined), '')
})

// Review finding 8: a file download has a timeout. The Telegram file lookup and the download fetch both get an abort
// signal (60 s). The stubs stop the download before anything is written.
test('a file download passes an abort signal to the lookup and to the fetch', async () => {
  const tg = new Telegram('123:TEST', '1', [], '1')
  const api = (tg as unknown as { bot: { api: { getFile: (id: string, signal?: AbortSignal) => Promise<unknown> } } }).bot.api
  let lookupSignal: AbortSignal | undefined
  api.getFile = async (_id: string, signal?: AbortSignal) => {
    lookupSignal = signal
    return { file_path: 'voice/a.ogg', file_size: 10 }
  }
  const realFetch = globalThis.fetch
  let fetchSignal: AbortSignal | null | undefined
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    fetchSignal = init?.signal
    throw new Error('stop here')
  }) as typeof fetch
  try {
    await assert.rejects(tg.download('f1', '/nonexistent/dir/a.ogg', 1000), /stop here/)
  } finally {
    globalThis.fetch = realFetch
  }
  assert.ok(lookupSignal instanceof AbortSignal, 'the getFile call has a signal')
  assert.ok(fetchSignal instanceof AbortSignal, 'the download fetch has a signal')
  assert.equal(fetchSignal.aborted, false)
})

// Markdown sends: HTML with parse_mode, and a chunk Telegram refuses as HTML goes again as plain text.
test('sendText with format markdown sends HTML; a "can\'t parse entities" refusal resends the same text as plain', async () => {
  const tg = new Telegram('123:TEST', '1', [], '1')
  const api = (tg as unknown as { bot: { api: { sendMessage: (...a: unknown[]) => Promise<{ message_id: number }> } } }).bot.api
  const calls: Array<{ text: string; opts: Record<string, unknown> }> = []
  api.sendMessage = async (_chat: unknown, text: unknown, opts: unknown) => {
    calls.push({ text: text as string, opts: opts as Record<string, unknown> })
    if ((opts as { parse_mode?: string }).parse_mode === 'HTML' && (text as string).includes('refuse')) {
      throw new GrammyError("Bad Request: can't parse entities: bad", { ok: false, error_code: 400, description: "Bad Request: can't parse entities: bad" }, 'sendMessage', {})
    }
    return { message_id: calls.length }
  }
  assert.equal(await tg.sendText('**hi** & bye', { format: 'markdown' }), tgMsg(1))
  assert.equal(calls[0]!.text, '<b>hi</b> &amp; bye')
  assert.equal(calls[0]!.opts.parse_mode, 'HTML')

  assert.equal(await tg.sendText('**refuse**', { format: 'markdown' }), tgMsg(3))
  assert.equal(calls.length, 3)
  assert.equal(calls[1]!.text, '<b>refuse</b>')
  assert.equal(calls[2]!.text, '**refuse**', 'the fallback is the raw text, not the HTML')
  assert.equal(calls[2]!.opts.parse_mode, undefined)

  await tg.sendText('**plain**')
  assert.equal(calls[3]!.text, '**plain**')
  assert.equal(calls[3]!.opts.parse_mode, undefined)
})

test('sendText with format markdown: an error other than an entity refusal is not retried as plain', async () => {
  const tg = new Telegram('123:TEST', '1', [], '1')
  const api = (tg as unknown as { bot: { api: { sendMessage: (...a: unknown[]) => Promise<unknown> } } }).bot.api
  let calls = 0
  api.sendMessage = async () => {
    calls++
    throw new GrammyError('Bad Request: chat not found', { ok: false, error_code: 400, description: 'Bad Request: chat not found' }, 'sendMessage', {})
  }
  await assert.rejects(tg.sendText('x', { format: 'markdown' }), /chat not found/)
  assert.equal(calls, 1)
})
