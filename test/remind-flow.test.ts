// /remind, /task and /reminders through a real AddonPeer and a fake host. The host answers every addon request by its op, so
// no 60 s timer is left open. Host ids start at 1000, so they never collide with the addon's own request ids.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readManifest } from '../src/addons-host/manifest.ts'
import { BUTTON_DATA_MAX } from '../src/addons-host/tokens.ts'
import { AddonPeer, type Handler } from '../src/addons/sdk.ts'
import { PARSE_FAILED, remindHandlers } from '../src/addons/remind/service.ts'
import { loadItems, saveItems, type Item } from '../src/addons/remind/store.ts'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'addons', 'remind')
const DAY = 86_400_000
const NOW = new Date(2026, 10, 19, 10, 0).getTime() // Thu 19 Nov 2026 10:00 local
const FRI_0900 = new Date(2026, 10, 20, 9, 0).getTime() // Fri 20 Nov 2026 09:00 local
const MON_0900 = new Date(2026, 10, 16, 9, 0).getTime() // Mon 16 Nov 2026 09:00 local
const FOLDERS = [
  { name: 'stolik', path: '/x/stolik' },
  { name: 'notes', path: '/x/notes' },
]

type Btn = { text: string; data: string }
type Out = { id?: number; op?: string; payload?: Record<string, unknown>; result?: unknown; error?: string }
type SendLine = Out & { payload: { text: string; rows?: Btn[][] } }

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// Polls until `ok` holds (the addon works in the background), or fails after two seconds.
async function until(ok: () => boolean): Promise<void> {
  const end = Date.now() + 2_000
  while (!ok()) {
    if (Date.now() > end) assert.fail('timed out waiting for the addon')
    await delay(5)
  }
}

function btnData(s: SendLine, text: string): string {
  const b = (s.payload.rows ?? []).flat().find((x) => x.text === text)
  assert.ok(b, `a "${text}" button`)
  return b.data
}

function harness() {
  const dir = mkdtempSync(join(process.env.XDG_STATE_HOME!, 'remind-flow-'))
  const path = join(dir, 'remind', 'items.json')
  const clock = { t: NOW }
  const out: Out[] = []
  const prompts: string[] = []
  const problems: string[] = [] // button data that does not fit the 256-character limit
  const host = { parseReply: null as string | null, refuse: false, hold: null as Promise<void> | null, msgs: 0 }
  const table: Record<string, Handler> = {}
  let peer!: AddonPeer

  const answer = (op: string): unknown => {
    switch (op) {
      case 'send':
        return { messageIds: ['tg:' + ++host.msgs] }
      case 'folders':
        return { folders: FOLDERS }
      case 'spawn':
        return { ok: true }
      case 'quota':
        return host.refuse ? { refuse: true, reason: 'over pace' } : { refuse: false }
      default:
        return {}
    }
  }

  peer = new AddonPeer((line) => {
    const msg = JSON.parse(line) as Out
    out.push(msg)
    const { op, id } = msg
    if (typeof op !== 'string' || typeof id !== 'number') return
    if (op === 'send') {
      for (const b of ((msg.payload?.rows ?? []) as Btn[][]).flat()) if (b.data.length < 1 || b.data.length > BUTTON_DATA_MAX) problems.push(b.data)
    }
    const reply = () => setImmediate(() => peer.receive(JSON.stringify({ id, result: answer(op) })))
    if (op === 'send' && host.hold) void host.hold.then(reply)
    else reply()
  }, table)

  Object.assign(
    table,
    remindHandlers(peer, {
      now: () => clock.t,
      path,
      parse: async (prompt) => {
        prompts.push(prompt)
        return host.parseReply
      },
    }),
  )

  let seq = 1000
  const hostCall = (op: string, payload: Record<string, unknown>): number => {
    const id = ++seq
    peer.receive(JSON.stringify({ id, op, payload }))
    return id
  }
  const command = (name: string, text = '') => hostCall('command', { command: name, text })
  const callback = (data: string) => hostCall('callback', { data, messageId: 'tg:5' })
  const tick = () => hostCall('tick', { now: clock.t })
  const result = (id: number): unknown => out.find((l) => l.id === id && 'result' in l)?.result
  const settle = async (id: number): Promise<unknown> => {
    await until(() => result(id) !== undefined)
    return result(id)
  }
  const sends = (): SendLine[] => out.filter((l) => l.op === 'send') as SendLine[]
  const spawns = (): Out[] => out.filter((l) => l.op === 'spawn')
  return { path, clock, out, prompts, problems, host, command, callback, tick, settle, sends, spawns }
}

test('the remind manifest is valid: three commands, a one-minute schedule, four access fields', () => {
  const r = readManifest(SRC)
  assert.ok('manifest' in r, 'manifest reads')
  if (!('manifest' in r)) return
  const m = r.manifest
  assert.equal(m.name, 'remind')
  assert.deepEqual(m.provides, [
    { point: 'command', name: 'remind' },
    { point: 'command', name: 'task' },
    { point: 'command', name: 'reminders' },
    { point: 'schedule', everyMinutes: 1 },
  ])
  assert.deepEqual(m.access, ['message.text', 'messages.send', 'sessions.spawn', 'usage.record'])
})

test('/remind shows what it understood, Save stores it, /reminders lists it and Delete removes it', async () => {
  const h = harness()
  h.host.parseReply = JSON.stringify({ text: 'call mom', once: '2026-11-20T09:00', cron: null, project: null })
  h.command('remind', 'tomorrow 9:00 call mom')
  await until(() => h.sends().length === 1)
  const confirm = h.sends()[0]
  assert.equal(confirm.payload.text, 'Remind: call mom\nOnce, Fri 20 Nov 09:00')
  assert.match(h.prompts[0]!, /Thursday 2026-11-19/)
  assert.deepEqual(await h.settle(h.callback(btnData(confirm, 'Save'))), { toast: 'Saved' })

  const items = loadItems(h.path)
  assert.equal(items.length, 1)
  assert.equal(items[0]!.text, 'call mom')
  assert.equal(items[0]!.nextRun, FRI_0900)

  h.command('reminders')
  await until(() => h.sends().length === 2)
  const list = h.sends()[1]
  assert.equal(list.payload.text, '1. Remind call mom · Once, Fri 20 Nov 09:00')
  assert.deepEqual(await h.settle(h.callback(`d:${items[0]!.id}`)), { toast: 'Deleted' })
  assert.deepEqual(loadItems(h.path), [])
  assert.deepEqual(h.problems, [], 'every button fits the button data limit')
})

test('plain words the model cannot turn into a time send the exact failure text and save nothing', async () => {
  const h = harness()
  h.host.parseReply = 'I have no idea what you mean'
  h.command('remind', 'whenever')
  await until(() => h.sends().length === 1)
  assert.equal(h.sends()[0]!.payload.text, "Couldn't read a time from that. Try e.g. /remind tomorrow 9:00 call mom")
  assert.equal(PARSE_FAILED, "Couldn't read a time from that. Try e.g. /remind tomorrow 9:00 call mom")
  assert.deepEqual(loadItems(h.path), [])
})

test('a daily reminder missed for 3 days fires once, marked late, then waits for its next run', async () => {
  const h = harness()
  const daily: Item = {
    id: 'daily001',
    kind: 'remind',
    text: 'take the bins out',
    schedule: { kind: 'cron', expr: '0 9 * * *' },
    nextRun: MON_0900,
    createdAt: NOW - 10 * DAY,
  }
  saveItems(h.path, [daily])
  assert.deepEqual(await h.settle(h.tick()), { started: true })
  await until(() => h.sends().length === 1)
  const fired = h.sends()[0]
  assert.equal(fired.payload.text, '⏰ take the bins out (late, was due Mon 16 Nov 09:00)')
  assert.equal(btnData(fired, 'Done'), 'k:daily001')
  assert.equal(btnData(fired, 'Snooze 1h'), 'z:daily001')
  assert.deepEqual(h.problems, [])

  await delay(40) // let the first pass finish
  assert.deepEqual(await h.settle(h.tick()), { started: true })
  await delay(40)
  assert.equal(h.sends().length, 1, 'a second tick sends nothing')
  assert.equal(loadItems(h.path)[0]!.nextRun, FRI_0900)
})

test('a due task sends "Task started" and then spawns the session in its folder', async () => {
  const h = harness()
  const task: Item = {
    id: 'task0001',
    kind: 'task',
    text: 'summarise the inbox',
    schedule: { kind: 'once', at: NOW - 30_000 },
    nextRun: NOW - 30_000,
    createdAt: NOW - DAY,
    dir: '/x/stolik',
  }
  saveItems(h.path, [task])
  h.tick()
  await until(() => h.spawns().length === 1)
  assert.equal(h.sends()[0]!.payload.text, 'Task started: summarise the inbox (in stolik)')
  assert.deepEqual(h.spawns()[0]!.payload, { dir: '/x/stolik', prompt: 'summarise the inbox', messageId: 'tg:1' })
  assert.deepEqual(loadItems(h.path), [], 'a once task is dropped after it fires')
})

test('a due task the quota gate refuses posts the reason and spawns nothing', async () => {
  const h = harness()
  h.host.refuse = true
  const task: Item = {
    id: 'task0002',
    kind: 'task',
    text: 'summarise the inbox',
    schedule: { kind: 'once', at: NOW - 30_000 },
    nextRun: NOW - 30_000,
    createdAt: NOW - DAY,
    dir: '/x/stolik',
  }
  saveItems(h.path, [task])
  h.tick()
  await until(() => h.sends().length === 1)
  assert.equal(h.sends()[0]!.payload.text, 'Task skipped: summarise the inbox (over pace)')
  await delay(40)
  assert.equal(h.spawns().length, 0)
})

test('a task that names a known folder shows it and saves into that folder', async () => {
  const h = harness()
  h.host.parseReply = JSON.stringify({ text: 'summarise the inbox', once: '2026-11-20T09:00', cron: null, project: 'STOLIK' })
  h.command('task', 'friday 9:00 in stolik summarise the inbox')
  await until(() => h.sends().length === 1)
  const confirm = h.sends()[0]
  assert.equal(confirm.payload.text, 'Task: summarise the inbox\nOnce, Fri 20 Nov 09:00\nIn: stolik')
  assert.deepEqual(await h.settle(h.callback(btnData(confirm, 'Save'))), { toast: 'Saved' })
  assert.equal(loadItems(h.path)[0]!.dir, '/x/stolik')
})

test('a task with no known folder asks which folder first, then shows the choice before saving', async () => {
  const h = harness()
  h.host.parseReply = JSON.stringify({ text: 'summarise the inbox', once: '2026-11-20T09:00', cron: null, project: null })
  h.command('task', 'friday 9:00 summarise the inbox')
  await until(() => h.sends().length === 1)
  const ask = h.sends()[0]
  assert.equal(ask.payload.text, 'Which folder?')
  assert.deepEqual(h.problems, [], 'folder buttons fit the button data limit')
  assert.deepEqual(await h.settle(h.callback(btnData(ask, 'notes'))), { toast: 'Folder set' })
  await until(() => h.sends().length === 2)
  const confirm = h.sends()[1]
  assert.equal(confirm.payload.text, 'Task: summarise the inbox\nOnce, Fri 20 Nov 09:00\nIn: notes')
  assert.deepEqual(await h.settle(h.callback(btnData(confirm, 'Save'))), { toast: 'Saved' })
  assert.equal(loadItems(h.path)[0]!.dir, '/x/notes')
})

test('two ticks overlapping a slow send fire the item once: the second tick is skipped while the first runs', async () => {
  const h = harness()
  let release!: () => void
  h.host.hold = new Promise<void>((r) => (release = r))
  const first: Item = {
    id: 'first001',
    kind: 'remind',
    text: 'first',
    schedule: { kind: 'once', at: NOW - 30_000 },
    nextRun: NOW - 30_000,
    createdAt: NOW - DAY,
  }
  saveItems(h.path, [first])
  h.tick()
  await until(() => h.sends().length === 1) // the first item's send is held open
  const second: Item = { ...first, id: 'second01', text: 'second', schedule: { kind: 'once', at: NOW - 10_000 }, nextRun: NOW - 10_000 }
  saveItems(h.path, [second])
  assert.deepEqual(await h.settle(h.tick()), { started: false })
  release()
  await delay(40)
  assert.equal(h.sends().length, 1, 'the overlapping tick did not fire the second item')
  assert.deepEqual(loadItems(h.path), [second], 'it stays for the next tick')
})

test('Snooze 1h makes a one-time copy due in an hour, and Done only toasts', async () => {
  const h = harness()
  const once: Item = {
    id: 'stretch1',
    kind: 'remind',
    text: 'stretch',
    schedule: { kind: 'once', at: NOW - 30_000 },
    nextRun: NOW - 30_000,
    createdAt: NOW - DAY,
  }
  saveItems(h.path, [once])
  h.tick()
  await until(() => h.sends().length === 1)
  const fired = h.sends()[0]
  assert.deepEqual(await h.settle(h.callback(btnData(fired, 'Snooze 1h'))), { toast: 'Snoozed 1h' })
  const items = loadItems(h.path)
  assert.equal(items.length, 1)
  assert.equal(items[0]!.text, 'stretch')
  assert.deepEqual(items[0]!.schedule, { kind: 'once', at: NOW + 3_600_000 })
  assert.equal(items[0]!.nextRun, NOW + 3_600_000)
  assert.deepEqual(await h.settle(h.callback('k:stretch1')), { toast: 'Done' })
  assert.equal(loadItems(h.path).length, 1, 'Done changes nothing')
})
