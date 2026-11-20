// Live smoke test of the opencode backend against the real opencode binary (no chat, no router, no model call).
// Starts one session in a state folder, checks that its server lists the stolik MCP server and holds the stolik skill as
// instructions, then kills the session. Prints OK or FAIL. Run it pinned:
//   OC_SMOKE_DIR=<project dir> [OC_SMOKE_STATE=<state dir>] [OC_SMOKE_MODEL=<provider/model>] \
//     $(ai-resources prefix) node --experimental-strip-types scripts/opencode-smoke.ts
// OC_SMOKE_DIR is required (the project folder the session opens in). OC_SMOKE_STATE defaults to a new folder under the
// temp dir. OC_SMOKE_MODEL defaults to opencode's own model. Only the session records file in the state folder is reset.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_DIR } from '../src/config.ts'
import { OpencodeBackend, SERVERS_FILE, type OcServer } from '../src/adapters/agent/opencode.ts'
import { ocFetch } from '../src/adapters/agent/opencode-http.ts'

const PROJECT_DIR = process.env.OC_SMOKE_DIR ?? ''
if (PROJECT_DIR === '') {
  console.error('usage: OC_SMOKE_DIR=<project dir> [OC_SMOKE_STATE=<state dir>] [OC_SMOKE_MODEL=<provider/model>] node --experimental-strip-types scripts/opencode-smoke.ts')
  process.exit(2)
}
const STATE_DIR = process.env.OC_SMOKE_STATE || mkdtempSync(join(tmpdir(), 'opencode-smoke-'))
const SOCKET_PATH = join(STATE_DIR, 'router.sock')
const CHANNEL = join(REPO_DIR, 'dist', 'channel.js')
const MODEL = process.env.OC_SMOKE_MODEL || null
const TOKEN = 'smoke-token'
const CAP_MS = 90_000
const POLL_MS = 1_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// The record of this session, once the backend has written it (the backend keeps no public getter).
function recordOf(): OcServer | undefined {
  try {
    const list = JSON.parse(readFileSync(join(STATE_DIR, SERVERS_FILE), 'utf8')) as OcServer[]
    return list.find((r) => r.token === TOKEN)
  } catch {
    return undefined
  }
}

async function poll<T>(label: string, deadline: number, fn: () => Promise<T | undefined>): Promise<T> {
  for (;;) {
    const v = await fn()
    if (v !== undefined) return v
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(POLL_MS)
  }
}

async function main(): Promise<void> {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  // The records file is reset so an old record of this token is never read as this run's session.
  rmSync(join(STATE_DIR, SERVERS_FILE), { force: true })
  const deadline = Date.now() + CAP_MS
  const backend = new OpencodeBackend({
    stateDir: STATE_DIR,
    model: MODEL,
    socketPath: SOCKET_PATH,
    channelScript: CHANNEL,
    onDeliveryError: (key, reason) => console.log(`delivery error ${key}: ${reason}`),
  })
  let name: string | null = null
  try {
    name = await backend.startSession('smoke', PROJECT_DIR, [], TOKEN)
    console.log(`tmux session: ${name}`)
    const rec = await poll('session id', deadline, async () => {
      const r = recordOf()
      return r?.sessionId ? r : undefined
    })
    console.log(`session id: ${rec.sessionId}`)

    const mcpOk = await poll('stolik in GET /api/mcp', deadline, async () => {
      const res = await ocFetch(rec, 'GET', '/api/mcp', undefined)
      if (res.status !== 200) throw new Error(`GET /api/mcp: HTTP ${res.status}`)
      return JSON.stringify(res.body).includes('"stolik"') ? true : undefined
    })
    console.log(`GET /api/mcp lists stolik: ${mcpOk}`)

    const instr = await poll('stolik instructions', deadline, async () => {
      const res = await ocFetch(rec, 'GET', `/api/experimental/session/${encodeURIComponent(rec.sessionId!)}/instructions/entries`, undefined)
      if (res.status !== 200) throw new Error(`GET instructions: HTTP ${res.status}`)
      return JSON.stringify(res.body).includes('stolik') ? true : undefined
    })
    console.log(`instructions hold stolik skill: ${instr}`)
    console.log('OK')
  } catch (e) {
    console.log(`FAIL: ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 1
  } finally {
    if (name) await backend.killSession(name)
    console.log(`killed session ${name ?? '(none)'}`)
  }
}

const cap = setTimeout(() => {
  console.log('FAIL: 90 s cap reached')
  process.exit(1)
}, CAP_MS + 5_000)
cap.unref()

await main()
