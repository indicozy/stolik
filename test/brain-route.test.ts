import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FOLDER_PAGE_SIZE, ROUTE_PENDING_CAP, ROUTE_PENDING_TTL_MS, RoutePendingStore, folderPage, orderFolders } from '../src/brain/route.ts'
import { MINUTE } from '../src/brain/common.ts'

test('route pending TTL: 30 minutes; a route exactly at the TTL is still live, one ms later it expires', () => {
  const store = new RoutePendingStore<{ createdAt: number }>()
  const p = { createdAt: 1_000 }
  assert.equal(ROUTE_PENDING_TTL_MS, 30 * MINUTE)
  assert.equal(store.isExpired(p, 1_000 + ROUTE_PENDING_TTL_MS), false)
  assert.equal(store.isExpired(p, 1_000 + ROUTE_PENDING_TTL_MS + 1), true)
})

test('route pending TTL: expired() lists only the routes past the TTL, oldest first, and does not remove them', () => {
  const store = new RoutePendingStore<{ createdAt: number; name: string }>()
  store.put('a', { createdAt: 0, name: 'a' })
  store.put('b', { createdAt: 10 * MINUTE, name: 'b' })
  store.put('c', { createdAt: 20 * MINUTE, name: 'c' })
  const due = store.expired(31 * MINUTE)
  assert.deepEqual(due.map(([id]) => id), ['a'])
  assert.equal(store.size(), 3)
  assert.deepEqual(store.expired(41 * MINUTE).map(([id]) => id), ['a', 'b'])
})

test('route pending store: get and delete; a deleted route is gone', () => {
  const store = new RoutePendingStore<{ createdAt: number }>()
  store.put('x', { createdAt: 0 })
  assert.deepEqual(store.get('x'), { createdAt: 0 })
  store.delete('x')
  assert.equal(store.get('x'), undefined)
  assert.equal(store.size(), 0)
})

test('route pending store: the cap drops the oldest entry first', () => {
  const store = new RoutePendingStore<{ createdAt: number }>(2)
  store.put('a', { createdAt: 0 })
  store.put('b', { createdAt: 1 })
  store.put('c', { createdAt: 2 })
  assert.equal(store.get('a'), undefined)
  assert.ok(store.get('b'))
  assert.ok(store.get('c'))
  assert.equal(store.size(), 2)
  assert.equal(ROUTE_PENDING_CAP, 200)
})

test('orderFolders: master first, then the folders with transcripts newest first, then the rest by path', () => {
  const master = '/h/master'
  const recency = new Map([['/h/a', 100], ['/h/c', 300], ['/h/z', 200]])
  assert.deepEqual(
    orderFolders(['/h/b', '/h/z', master, '/h/a', '/h/c', '/h/b'], master, recency),
    [master, '/h/c', '/h/z', '/h/a', '/h/b'],
  )
  assert.deepEqual(orderFolders(['/h/b', '/h/a'], master, new Map()), ['/h/a', '/h/b'], 'no recency: by path')
  assert.deepEqual(orderFolders([], master, recency), [])
})

test('folderPage: 8 per page, the page clamped to the pages that exist', () => {
  assert.equal(FOLDER_PAGE_SIZE, 8)
  assert.deepEqual(folderPage(35, 0), { page: 0, pages: 5, start: 0, end: 8 })
  assert.deepEqual(folderPage(35, 4), { page: 4, pages: 5, start: 32, end: 35 })
  assert.deepEqual(folderPage(35, 9), { page: 4, pages: 5, start: 32, end: 35 })
  assert.deepEqual(folderPage(35, -2), { page: 0, pages: 5, start: 0, end: 8 })
  assert.deepEqual(folderPage(0, 0), { page: 0, pages: 1, start: 0, end: 0 })
})
