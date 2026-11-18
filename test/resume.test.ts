import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  cleanTitle, channelSessionFor, isResumeId, listResumable, parseResumeCallback, pickTitle,
  relativeAgo, resumeCallbackData, resumeLabel, RESUME_LIST_MAX, RESUME_TITLE_MAX,
  type ResumeItem, type TranscriptMeta,
} from '../src/brain/resume.ts'
import { liveSessions, readTranscript, scanTranscripts } from '../src/adapters/transcripts.ts'
import { newSession, validSessionId, type Session } from '../src/router/state.ts'
import { tmuxNewSessionArgs } from '../src/adapters/tmux.ts'

const NOW = 1_800_000_000_000
const ID_A = '11111111-2222-3333-4444-555555555555'
const ID_B = '66666666-7777-8888-9999-aaaaaaaaaaaa'
const ID_C = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'

function meta(over: Partial<TranscriptMeta> & { id: string }): TranscriptMeta {
  return { path: `/x/${over.id}.jsonl`, cwd: '/home/u/proj', title: 'a title', mtime: NOW - 60_000, entrypoint: 'cli', ...over }
}

function sess(over: Partial<Session> = {}): Session {
  return { ...newSession(1, 'proj', '/home/u/proj', 4242, NOW), ...over }
}

// ---------- id validation ----------

test('isResumeId: accepts a UUID, rejects anything else', () => {
  assert.equal(isResumeId(ID_A), true)
  assert.equal(isResumeId(ID_A.toUpperCase()), true)
  assert.equal(isResumeId(''), false)
  assert.equal(isResumeId(ID_A + ' '), false)
  assert.equal(isResumeId(ID_A.slice(0, -1)), false)
  assert.equal(isResumeId('../' + ID_A), false)
  assert.equal(isResumeId('--dangerously-skip-permissions'), false)
})

test('validSessionId: the hook session_id rule, /^[A-Za-z0-9-]{1,200}$/', () => {
  assert.equal(validSessionId(ID_A), ID_A)
  assert.equal(validSessionId('abc'), 'abc')
  assert.equal(validSessionId('a'.repeat(200)), 'a'.repeat(200))
  assert.equal(validSessionId('a'.repeat(201)), null)
  assert.equal(validSessionId(''), null)
  assert.equal(validSessionId('a/b'), null)
  assert.equal(validSessionId('a b'), null)
  assert.equal(validSessionId('a_b'), null)
  assert.equal(validSessionId(undefined), null)
  assert.equal(validSessionId(42), null)
})

// ---------- titles ----------

test('cleanTitle: one line, trimmed, cut to the limit with an ellipsis', () => {
  assert.equal(cleanTitle('  fix   the\n login  '), 'fix the login')
  assert.equal(cleanTitle('x'.repeat(RESUME_TITLE_MAX)), 'x'.repeat(RESUME_TITLE_MAX))
  const long = cleanTitle('y'.repeat(RESUME_TITLE_MAX + 5))
  assert.equal(Array.from(long).length, RESUME_TITLE_MAX)
  assert.ok(long.endsWith('…'))
  // Counts code points, so an emoji is not split.
  assert.equal(Array.from(cleanTitle('🙂'.repeat(70))).length, RESUME_TITLE_MAX)
})

test('pickTitle: AI title, then last prompt, then first prompt, then a placeholder', () => {
  assert.equal(pickTitle({ aiTitle: 'AI', lastPrompt: 'last', firstPrompt: 'first' }), 'AI')
  assert.equal(pickTitle({ aiTitle: null, lastPrompt: 'last', firstPrompt: 'first' }), 'last')
  assert.equal(pickTitle({ aiTitle: ' ', lastPrompt: '', firstPrompt: 'first' }), 'first')
  assert.equal(pickTitle({}), '(untitled session)')
})

test('relativeAgo: just now, minutes, hours, days', () => {
  assert.equal(relativeAgo(NOW, NOW), 'just now')
  assert.equal(relativeAgo(NOW - 5 * 60_000, NOW), '5 min ago')
  assert.equal(relativeAgo(NOW - 3 * 3_600_000, NOW), '3 h ago')
  assert.equal(relativeAgo(NOW - 2 * 86_400_000, NOW), '2 d ago')
  assert.equal(relativeAgo(NOW + 10_000, NOW), 'just now')
})

// ---------- listResumable ----------

test('listResumable: newest first, at most RESUME_LIST_MAX items', () => {
  const entries: TranscriptMeta[] = []
  for (let i = 0; i < 14; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    entries.push(meta({ id, mtime: NOW - i * 1000, title: `t${i}` }))
  }
  // Shuffle the input so the order comes from the sort, not the input.
  const shuffled = [...entries].reverse()
  const items = listResumable(shuffled, new Set(), new Set(), NOW)
  assert.equal(items.length, RESUME_LIST_MAX)
  assert.deepEqual(items.map((x) => x.title), Array.from({ length: RESUME_LIST_MAX }, (_, i) => `t${i}`))
  for (let i = 1; i < items.length; i++) assert.ok(items[i - 1].lastActive >= items[i].lastActive)
})

test('listResumable: states ended, live-channel, live-no-channel', () => {
  const entries = [meta({ id: ID_A }), meta({ id: ID_B, mtime: NOW - 2000 }), meta({ id: ID_C, mtime: NOW - 3000 })]
  const items = listResumable(entries, new Set([ID_B, ID_C]), new Set([ID_C]), NOW)
  const state = Object.fromEntries(items.map((x) => [x.id, x.state]))
  assert.deepEqual(state, { [ID_A]: 'ended', [ID_B]: 'live-no-channel', [ID_C]: 'live-channel' })
})

test('listResumable: keeps only cli transcripts with a valid id and a cwd', () => {
  const entries = [
    meta({ id: ID_A }),
    meta({ id: ID_B, entrypoint: 'sdk-py' }),
    meta({ id: ID_C, entrypoint: null }),
    meta({ id: 'not-a-uuid' }),
    meta({ id: '00000000-0000-4000-8000-000000000001', cwd: '' }),
  ]
  const items = listResumable(entries, new Set(), new Set(), NOW)
  assert.deepEqual(items.map((x) => x.id), [ID_A])
})

test('listResumable: one item per session id, the newest copy', () => {
  const entries = [meta({ id: ID_A, mtime: NOW - 5000, title: 'old' }), meta({ id: ID_A, mtime: NOW - 100, title: 'new' })]
  const items = listResumable(entries, new Set(), new Set(), NOW)
  assert.equal(items.length, 1)
  assert.equal(items[0].title, 'new')
})

test('listResumable: lastActive is never in the future', () => {
  const items = listResumable([meta({ id: ID_A, mtime: NOW + 60_000 })], new Set(), new Set(), NOW)
  assert.equal(items[0].lastActive, NOW)
})

// ---------- channel matching ----------

test('channelSessionFor: matched by the hook session id, or by the live pid', () => {
  const byHook = sess({ key: 1, pid: 100, hasChannel: true, backendSessionId: ID_A })
  const byPid = sess({ key: 2, pid: 200, hasChannel: true, backendSessionId: null })
  const noChannel = sess({ key: 3, pid: 300, hasChannel: false, backendSessionId: ID_C })
  const sessions = [byHook, byPid, noChannel]
  const live = new Map([[ID_B, 200], [ID_C, 300]])
  assert.equal(channelSessionFor(ID_A, sessions, live), byHook)
  assert.equal(channelSessionFor(ID_B, sessions, live), byPid)
  assert.equal(channelSessionFor(ID_C, sessions, live), undefined)
  assert.equal(channelSessionFor(ID_A, [], live), undefined)
})

// ---------- labels and callbacks ----------

test('resumeLabel: title, folder, relative time, and the live mark; at most 64 characters', () => {
  const base: ResumeItem = { id: ID_A, path: '/x', cwd: '/home/u/Documents/projects/alpha', title: 'Fix login', lastActive: NOW - 3 * 3_600_000, state: 'ended' }
  assert.equal(resumeLabel(base, NOW), 'Fix login · alpha · 3 h ago')
  assert.equal(resumeLabel({ ...base, state: 'live-channel' }, NOW), 'Fix login · alpha · 3 h ago · live')
  assert.equal(resumeLabel({ ...base, state: 'live-no-channel' }, NOW), 'Fix login · alpha · 3 h ago · live, no channel')
  const long = resumeLabel({ ...base, title: 'z'.repeat(200), state: 'live-no-channel' }, NOW)
  assert.ok(Array.from(long).length <= 64)
  assert.ok(long.endsWith('· live, no channel'))
})

test('resume callback data: round trip, and rejects anything else', () => {
  const data = resumeCallbackData('abcdef01', 9)
  assert.equal(data, 'rz:abcdef01:9')
  assert.deepEqual(parseResumeCallback(data), { pendingId: 'abcdef01', idx: 9 })
  assert.equal(parseResumeCallback('rz:abcdef0:1'), null)
  assert.equal(parseResumeCallback('rz:abcdef01:123'), null)
  assert.equal(parseResumeCallback('rt:abcdef01:1'), null)
  assert.equal(parseResumeCallback('rz:ABCDEF01:1'), null)
})

// ---------- tmux argv ----------

test('tmuxNewSessionArgs: no extra args gives the plain launcher; extra args follow it as separate argv', () => {
  const plain = tmuxNewSessionArgs('tg-alpha', '/home/u/alpha')
  const launcher = plain[plain.length - 1]
  assert.match(launcher, /bin\/tg-claude$/)
  assert.deepEqual(plain.slice(0, 6), ['new-session', '-d', '-s', 'tg-alpha', '-c', '/home/u/alpha'])

  const resumed = tmuxNewSessionArgs('tg-alpha', '/home/u/alpha', ['--resume', ID_A])
  assert.deepEqual(resumed.slice(-3), [launcher, '--resume', ID_A])
  assert.deepEqual(resumed.slice(0, -3), plain.slice(0, -1), 'the launcher argv is the same with or without extra args')
})

// ---------- readers, against a temp-dir fixture ----------

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '.tmp-resume')

function jsonl(records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n'
}

test('scanTranscripts and readTranscript: fields from the records, filters, cap, mtime order', async () => {
  rmSync(FIXTURE, { recursive: true, force: true })
  try {
    const projects = join(FIXTURE, 'projects')
    const cwdA = '/home/u/Documents/projects/alpha'
    // Folder name deliberately misleading: the cwd must come from the record.
    const dirA = join(projects, '-wrong-folder-name')
    mkdirSync(join(dirA, ID_A, 'subagents'), { recursive: true })
    writeFileSync(join(dirA, `${ID_A}.jsonl`), jsonl([
      { type: 'user', cwd: cwdA, entrypoint: 'cli', message: { role: 'user', content: 'Fix the flaky login test' } },
      { type: 'assistant', cwd: cwdA, entrypoint: 'cli', message: { content: [{ type: 'text', text: 'ok' }] } },
      { type: 'ai-title', aiTitle: 'Fix flaky login test', sessionId: ID_A },
      { type: 'last-prompt', lastPrompt: 'thanks' },
    ]))
    writeFileSync(join(dirA, ID_A, 'subagents', `${ID_B}.jsonl`), jsonl([
      { type: 'user', cwd: '/nowhere', entrypoint: 'cli', message: { content: 'subagent' } },
    ]))
    writeFileSync(join(dirA, 'notes.jsonl'), jsonl([{ type: 'user', cwd: cwdA, entrypoint: 'cli' }]))
    utimesSync(join(dirA, `${ID_A}.jsonl`), NOW / 1000 - 300, NOW / 1000 - 300)

    // Print-mode run: excluded by entrypoint.
    const dirB = join(projects, '-home-u-other')
    mkdirSync(dirB, { recursive: true })
    writeFileSync(join(dirB, `${ID_B}.jsonl`), jsonl([
      { type: 'user', cwd: '/home/u/other', entrypoint: 'sdk-py', message: { content: 'sdk run' } },
    ]))
    utimesSync(join(dirB, `${ID_B}.jsonl`), NOW / 1000 - 10, NOW / 1000 - 10)

    // No first prompt in the meta records: skips isMeta and command wrappers, takes the real prompt.
    const dirC = join(projects, '-home-u-gamma')
    mkdirSync(dirC, { recursive: true })
    writeFileSync(join(dirC, `${ID_C}.jsonl`), jsonl([
      { type: 'user', cwd: '/home/u/gamma', entrypoint: 'cli', isMeta: true, message: { content: 'Caveat: meta' } },
      { type: 'user', cwd: '/home/u/gamma', entrypoint: 'cli', message: { content: '<command-name>/clear</command-name>' } },
      { type: 'user', cwd: '/home/u/gamma', entrypoint: 'cli', message: { content: '  Add   dark mode\n to settings ' } },
    ]))
    utimesSync(join(dirC, `${ID_C}.jsonl`), NOW / 1000 - 600, NOW / 1000 - 600)

    // No cwd anywhere: excluded.
    const dirD = join(projects, '-home-u-nocwd')
    mkdirSync(dirD, { recursive: true })
    writeFileSync(join(dirD, '22222222-2222-4222-8222-222222222222.jsonl'), jsonl([{ type: 'ai-title', aiTitle: 'x', entrypoint: 'cli' }]))

    // Big transcript: the title is read from the tail, the cwd and first prompt from the head.
    const dirE = join(projects, '-home-u-big')
    mkdirSync(dirE, { recursive: true })
    const idE = '33333333-3333-4333-8333-333333333333'
    const filler = { type: 'assistant', cwd: '/home/u/big', entrypoint: 'cli', message: { content: 'x'.repeat(4000) } }
    const many = Array.from({ length: 200 }, () => filler)
    writeFileSync(join(dirE, `${idE}.jsonl`), jsonl([
      { type: 'user', cwd: '/home/u/big', entrypoint: 'cli', message: { content: 'Migrate the big table' } },
      ...many,
      { type: 'ai-title', aiTitle: 'Migrate big table', sessionId: idE },
    ]))
    utimesSync(join(dirE, `${idE}.jsonl`), NOW / 1000 - 60, NOW / 1000 - 60)

    const found = await scanTranscripts(projects)
    assert.deepEqual(found.map((x) => x.id), [idE, ID_A, ID_C])
    const byId = Object.fromEntries(found.map((x) => [x.id, x]))
    assert.equal(byId[ID_A].cwd, cwdA)
    assert.equal(byId[ID_A].title, 'Fix flaky login test')
    assert.equal(byId[ID_A].entrypoint, 'cli')
    assert.equal(byId[ID_C].cwd, '/home/u/gamma')
    assert.equal(byId[ID_C].title, 'Add dark mode to settings')
    assert.equal(byId[idE].title, 'Migrate big table')
    assert.equal(byId[idE].cwd, '/home/u/big')

    // Cap: only the newest `limit` files are read.
    assert.deepEqual((await scanTranscripts(projects, 1)).map((x) => x.id), [])
    assert.deepEqual(await scanTranscripts(join(FIXTURE, 'missing')), [])

    // Title fallback when there is no ai-title and no first prompt: last prompt, then placeholder.
    const lone = join(FIXTURE, 'lone.jsonl')
    writeFileSync(lone, jsonl([{ type: 'user', cwd: '/home/u/lone', entrypoint: 'cli', message: { content: [{ type: 'tool_result', content: 'r' }] } }, { type: 'last-prompt', lastPrompt: 'run it again' }]))
    assert.equal((await readTranscript(lone, ID_A, NOW))?.title, 'run it again')
  } finally {
    rmSync(FIXTURE, { recursive: true, force: true })
  }
})

test('liveSessions: only alive claude processes; dead, non-claude and malformed files are skipped', () => {
  rmSync(FIXTURE, { recursive: true, force: true })
  try {
    const dir = join(FIXTURE, 'sessions')
    mkdirSync(dir, { recursive: true })
    // This test process is alive but is node, not claude: excluded.
    writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: ID_A }))
    // No such pid: excluded.
    writeFileSync(join(dir, '999999999.json'), JSON.stringify({ pid: 999999999, sessionId: ID_B }))
    writeFileSync(join(dir, `${process.pid}.bad.json`), '{}')
    writeFileSync(join(dir, 'garbage.json'), 'not json')
    writeFileSync(join(dir, '1.key'), 'secret')
    assert.equal(liveSessions(dir).size, 0)
    assert.equal(liveSessions(join(FIXTURE, 'absent')).size, 0)
  } finally {
    rmSync(FIXTURE, { recursive: true, force: true })
  }
})
