// Discord ids (research/d1-brief.md, batch D1a, decision 2): "dc:" strings only, snowflakes kept as decimal text
// (they exceed 2^53), compared as BigInt.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MessageId } from '../src/brain/chat-types.ts'
import {
  compareMessages,
  dcChat,
  dcDm,
  dcMsg,
  dcThread,
  dcUser,
  isDcId,
  isSnowflake,
  parseDcChat,
  parseDcDm,
  parseDcMessage,
  parseDcThread,
} from '../src/adapters/chat/dc-ids.ts'

const CH = '100000000000000002' // 18 digits
const MSG = '1000000000000000123' // 19 digits, above 2^53
const MSG_NEXT = '1000000000000000124'
const MAX = '18446744073709551615' // 2^64 - 1

test('dc ids: each kind is built and parsed back as the same digits (above 2^53 too)', () => {
  assert.equal(dcMsg(CH, MSG), `dc:${CH}:${MSG}`)
  assert.deepEqual(parseDcMessage(dcMsg(CH, MSG)), { channelId: CH, messageId: MSG })
  assert.equal(parseDcThread(dcThread(MSG)), MSG)
  assert.equal(dcThread(MSG), `dc:${MSG}`)
  assert.deepEqual(parseDcChat(dcChat('1000000000000000777', CH)), { guildId: '1000000000000000777', channelId: CH })
  assert.equal(dcChat('1000000000000000777', CH), `dc:g1000000000000000777:l${CH}`)
  assert.equal(parseDcDm(dcDm(CH)), CH)
  assert.equal(dcDm(CH), `dc:d${CH}`)
  assert.equal(dcUser(MAX), `dc:${MAX}`)
})

test('dc ids: snowflakes are unsigned 64-bit decimal text, no leading zero, no sign, no spaces', () => {
  for (const ok of ['1', MAX, MSG]) assert.equal(isSnowflake(ok), true, ok)
  for (const bad of ['', '0', '01', '-1', '1.5', '1e3', ' 1', '1 ', '18446744073709551616', '1'.repeat(21), 'abc']) {
    assert.equal(isSnowflake(bad), false, JSON.stringify(bad))
  }
  assert.throws(() => dcUser('0'), /not a Discord user id/)
  assert.throws(() => dcMsg(CH, '18446744073709551616'), /not a Discord message id/)
})

test('dc ids: parsers reject another kind or a malformed id', () => {
  assert.throws(() => parseDcMessage(`dc:${CH}`))
  assert.throws(() => parseDcMessage(`dc:${CH}:${MSG}:1`))
  assert.throws(() => parseDcThread(`dc:${CH}:${MSG}`))
  assert.throws(() => parseDcChat(`dc:d${CH}`))
  assert.throws(() => parseDcDm(`dc:g${CH}:l${MSG}`))
  assert.throws(() => parseDcMessage('tg:1:2'))
  assert.throws(() => parseDcMessage(`Dc:${CH}:${MSG}`))
})

test('dc ids: isDcId accepts every shape and nothing else', () => {
  for (const id of [`dc:${CH}:${MSG}`, `dc:${MSG}`, `dc:g${CH}:l${MSG}`, `dc:d${CH}`]) assert.equal(isDcId(id), true, id)
  for (const id of ['tg:42', 'dc:', 'dc:0', `dc:${CH}:`, `dc:g${CH}`]) assert.equal(isDcId(id), false, id)
})

test('dc ids: compareMessages orders by message snowflake as BigInt, ties are 0', () => {
  const a = dcMsg(CH, MSG) as MessageId
  const b = dcMsg(CH, MSG_NEXT) as MessageId
  assert.ok(compareMessages(a, b) < 0)
  assert.ok(compareMessages(b, a) > 0)
  assert.equal(compareMessages(a, a), 0)
  // The same message number in another channel is a tie: the message snowflake is what orders.
  assert.equal(compareMessages(a, dcMsg('100000000000000009', MSG) as MessageId), 0)
  // Different digit counts: a longer snowflake is newer, a Number() comparison would also agree here, but a string
  // comparison would not.
  const short = dcMsg(CH, '999') as MessageId
  const long = dcMsg(CH, '1000') as MessageId
  assert.ok(compareMessages(short, long) < 0)
  // Sorting a list gives time order.
  const ids = [b, a, short, long].sort(compareMessages)
  assert.deepEqual(ids, [short, long, a, b])
})
