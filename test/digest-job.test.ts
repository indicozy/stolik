// Digest job with fakes (plan 3.4): the flow of one digest, the scheduled pass with catch-up, and the addon SDK request.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDigest, runDue, type DigestDeps } from '../src/addons/digest/job.ts'
import type { DigestLine } from '../src/addons/digest/text.ts'
import { AddonPeer } from '../src/addons/sdk.ts'

const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime()
const msg = (ts: number, text: string, dir: 'in' | 'out' = 'in'): DigestLine => ({ ts, dir, kind: 'text', text, target: null })

// A fake world: a chat log by day, a model that echoes the prompt length, and a file store.
function fakeDeps(opts: { lines?: DigestLine[]; answer?: string; costs?: 'ok' | 'fail'; now?: number } = {}) {
  const prompts: string[] = []
  const files = new Map<string, string>()
  const reads: Array<[string, number]> = []
  const deps: DigestDeps = {
    readChat: async (from, days) => {
      reads.push([from, days])
      return opts.lines ?? []
    },
    costs: async () => {
      if (opts.costs === 'fail') throw new Error('no usage')
      return { today: { runs: 1, costUsd: 0.25 }, week: { runs: 4, costUsd: 1.5 } }
    },
    generate: async (prompt) => {
      prompts.push(prompt)
      return opts.answer ?? '## Asked\n- the reminder\n## Done\n- none\n## Open\n- none'
    },
    write: (name, text) => files.set(name, text),
    now: () => opts.now ?? at(14, 9),
  }
  return { deps, prompts, files, reads }
}

test('a day with messages: the model is asked once, the file is written under the day, the cost line is last', async () => {
  const w = fakeDeps({ lines: [msg(at(13, 9), 'fix the reminder'), msg(at(13, 9, 2), 'done', 'out')] })
  const text = await makeDigest(w.deps, { name: '2026-11-13', from: '2026-11-13', days: 1 })
  assert.deepEqual(w.reads, [['2026-11-13', 1]])
  assert.equal(w.prompts.length, 1)
  assert.match(w.prompts[0], /fix the reminder/)
  assert.deepEqual([...w.files.keys()], ['2026-11-13'])
  assert.equal(w.files.get('2026-11-13'), text)
  assert.match(text, /^# Digest 2026-11-13/)
  assert.match(text.trimEnd().split('\n').pop()!, /^Cost: \$0\.25 today, \$1\.50 this week \(1 mode runs today, 4 this week\)\.$/)
})

test('a day with no messages: no model call, and the file says so', async () => {
  const w = fakeDeps({ lines: [] })
  const text = await makeDigest(w.deps, { name: '2026-11-13', from: '2026-11-13', days: 1 })
  assert.equal(w.prompts.length, 0)
  assert.match(text, /No messages in this period\./)
})

test('a weekly period reads seven days and names them in the file', async () => {
  const w = fakeDeps({ lines: [msg(at(10, 9), 'one')] })
  const text = await makeDigest(w.deps, { name: '2026-W46', from: '2026-11-09', days: 7 })
  assert.deepEqual(w.reads, [['2026-11-09', 7]])
  assert.match(text, /^# Digest 2026-W46 \(2026-11-09 to 2026-11-15\)/)
  assert.match(w.prompts[0], /Period: 2026-W46, 2026-11-09 to 2026-11-15/)
})

test('an empty model answer is a failure, and nothing is written', async () => {
  const w = fakeDeps({ lines: [msg(at(13, 9), 'hi')], answer: '   ' })
  await assert.rejects(makeDigest(w.deps, { name: '2026-11-13', from: '2026-11-13', days: 1 }), /empty answer/)
  assert.equal(w.files.size, 0)
})

test('unknown usage is written as unknown, the digest is still made', async () => {
  const w = fakeDeps({ lines: [msg(at(13, 9), 'hi')], costs: 'fail' })
  const text = await makeDigest(w.deps, { name: '2026-11-13', from: '2026-11-13', days: 1 })
  assert.match(text, /Cost: unknown \(usage could not be read\)\./)
})

test('secrets in the chat never reach the model', async () => {
  const w = fakeDeps({ lines: [msg(at(13, 9), 'my key is sk-ant-api03-abcdefghijklmnop1234 ok')] })
  await makeDigest(w.deps, { name: '2026-11-13', from: '2026-11-13', days: 1 })
  assert.doesNotMatch(w.prompts[0], /sk-ant-api03/)
  assert.match(w.prompts[0], /\[redacted\]/)
})

test('a scheduled pass makes each due run, delivers it, and reports a failed one without stopping', async () => {
  // Last run 11-11 04:00, now 11-14 09:00: due runs for 11-12, 11-13 and 11-14 (periods 11-11, 11-12, 11-13).
  const w = fakeDeps({ lines: [msg(at(13, 9), 'hi')], now: at(14, 9) })
  const delivered: string[] = []
  const failed: string[] = []
  let calls = 0
  const deps: DigestDeps = { ...w.deps, generate: async (p) => {
    calls++
    if (calls === 2) throw new Error('model down')
    return w.deps.generate(p)
  } }
  const done = await runDue(deps, 'daily', at(11, 4), async (t) => void delivered.push(t), async (p, r) => void failed.push(`${p.name}: ${r}`))
  assert.deepEqual(done, [at(12, 4), at(13, 4), at(14, 4)])
  assert.equal(delivered.length, 2)
  assert.deepEqual(failed, ['2026-11-12: model down'])
})

test('a scheduled pass saves its state after each run, in order, with the run time', async () => {
  // Due runs 11-13 04:00 and 11-14 04:00 (last run 11-12 04:00, now 11-14 09:00).
  const w = fakeDeps({ lines: [msg(at(13, 9), 'hi')], now: at(14, 9) })
  const events: string[] = []
  const done = await runDue(
    w.deps,
    'daily',
    at(12, 4),
    async () => void events.push('deliver'),
    async () => void events.push('fail'),
    (runAt) => void events.push(`saved ${runAt}`),
  )
  assert.deepEqual(done, [at(13, 4), at(14, 4)])
  assert.deepEqual(events, ['deliver', `saved ${at(13, 4)}`, 'deliver', `saved ${at(14, 4)}`])
})

test('the first run is saved even when a later run fails and its failure report fails too', async () => {
  const w = fakeDeps({ lines: [msg(at(13, 9), 'hi')], now: at(14, 9) })
  const saved: number[] = []
  let delivers = 0
  await assert.rejects(
    runDue(
      w.deps,
      'daily',
      at(12, 4),
      async () => {
        delivers++
        if (delivers === 2) throw new Error('send refused')
      },
      async () => {
        throw new Error('report refused')
      },
      (runAt) => void saved.push(runAt),
    ),
    /report refused/,
  )
  assert.deepEqual(saved, [at(13, 4)], 'the first run stays saved; the second is not marked done')
})

test('request-only schedules make nothing on a pass', async () => {
  const w = fakeDeps({ lines: [msg(at(13, 9), 'hi')] })
  const done = await runDue(w.deps, 'request', null, async () => {}, async () => {})
  assert.deepEqual(done, [])
  assert.equal(w.reads.length, 0)
})

test('the addon SDK asks the host for something and resolves on the host reply with the same id', async () => {
  const written: string[] = []
  const peer = new AddonPeer((line) => written.push(line), {})
  const p = peer.request('chatlog', { from: '2026-11-13', days: 1 })
  const sent = JSON.parse(written[0]) as { id: number; op: string; payload: unknown }
  assert.equal(sent.op, 'chatlog')
  assert.deepEqual(sent.payload, { from: '2026-11-13', days: 1 })
  peer.receive(JSON.stringify({ id: sent.id, result: { lines: [] } }))
  assert.deepEqual(await p, { lines: [] })
})
