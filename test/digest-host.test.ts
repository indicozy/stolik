// Digest host pieces (plan 3.4): the usage.read access field, the chatlog and costs requests, the digest manifest, and the
// router's answer to those requests.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REQUEST_ACCESS } from '../src/addons-host/host.ts'
import { ACCESS_FIELDS, parseManifest, readManifest } from '../src/addons-host/manifest.ts'
import { describeAccess } from '../src/addons-host/consent.ts'
import { AddonBridge } from '../src/router/addon-bridge.ts'
import { SqliteStore } from '../src/adapters/store-sqlite.ts'
import { readChatDays, FilesChatLog } from '../src/adapters/files.ts'
import { newChatLine } from '../src/brain/chatlog.ts'

const SRC = join(import.meta.dirname, '..', 'src', 'addons', 'digest')

test('the digest manifest is valid, requires ml-worker, and declares the schedule and command', () => {
  const r = readManifest(SRC)
  assert.ok('manifest' in r, 'manifest reads')
  if (!('manifest' in r)) return
  const m = r.manifest
  assert.equal(m.name, 'digest')
  assert.deepEqual(m.requires, ['ml-worker'])
  assert.ok(m.provides.some((p) => p.point === 'command' && p.name === 'digest'))
  assert.ok(m.provides.some((p) => p.point === 'schedule'))
  assert.deepEqual([...m.access].sort(), ['chatlog.read', 'message.text', 'messages.send', 'usage.read'])
})

test('usage.read is an access field and is described on the consent screen', () => {
  assert.ok((ACCESS_FIELDS as readonly string[]).includes('usage.read'))
  const m = parseManifest({ name: 'x-test', version: '1', protocol: 2, command: ['node', 'x.js'], provides: [], access: ['usage.read'] })
  assert.ok(describeAccess(m).some((l) => /cost/.test(l)))
})

test('the new requests need the matching declared access', () => {
  assert.equal(REQUEST_ACCESS.chatlog, 'chatlog.read')
  assert.equal(REQUEST_ACCESS.costs, 'usage.read')
})

test('readChatDays returns whole days across the month boundary, oldest first, and skips other days', () => {
  const root = mkdtempSync(join(tmpdir(), 'digest-days-'))
  try {
    const log = new FilesChatLog(root)
    const at = (mo: number, d: number, h: number) => new Date(2026, mo - 1, d, h).getTime()
    log.append(newChatLine({ ts: at(10, 31, 23), dir: 'in', kind: 'text', text: 'before' }))
    log.append(newChatLine({ ts: at(11, 1, 9), dir: 'in', kind: 'text', text: 'first' }))
    log.append(newChatLine({ ts: at(11, 1, 10), dir: 'out', kind: 'text', text: 'second' }))
    log.append(newChatLine({ ts: at(11, 3, 9), dir: 'in', kind: 'text', text: 'after' }))
    const lines = readChatDays(root, '2026-11-01', 2)
    assert.deepEqual(lines.map((l) => l.text), ['first', 'second'])
    assert.deepEqual(readChatDays(root, '2026-11-02', 7).map((l) => l.text), ['after'])
    assert.deepEqual(readChatDays(join(root, 'missing'), '2026-11-01', 1), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the router answers chatlog and costs, and refuses a bad chatlog request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'digest-bridge-'))
  mkdirSync(join(dir, 'state'))
  const db = new SqliteStore({ stateDir: join(dir, 'state'), inboxDir: join(dir, 'inbox'), notesDir: join(dir, 'notes') })
  try {
    const now = new Date(2026, 10, 14, 15).getTime()
    db.addUsage({ mode: 'quick', costUsd: 0.5, durationMs: 10, ts: now - 60_000, outcome: 'answer' })
    db.addUsage({ mode: 'web', costUsd: 0.25, durationMs: 10, ts: now - 2 * 86_400_000, outcome: 'answer' })
    const seenDays: Array<[string, number]> = []
    const bridge = new AddonBridge({
      db,
      weeklyLimitPct: 99,
      quota: async () => null,
      now: () => now,
      readChat: (from, days) => {
        seenDays.push([from, days])
        return []
      },
    })
    const costs = (await bridge.request('digest', 'costs', {})) as { today: { costUsd: number }; week: { costUsd: number; runs: number } }
    assert.equal(costs.today.costUsd, 0.5)
    assert.equal(costs.week.costUsd, 0.75)
    assert.equal(costs.week.runs, 2)
    assert.deepEqual(await bridge.request('digest', 'chatlog', { from: '2026-11-13', days: 1 }), { lines: [] })
    assert.deepEqual(seenDays, [['2026-11-13', 1]])
    await assert.rejects(bridge.request('digest', 'chatlog', { from: '2026-11-13', days: 30 }), /chatlog needs/)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
