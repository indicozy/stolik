// tg-notify's flags (src/notify-args.ts): --silent and --critical set the level; bad flags are refused.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseNotifyArgs } from '../src/notify-args.ts'

test('tg-notify flags: no flag is the default level; --silent and --critical set it', () => {
  assert.equal(parseNotifyArgs(['build', 'done']).level, 'default')
  assert.equal(parseNotifyArgs(['--silent', 'progress']).level, 'silent')
  assert.equal(parseNotifyArgs(['--critical', 'blocked']).level, 'critical')
  assert.deepEqual(parseNotifyArgs(['--silent', 'a', 'b']).words, ['a', 'b'], 'the level flag is not a word')
})

test('tg-notify flags: --silent with --critical is refused', () => {
  assert.throws(() => parseNotifyArgs(['--silent', '--critical', 'x']), /cannot be used together/)
  assert.throws(() => parseNotifyArgs(['--critical', '--silent', 'x']), /cannot be used together/)
})

test('tg-notify flags: the other flags still parse, with --file in both forms', () => {
  const a = parseNotifyArgs(['--raw', '--plain', '--silent', '--file', '/tmp/a.png', '--file=/tmp/b.png', 'done'])
  assert.equal(a.raw, true)
  assert.equal(a.plain, true)
  assert.equal(a.level, 'silent')
  assert.deepEqual(a.files, ['/tmp/a.png', '/tmp/b.png'])
  assert.deepEqual(a.words, ['done'])
  assert.throws(() => parseNotifyArgs(['--file']), /--file needs a path/)
})
