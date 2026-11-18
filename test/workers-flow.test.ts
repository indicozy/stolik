// /workers addon flow (plan 3.7): the manifest, and the command through a real AddonPeer with a fake host. The host's side
// is the NDJSON protocol: the test writes the command line, reads the addon's request lines and answers them.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readManifest } from '../src/addons-host/manifest.ts'
import { AddonPeer, type Handler } from '../src/addons/sdk.ts'
import { COLLECTING_TEXT, workersHandlers } from '../src/addons/workers/command.ts'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'addons', 'workers')

type Line = { id?: number; op?: string; payload?: { text?: string }; result?: unknown; error?: string }

// A fake host: `out` collects every line the addon writes. `command()` sends the owner's /workers into the addon.
function harness(build: () => Promise<string>, noteMs: number) {
  const out: Line[] = []
  const table: Record<string, Handler> = {}
  const peer = new AddonPeer((line) => out.push(JSON.parse(line) as Line), table)
  Object.assign(table, workersHandlers(peer, build, noteMs))
  const command = (id: number) => peer.receive(JSON.stringify({ id, op: 'command', payload: { command: 'workers', text: '' } }))
  // Answers one addon request the way the host does (an empty result). Every request is answered: an open one keeps its
  // 60 s timer alive and the test process waits for it.
  const answer = (req: Line) => peer.receive(JSON.stringify({ id: req.id, result: { messageIds: ['tg:1'] } }))
  const sends = () => out.filter((l) => l.op === 'send')
  return { out, command, answer, sends }
}

// Polls until `ok` holds (the command runs in the background), or fails after two seconds.
async function until(ok: () => boolean): Promise<void> {
  const end = Date.now() + 2_000
  while (!ok()) {
    if (Date.now() > end) assert.fail('timed out waiting for the addon')
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('the workers manifest is valid: a command, messages.send only, no requirements', () => {
  const r = readManifest(SRC)
  assert.ok('manifest' in r, 'manifest reads')
  if (!('manifest' in r)) return
  const m = r.manifest
  assert.equal(m.name, 'workers')
  assert.deepEqual(m.provides, [{ point: 'command', name: 'workers' }])
  assert.deepEqual(m.access, ['messages.send'])
  assert.deepEqual(m.requires, [])
})

test('/workers answers at once and sends the report (no note when collection is quick)', async () => {
  const h = harness(async () => 'AI workers, report', 50)
  h.command(7)
  // The command's own reply: handled, so the host does not answer the owner itself. (Its order against the send is not fixed.)
  await until(() => h.out.some((l) => l.id === 7))
  assert.deepEqual(h.out.find((l) => l.id === 7), { id: 7, result: { handled: true } })
  await until(() => h.sends().length === 1)
  assert.equal(h.sends()[0]!.payload!.text, 'AI workers, report')
  h.answer(h.sends()[0]!)
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(h.sends().length, 1, 'no "Collecting…" note: the report was quick')
})

test('a slow collection sends "Collecting…" first, then the report', async () => {
  const h = harness(() => new Promise((r) => setTimeout(() => r('slow report'), 60)), 10)
  h.command(8)
  await until(() => h.sends().length >= 1)
  assert.equal(h.sends()[0]!.payload!.text, COLLECTING_TEXT)
  h.answer(h.sends()[0]!)
  await until(() => h.sends().length >= 2)
  assert.equal(h.sends()[1]!.payload!.text, 'slow report')
  h.answer(h.sends()[1]!)
  assert.equal(h.sends().length, 2, 'exactly the note and the report')
})

test('a failed collection sends "workers failed: <reason>"', async () => {
  const h = harness(async () => {
    throw new Error('nvidia-smi is gone')
  }, 50)
  h.command(9)
  await until(() => h.sends().length >= 1)
  assert.equal(h.sends()[0]!.payload!.text, 'workers failed: nvidia-smi is gone')
  h.answer(h.sends()[0]!)
})
