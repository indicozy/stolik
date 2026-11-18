import './helpers/isolate.ts'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:net'
import { mkdtempSync, rmSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Temp dir and socket path must be set before src/config.ts (which reads TG_BRIDGE_SOCKET) is imported.
const dir = mkdtempSync(join(tmpdir(), 'tg-bridge-test-'))
const sockPath = join(dir, 'bridge.sock')
process.env.TG_BRIDGE_SOCKET = sockPath
const { oneShot, request } = await import('../src/adapters/channel/ipc.ts')

let server: Server

before(async () => {
  // Echo server: replies to each newline-delimited JSON line with the same line.
  server = createServer((socket) => {
    let buf = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buf += chunk
      let idx: number
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        socket.write(line + '\n')
      }
    })
    socket.on('error', () => {})
  })
  await new Promise<void>((resolve) => server.listen(sockPath, resolve))
})

after(() => {
  server?.close()
  if (existsSync(sockPath)) unlinkSync(sockPath)
  rmSync(dir, { recursive: true, force: true })
})

test('oneShot gets the echo reply from a listening socket', async () => {
  const reply = await oneShot({ t: 'ping', n: 1 })
  assert.deepEqual(reply, { t: 'ping', n: 1 })
})

test('request gets the echo reply within its timeout', async () => {
  const reply = await request({ t: 'ask', n: 2 }, 5000)
  assert.deepEqual(reply, { t: 'ask', n: 2 })
})

test('oneShot returns null when nothing listens', async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (existsSync(sockPath)) unlinkSync(sockPath)
  const reply = await oneShot({ t: 'ping' })
  assert.equal(reply, null)
})
