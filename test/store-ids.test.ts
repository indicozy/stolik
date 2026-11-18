import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toDbId, fromDbMsg, fromDbThread, fromDbChat, E2E_DB_BASE } from '../src/adapters/store-ids.ts'
import { tgMsg, tgThread, tgChat, tgUser, tgNum } from '../src/adapters/chat/tg-ids.ts'
import { e2eMsg, e2eNum, isE2eId } from '../src/router/e2e.ts'

test('Telegram ids round-trip through the store numbers', () => {
  assert.equal(toDbId(tgMsg(42)), 42)
  assert.equal(toDbId(tgThread(7)), 7)
  assert.equal(toDbId(tgChat(-1001234567890)), -1001234567890)
  assert.equal(toDbId(tgUser(99)), 99)
  assert.equal(fromDbMsg(42), 'tg:42')
  assert.equal(fromDbThread(7), 'tg:7')
  assert.equal(fromDbChat(-1001234567890), 'tg:-1001234567890')
  assert.equal(fromDbChat(toDbId(tgChat(-100123))), tgChat(-100123))
})

test('null stays null in both directions', () => {
  assert.equal(toDbId(null), null)
  assert.equal(fromDbMsg(null), null)
  assert.equal(fromDbThread(null), null)
  assert.equal(fromDbChat(null), null)
})

test('e2e ids round-trip and never collide with Telegram numbers', () => {
  for (const n of [0, 1, 5, 123456]) {
    const id = e2eMsg(n)
    const stored = toDbId(id)
    assert.equal(typeof stored, 'number')
    assert.ok((stored as number) <= -E2E_DB_BASE)
    assert.equal(fromDbMsg(stored as number), id)
    assert.equal(fromDbThread(stored as number), id)
    assert.equal(fromDbChat(stored as number), id)
    assert.equal(e2eNum(id), n)
  }
  // Telegram's largest-magnitude real id (a supergroup) stays on the Telegram side.
  assert.equal(fromDbChat(-1_002_000_000_000), 'tg:-1002000000000')
})

test('ids that have no storable form are refused', () => {
  assert.throws(() => toDbId('dc:123:456'))
  assert.throws(() => toDbId(''))
  assert.throws(() => fromDbMsg(1.5))
  assert.throws(() => tgNum('e2e:5'))
  assert.throws(() => tgNum('tg:abc'))
  assert.throws(() => tgNum('tg:'))
  assert.throws(() => e2eMsg(-1))
  assert.throws(() => e2eNum('tg:5'))
})

test('tgNum reads the number back and e2e ids are recognised', () => {
  assert.equal(tgNum(tgMsg(-3)), -3)
  assert.equal(isE2eId(e2eMsg(9)), true)
  assert.equal(isE2eId('tg:9'), false)
  assert.equal(isE2eId('e2e:'), false)
})
