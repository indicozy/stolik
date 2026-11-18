// Smoke test for dist/channel.js (not part of `npm test`). Run after `npm run build`:
//   nice -n 19 taskset -c 8-19 node --experimental-strip-types test/channel.smoke.ts
// Starts a fake router on a temp unix socket, spawns the channel server, and drives it over stdio.
import { createServer, type Server as NetServer } from 'node:net'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LineConn } from '../src/adapters/channel/ipc.ts'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHANNEL_JS = join(REPO, 'dist', 'channel.js')
const TMP = mkdtempSync(join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), 'tgb-smoke-'))
const SOCK = join(TMP, 'router.sock')
const PROJ_DIR = join(TMP, 'proj')

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed++
    console.log(`PASS ${name}`)
  } else {
    failed++
    console.log(`FAIL ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function until<T>(get: () => T | undefined, what: string, ms = 5000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = get()
    if (v !== undefined) return v
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`)
    await sleep(20)
  }
}

// ---- fake router -----------------------------------------------------------
const routerMsgs: any[] = []
let routerConn: LineConn | null = null
let routerServer: NetServer | null = null

function startRouter(): Promise<void> {
  return new Promise((resolve, reject) => {
    const srv = createServer((socket) => {
      socket.on('error', () => {})
      const c = new LineConn(socket)
      routerConn = c
      c.onMessage((m) => routerMsgs.push(m))
    })
    srv.once('error', reject)
    srv.listen(SOCK, () => {
      routerServer = srv
      resolve()
    })
  })
}

function stopRouter(): Promise<void> {
  return new Promise((resolve) => {
    routerConn?.socket.destroy()
    routerConn = null
    if (!routerServer) return resolve()
    routerServer.close(() => resolve())
    routerServer = null
  })
}

// ---- channel process -------------------------------------------------------
const stdoutMsgs: any[] = []
const stderrChunks: string[] = []
let child!: ChildProcessWithoutNullStreams

function spawnChannel(): void {
  child = spawn(process.execPath, [CHANNEL_JS], {
    env: { ...process.env, TG_BRIDGE_SOCKET: SOCK, CLAUDE_PROJECT_DIR: PROJ_DIR },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buf += chunk
    let idx: number
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (!line.trim()) continue
      try {
        stdoutMsgs.push(JSON.parse(line))
      } catch {
        stdoutMsgs.push({ __unparsable: line })
      }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => stderrChunks.push(chunk))
}

function writeStdin(obj: unknown): void {
  child.stdin.write(JSON.stringify(obj) + '\n')
}

async function rpc(id: number, method: string, params: unknown): Promise<any> {
  writeStdin({ jsonrpc: '2.0', id, method, params })
  const msg = await until(() => stdoutMsgs.find((m) => m.id === id), `rpc response ${id} (${method})`)
  return msg
}

function routerMsg(pred: (m: any) => boolean, what: string, ms?: number): Promise<any> {
  return until(() => routerMsgs.find(pred), what, ms)
}

function toolText(res: any): string {
  return res?.result?.content?.[0]?.text
}

async function main(): Promise<void> {
  await startRouter()
  spawnChannel()

  // 1. Register on connect
  const reg = await routerMsg((m) => m.t === 'register', 'register message')
  check('register: t=register with cwd from CLAUDE_PROJECT_DIR', reg.cwd === PROJ_DIR, reg)
  check('register: claudePid is number or null', reg.claudePid === null || Number.isInteger(reg.claudePid), reg)
  routerConn!.send({ t: 'registered', name: 'proj' })

  // 2. MCP handshake and capabilities
  const init = await rpc(1, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'channel-smoke', version: '0.0.0' },
  })
  const exp = init.result?.capabilities?.experimental ?? {}
  check('initialize: serverInfo.name is tg-bridge', init.result?.serverInfo?.name === 'tg-bridge', init.result?.serverInfo)
  check('initialize: experimental claude/channel declared', 'claude/channel' in exp, exp)
  check('initialize: experimental claude/channel/permission declared', 'claude/channel/permission' in exp, exp)
  check('initialize: instructions present', typeof init.result?.instructions === 'string' && init.result.instructions.length > 0)
  writeStdin({ jsonrpc: '2.0', method: 'notifications/initialized' })

  const tools = await rpc(2, 'tools/list', {})
  const names = (tools.result?.tools ?? []).map((t: any) => t.name)
  check('tools/list: exposes reply', names.includes('reply'), names)

  // 3. Inbound from router -> notifications/claude/channel
  routerConn!.send({ t: 'inbound', content: 'hello from phone', meta: { message_id: '7', ts: '2026-11-02T00:00:00.000Z' } })
  const inbound = await until(() => stdoutMsgs.find((m) => m.method === 'notifications/claude/channel'), 'inbound notification')
  check('inbound: content forwarded', inbound.params?.content === 'hello from phone', inbound)
  check('inbound: meta forwarded', inbound.params?.meta?.message_id === '7', inbound.params)

  // 4. Permission verdict from router -> notifications/claude/channel/permission
  routerConn!.send({ t: 'permission', request_id: 'abcde', behavior: 'allow' })
  const verdict = await until(
    () => stdoutMsgs.find((m) => m.method === 'notifications/claude/channel/permission'),
    'permission verdict notification',
  )
  check(
    'permission verdict: request_id and behavior forwarded',
    verdict.params?.request_id === 'abcde' && verdict.params?.behavior === 'allow',
    verdict.params,
  )

  // 5. Permission request from Claude -> router permission_request
  writeStdin({
    jsonrpc: '2.0',
    method: 'notifications/claude/channel/permission_request',
    params: { request_id: 'fghjk', tool_name: 'Bash', description: 'run ls', input_preview: '{"command":"ls"}' },
  })
  const pr = await routerMsg((m) => m.t === 'permission_request', 'permission_request at router')
  check(
    'permission_request: relayed to router',
    pr.request_id === 'fghjk' && pr.tool_name === 'Bash' && pr.description === 'run ls' && pr.input_preview === '{"command":"ls"}',
    pr,
  )

  // 6. reply tool, proactive, router says not delivered (user at desk)
  const p1 = rpc(3, 'tools/call', { name: 'reply', arguments: { text: 'proactive-check', kind: 'proactive' } })
  const r1 = await routerMsg((m) => m.t === 'reply' && m.text === 'proactive-check', 'proactive reply at router')
  check('reply proactive: kind and reqId forwarded', r1.kind === 'proactive' && typeof r1.reqId === 'string' && r1.files === undefined, r1)
  routerConn!.send({ t: 'reply_result', reqId: r1.reqId, ok: true, delivered: false })
  const res1 = await p1
  check(
    'reply proactive, not delivered: result text',
    toolText(res1) === 'not sent: user is at the desk (proactive messages are only delivered when away)' && !res1.result.isError,
    res1,
  )

  // 7. reply tool, response, delivered, with a real absolute file
  const pkgJson = join(REPO, 'package.json')
  const p2 = rpc(4, 'tools/call', { name: 'reply', arguments: { text: 'response-check', files: [pkgJson] } })
  const r2 = await routerMsg((m) => m.t === 'reply' && m.text === 'response-check', 'response reply at router')
  check('reply response: default kind is response, files forwarded', r2.kind === 'response' && r2.files?.[0] === pkgJson, r2)
  routerConn!.send({ t: 'reply_result', reqId: r2.reqId, ok: true, delivered: true })
  const res2 = await p2
  check('reply response, delivered: result text "sent"', toolText(res2) === 'sent' && !res2.result.isError, res2)

  // 8. reply tool, router reports an error
  const p3 = rpc(5, 'tools/call', { name: 'reply', arguments: { text: 'error-check', kind: 'requested' } })
  const r3 = await routerMsg((m) => m.t === 'reply' && m.text === 'error-check', 'requested reply at router')
  routerConn!.send({ t: 'reply_result', reqId: r3.reqId, ok: false, delivered: false, error: 'chat not allowed' })
  const res3 = await p3
  check('reply router error: isError with message', res3.result.isError === true && toolText(res3) === 'error: chat not allowed', res3)

  // 9. reply tool input validation (no router traffic)
  const before = routerMsgs.length
  const rel = await rpc(6, 'tools/call', { name: 'reply', arguments: { text: 'x', files: ['relative/file.png'] } })
  check('reply validation: relative path rejected', rel.result.isError === true && toolText(rel).includes('absolute'), rel)
  const missing = await rpc(7, 'tools/call', { name: 'reply', arguments: { text: 'x', files: [join(TMP, 'nope.png')] } })
  check('reply validation: missing file rejected', missing.result.isError === true && toolText(missing).includes('not found'), missing)
  const badKind = await rpc(8, 'tools/call', { name: 'reply', arguments: { text: 'x', kind: 'shout' } })
  check('reply validation: bad kind rejected', badKind.result.isError === true, badKind)
  await sleep(100)
  check('reply validation: nothing sent to router', routerMsgs.length === before, routerMsgs.slice(before))

  // 10. Router goes away: reply reports not running, channel keeps serving
  await stopRouter()
  await sleep(150)
  const down = await rpc(9, 'tools/call', { name: 'reply', arguments: { text: 'while-down' } })
  check(
    'router down: reply reports not running',
    down.result.isError === true && toolText(down) === 'tg-bridge router is not running',
    down,
  )

  // 11. Router comes back: channel re-registers without restarting
  const regsBefore = routerMsgs.filter((m) => m.t === 'register').length
  await startRouter()
  await until(() => (routerMsgs.filter((m) => m.t === 'register').length > regsBefore ? true : undefined), 're-register after router restart', 6000)
  check('router restart: channel re-registers', true)
  routerConn!.send({ t: 'inbound', content: 'after restart', meta: { message_id: '8' } })
  await until(
    () => stdoutMsgs.find((m) => m.method === 'notifications/claude/channel' && m.params?.content === 'after restart'),
    'inbound after restart',
  )
  check('router restart: inbound works again', true)

  // 12. stdin closed -> channel exits 0
  const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
  child.stdin.end()
  const code = await Promise.race([exit, sleep(3000).then(() => 'timeout' as const)])
  check('stdin close: channel exits with code 0', code === 0, code)

  check('stdout: only JSON-RPC lines', stdoutMsgs.every((m) => !('__unparsable' in m)), stdoutMsgs.filter((m) => '__unparsable' in m))
}

let exitCode = 0
try {
  await main()
} catch (err) {
  exitCode = 1
  failed++
  console.log(`FAIL aborted :: ${err instanceof Error ? err.message : String(err)}`)
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL')
  await stopRouter()
  rmSync(TMP, { recursive: true, force: true })
  const stderr = stderrChunks.join('')
  if (stderr.trim()) console.log(`--- channel stderr ---\n${stderr.trimEnd()}\n--- end stderr ---`)
  console.log(`${failed === 0 && exitCode === 0 ? 'smoke: PASS' : 'smoke: FAIL'} (${passed} passed, ${failed} failed)`)
  process.exit(failed === 0 && exitCode === 0 ? 0 : 1)
}
