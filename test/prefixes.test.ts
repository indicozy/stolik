import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { editDistance, matchName, parseGeneral, parsePrefix, parseNote, type Prefix } from '../src/brain/prefixes.ts'

// Table-driven: [input, expected prefix or null]. Covers English, Russian, spoken style, no separator, spaces in names.
const PARSE: Array<[string, Prefix | null]> = [
  ['to cat: hi', { kind: 'to', name: 'cat', body: 'hi' }],
  ['To Cat, hi there', { kind: 'to', name: 'Cat', body: 'hi there' }],
  ['TO CAT: hi', { kind: 'to', name: 'CAT', body: 'hi' }],
  ['send to cat - hi', { kind: 'to', name: 'cat', body: 'hi' }],
  ['Send To cat — hi', { kind: 'to', name: 'cat', body: 'hi' }],
  ['to stolik: fix it', { kind: 'to', name: 'stolik', body: 'fix it' }],
  ['to stolik - fix it', { kind: 'to', name: 'stolik', body: 'fix it' }],
  ['to cat garden, look at this', { kind: 'to', name: 'cat garden', body: 'look at this' }],
  ['to cat  , hi', { kind: 'to', name: 'cat', body: 'hi' }],
  ['to: hello', { kind: 'to', body: 'hello' }],
  ['отправь в cat: привет', { kind: 'to', name: 'cat', body: 'привет' }],
  ['ОТПРАВЬ В Cat: привет', { kind: 'to', name: 'Cat', body: 'привет' }],
  ['new cat: start', { kind: 'new', name: 'cat', body: 'start' }],
  ['new: something', { kind: 'new', body: 'something' }],
  ['новая проект: x', { kind: 'new', name: 'проект', body: 'x' }],
  ['Новый: x', { kind: 'new', body: 'x' }],
  ['note: buy milk', { kind: 'note', body: 'buy milk' }],
  ['Note — buy milk', { kind: 'note', body: 'buy milk' }],
  ['NOTE, buy milk', { kind: 'note', body: 'buy milk' }],
  ['quick - x', { kind: 'quick', body: 'x' }],
  ['quick- x', { kind: 'quick', body: 'x' }],
  ['read — the docs', { kind: 'read', body: 'the docs' }],
  ['  \n note:\nbuy', { kind: 'note', body: 'buy' }],
  ['note:', { kind: 'note', body: '' }],
  ['заметка: купить молоко', { kind: 'note', body: 'купить молоко' }],
  ['запиши: хлеб', { kind: 'note', body: 'хлеб' }],
  ['Quick question: why', { kind: 'quick', body: 'why' }],
  ['quick: why', { kind: 'quick', body: 'why' }],
  ['question, why', { kind: 'quick', body: 'why' }],
  ['вопрос: почему', { kind: 'quick', body: 'почему' }],
  ['быстро, что такое', { kind: 'quick', body: 'что такое' }],
  ['read: the docs', { kind: 'read', body: 'the docs' }],
  ['check, the status', { kind: 'read', body: 'the status' }],
  ['почитай: README', { kind: 'read', body: 'README' }],
  ['проверь - лог', { kind: 'read', body: 'лог' }],
  ['web search: lint rules', { kind: 'web', body: 'lint rules' }],
  ['search: lint', { kind: 'web', body: 'lint' }],
  ['загугли: погода', { kind: 'web', body: 'погода' }],
  ['поиск: погода', { kind: 'web', body: 'погода' }],
  // No separator: an ordinary message.
  ['note that the build failed', null],
  ['to cat hello', null],
  ['to hello there', null],
  ['to sto lik', null],
  ['read this', null],
  ['quick question about the build: why', null],
  // A dash inside a word is not a separator, only a dash followed by a space is (the coordinator's rule).
  ['note-to-self', null],
  ['quick-fix the bug', null],
  ['read-only audit', null],
  ['web-based tool', null],
  ['check-in with the team', null],
  ['Quick question about the build', null],
  // Words that only start like a prefix.
  ['notes: x', null],
  ['newbie: x', null],
  ['tomorrow: x', null],
  ['checkout: x', null],
  ['take a note: x', null],
  ['/note buy milk', null],
  ['', null],
  ['   ', null],
  // A name that spans lines, or is a whole sentence, is not a name.
  ['to cat\nhi: x', null],
  ['to ' + 'x'.repeat(61) + ': hi', null],
]

test('parsePrefix: table of inputs', () => {
  for (const [input, want] of PARSE) {
    assert.deepEqual(parsePrefix(input), want, `input: ${JSON.stringify(input)}`)
  }
})

test('parsePrefix: a name is cut at the first separator, so a name with spaces needs one', () => {
  assert.deepEqual(parsePrefix('to cat garden: hi'), { kind: 'to', name: 'cat garden', body: 'hi' })
  assert.deepEqual(parsePrefix('to cat garden hi: x'), { kind: 'to', name: 'cat garden hi', body: 'x' })
})

test('parsePrefix: only the start of a message counts', () => {
  assert.equal(parsePrefix('hello. note: later'), null)
  assert.equal(parsePrefix('ok, to cat: hi'), null)
})

test('parseGeneral: the one entry for General messages', () => {
  assert.deepEqual(parseGeneral('Quick question: why'), { kind: 'quick', body: 'why' })
  assert.equal(parseGeneral('just chatting'), null)
  assert.equal(parseGeneral(''), null)
})

test('parseNote (legacy reader for the notes inbox): space, newline or bare word also count', () => {
  assert.equal(parseNote('note buy milk'), 'buy milk')
  assert.equal(parseNote('Note.'), '')
  assert.equal(parseNote('note'), '')
  assert.equal(parseNote('notes are good'), null)
})

test('matchName: case, spaces, dashes and underscores do not count', () => {
  const list = ['alpha', 'beta', 'stolik']
  assert.deepEqual(matchName('Stolik', list), { match: 'stolik' })
  assert.deepEqual(matchName('Sto lik', list), { match: 'stolik' })
  assert.deepEqual(matchName('sto_lik', list), { match: 'stolik' })
  assert.deepEqual(matchName('STO-LIK', list), { match: 'stolik' })
  assert.deepEqual(matchName('  beta ', list), { match: 'beta' })
})

test('matchName: exact, then a unique prefix', () => {
  const list = ['alpha', 'beta', 'gamma']
  assert.deepEqual(matchName('bet', list), { match: 'beta' })
  assert.deepEqual(matchName('gamma', list), { match: 'gamma' })
})

test('matchName: several prefix hits are ambiguous and all are returned', () => {
  assert.deepEqual(matchName('alp', ['alpha', 'alphabet', 'beta']), { ambiguous: ['alpha', 'alphabet'] })
})

test('matchName: within edit distance 2 the closest name wins', () => {
  assert.deepEqual(matchName('alpah', ['alpha', 'beta']), { match: 'alpha' })
  assert.deepEqual(matchName('betaa', ['beta', 'zeta']), { match: 'beta' })
  assert.deepEqual(matchName('alphq', ['alpha', 'beta']), { match: 'alpha' })
})

test('matchName: a tie at the closest distance is ambiguous', () => {
  assert.deepEqual(matchName('bata', ['beta', 'bota']), { ambiguous: ['beta', 'bota'] })
})

test('matchName: farther than 2 edits, or an empty name, is no match', () => {
  assert.equal(matchName('gamma', ['alpha', 'beta']), null)
  assert.equal(matchName('abcdefgh', ['alpha']), null)
  assert.equal(matchName('   ', ['alpha']), null)
  assert.equal(matchName('alpha', []), null)
})

test('matchName: the last segment of parent/name matches too', () => {
  assert.deepEqual(matchName('notes', ['proj/notes', 'other/zzz']), { match: 'proj/notes' })
  assert.deepEqual(matchName('proj/notes', ['proj/notes', 'other/zzz']), { match: 'proj/notes' })
})

test('matchName: a full name beats a last-segment match', () => {
  assert.deepEqual(matchName('notes', ['proj/notes', 'notes']), { match: 'notes' })
})

test('matchName: duplicates in the list are one candidate', () => {
  assert.deepEqual(matchName('beta', ['beta', 'beta']), { match: 'beta' })
})

test('editDistance: Levenshtein, with an early cut-off', () => {
  assert.equal(editDistance('kitten', 'sitting'), 3)
  assert.equal(editDistance('ab', 'ba'), 2)
  assert.equal(editDistance('same', 'same'), 0)
  assert.equal(editDistance('abcdef', 'x', 2), 3)
})
