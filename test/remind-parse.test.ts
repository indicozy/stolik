// Remind parse: the Haiku prompt and the check of its reply (valid cron, a future once time, text, a known project).
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildParsePrompt, checkParse } from '../src/addons/remind/parse.ts'

const now = new Date(2026, 10, 19, 10, 0).getTime() // Thu 19 Nov 2026 10:00 local
const PROJECTS = ['stolik']

test('a valid cron reply wrapped in prose is accepted', () => {
  const raw = 'Sure! {"text":"take the bins out","once":null,"cron":"0 9 * * 1-5","project":null} Done.'
  assert.deepEqual(checkParse(raw, now, PROJECTS), {
    text: 'take the bins out',
    schedule: { kind: 'cron', expr: '0 9 * * 1-5' },
    project: null,
  })
})

test('a once reply in the future is accepted as local time', () => {
  const raw = '{"text":"call mom","once":"2026-11-20T09:00","cron":null,"project":null}'
  const parsed = checkParse(raw, now, PROJECTS)
  assert.deepEqual(parsed?.schedule, { kind: 'once', at: new Date(2026, 10, 20, 9, 0).getTime() })
  assert.equal(parsed?.text, 'call mom')
})

test('a once time in the past is rejected', () => {
  assert.equal(checkParse('{"text":"call mom","once":"2026-11-19T09:00","cron":null,"project":null}', now, PROJECTS), null)
})

test('an impossible once date is rejected', () => {
  assert.equal(checkParse('{"text":"call mom","once":"2026-02-30T09:00","cron":null,"project":null}', now, PROJECTS), null)
})

test('a bad cron is rejected', () => {
  assert.equal(checkParse('{"text":"x","once":null,"cron":"99 * * * *","project":null}', now, PROJECTS), null)
})

test('a cron that never matches is rejected', () => {
  assert.equal(checkParse('{"text":"x","once":null,"cron":"0 0 31 2 *","project":null}', now, PROJECTS), null)
})

test('both or neither of once and cron is rejected', () => {
  assert.equal(checkParse('{"text":"x","once":"2026-11-20T09:00","cron":"0 9 * * *","project":null}', now, PROJECTS), null)
  assert.equal(checkParse('{"text":"x","once":null,"cron":null,"project":null}', now, PROJECTS), null)
})

test('empty text is rejected', () => {
  assert.equal(checkParse('{"text":"   ","once":null,"cron":"0 9 * * *","project":null}', now, PROJECTS), null)
})

test('no JSON, or broken JSON, is rejected', () => {
  assert.equal(checkParse('I cannot help with that.', now, PROJECTS), null)
  assert.equal(checkParse('{"text": "x", "cron": ', now, PROJECTS), null)
})

test('a project is kept only when it names a known folder, in the listed spelling', () => {
  const up = checkParse('{"text":"x","once":null,"cron":"0 9 * * *","project":"STOLIK"}', now, PROJECTS)
  assert.equal(up?.project, 'stolik')
  const unknown = checkParse('{"text":"x","once":null,"cron":"0 9 * * *","project":"nope"}', now, PROJECTS)
  assert.equal(unknown?.project, null)
})

test('the parse prompt has the weekday, the JSON shape, the projects and the request in tags', () => {
  const prompt = buildParsePrompt('remind me tomorrow 9:00 call mom', 'remind', new Date(2026, 10, 19, 10, 0), PROJECTS)
  assert.ok(prompt.includes('Thursday'))
  assert.ok(prompt.includes('2026-11-19'))
  assert.ok(prompt.includes('"cron"'))
  assert.ok(prompt.includes('<request>remind me tomorrow 9:00 call mom</request>'))
  assert.ok(buildParsePrompt('x', 'task', new Date(2026, 10, 19, 10, 0), PROJECTS).includes('stolik'))
})
