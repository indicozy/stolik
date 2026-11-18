import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { idleVerdict, isBashToolArgv, lastActivityAt, pendingSchedule, type IdleInput } from '../src/brain/idle.ts'
import { latestTranscriptMtime } from '../src/adapters/transcripts.ts'

const SNAP = '/home/u/.claude/shell-snapshots/snapshot-zsh-1794985561732-5auxiy.sh'

// One transcript line: an assistant entry with the given content blocks.
const assistant = (...content: unknown[]) => JSON.stringify({ type: 'assistant', message: { content } })
const wakeup = (stop: boolean) => ({ type: 'tool_use', name: 'ScheduleWakeup', input: { stop } })
const cron = (name: 'CronCreate' | 'CronDelete') => ({ type: 'tool_use', name, input: {} })

const NOW = 10_000_000
const IDLE_MS = 60_000
const base: IdleInput = {
  inTurn: false,
  procs: [],
  now: NOW,
  idleMs: IDLE_MS,
  lastActive: NOW - 3 * IDLE_MS,
  lastSentAt: NOW - 3 * IDLE_MS,
  latestTranscriptMtime: NOW - 3 * IDLE_MS,
  transcriptText: '',
}

test('isBashToolArgv: the snapshot path marks a Bash tool shell, in any argument', () => {
  assert.equal(isBashToolArgv(['/usr/bin/zsh', '-c', `source ${SNAP} 2>/dev/null || true && ls`]), true)
  assert.equal(isBashToolArgv(['bash', '-c', `source /x/.claude/shell-snapshots/s.sh`]), true)
  assert.equal(isBashToolArgv(['claude']), false)
  assert.equal(isBashToolArgv(['node', '/home/u/.claude/shell-snapshots-old/x.js']), false)
  assert.equal(isBashToolArgv([]), false)
})

test('pendingSchedule: nothing scheduled is not pending; unparseable lines are skipped', () => {
  assert.equal(pendingSchedule(''), false)
  assert.equal(pendingSchedule(`not json\n${assistant({ type: 'text', text: 'hi' })}\n{"half":`), false)
})

test('pendingSchedule: the last ScheduleWakeup decides (stop:true ends it)', () => {
  assert.equal(pendingSchedule(assistant(wakeup(false))), true)
  assert.equal(pendingSchedule(assistant(wakeup(true))), false)
  assert.equal(pendingSchedule([assistant(wakeup(false)), assistant(wakeup(true))].join('\n')), false)
  assert.equal(pendingSchedule([assistant(wakeup(true)), assistant(wakeup(false))].join('\n')), true)
})

test('pendingSchedule: CronCreate without a matching CronDelete is pending', () => {
  assert.equal(pendingSchedule(assistant(cron('CronCreate'))), true)
  assert.equal(pendingSchedule([assistant(cron('CronCreate')), assistant(cron('CronDelete'))].join('\n')), false)
  assert.equal(
    pendingSchedule([assistant(cron('CronCreate')), assistant(cron('CronCreate')), assistant(cron('CronDelete'))].join('\n')),
    true,
  )
})

test('pendingSchedule: only assistant entries count', () => {
  const userLine = JSON.stringify({ type: 'user', message: { content: [wakeup(false)] } })
  assert.equal(pendingSchedule(userLine), false)
})

test('lastActivityAt: the newest of the three times', () => {
  assert.equal(lastActivityAt({ lastActive: 5, lastSentAt: 9, latestTranscriptMtime: 7 }), 9)
  assert.equal(lastActivityAt({ lastActive: 5, lastSentAt: 1, latestTranscriptMtime: 7 }), 7)
  assert.equal(lastActivityAt({ lastActive: 5, lastSentAt: 1, latestTranscriptMtime: null }), 5)
})

test('idleVerdict: a quiet session with no busy signal is idle', () => {
  assert.deepEqual(idleVerdict(base), { idle: true })
})

test('idleVerdict: each busy rule, in order (first busy reason wins)', () => {
  assert.deepEqual(idleVerdict({ ...base, inTurn: true }), { idle: false, reason: 'in turn' })
  assert.deepEqual(idleVerdict({ ...base, procs: null, inTurn: true }), { idle: false, reason: 'in turn' })
  assert.deepEqual(idleVerdict({ ...base, procs: null }), { idle: false, reason: 'process tree unreadable' })
  assert.deepEqual(idleVerdict({ ...base, procs: [{ pid: 9, argv: ['claude'] }, { pid: 10, argv: ['zsh', '-c', SNAP] }] }), {
    idle: false,
    reason: 'running a command',
  })
  assert.deepEqual(idleVerdict({ ...base, latestTranscriptMtime: null }), { idle: false, reason: 'transcript unknown' })
  assert.deepEqual(idleVerdict({ ...base, lastSentAt: NOW - 1000 }), { idle: false, reason: 'recent activity' })
  assert.deepEqual(idleVerdict({ ...base, transcriptText: null }), { idle: false, reason: 'transcript unreadable' })
  assert.deepEqual(idleVerdict({ ...base, transcriptText: assistant(wakeup(false)) }), {
    idle: false,
    reason: 'scheduled wake-up',
  })
})

test('idleVerdict: the threshold is strict; exactly idleMs of quiet is idle', () => {
  const edge = { ...base, lastActive: NOW - IDLE_MS, lastSentAt: 0, latestTranscriptMtime: 0 }
  assert.deepEqual(idleVerdict(edge), { idle: true })
  assert.deepEqual(idleVerdict({ ...edge, lastActive: NOW - IDLE_MS + 1 }), { idle: false, reason: 'recent activity' })
})

test('idleVerdict: a transcript write counts as activity', () => {
  assert.deepEqual(idleVerdict({ ...base, latestTranscriptMtime: NOW - 1000 }), { idle: false, reason: 'recent activity' })
})

test('latestTranscriptMtime: null when the session file is missing or the id is unusable', () => {
  const home = mkdtempSync(join(tmpdir(), 'idle-home-'))
  try {
    assert.equal(latestTranscriptMtime(home, '/work/proj', 'missing-id'), null)
    assert.equal(latestTranscriptMtime(home, '/work/proj', '../escape'), null)
    assert.equal(latestTranscriptMtime(home, '/work/proj', null), null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('latestTranscriptMtime: the newest of the session file and its subagent transcripts', () => {
  const home = mkdtempSync(join(tmpdir(), 'idle-home-'))
  try {
    const dir = join(home, '.claude', 'projects', '-work-proj')
    const sid = 'sess-1'
    mkdirSync(join(dir, sid, 'subagents'), { recursive: true })
    const main = join(dir, `${sid}.jsonl`)
    const sub = join(dir, sid, 'subagents', 'agent-a.jsonl')
    writeFileSync(main, '{}\n')
    writeFileSync(sub, '{}\n')
    utimesSync(main, 1_000, 1_000)
    utimesSync(sub, 5_000, 5_000)
    assert.equal(latestTranscriptMtime(home, '/work/proj', sid), 5_000_000)
    utimesSync(sub, 500, 500)
    assert.equal(latestTranscriptMtime(home, '/work/proj', sid), 1_000_000)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
