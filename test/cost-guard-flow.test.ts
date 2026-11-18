// cost-guard's handlers over a fake peer: the gate's hold and its notice, the three buttons (Send anyway, New session,
// Cancel), the release window, and the fail-open path when the notice cannot be sent. The transcript is a real file in a
// temporary home folder.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { makeGuard, type GuardHost } from '../src/addons/cost-guard/guard.ts'
import { newSessionPrompt } from '../src/addons/cost-guard/decide.ts'
import { transcriptPath } from '../src/addons/cost-guard/transcript.ts'
import { removeDir, tmpDir } from './helpers/addon-fakes.ts'

const MIN = 60_000
const NOW0 = Date.parse('2026-11-17T12:00:00.000Z')

// A host that records each request and answers from `answers` (a throw is a failed request).
class FakePeer implements GuardHost {
  readonly requests: Array<{ op: string; payload: Record<string, unknown> }> = []
  answers: Record<string, (payload: Record<string, unknown>) => unknown> = {}
  async request(op: string, payload: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ op, payload })
    const f = this.answers[op]
    return f ? f(payload) : {}
  }
  ops(): string[] {
    return this.requests.map((r) => r.op)
  }
  last(op: string): Record<string, unknown> | undefined {
    return this.requests.filter((r) => r.op === op).at(-1)?.payload
  }
}

// A transcript of the session in the home folder: one assistant turn with `contextTokens` that ended `idleMin` minutes ago.
function writeSession(home: string, cwd: string, sid: string, idleMin: number, contextTokens = 154_000): void {
  const path = transcriptPath(home, cwd, sid) as string
  mkdirSync(dirname(path), { recursive: true })
  const at = new Date(NOW0 - idleMin * MIN).toISOString()
  const entry = { type: 'assistant', timestamp: at, message: { usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: contextTokens } } }
  writeFileSync(path, JSON.stringify(entry) + '\n')
}

function setup(over: { idleMin?: number; contextTokens?: number } = {}) {
  const home = tmpDir('cg-home')
  const cwd = '/home/u/proj'
  writeSession(home, cwd, 'sess-1', over.idleMin ?? 125, over.contextTokens ?? 154_000)
  const peer = new FakePeer()
  let now = NOW0
  const logs: string[] = []
  const guard = makeGuard({ host: peer, now: () => now, home, log: (m) => logs.push(m) })
  const session = { name: 'proj', cwd, backendSessionId: 'sess-1' }
  const gateReq = (messageId: string) => ({ session, messageId, kind: 'text', length: 5 })
  return {
    home,
    cwd,
    peer,
    guard,
    session,
    gateReq,
    logs,
    advance: (ms: number) => (now += ms),
    cleanup: () => removeDir(home),
  }
}

test('an expired cache holds the message at once, then the notice goes out with its three buttons and the week line', async () => {
  const s = setup()
  try {
    s.peer.answers.quota = () => ({ refuse: false, usedPct: 58, pacePct: 36 })
    assert.deepEqual(await s.guard.gate(s.gateReq('tg:50')), { hold: true })
    await s.guard.idle()
    assert.deepEqual(s.peer.ops(), ['quota', 'send'])
    const send = s.peer.last('send') as { text: string; replyTo: string; rows: Array<Array<{ text: string; data: string }>> }
    assert.equal(
      send.text,
      "⏸ Held: proj's cache expired (idle 2h 05m, context 154k). Sending now re-reads the whole history uncached, about 10-15x a normal turn.\n" +
        'Week: 58% used, pace 36%.',
    )
    assert.equal(send.replyTo, 'tg:50')
    assert.deepEqual(send.rows, [
      [
        { text: 'Send anyway', data: 'release:tg:50' },
        { text: 'New session', data: 'new:tg:50' },
      ],
      [{ text: 'Cancel', data: 'cancel:tg:50' }],
    ])
  } finally {
    s.cleanup()
  }
})

test('without a readable quota the notice has no week line', async () => {
  const s = setup()
  try {
    s.peer.answers.quota = () => {
      throw new Error('quota not available')
    }
    assert.deepEqual(await s.guard.gate(s.gateReq('tg:51')), { hold: true })
    await s.guard.idle()
    const text = (s.peer.last('send') as { text: string }).text
    assert.doesNotMatch(text, /Week:/)
    assert.match(text, /^⏸ Held: proj's cache expired \(idle 2h 05m, context 154k\)\./)
    assert.ok(s.logs.some((l) => /quota unavailable/.test(l)))
  } finally {
    s.cleanup()
  }
})

test('the gate passes a message when the cache is warm, the context is small, the session id is unknown, or no transcript exists', async () => {
  for (const over of [{ idleMin: 30 }, { contextTokens: 99_000 }] as const) {
    const s = setup(over)
    try {
      assert.deepEqual(await s.guard.gate(s.gateReq('tg:60')), { hold: false }, JSON.stringify(over))
      await s.guard.idle()
      assert.equal(s.peer.requests.length, 0, 'no notice for a passed message')
    } finally {
      s.cleanup()
    }
  }
  const s = setup()
  try {
    assert.deepEqual(await s.guard.gate({ ...s.gateReq('tg:61'), session: { ...s.session, backendSessionId: null } }), { hold: false })
    assert.deepEqual(await s.guard.gate({ ...s.gateReq('tg:62'), session: { ...s.session, backendSessionId: 'missing' } }), { hold: false })
    assert.deepEqual(await s.guard.gate({ messageId: 'tg:63' }), { hold: false }, 'a payload without a session passes')
  } finally {
    s.cleanup()
  }
})

test('Send anyway releases the message, and the same session then goes through for 10 minutes', async () => {
  const s = setup()
  try {
    s.peer.answers.quota = () => ({})
    await s.guard.gate(s.gateReq('tg:70'))
    await s.guard.idle()
    s.peer.answers.release = () => ({ ok: true })
    assert.deepEqual(await s.guard.callback({ data: 'release:tg:70', messageId: 'tg:999' }), { toast: 'sent' })
    assert.deepEqual(s.peer.last('release'), { messageId: 'tg:70' })
    // A follow-up of the same session, inside the window, is not held.
    s.advance(2 * MIN)
    assert.deepEqual(await s.guard.gate(s.gateReq('tg:71')), { hold: false })
    // After the window it is held again.
    s.advance(9 * MIN)
    assert.deepEqual(await s.guard.gate(s.gateReq('tg:72')), { hold: true })
    await s.guard.idle()
  } finally {
    s.cleanup()
  }
})

test('a failed release says why, and does not open the window', async () => {
  const s = setup()
  try {
    s.peer.answers.quota = () => ({})
    await s.guard.gate(s.gateReq('tg:80'))
    await s.guard.idle()
    s.peer.answers.release = () => ({ ok: false, error: 'the session is gone or not connected' })
    assert.deepEqual(await s.guard.callback({ data: 'release:tg:80', messageId: 'tg:999' }), {
      toast: 'Not sent: the session is gone or not connected',
    })
    assert.deepEqual(await s.guard.gate(s.gateReq('tg:81')), { hold: true }, 'still held: the window was not opened')
    await s.guard.idle()
  } finally {
    s.cleanup()
  }
})

test('Cancel drops the held message and says so; a refused drop is said too', async () => {
  const s = setup()
  try {
    s.peer.answers.quota = () => ({})
    await s.guard.gate(s.gateReq('tg:90'))
    await s.guard.idle()
    s.peer.answers.drop = () => ({ ok: true })
    assert.deepEqual(await s.guard.callback({ data: 'cancel:tg:90', messageId: 'tg:999' }), { toast: 'cancelled' })
    assert.deepEqual(s.peer.last('drop'), { messageId: 'tg:90' })
    s.peer.answers.drop = () => ({ ok: false, error: 'no message of yours is held with that id' })
    assert.deepEqual(await s.guard.callback({ data: 'cancel:tg:90', messageId: 'tg:999' }), {
      toast: 'Not cancelled: no message of yours is held with that id',
    })
  } finally {
    s.cleanup()
  }
})

test('New session starts a session in the held folder with the owner message, then drops the held one', async () => {
  const s = setup()
  try {
    s.peer.answers.quota = () => ({})
    await s.guard.gate(s.gateReq('tg:100'))
    await s.guard.idle()
    s.peer.answers.held = () => ({ ok: true, text: 'carry on with the parser', session: { name: 'proj', cwd: s.cwd, backendSessionId: 'sess-1' } })
    s.peer.answers.spawn = () => ({ ok: true })
    s.peer.answers.drop = () => ({ ok: true })
    assert.deepEqual(await s.guard.callback({ data: 'new:tg:100', messageId: 'tg:999' }), { toast: 'Starting a new session…' })
    await s.guard.idle()
    const spawn = s.peer.last('spawn') as { dir: string; prompt: string; messageId: string }
    assert.equal(spawn.dir, s.cwd)
    assert.equal(spawn.messageId, 'tg:100')
    const path = transcriptPath(s.home, s.cwd, 'sess-1') as string
    assert.equal(spawn.prompt, newSessionPrompt(path, 'carry on with the parser'))
    assert.ok(s.peer.ops().indexOf('spawn') < s.peer.ops().lastIndexOf('drop'), 'the held message is dropped after the spawn')
    assert.deepEqual(s.peer.last('drop'), { messageId: 'tg:100' })
    assert.equal((s.peer.last('send') as { text: string }).text, 'New session started in proj.')
  } finally {
    s.cleanup()
  }
})

test('a failed new session keeps the message held and says why in General', async () => {
  const s = setup()
  try {
    s.peer.answers.quota = () => ({})
    await s.guard.gate(s.gateReq('tg:110'))
    await s.guard.idle()
    s.peer.answers.held = () => ({ ok: true, text: 'x', session: { name: 'proj', cwd: s.cwd, backendSessionId: 'sess-1' } })
    s.peer.answers.spawn = () => ({ ok: false, error: 'that folder is not trusted yet' })
    await s.guard.callback({ data: 'new:tg:110', messageId: 'tg:999' })
    await s.guard.idle()
    assert.equal(s.peer.ops().includes('drop'), false, 'not dropped')
    assert.equal(
      (s.peer.last('send') as { text: string }).text,
      'Could not start a new session: that folder is not trusted yet. The message is still held.',
    )
  } finally {
    s.cleanup()
  }
})

test('a button for a message that is no longer held says so, and an unknown button is not available', async () => {
  const s = setup()
  try {
    s.peer.answers.held = () => ({ ok: false, error: 'no message of yours is held with that id' })
    s.peer.answers.drop = () => ({ ok: false, error: 'no message of yours is held with that id' })
    assert.deepEqual(await s.guard.callback({ data: 'cancel:tg:5', messageId: 'tg:1' }), {
      toast: 'Not cancelled: no message of yours is held with that id',
    })
    assert.deepEqual(await s.guard.callback({ data: 'bogus', messageId: 'tg:1' }), { toast: 'Not available.' })
    await s.guard.callback({ data: 'new:tg:5', messageId: 'tg:1' })
    await s.guard.idle()
    assert.equal((s.peer.last('send') as { text: string }).text, 'Could not start a new session: no message of yours is held with that id.')
  } finally {
    s.cleanup()
  }
})

test('when the notice cannot be sent, the message is released (the guard fails open)', async () => {
  const s = setup()
  try {
    s.peer.answers.quota = () => ({})
    s.peer.answers.send = () => {
      throw new Error('telegram is down')
    }
    s.peer.answers.release = () => ({ ok: true })
    assert.deepEqual(await s.guard.gate(s.gateReq('tg:120')), { hold: true })
    await s.guard.idle()
    assert.deepEqual(s.peer.last('release'), { messageId: 'tg:120' })
    assert.ok(s.logs.some((l) => /the notice failed, releasing the message: telegram is down/.test(l)))
  } finally {
    s.cleanup()
  }
})

test('a request that fails outright during a new session is said in General, and the message stays held', async () => {
  const s = setup()
  try {
    s.peer.answers.quota = () => ({})
    await s.guard.gate(s.gateReq('tg:130'))
    await s.guard.idle()
    s.peer.answers.held = () => {
      throw new Error('access denied')
    }
    await s.guard.callback({ data: 'new:tg:130', messageId: 'tg:999' })
    await s.guard.idle()
    assert.equal(
      (s.peer.last('send') as { text: string }).text,
      'Could not start a new session: access denied. The message is still held.',
    )
    assert.equal(s.peer.ops().includes('drop'), false)
  } finally {
    s.cleanup()
  }
})
