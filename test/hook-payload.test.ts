// The PostToolUse payload the hook sends (finding 16): run for real (node, strip-types) against a fake router socket.
// The input is sent as a key, never as the input itself, and tool_response is not sent, so a large call still arrives.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { callKey } from '../src/brain/posttool.ts'

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'adapters', 'hooks', 'hook.ts')

// Runs the hook with `payload` on stdin; returns the messages it sent to the fake router.
async function runHook(event: string, payload: unknown, args: string[] = []): Promise<any[]> {
  // A short folder: a unix socket path is limited to about 100 characters.
  const dir = mkdtempSync(join(tmpdir(), 'tgb-hook-'))
  const sock = join(dir, 's.sock')
  const messages: any[] = []
  const server: Server = createServer((socket) => {
    let buf = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buf += chunk
      let idx: number
      while ((idx = buf.indexOf('\n')) !== -1) {
        messages.push(JSON.parse(buf.slice(0, idx)))
        buf = buf.slice(idx + 1)
        socket.write('{"t":"ok"}\n')
      }
    })
    socket.on('error', () => {})
  })
  try {
    await new Promise<void>((resolve) => server.listen(sock, resolve))
    const child = spawn(process.execPath, ['--experimental-strip-types', HOOK, event, ...args], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, TG_BRIDGE_SOCKET: sock },
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    child.stdin.end(JSON.stringify(payload))
    await new Promise<void>((resolve) => child.on('exit', () => resolve()))
    return messages
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
}

test('PostToolUse: the input is sent as a key, and tool_response is not sent', async () => {
  const tool_input = { command: 'ls -la' }
  const msgs = await runHook('PostToolUse', {
    session_id: 's1',
    tool_name: 'Bash',
    tool_use_id: 'toolu_1',
    tool_input,
    tool_response: { stdout: 'x'.repeat(500_000) },
  })
  assert.equal(msgs.length, 1)
  const m = msgs[0]
  assert.equal(m.t, 'hook')
  assert.equal(m.event, 'PostToolUse')
  assert.equal(m.payload.tool_name, 'Bash')
  assert.equal(m.payload.tool_use_id, 'toolu_1')
  assert.equal(m.payload.tool_input, undefined)
  assert.equal(m.payload.input_hash, callKey(tool_input).hash)
  assert.equal(m.payload.input_head, callKey(tool_input).head)
  assert.equal(m.payload.tool_response, undefined)
})

test('PostToolUse: a large call (over the old 1 MB stdin limit) still arrives, with its key', async () => {
  const tool_input = { file_path: '/x/big.txt', content: 'c'.repeat(3_000_000) }
  const msgs = await runHook('PostToolUse', {
    session_id: 's1',
    tool_name: 'Write',
    tool_use_id: 'toolu_2',
    tool_input,
    tool_response: { ok: true, text: 'w'.repeat(1_500_000) },
  })
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].payload.tool_name, 'Write')
  assert.equal(msgs[0].payload.input_hash, callKey(tool_input).hash)
  assert.ok(JSON.stringify(msgs[0]).length < 10_000, 'nothing big is sent')
})

test('PermissionRequest: every tool is forwarded to the router, not only AskUserQuestion and ExitPlanMode', async () => {
  const msgs = await runHook('PermissionRequest', {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    cwd: '/home/u/proj',
  })
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].t, 'ask')
  assert.equal(msgs[0].tool_name, 'Bash')
  assert.deepEqual(msgs[0].tool_input, { command: 'ls' })
})

test('PermissionRequest with --race-id: the id is sent with the raced ask', async () => {
  const msgs = await runHook('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: { questions: [] }, cwd: '/home/u/proj' }, ['--race', '--race-id=abc-123'])
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].race, true)
  assert.equal(msgs[0].raceId, 'abc-123')
})

test('AskResolved: sends ask_resolved with the race id and the verdict from stdin', async () => {
  const msgs = await runHook('AskResolved', { verdict: 'Send anyway ($1.20)' }, ['--race-id=abc-123'])
  assert.deepEqual(msgs, [{ t: 'ask_resolved', raceId: 'abc-123', verdict: 'Send anyway ($1.20)' }])
})

test('AskResolved without a race id sends nothing', async () => {
  const msgs = await runHook('AskResolved', { verdict: 'dismissed' })
  assert.deepEqual(msgs, [])
})

test('PermResolved: the tool, the key of its input and the verdict are sent; the input and tool_response are not', async () => {
  const tool_input = { command: 'npm test', description: 'Run tests' }
  const msgs = await runHook('PermResolved', {
    session_id: 's1',
    tool_name: 'Bash',
    tool_input,
    verdict: 'denied',
    tool_response: { stdout: 'y'.repeat(100_000) },
  })
  assert.equal(msgs.length, 1)
  const m = msgs[0]
  assert.equal(m.t, 'hook')
  assert.equal(m.event, 'PermResolved')
  assert.deepEqual(m.payload, {
    tool_name: 'Bash',
    input_hash: callKey(tool_input).hash,
    input_head: callKey(tool_input).head,
    verdict: 'denied',
  })
})

test('PermResolved: a verdict other than allowed or denied sends nothing', async () => {
  assert.deepEqual(await runHook('PermResolved', { tool_name: 'Bash', tool_input: { command: 'ls' }, verdict: 'maybe' }), [])
  assert.deepEqual(await runHook('PermResolved', { tool_name: 'Bash', tool_input: { command: 'ls' } }), [])
})
