// /help text (plan 2.16): snapshot, size, the words it documents, and the Telegram command menu.
// To accept a deliberate change: UPDATE_SNAPSHOTS=1 node --test --experimental-strip-types test/help.test.ts
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { helpText, ROUTER_COMMANDS } from '../src/router/state.ts'
import { TELEGRAM_CAPABILITIES } from '../src/adapters/chat/telegram.ts'
import { words } from '../src/brain/words.ts'
import { BOT_COMMANDS as COMMANDS } from '../src/brain/commands.ts'
import { PREFIX_WORDS } from '../src/brain/prefixes.ts'

// The Telegram help: the words of the Telegram port (plan 0e decision 9); the snapshot is its exact text.
const HELP_TEXT = helpText(words(TELEGRAM_CAPABILITIES))
const SNAP = join(dirname(fileURLToPath(import.meta.url)), 'snapshots', 'help.txt')

test('help text matches the snapshot', () => {
  if (process.env.UPDATE_SNAPSHOTS === '1' || !existsSync(SNAP)) {
    mkdirSync(dirname(SNAP), { recursive: true })
    writeFileSync(SNAP, HELP_TEXT + '\n')
  }
  assert.equal(HELP_TEXT + '\n', readFileSync(SNAP, 'utf8'))
})

test('help text fits one phone message and documents the v3 surface', () => {
  assert.ok(HELP_TEXT.split('\n').length <= 40, 'at most about 40 lines')
  for (const cmd of ['/list', '/to', '/resume', '/usage', '/addons', '/away', '/here', '/lock', '/bind']) {
    assert.ok(HELP_TEXT.includes(`${cmd}`), `help mentions ${cmd}`)
  }
  // Every word of the design §4.3 table is listed (the code also takes "quick question" and "web search").
  const designWords = ['to', 'send to', 'отправь в', 'new', 'новая', 'новый', 'note', 'заметка', 'запиши', 'quick', 'question',
    'вопрос', 'быстро', 'read', 'check', 'почитай', 'проверь', 'web', 'search', 'поиск', 'загугли']
  for (const w of designWords) assert.ok(HELP_TEXT.includes(w), `help mentions word "${w}"`)
  for (const kind of Object.keys(PREFIX_WORDS)) assert.ok(HELP_TEXT.includes(`${kind}`), `help mentions prefix ${kind}`)
  assert.match(HELP_TEXT, /Topics:/)
  assert.match(HELP_TEXT, /DM:/)
})

test('help text has no btw, no classifier, no reranker', () => {
  assert.doesNotMatch(HELP_TEXT, /btw|classif|rerank/i)
})

test('the Telegram command menu lists only commands the router handles', () => {
  const handled = new Set<string>([...ROUTER_COMMANDS, 'to'])
  for (const { command } of COMMANDS) assert.ok(handled.has(command), `menu entry /${command} is routed`)
  const menu = COMMANDS.map((c) => c.command)
  for (const cmd of ['list', 'to', 'resume', 'usage', 'addons', 'away', 'here', 'lock', 'help']) {
    assert.ok(menu.includes(cmd), `menu has /${cmd}`)
  }
  for (const { command, description } of COMMANDS) {
    assert.match(command, /^[a-z0-9_]{1,32}$/, `/${command} is a valid command name`)
    assert.ok(description.length >= 3 && description.length <= 256, `/${command} description length`)
  }
})
