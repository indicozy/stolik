// cost-guard's transcript reader (the port of the token-guard hook's analyze): the folder name, the path, the tail read, and
// the analysis on a small synthetic transcript. Nothing here touches the real ~/.claude.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { analyze, analyzeTranscript, projectFolder, readTail, transcriptPath } from '../src/addons/cost-guard/transcript.ts'
import { removeDir, tmpDir } from './helpers/addon-fakes.ts'

const T_OLD = '2026-11-17T10:00:00.000Z'
const T_LATER = '2026-11-17T10:30:00.000Z'
const line = (o: unknown) => JSON.stringify(o)
const usage = (input: number, create: number, read: number) => ({
  input_tokens: input,
  cache_creation_input_tokens: create,
  cache_read_input_tokens: read,
  output_tokens: 7,
})

test('the projects folder name replaces every character that is not a letter or digit with a dash', () => {
  assert.equal(projectFolder('/home/user/Documents/projects/master'), '-home-user-Documents-projects-master')
  assert.equal(projectFolder('/home/me/.config/app_x'), '-home-me--config-app-x')
  assert.equal(projectFolder('/tmp/😀 x'), '-tmp---x', 'an emoji is one dash, as Claude Code names it')
})

test('the transcript path is <home>/.claude/projects/<folder>/<session id>.jsonl, and an unusable id gives none', () => {
  assert.equal(
    transcriptPath('/home/u', '/home/u/proj', 'abc-123_X'),
    '/home/u/.claude/projects/-home-u-proj/abc-123_X.jsonl',
  )
  assert.equal(transcriptPath('/home/u', '/home/u/proj', null), null, 'no session id')
  assert.equal(transcriptPath('/home/u', '/home/u/proj', '../../etc/passwd'), null, 'an id with a path is refused')
  assert.equal(transcriptPath('/home/u', '/home/u/proj', ''), null)
  assert.equal(transcriptPath('/home/u', '', 'abc'), null, 'no folder')
})

test('the analysis takes the last main-chain assistant entry: its context is the sum of the three input fields', () => {
  const lines = [
    line({ type: 'user', timestamp: T_OLD, message: { content: 'hi' } }),
    line({ type: 'assistant', timestamp: T_OLD, message: { usage: usage(10, 1000, 90_000) } }),
    line({ type: 'assistant', isSidechain: true, timestamp: T_LATER, message: { usage: usage(999, 999, 999_999) } }),
    line({ type: 'user', timestamp: T_LATER, message: { content: 'again' } }),
  ]
  assert.deepEqual(analyze(lines), { contextTokens: 91_010, lastAt: Date.parse(T_OLD) })
})

test('a later main-chain assistant entry replaces the earlier one; output tokens do not count', () => {
  const lines = [
    line({ type: 'assistant', timestamp: T_OLD, message: { usage: usage(1, 1, 1) } }),
    line({ type: 'assistant', timestamp: T_LATER, message: { usage: usage(5, 0, 200) } }),
  ]
  assert.deepEqual(analyze(lines), { contextTokens: 205, lastAt: Date.parse(T_LATER) })
})

test('a compaction after the last assistant entry gives no analysis (the context is gone)', () => {
  const lines = [
    line({ type: 'assistant', timestamp: T_OLD, message: { usage: usage(10, 0, 500) } }),
    line({ type: 'system', subtype: 'compact_boundary', timestamp: T_LATER }),
  ]
  assert.equal(analyze(lines), null)
})

test('a compaction before the last assistant entry does not matter', () => {
  const lines = [
    line({ type: 'system', subtype: 'compact_boundary', timestamp: T_OLD }),
    line({ type: 'assistant', timestamp: T_LATER, message: { usage: usage(10, 0, 500) } }),
  ]
  assert.deepEqual(analyze(lines), { contextTokens: 510, lastAt: Date.parse(T_LATER) })
})

test('no usable assistant entry, or one without a readable timestamp, gives no analysis', () => {
  assert.equal(analyze([]), null)
  assert.equal(analyze([line({ type: 'user', message: {} })]), null)
  assert.equal(analyze([line({ type: 'assistant', message: { usage: usage(1, 1, 1) } })]), null, 'no timestamp')
  assert.equal(analyze([line({ type: 'assistant', timestamp: 'not a date', message: { usage: usage(1, 1, 1) } })]), null)
  assert.equal(analyze(['', 'not json', '[1,2]', line({ type: 'assistant', timestamp: T_OLD, message: 'x' })]), null)
})

test('readTail returns the whole file when it is short, and only the lines after a cut when it is long', () => {
  const dir = tmpDir('cg-tail')
  try {
    const short = join(dir, 'short.jsonl')
    writeFileSync(short, 'one\ntwo\n')
    assert.deepEqual(readTail(short), ['one', 'two', ''])
    const long = join(dir, 'long.jsonl')
    writeFileSync(long, 'aaaaaaaaaa\nbbbb\ncccc\n')
    // 10 bytes from the end: the read starts inside "bbbb", so the partial line is dropped.
    assert.deepEqual(readTail(long, 10), ['cccc', ''])
    assert.equal(readTail(join(dir, 'missing.jsonl')), null, 'a missing file is unreadable')
  } finally {
    removeDir(dir)
  }
})

test('analyzeTranscript reads a file end to end, and is null for a missing one', () => {
  const dir = tmpDir('cg-file')
  try {
    const path = join(dir, 's.jsonl')
    writeFileSync(path, [line({ type: 'assistant', timestamp: T_OLD, message: { usage: usage(2, 3, 4) } })].join('\n') + '\n')
    assert.deepEqual(analyzeTranscript(path), { contextTokens: 9, lastAt: Date.parse(T_OLD) })
    assert.equal(analyzeTranscript(join(dir, 'nope.jsonl')), null)
  } finally {
    removeDir(dir)
  }
})
