// Non-Telegram ids in the core (research/d1-brief.md, batch D0): the stores, the chat log, the inbox names, the channel
// meta and the router flows carry "<platform>:<opaque>" ids as strings. Telegram and e2e keep their numbers on disk, in
// the chat log and in the inbox names, as before. The fake's Discord profile uses 19-digit snowflakes.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import type { ButtonPress, ChatId, MessageId, ThreadId } from '../src/brain/chat-types.ts'
import { jsonlLine, newChatLine, parseJsonl, type ChatLine } from '../src/brain/chatlog.ts'
import { loadMsgMap } from '../src/brain/msgmap.ts'
import { parseTopics, serializeTopics, newTopic } from '../src/brain/topics.ts'
import { isWellFormedId, legacyChatId, legacyMsgId, storedId } from '../src/adapters/legacy-ids.ts'
import { hasDbNumber, idFileStem, toDbId } from '../src/adapters/store-ids.ts'
import { tgMsg, tgThread, tgUserOf } from '../src/adapters/chat/tg-ids.ts'
import { SqliteStore } from '../src/adapters/store-sqlite.ts'
import { wireNum, fileStem } from '../src/router/deliver.ts'
import type { ChatLogPort } from '../src/ports.ts'
import { DISCORD_FAKE_CAPABILITIES, DISCORD_GUILD, DISCORD_OWNER, FakeConn, HOME, flush, harness, textFrom } from './helpers/fakes.ts'
import { sandboxPaths } from './helpers/store-contract.ts'
import { MINUTE } from '../src/brain/common.ts'

const DC_MSG = 'dc:100000000000000002:1000000000000000123' as MessageId
const DC_MSG_NEXT = 'dc:100000000000000002:1000000000000000124' as MessageId
const DC_THREAD = 'dc:1000000000000000777' as ThreadId

test('legacy ids: a "<platform>:<opaque>" string is well formed; Telegram and e2e keep their strict forms', () => {
  for (const id of [DC_MSG, DC_THREAD, DISCORD_GUILD, 'dc:d100000000000000003', 'sl:T0123:C0456']) assert.equal(isWellFormedId(id), true, id)
  for (const id of ['tg:-1001234567890', 'tg:42', 'e2e:7']) assert.equal(isWellFormedId(id), true, id)
  for (const id of ['tg:abc', 'tg:', 'e2e:x', 'Dc:1', 'dc:', 'dc:a b', 'dc:a/b', `dc:${'1'.repeat(200)}`, '42', 'x']) assert.equal(isWellFormedId(id), false, id)
  assert.equal(storedId(DC_MSG, legacyMsgId), DC_MSG)
  assert.equal(storedId(' tg:9 ', legacyMsgId), 'tg:9')
  assert.equal(storedId('tg:abc', legacyMsgId), null)
  // Numbers (a file or a setting) still take the legacy rules.
  assert.equal(storedId(12, legacyMsgId), 'tg:12')
  assert.equal(storedId('-1000000000000005', legacyChatId), 'e2e:5')
})

test('a Discord snowflake is never a number: the owner id is text, and the stores keep it that way', () => {
  assert.equal(tgUserOf('123456789012345678'), 'tg:123456789012345678')
  assert.throws(() => tgUserOf('12a'))
  assert.equal(hasDbNumber(DC_MSG), false)
  assert.equal(hasDbNumber(tgMsg(5)), true)
  assert.equal(hasDbNumber('e2e:4'), true)
  assert.throws(() => toDbId(DC_MSG), /no storable form/)
})

test('file stems: Telegram and e2e stay numbers; another platform gets a file-safe form, injective for these ids', () => {
  assert.equal(idFileStem(DC_MSG), 'dc-100000000000000002-1000000000000000123')
  assert.equal(idFileStem('dc:a_b/c'), 'dc-a_5fb_2fc')
  assert.notEqual(idFileStem('dc:a_b'), idFileStem('dc:a-b'))
  assert.equal(fileStem(tgMsg(10)), '10')
  assert.equal(fileStem(DC_MSG), idFileStem(DC_MSG))
  assert.equal(wireNum(tgMsg(10)), '10')
  assert.equal(wireNum(DC_MSG), DC_MSG)
})

test('chat log: a Telegram line keeps its exact keys and numbers; another platform writes string ids and reads them back', () => {
  const tg: ChatLine = newChatLine({ ts: Date.UTC(2026, 10, 18, 9), dir: 'in', kind: 'text', text: 'hi', tg_message_id: tgMsg(42), topic_id: tgThread(7) })
  const line = jsonlLine(tg)
  assert.equal(line, '{"ts":"2026-11-18T09:00:00.000Z","dir":"in","kind":"text","text":"hi","raw":null,"target":null,"topic_id":7,' +
    '"backend":null,"scores":null,"gap":null,"attachments":[],"tg_message_id":42}\n')

  const dc: ChatLine = newChatLine({ ts: Date.UTC(2026, 10, 18, 9), dir: 'out', kind: 'text', text: 'ok', tg_message_id: DC_MSG, topic_id: DC_THREAD })
  const text = jsonlLine(dc)
  const o = JSON.parse(text) as Record<string, unknown>
  assert.equal(o.tg_message_id, null)
  assert.equal(o.topic_id, null)
  assert.equal(o.message_id, DC_MSG)
  assert.equal(o.thread_id, DC_THREAD)
  const back = parseJsonl(text)[0]
  assert.equal(back.tg_message_id, DC_MSG)
  assert.equal(back.topic_id, DC_THREAD)
  assert.equal(parseJsonl(line)[0].tg_message_id, tgMsg(42))
})

test('restart reload: message map and topics written with Discord ids load back to the same ids', () => {
  const json = JSON.stringify([[DC_MSG, { key: 'k', name: 'proj', cwd: '/c' }]])
  const map = loadMsgMap(json)
  assert.equal(map.get(DC_MSG)?.name, 'proj')

  const topic = newTopic(DC_THREAD, 'proj', 'proj', '/p/proj')
  const back = parseTopics(serializeTopics([topic]))
  assert.equal(back.length, 1)
  assert.equal(back[0].threadId, DC_THREAD)
})

test('store: a Discord group id, a message map and a topic survive a close and reopen', () => {
  const sb = sandboxPaths('discord-ids')
  const open = () => new SqliteStore({ stateDir: sb.paths.stateDir, inboxDir: sb.paths.inboxDir, notesDir: sb.paths.notesDir })
  try {
    const a = open()
    a.writeGroupId(DISCORD_GUILD as ChatId)
    a.writeMsgMap(JSON.stringify([[DC_MSG, { key: 'k', name: 'proj', cwd: '/c' }]]))
    a.writeTopics(serializeTopics([newTopic(DC_THREAD, 'proj', 'proj', '/p/proj')]))
    const b = open()
    assert.equal(b.readGroupId(), DISCORD_GUILD)
    assert.equal(loadMsgMap(b.readMsgMap()).get(DC_MSG)?.name, 'proj')
    assert.equal(parseTopics(b.readTopics())[0].threadId, DC_THREAD)
    assert.equal(join(sb.paths.inboxDir, idFileStem(DC_MSG)), b.inboxPath(idFileStem(DC_MSG)))
  } finally {
    sb.cleanup()
  }
})

// ---- router flows on the Discord-shaped fake ----

const DISCORD = { discord: true, groupId: DISCORD_GUILD as ChatId, ownerUserId: DISCORD_OWNER }

async function tap(h: ReturnType<typeof harness>, data: string, message: MessageId, id = 'cb') {
  const c: ButtonPress = { pressId: id, data, message, from: DISCORD_OWNER, chat: { kind: 'home', id: DISCORD_GUILD as ChatId, thread: null } }
  await h.chat.callback(c)
  await flush()
}

function register(h: ReturnType<typeof harness>, cwd: string, pid: number): FakeConn {
  h.platform.dirs.add(cwd)
  const conn = new FakeConn()
  h.agent.receive(conn, { t: 'register', claudePid: pid, cwd })
  return conn
}

class RecordingLog implements ChatLogPort {
  readonly lines: ChatLine[] = []
  append(line: ChatLine): void {
    this.lines.push(line)
  }
  attachmentPath(): null {
    return null
  }
  recentExchanges(): ChatLine[] {
    return []
  }
}

test('Discord profile: the fake sends 19-digit snowflake ids that stay distinct and compare as BigInt', () => {
  const h = harness(DISCORD)
  assert.equal(h.chat.capabilities.platform, DISCORD_FAKE_CAPABILITIES.platform)
  assert.equal(h.chat.compareMessages(DC_MSG, DC_MSG_NEXT), -1)
  assert.equal(h.chat.compareMessages(DC_MSG_NEXT, DC_MSG), 1)
  assert.equal(h.chat.compareMessages(DC_MSG, DC_MSG), 0)
})

test('Discord profile: a text in the lobby with no session gets its buttons; the reply and the log use the string ids', async () => {
  const log = new RecordingLog()
  const h = harness({ ...DISCORD, chatLog: log })
  await h.router.start()
  await h.chat.inbound(textFrom('hello?', { messageId: DC_MSG, fromId: DISCORD_OWNER, chat: { kind: 'home', id: DISCORD_GUILD as ChatId, thread: null } }))
  assert.equal(h.agent.sent.length, 0)
  const ask = h.chat.sent[0]
  assert.match(ask.text, /^No session can take it right now/)
  assert.ok(ask.id.startsWith('dc:'), `sent id ${ask.id}`)
  const inbound = log.lines.find((l) => l.dir === 'in')
  assert.equal(inbound?.tg_message_id, DC_MSG)
  assert.equal(jsonlLine(inbound!).includes(`"message_id":"${DC_MSG}"`), true)
})

test('Discord profile: several sessions give buttons; a tap with a Discord message id delivers to the chosen session', async () => {
  const h = harness(DISCORD)
  await h.router.start()
  register(h, `${HOME}/proj`, 4001)
  await flush()
  h.clock.advance(5 * MINUTE)
  register(h, `${HOME}/other`, 4002)
  await flush()
  await h.chat.inbound(textFrom('which one?', { messageId: DC_MSG, fromId: DISCORD_OWNER, chat: { kind: 'home', id: DISCORD_GUILD as ChatId, thread: null } }))
  assert.equal(h.agent.sent.length, 0)
  const rows = h.chat.sent[0].opts!.rows!
  await tap(h, rows[1][0].data, h.chat.sent[0].id)
  assert.equal(h.agent.sent.length, 1)
  assert.equal(h.agent.sent[0].content, 'which one?')
  assert.ok(h.chat.edits.length > 0)
})
