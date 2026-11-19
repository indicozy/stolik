// The chat adapter contract (chat connector 0d batch 3) run against the Telegram adapter, built through its seam
// (botInfo set so grammY does not call getMe; a transformer on every Bot API call that records the call in the
// contract's terms and answers it). Updates go in through bot.handleUpdate, so grammY's real middleware and handlers
// run. Downloads stub globalThis.fetch. No network. Platform refusals are the Bot API's own answers (the same
// descriptions chat-error.test.ts uses).
import './helpers/isolate.ts'
import { statSync } from 'node:fs'
import { Telegram, TELEGRAM_CAPABILITIES } from '../src/adapters/chat/telegram.ts'
import { chatContract, type Failure, type Out, type Rig, type Where } from './helpers/chat-contract.ts'
import { tgChat, tgMsg, tgNum, tgThread, tgUser } from '../src/adapters/chat/tg-ids.ts'

const OWNER_NUM = 111
const GROUP_NUM = -1001
const OTHER_NUM = -1002
const OWNER_USER = { id: OWNER_NUM, is_bot: false, first_name: 'owner' }
const STRANGER = { id: 777, is_bot: false, first_name: 'stranger' }
const BOT_USER = { id: 999, is_bot: true, first_name: 'bot', username: 'bot' }
const BOT_INFO = { ...BOT_USER, can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false }
const DM_CHAT = { id: OWNER_NUM, type: 'private', first_name: 'owner' }
const GROUP_CHAT = { id: GROUP_NUM, type: 'supergroup', title: 'group' }
const MAX_TEXT = 4096

const where = (chatId: unknown): Where => (String(chatId) === String(OWNER_NUM) ? 'dm' : String(chatId) === String(GROUP_NUM) ? 'home' : 'other')
const ok = (result: unknown) => ({ ok: true, result })
const buttonsOf = (markup: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined): string[] =>
  (markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data ?? '')
const at = (w: 'dm' | 'home' | undefined) => (w === 'home' ? GROUP_CHAT : DM_CHAT)

// The Bot API's answer for each refusal. A network failure is thrown, as a dropped connection is.
function refusal(f: Failure): unknown {
  switch (f) {
    case 'rate-limited': return { ok: false, error_code: 429, description: 'Too Many Requests: retry after 2', parameters: { retry_after: 2 } }
    case 'access-lost': return { ok: false, error_code: 403, description: 'Forbidden: bot was kicked from the supergroup chat' }
    case 'thread-closed': return { ok: false, error_code: 400, description: 'Bad Request: message thread not found' }
    case 'not-modified': return { ok: false, error_code: 400, description: 'Bad Request: TOPIC_NOT_MODIFIED' }
    case 'too-long': return { ok: false, error_code: 400, description: 'Bad Request: message is too long' }
    case 'server': return { ok: false, error_code: 500, description: 'Internal Server Error' }
    case 'client': return { ok: false, error_code: 400, description: 'Bad Request: wrong file identifier' }
    case 'network': throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
  }
}

async function telegramRig(): Promise<Rig> {
  const calls: Out[] = []
  let failure: { kind: Failure; skip: number } | null = null
  const gone = new Set<number>()
  let nextSent = 500
  let nextTopic = 40
  let nextIn = 900
  let nextUpdate = 1
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response('hello')) as unknown as typeof fetch

  const transformer = async (_prev: unknown, method: string, payload: any): Promise<any> => {
    if (failure) {
      if (failure.skip > 0) failure.skip--
      else {
        const kind = failure.kind
        failure = null
        return refusal(kind)
      }
    }
    if (method === 'sendMessage' && String(payload.text).length > MAX_TEXT) return refusal('too-long')
    if (method === 'sendMessage' && payload.message_thread_id !== undefined && gone.has(payload.message_thread_id)) return refusal('thread-closed')
    switch (method) {
      case 'sendMessage': {
        const id = nextSent++
        calls.push({
          op: 'send',
          chat: where(payload.chat_id),
          thread: payload.message_thread_id !== undefined ? tgThread(payload.message_thread_id) : undefined,
          text: payload.text,
          replyTo: payload.reply_parameters !== undefined,
          buttons: buttonsOf(payload.reply_markup),
          id: tgMsg(id),
        })
        return ok({ message_id: id, date: 1, chat: { id: Number(payload.chat_id), type: 'private' }, text: payload.text })
      }
      case 'sendPhoto':
      case 'sendDocument': {
        const input = payload.photo ?? payload.document
        if (typeof input.fileData === 'string' && statSync(input.fileData).size > TELEGRAM_CAPABILITIES.files.maxUploadBytes) {
          return { ok: false, error_code: 400, description: 'Bad Request: file is too big' }
        }
        const id = nextSent++
        calls.push({ op: 'file', chat: where(payload.chat_id), path: input.fileData, asPhoto: method === 'sendPhoto', id: tgMsg(id) })
        return ok({ message_id: id, date: 1, chat: { id: Number(payload.chat_id), type: 'private' } })
      }
      case 'editMessageText':
        calls.push({ op: 'edit', chat: where(payload.chat_id), id: tgMsg(payload.message_id), text: payload.text, buttons: buttonsOf(payload.reply_markup) })
        return ok(true)
      case 'editMessageReplyMarkup':
        calls.push({ op: 'clear', chat: where(payload.chat_id), id: tgMsg(payload.message_id) })
        return ok(true)
      case 'setMessageReaction':
        calls.push({ op: 'react', chat: where(payload.chat_id), id: tgMsg(payload.message_id), emoji: payload.reaction[0].emoji })
        return ok(true)
      case 'sendChatAction':
        calls.push({ op: 'typing', chat: where(payload.chat_id), thread: payload.message_thread_id !== undefined ? tgThread(payload.message_thread_id) : undefined })
        return ok(true)
      case 'createForumTopic': {
        const n = nextTopic++
        calls.push({ op: 'topic', action: 'create', thread: tgThread(n), name: payload.name })
        return ok({ message_thread_id: n, name: payload.name })
      }
      case 'editForumTopic':
        calls.push({ op: 'topic', action: 'rename', thread: tgThread(payload.message_thread_id), name: payload.name })
        return ok(true)
      case 'reopenForumTopic':
        calls.push({ op: 'topic', action: 'reopen', thread: tgThread(payload.message_thread_id) })
        return ok(true)
      case 'answerCallbackQuery':
        calls.push({ op: 'ack', id: payload.callback_query_id, text: payload.text })
        return ok(true)
      case 'getFile':
        return ok({ file_id: payload.file_id, file_unique_id: 'u', file_path: `photos/${payload.file_id}.jpg`, file_size: 5 })
      default:
        return ok(true)
    }
  }

  const tg = new Telegram('123:TEST', String(OWNER_NUM), [], String(OWNER_NUM), null, { botInfo: BOT_INFO as never, transformer })
  // Updates go through grammY's own dispatch, as Telegram's poll would deliver them.
  const feed = (update: object) => (tg as unknown as { bot: { handleUpdate(u: unknown): Promise<void> } }).bot.handleUpdate(update)

  return {
    chat: tg,
    dm: tgChat(OWNER_NUM),
    home: tgChat(GROUP_NUM),
    otherHome: tgChat(OTHER_NUM),
    owner: tgUser(OWNER_NUM),
    ghost: tgMsg(999999),
    adapterFilters: true,
    out: () => calls,
    fail: (kind, skip = 0) => {
      failure = { kind, skip }
    },
    goneThread: (t) => {
      gone.add(tgNum(t))
    },
    inject: {
      async message(o) {
        const msg: any = { message_id: nextIn++, date: 1, chat: at(o.chat), from: o.from === 'stranger' ? STRANGER : OWNER_USER }
        const kind = o.kind ?? 'text'
        if (kind === 'sticker') msg.sticker = { file_id: 'st', file_unique_id: 'su', type: 'regular', width: 1, height: 1, is_animated: false, is_video: false }
        else if (kind === 'photo') {
          msg.photo = [{ file_id: 'ph1', file_unique_id: 'pu', width: 1, height: 1 }]
          if (o.text) msg.caption = o.text
        } else msg.text = o.text ?? ''
        if (o.thread !== undefined) {
          msg.is_topic_message = true
          msg.message_thread_id = tgNum(o.thread)
        }
        if (o.replyTo !== undefined) msg.reply_to_message = { message_id: tgNum(o.replyTo), date: 1, chat: at(o.chat), text: 'orig' }
        await feed({ update_id: nextUpdate++, message: msg })
      },
      async press(o) {
        const cb: any = { id: `cb${nextUpdate}`, from: o.from === 'stranger' ? STRANGER : OWNER_USER, chat_instance: 'ci', data: o.data }
        if (o.message !== undefined) cb.message = { message_id: tgNum(o.message), date: 1, chat: at(o.chat), text: 'x' }
        await feed({ update_id: nextUpdate++, callback_query: cb })
      },
      async event(e) {
        const update = nextUpdate++
        switch (e.type) {
          case 'home-moved':
            return feed({ update_id: update, message: { message_id: nextIn++, date: 1, chat: GROUP_CHAT, from: OWNER_USER, migrate_to_chat_id: OTHER_NUM } })
          case 'member-joined': {
            const user = e.who === 'bot' ? BOT_USER : { id: e.who === 'owner' ? OWNER_NUM : STRANGER.id, is_bot: false, first_name: e.label }
            return feed({
              update_id: update,
              chat_member: { chat: GROUP_CHAT, from: OWNER_USER, date: 1, old_chat_member: { status: 'left', user }, new_chat_member: { status: 'member', user } },
            })
          }
          case 'rights':
            return feed({
              update_id: update,
              my_chat_member: {
                chat: GROUP_CHAT,
                from: OWNER_USER,
                date: 1,
                old_chat_member: { status: 'administrator', user: BOT_USER, can_manage_topics: true },
                new_chat_member: e.access === 'ok' ? { status: 'administrator', user: BOT_USER, can_manage_topics: true } : { status: 'left', user: BOT_USER },
              },
            })
          case 'anonymous-post':
            return feed({ update_id: update, message: { message_id: nextIn++, date: 1, chat: GROUP_CHAT, from: OWNER_USER, sender_chat: GROUP_CHAT, text: 'as the group' } })
        }
      },
    },
    close: async () => {
      await tg.stop()
      globalThis.fetch = realFetch
    },
  }
}

// The contract's remaining Telegram gaps. Each is a real mismatch, not a rig limit: the adapter maps every platform
// refusal through toChatError, and that function has no mapping for the "message is too long" or "file is too big"
// answers, so they reach the router as `other`. The adapter does not check the upload cap itself.
const TOO_LONG = 'toChatError has no mapping for "message is too long"; the refusal reaches the router as other'
chatContract('Telegram', telegramRig, {
  skip: {
    'E16:start': 'start() long-polls getUpdates; the rig has no poll loop and the suite makes no network calls',
  },
  todo: {
    E4: TOO_LONG,
    'E9:too-long': TOO_LONG,
    'E15:cap': 'the adapter does not check files.maxUploadBytes, and "file is too big" maps to other, not too-long',
  },
})
