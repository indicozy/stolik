// Review round (v3 fix-tg): the pure rules behind the fixes. Topic errors, the bot's rights, delete backoff, the
// message length limits and the reaction list.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DELETE_MAX_FAILURES, DELETE_RETRY_BASE_MS, deleteRetryDelay, errorText, isThreadGone, isTopicNotModified,
} from '../src/brain/topics.ts'
import { fitText, questionText, type AskQuestion } from '../src/router/ask.ts'
import { TG_TEXT_LIMIT } from '../src/router/state.ts'
import { ChatError } from '../src/brain/chat-types.ts'
import { REACTION_EMOJI } from '../src/adapters/chat/telegram.ts'

test('a thread that is gone is recognised from the adapter\'s ChatError kind, and nothing else', () => {
  assert.equal(isThreadGone(new ChatError('thread-closed', 'Call to sendMessage failed! (400: Bad Request: message thread not found)')), true)
  assert.equal(isThreadGone(new ChatError('other', 'Too Many Requests')), false)
  assert.equal(isThreadGone(new ChatError('not-modified', 'Bad Request: TOPIC_NOT_MODIFIED')), false)
  assert.equal(isThreadGone(new Error('Bad Request: message thread not found')), false, 'the text alone is not read here')
})

test('TOPIC_NOT_MODIFIED is the state already asked for (success), not a failure', () => {
  assert.equal(isTopicNotModified(new ChatError('not-modified', 'Bad Request: TOPIC_NOT_MODIFIED')), true)
  assert.equal(isTopicNotModified(new ChatError('thread-closed', 'Bad Request: message thread not found')), false)
  assert.equal(errorText(42), '42')
})

test('delete backoff: 1 h, 2 h, 4 h, 8 h, and a limit of failures before giving up', () => {
  assert.equal(deleteRetryDelay(1), DELETE_RETRY_BASE_MS)
  assert.equal(deleteRetryDelay(2), 2 * DELETE_RETRY_BASE_MS)
  assert.equal(deleteRetryDelay(4), 8 * DELETE_RETRY_BASE_MS)
  assert.equal(DELETE_MAX_FAILURES, 5)
})

test('a long question is cut to one Telegram message (code points, never a split emoji)', () => {
  const long = 'é😀'.repeat(3000)
  const cut = fitText(long)
  assert.equal(Array.from(cut).length, TG_TEXT_LIMIT)
  assert.ok(cut.endsWith('…'))
  assert.equal(fitText('short'), 'short')
  const q: AskQuestion = { question: 'x'.repeat(6000), header: '', options: [{ label: 'yes', description: '' }], multiSelect: false }
  assert.ok(Array.from(questionText('proj', q)).length <= TG_TEXT_LIMIT)
})

test('the busy and idle reactions are on Telegram\'s allowed list (grammY types)', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const types = readFileSync(join(here, '..', 'node_modules', '@grammyjs', 'types', 'message.d.ts'), 'utf8')
  const allowed = types.slice(types.indexOf('export interface ReactionTypeEmoji'))
  for (const e of Object.values(REACTION_EMOJI)) assert.ok(allowed.includes(`"${e}"`), `${e} is in the list`)
  assert.equal(REACTION_EMOJI.queued, '✍', 'the old ⏳ is not an allowed reaction')
})
