// Live smoke test of the opencode backend against the real opencode binary (no chat, no router, no model call).
// Starts one session in a scratch state folder, checks that its server lists the stolik MCP server and holds the stolik
// skill as instructions, then kills the session. Prints OK or FAIL. Run it pinned:
//   $(ai-resources prefix) node --experimental-strip-types scripts/opencode-smoke.ts
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_DIR } from '../src/config.ts'
import { OpencodeBackend, SERVERS_FILE, type OcServer } from '../src/adapters/agent/opencode.ts'
import { ocFetch } from '../src/adapters/agent/opencode-http.ts'

const ASSETS = '/home/indicozy/Documents/projects/stolik-assets/opencode-probe'
const STATE_DIR = join(ASSETS, 'smoke-state')
const PROJECT_DIR = join(ASSETS, 'proj')
const SOCKET_PATH = join(STATE_DIR, 'router.sock')
const CHANNEL = join(REPO_DIR, 'dist', 'channel.js')
const MODEL = 'zai-coding-plan/glm-5.3'
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
  rmSync(STATE_DIR, { recursive: true, force: true })
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
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
