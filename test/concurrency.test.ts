import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MODE_CONCURRENCY, Semaphore } from '../src/brain/concurrency.ts'

const tick = () => new Promise((r) => setImmediate(r))

test('semaphore: MODE_CONCURRENCY is 3', () => {
  assert.equal(MODE_CONCURRENCY, 3)
})

test('semaphore: waiters are served in arrival order', async () => {
  const s = new Semaphore(1)
  const order: string[] = []
  const r1 = await s.acquire()
  const p2 = s.acquire().then((r) => (order.push('2'), r))
  const p3 = s.acquire().then((r) => (order.push('3'), r))
  assert.equal(s.waiting, 2)
  assert.equal(s.active, 1)
  r1()
  const r2 = await p2
  assert.equal(s.waiting, 1)
  r2()
  const r3 = await p3
  assert.equal(s.waiting, 0)
  r3()
  assert.deepEqual(order, ['2', '3'])
  assert.equal(s.active, 0)
})

test('semaphore: run releases the permit when the task throws', async () => {
  const s = new Semaphore(1)
  await assert.rejects(
    s.run(() => {
      throw new Error('boom')
    }),
    /boom/,
  )
  assert.equal(s.active, 0)
  assert.equal(await s.run(() => 'ok'), 'ok')
})

test('semaphore: run releases on a rejected promise too, and waiters continue', async () => {
  const s = new Semaphore(1)
  const first = s.run(async () => {
    await tick()
    throw new Error('late')
  })
  const second = s.run(async () => 'second')
  await assert.rejects(first, /late/)
  assert.equal(await second, 'second')
})

test('semaphore: waiting count is the number behind the permits', async () => {
  const s = new Semaphore(3)
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const runs = [1, 2, 3, 4].map(() => s.run(() => gate))
  await tick()
  assert.equal(s.active, 3)
  assert.equal(s.waiting, 1, 'a fourth run waits with a "⏳ waiting" count of 1')
  release()
  await Promise.all(runs)
  assert.equal(s.waiting, 0)
  assert.equal(s.active, 0)
})

test('semaphore: a release called twice gives back one permit only', async () => {
  const s = new Semaphore(2)
  const r = await s.acquire()
  r()
  r()
  assert.equal(s.active, 0)
  await s.acquire()
  await s.acquire()
  assert.equal(s.active, 2)
})

test('semaphore: capacity must be a positive integer', () => {
  assert.throws(() => new Semaphore(0))
  assert.throws(() => new Semaphore(1.5))
})
