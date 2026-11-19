// Router shutdown order, the hard-exit timer, and the start-up notices to the owner (fakes only, no network).
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddonsPort } from '../src/ports.ts'
import { shutdownRouter } from '../src/router/core.ts'
import { harness } from './helpers/fakes.ts'

// Wraps a fake's method so each call is recorded in `seq` (the original still runs).
function record<T extends object, K extends keyof T>(obj: T, key: K, seq: string[], label: string): void {
  const fn = obj[key] as unknown as (...args: unknown[]) => unknown
  ;(obj as Record<K, unknown>)[key] = (...args: unknown[]) => {
    seq.push(label)
    return fn.apply(obj, args)
  }
}

test('stop: saves, stops intake, drains, stops the ML worker and addons, saves again, then closes the store', async () => {
  const seq: string[] = []
  const h = harness()
  record(h.store, 'writeMsgMap', seq, 'save')
  record(h.chat, 'stop', seq, 'telegram.stop')
  record(h.agent, 'stop', seq, 'agent.stop')
  record(h.router.ml as { close: () => void }, 'close', seq, 'ml.close')
  const addons = {
    beginStop: () => seq.push('addons.beginStop'),
    stop: async () => {
      seq.push('addons.stop')
    },
  }
  // The router is built without addons by the harness; attach the fake the way the router reads it.
  ;(h.router as unknown as { addons: AddonsPort }).addons = addons as unknown as AddonsPort
  // drain takes the time left (a duration from now).
  ;(h.chat as unknown as { drain: (ms: number) => Promise<void> }).drain = async (ms: number) => {
    seq.push(`drain ${ms}`)
  }
  ;(h.store as unknown as { close: () => void }).close = () => seq.push('store.close')

  await h.router.stop(10_000)

  assert.deepEqual(seq, [
    'save',
    'addons.beginStop',
    'telegram.stop',
    'agent.stop',
    'drain 5000',
    'ml.close',
    'addons.stop',
    'save',
    'store.close',
  ])
})

test('stop: without a drain method on the Telegram adapter the outbound step is skipped', async () => {
  const seq: string[] = []
  const h = harness()
  record(h.chat, 'stop', seq, 'telegram.stop')
  record(h.agent, 'stop', seq, 'agent.stop')
  await h.router.stop()
  assert.deepEqual(seq, ['telegram.stop', 'agent.stop'])
})

test('stop: a step that throws is logged, and the later steps still run', async () => {
  const seq: string[] = []
  const h = harness()
  h.agent.stop = async () => {
    throw new Error('socket busy')
  }
  record(h.router.ml as { close: () => void }, 'close', seq, 'ml.close')
  ;(h.store as unknown as { close: () => void }).close = () => seq.push('store.close')
  await h.router.stop()
  assert.deepEqual(seq, ['ml.close', 'store.close'])
  assert.ok(h.logger.lines.some((l) => /agent stop: socket busy/.test(l)))
})

test('shutdownRouter: stop, then the lock is released, then exit 0; stop gets the configured budget', async () => {
  const h = harness()
  const seq: string[] = []
  let budget: number | undefined
  h.router.stop = async (ms?: number) => {
    budget = ms
    seq.push('stop')
  }
  await shutdownRouter(h.router, { timeoutMs: 1234, release: () => seq.push('release'), exit: (c) => seq.push(`exit ${c}`) })
  assert.deepEqual(seq, ['stop', 'release', 'exit 0'])
  assert.equal(budget, 1234)
})

test('shutdownRouter: when stop never settles, the hard timer releases the lock and exits 0 at the configured limit', async () => {
  const h = harness()
  h.router.stop = () => new Promise<void>(() => {})
  const seq: string[] = []
  const exited = new Promise<number>((resolve) => {
    void shutdownRouter(h.router, {
      timeoutMs: 40,
      release: () => seq.push('release'),
      exit: (code) => {
        seq.push(`exit ${code}`)
        resolve(code)
      },
    })
  })
  assert.equal(await exited, 0)
  assert.deepEqual(seq, ['release', 'exit 0'])
})

test('shutdownRouter: a stop that throws still releases the lock and exits', async () => {
  const h = harness()
  h.router.stop = async () => {
    throw new Error('boom')
  }
  const seq: string[] = []
  await shutdownRouter(h.router, { timeoutMs: 1000, release: () => seq.push('release'), exit: (c) => seq.push(`exit ${c}`) })
  assert.deepEqual(seq, ['release', 'exit 0'])
  assert.ok(h.logger.lines.some((l) => /shutdown: boom/.test(l)))
})

test('start: each store start-up notice is sent to the owner once, after the router is up', async () => {
  const h = harness()
  ;(h.store as unknown as { startupNotices: string[] }).startupNotices = ['The database was damaged and was moved aside to stolik.db.bad.']
  await h.router.start()
  const hits = h.chat.texts().filter((t) => t.includes('moved aside'))
  assert.equal(hits.length, 1)
})

test('start: no notices, nothing extra is sent', async () => {
  const h = harness()
  await h.router.start()
  assert.equal(h.chat.texts().filter((t) => t.includes('moved aside')).length, 0)
})

test('stop: an open prompt gets its answer-at-desk note as an urgent edit, before the drain', async () => {
  const seq: string[] = []
  const h = harness()
  const priorities: unknown[] = []
  const edit = h.chat.editText.bind(h.chat)
  h.chat.editText = (id: number, text: string, perm: unknown, priority?: unknown) => {
    priorities.push(priority)
    seq.push(`edit ${id}`)
    return edit(id, text, perm as never)
  }
  // A prompt still open at shutdown (a pending approval; no pid, so no marker to clear).
  ;(h.router as unknown as { pending: Map<string, unknown> }).pending.set('r1', {
    session: { pid: null },
    messageId: 77,
    text: 'Approve?',
  })
  ;(h.chat as unknown as { drain: (ms: number) => Promise<void> }).drain = async (ms: number) => {
    seq.push(`drain ${ms}`)
  }
  await h.router.stop(10_000)
  assert.deepEqual(seq, ['edit 77', 'drain 5000'])
  assert.deepEqual(priorities, ['urgent'])
})

test('stop: an answer-at-desk edit that never returns is cut at the drain deadline, and the drain gets no time', async () => {
  const seq: string[] = []
  const h = harness()
  ;(h.chat as unknown as { editGate: Promise<void> }).editGate = new Promise<void>(() => {})
  ;(h.router as unknown as { pending: Map<string, unknown> }).pending.set('r1', {
    session: { pid: null },
    messageId: 78,
    text: 'Approve?',
  })
  ;(h.chat as unknown as { drain: (ms: number) => Promise<void> }).drain = async (ms: number) => {
    seq.push(`drain ${ms}`)
  }
  const stopped = h.router.stop(10_000)
  h.clock.advance(5_000)
  await stopped
  assert.deepEqual(seq, ['drain 0'])
})
