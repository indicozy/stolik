// Single-instance guards: the router lock file (src/adapters/instance-lock.ts) and the channel socket server's probe
// (src/adapters/channel/server.ts). Temp folders under test/.tmp-*; sockets use short paths (unix socket limit).
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Server } from 'node:net'
import { AlreadyRunningError, acquireRouterLock, routerLockHeld, socketAnswers } from '../src/adapters/instance-lock.ts'
import { closeSocketServer, startSocketServer } from '../src/adapters/channel/server.ts'
import { removeDir, tmpDir } from './helpers/addon-fakes.ts'

// A pid that belonged to a process which has exited.
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '0'])
  return r.pid as number
}

function listen(path: string): Promise<Server> {
  const server = createServer()
  return new Promise((resolve) => server.listen(path, () => resolve(server)))
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

test('acquireRouterLock: a second acquisition on the same folder throws AlreadyRunningError; release removes the file', async () => {
  const root = tmpDir('lock-two')
  try {
    const sock = join(root, 's.sock')
    const first = await acquireRouterLock(root, sock)
    assert.equal(first.path, join(root, 'router.lock'))
    assert.equal(readFileSync(first.path, 'utf8'), `${process.pid}\n`)
    await assert.rejects(acquireRouterLock(root, sock), (e: unknown) => {
      assert.ok(e instanceof AlreadyRunningError)
      assert.match((e as Error).message, new RegExp(`pid ${process.pid}`))
      assert.match((e as Error).message, /Stop it first/)
      return true
    })
    first.release()
    assert.equal(existsSync(first.path), false)
    const third = await acquireRouterLock(root, sock)
    third.release()
  } finally {
    removeDir(root)
  }
})

test('acquireRouterLock: a lock file whose pid is dead is taken over', async () => {
  const root = tmpDir('lock-stale')
  try {
    writeFileSync(join(root, 'router.lock'), `${deadPid()}\n`)
    assert.equal(routerLockHeld(root), false)
    const lock = await acquireRouterLock(root, join(root, 's.sock'))
    assert.equal(readFileSync(lock.path, 'utf8'), `${process.pid}\n`)
    assert.equal(routerLockHeld(root), true)
    lock.release()
  } finally {
    removeDir(root)
  }
})

test('release removes the lock file only while it still holds this pid', async () => {
  const root = tmpDir('lock-release')
  try {
    const lock = await acquireRouterLock(root, join(root, 's.sock'))
    writeFileSync(lock.path, `${deadPid()}\n`)
    lock.release()
    assert.equal(existsSync(lock.path), true, 'a file another process wrote is left alone')
  } finally {
    removeDir(root)
  }
})

test('routerLockHeld: true for a live pid, false for a dead pid or no file, and never throws', () => {
  const root = tmpDir('lock-held')
  try {
    assert.equal(routerLockHeld(root), false)
    writeFileSync(join(root, 'router.lock'), `${process.pid}\n`)
    assert.equal(routerLockHeld(root), true)
    writeFileSync(join(root, 'router.lock'), 'garbage')
    assert.equal(routerLockHeld(root), false)
    assert.equal(routerLockHeld(join(root, 'no', 'such', 'dir')), false)
  } finally {
    removeDir(root)
  }
})

test('acquireRouterLock: an answering socket releases the lock it just took and throws', async () => {
  const root = tmpDir('lock-sock')
  try {
    const sock = join(root, 's.sock')
    const server = await listen(sock)
    try {
      await assert.rejects(acquireRouterLock(root, sock), AlreadyRunningError)
      assert.equal(existsSync(join(root, 'router.lock')), false)
    } finally {
      await close(server)
    }
  } finally {
    removeDir(root)
  }
})

test('socketAnswers: true with a listener; false with no socket and with a plain file', async () => {
  const root = tmpDir('lock-probe')
  try {
    const sock = join(root, 's.sock')
    assert.equal(await socketAnswers(sock), false, 'missing socket')
    writeFileSync(join(root, 'plain.sock'), '')
    assert.equal(await socketAnswers(join(root, 'plain.sock')), false, 'a file that is not a socket')
    const server = await listen(sock)
    try {
      assert.equal(await socketAnswers(sock), true)
    } finally {
      await close(server)
    }
  } finally {
    removeDir(root)
  }
})

test('startSocketServer: a live listener makes the server refuse to start and leaves the socket file in place', async () => {
  const root = tmpDir('srv-live')
  try {
    const sock = join(root, 's.sock')
    const other = await listen(sock)
    try {
      await assert.rejects(
        startSocketServer(() => {}, () => {}, sock),
        (e: unknown) => e instanceof AlreadyRunningError && /answering on the socket/.test((e as Error).message),
      )
      assert.equal(existsSync(sock), true)
      assert.equal(await socketAnswers(sock), true, 'the other listener still answers')
    } finally {
      await close(other)
    }
  } finally {
    removeDir(root)
  }
})

test('startSocketServer: a stale socket file (no listener) is removed and the server starts', async () => {
  const root = tmpDir('srv-stale')
  try {
    const sock = join(root, 's.sock')
    writeFileSync(sock, '')
    const server = await startSocketServer(() => {}, () => {}, sock)
    try {
      assert.equal(await socketAnswers(sock), true)
      assert.equal(statSync(sock).isSocket(), true)
    } finally {
      await closeSocketServer(server)
    }
  } finally {
    removeDir(root)
  }
})
