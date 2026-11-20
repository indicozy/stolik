// The opencode backend (Task 5): one `opencode serve` per session in tmux, the session created over HTTP, the stolik skill
// loaded, the TUI in a second window, and chat messages posted as prompts. A fake serve on 127.0.0.1:0 checks basic auth
// and records requests; a fake tmux runner records the commands. No real opencode, tmux or network beyond loopback.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ISOLATED_ROOT } from './helpers/isolate.ts'
import { harness } from './helpers/fakes.ts'
import { REPO_DIR } from '../src/config.ts'
import { configureLog } from '../src/router/log.ts'
import { OpencodeBackend, OC_HEADER, SERVERS_FILE, agentOfArgs, attachments, resolveOpencodeBin, shQuote, skillBody, splitModel } from '../src/adapters/agent/opencode.ts'
import { tmuxNewSessionArgs, type Run, type ServerLauncher, type TmuxRun } from '../src/adapters/tmux.ts'
import type { SessionKey } from '../src/brain/sessions.ts'

const SOCK = '/run/user/1000/stolik-test.sock'
const CHANNEL = '/opt/stolik/dist/channel.js'
const SKILL_FILE = join(REPO_DIR, 'opencode', 'skills', 'stolik', 'SKILL.md')
const TOKEN = 'token-stolik-1'

// Log lines go to this list, not to the test output; a test can check that no line carries a password.
const logged: string[] = []
configureLog({ level: 'error', file: false, sink: (r) => void logged.push(JSON.stringify(r)) })

// ---------- fake tmux ----------

type Call = { args: string[] }

// Records every tmux command. `new-session` records the serve's password under its port (the password is the basic-auth
// check of the fake serve for requests from that port). The password is read from the env file the script sources.
function fakeTmux(passwords: Map<string, string>): { calls: Call[]; run: TmuxRun } {
  const calls: Call[] = []
  const run: TmuxRun = async (_cmd, args) => {
    calls.push({ args: [...args] })
    const ok = (stdout = ''): Run => ({ code: 0, stdout, stderr: '' })
    if (args[0] === 'has-session') return { code: 1, stdout: '', stderr: "can't find session" }
    if (args[0] === 'display-message') return ok('4242\n')
    if (args[0] === 'capture-pane') return ok('serve listening\n')
    if (args[0] === 'new-session') {
      const pw = envFilePassword(args[args.length - 1])
      passwords.set(String(servePort(args)), pw)
    }
    return ok()
  }
  return { calls, run }
}

// The password in the env file a window script sources (`. <file> && exec ...`).
function envFilePassword(script: string): string {
  const file = /^\. (\S+) && exec /.exec(script)?.[1] ?? ''
  return /export OPENCODE_PASSWORD=(\S+)/.exec(readFileSync(file, 'utf8'))?.[1] ?? ''
}

// The launcher a plain test wants: tmux runs directly (no systemd scope, no login shell).
const plainLauncher: ServerLauncher = async (tmuxArgs) => ({ file: 'tmux', args: tmuxArgs })

// The `-e NAME=VALUE` pairs of a tmux argv.
function envPairs(args: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '-e') continue
    const pair = args[i + 1]
    const eq = pair.indexOf('=')
    out[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return out
}

// The port of the serve in a new-session argv (its window script ends with `--port <n>`).
function servePort(args: string[]): number {
  return Number(/--port (\d+)/.exec(args[args.length - 1])?.[1] ?? 0)
}

// Every new-session argv, in order, parsed.
function sessionsOf(calls: Call[]): Array<{ name: string; env: Record<string, string>; port: number; password: string; script: string; argv: string[] }> {
  return calls
    .filter((c) => c.args[0] === 'new-session')
    .map((c) => {
      const script = c.args[c.args.length - 1]
      return { name: c.args[c.args.indexOf('-s') + 1], env: envPairs(c.args), port: servePort(c.args), password: envFilePassword(script), script, argv: c.args }
    })
}

// ---------- fake serve ----------

type Seen = { method: string; path: string; origin: string; auth: string | undefined; body: any }

type Fake = { port: number; seen: Seen[]; promptStatus: number; putStatus: number; createStatus: number; server: Server }

// A fake `opencode serve` on 127.0.0.1:0. The backend's own port is not listening: the fetch of each backend is routed here
// with the backend's port in `x-origin-port`, and that port picks the password the auth check wants and the session id
// (`ses_<port>`). /health needs no auth, the rest do.
async function fakeServe(passwords: Map<string, string>): Promise<Fake> {
  const fake: Fake = { port: 0, seen: [], promptStatus: 200, putStatus: 200, createStatus: 200, server: createServer() }
  fake.server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (c: Buffer) => (raw += c))
    req.on('end', () => {
      const origin = String(req.headers['x-origin-port'] ?? '')
      const auth = req.headers.authorization
      const path = req.url ?? ''
      const body = raw === '' ? undefined : JSON.parse(raw)
      fake.seen.push({ method: req.method ?? '', path, origin, auth, body })
      const reply = (status: number, json: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(json === undefined ? '' : JSON.stringify(json))
      }
      if (path === '/health') return reply(200, undefined)
      const pw = passwords.get(origin)
      if (pw === undefined || auth !== basic(pw)) return reply(401, { name: 'UnauthorizedError' })
      if (req.method === 'POST' && path === '/api/session') return reply(fake.createStatus, fake.createStatus === 200 ? { data: { id: `ses_${origin}` } } : {})
      if (req.method === 'PUT' && path.includes('/instructions/entries/stolik')) return reply(fake.putStatus, {})
      if (req.method === 'POST' && path.endsWith('/prompt')) return reply(fake.promptStatus, { data: { id: 'msg_1' } })
      if (req.method === 'POST' && path.endsWith('/interrupt')) return reply(200, {})
      reply(404, { name: 'NotFound' })
    })
  })
  await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', () => resolve()))
  const addr = fake.server.address()
  fake.port = typeof addr === 'object' && addr !== null ? addr.port : 0
  return fake
}

function basic(pw: string): string {
  return 'Basic ' + Buffer.from(`opencode:${pw}`).toString('base64')
}

// A fetch that sends each request to the fake serve, keeping the port the backend asked for in x-origin-port.
function routedFetch(fakePort: number): typeof fetch {
  return async (input: string | URL | Request, init: RequestInit = {}) => {
    const u = new URL(String(input))
    const origin = u.port
    u.port = String(fakePort)
    const headers = { ...((init.headers as Record<string, string> | undefined) ?? {}), 'x-origin-port': origin }
    return fetch(u, { ...init, headers })
  }
}

// ---------- helpers ----------

async function waitFor(pred: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 3000
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

// A backend wired to the fakes, and the fakes themselves. The test closes the fake serve (t.after).
async function setup(t: { after: (fn: () => void | Promise<void>) => void }, opts: { model?: string | null; stateDir?: string; onDeliveryError?: (k: SessionKey, r: string) => void } = {}) {
  const passwords = new Map<string, string>()
  const tmux = fakeTmux(passwords)
  const fake = await fakeServe(passwords)
  t.after(() => {
    fake.server.closeAllConnections()
    fake.server.close()
  })
  const stateDir = opts.stateDir ?? mkdtempSync(join(ISOLATED_ROOT, 'oc-state-'))
  const reports: Array<[SessionKey, string]> = []
  const backend = new OpencodeBackend({
    stateDir,
    model: opts.model ?? null,
    socketPath: SOCK,
    channelScript: CHANNEL,
    tmux: tmux.run,
    launcher: plainLauncher,
    fetchImpl: routedFetch(fake.port),
    onDeliveryError: opts.onDeliveryError ?? ((k, r) => reports.push([k, r])),
  })
  return { backend, tmux, fake, passwords, reports, stateDir }
}

// Starts a session and waits until its TUI window is open (the boot is done by then).
async function started(t: Parameters<typeof setup>[0], project: string, dir: string, args: string[] = [], token = TOKEN, opts: Parameters<typeof setup>[1] = {}) {
  const s = await setup(t, opts)
  const name = await s.backend.startSession(project, dir, args, token)
  await waitFor(() => s.tmux.calls.some((c) => c.args[0] === 'new-window'), 'the TUI window')
  return { ...s, name }
}

// ---------- tests ----------

test('startSession runs serve in tmux with its env; the start command shows no password', async (t) => {
  const { backend, tmux, name } = await started(t, 'stolik', '/home/u/stolik')
  assert.equal(name, 'oc-stolik')
  const [ns] = sessionsOf(tmux.calls)
  assert.equal(ns.name, 'oc-stolik')
  assert.deepEqual(ns.argv.slice(0, 6), ['new-session', '-d', '-s', 'oc-stolik', '-c', '/home/u/stolik'])
  assert.equal(ns.env.STOLIK_AGENT, 'opencode')
  assert.equal(ns.env.STOLIK_SPAWN_TOKEN, TOKEN)
  assert.equal(ns.env.STOLIK_SOCKET, SOCK)
  assert.deepEqual(JSON.parse(ns.env.OPENCODE_CONFIG_CONTENT), { mcp: { stolik: { type: 'local', command: [process.execPath, CHANNEL] } } })
  assert.match(ns.env.OPENCODE_CONFIG_CONTENT, /"stolik"/)
  assert.equal(ns.password.length, 32, 'a 24-byte base64url password')
  assert.equal(ns.env.OPENCODE_PASSWORD, undefined, 'the password is not an -e argument')
  assert.match(ns.script, /^\. \S+ && exec opencode serve --hostname 127\.0\.0\.1 --port \d+$/)
  assert.ok(ns.port > 0)
  assert.equal(JSON.stringify(backend.startCommand()).includes(ns.password), false)
  assert.deepEqual(backend.startCommand(), ['opencode', 'serve', '--hostname', '127.0.0.1', '--port', '<port>'])
})

test('after health: creates the session, loads the skill, opens the TUI in a second window', async (t) => {
  const { fake, tmux } = await started(t, 'stolik', '/home/u/stolik', ['--agent', 'plan'], TOKEN, { model: 'openrouter/qwen/qwen3-coder' })
  const [ns] = sessionsOf(tmux.calls)
  const port = String(ns.port)
  const seen = fake.seen
  assert.deepEqual(seen.map((s) => `${s.method} ${s.path}`), [
    'GET /health',
    'POST /api/session',
    'PUT /api/experimental/session/ses_' + port + '/instructions/entries/stolik',
  ])
  assert.deepEqual(seen[1].body, {
    title: 'stolik',
    agent: 'plan',
    location: { directory: '/home/u/stolik' },
    model: { providerID: 'openrouter', id: 'qwen/qwen3-coder' },
  })
  const skill = skillBody(readFileSync(SKILL_FILE, 'utf8'))
  assert.equal(seen[2].body.value, skill)
  assert.equal(seen[2].body.value.startsWith('---'), false, 'frontmatter is not in the instructions')
  const win = tmux.calls.find((c) => c.args[0] === 'new-window')!.args
  assert.equal(win[win.indexOf('-t') + 1], '=oc-stolik:')
  assert.equal(win.includes('-e'), false, 'no -e: the password comes from the env file')
  assert.equal(
    win[win.length - 1],
    `. ${envFileOf(tmux.calls)} && exec opencode --server http://127.0.0.1:${port} --session ses_${port} /home/u/stolik`,
  )
})

// The env file a test's window scripts source (the path is in the serve's script).
function envFileOf(calls: Call[]): string {
  const script = calls.find((c) => c.args[0] === 'new-session')!.args.slice(-1)[0]
  return /^\. (\S+) && exec /.exec(script)![1]
}

test('no model and no --agent plan: the session is build with no model field', async (t) => {
  const { fake } = await started(t, 'stolik', '/home/u/stolik')
  assert.deepEqual(fake.seen[1].body, { title: 'stolik', agent: 'build', location: { directory: '/home/u/stolik' } })
})

test('sendToSession posts the prompt with the header and delivery queue; a file goes as a file part', async (t) => {
  const { backend, fake } = await started(t, 'stolik', '/home/u/stolik')
  const key = 'k-stolik'
  backend.bindToken(key, TOKEN)
  assert.equal(backend.sendToSession(key, 'hello', {}), true)
  await waitFor(() => fake.seen.some((s) => s.path.endsWith('/prompt')), 'the prompt')
  const p = fake.seen.find((s) => s.path.endsWith('/prompt'))!
  assert.equal(p.method, 'POST')
  assert.equal(p.path, '/api/session/ses_' + p.origin + '/prompt')
  assert.deepEqual(p.body, { text: OC_HEADER + 'hello', delivery: 'queue' })
  assert.equal(OC_HEADER, "[stolik] Message from the owner's chat. Answer with the stolik reply tool.\n\n")

  assert.equal(backend.sendToSession(key, 'see the file', { file_path: '/home/u/report.pdf' }), true)
  await waitFor(() => fake.seen.filter((s) => s.path.endsWith('/prompt')).length === 2, 'the second prompt')
  const f = fake.seen.filter((s) => s.path.endsWith('/prompt'))[1]
  assert.deepEqual(f.body.files, [{ uri: 'file:///home/u/report.pdf' }])
})

test('a refused prompt reports once with the status, and a closed server reports its error; the password is in neither', async (t) => {
  const { backend, fake, passwords, reports } = await started(t, 'stolik', '/home/u/stolik')
  const password = [...passwords.values()][0]
  const key = 'k-fail'
  backend.bindToken(key, TOKEN)
  fake.promptStatus = 500
  assert.equal(backend.sendToSession(key, 'x', {}), true)
  await waitFor(() => reports.length === 1, 'the failure report')
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(reports.length, 1, 'reported once')
  assert.equal(reports[0][0], key)
  assert.match(reports[0][1], /500/)
  fake.server.closeAllConnections()
  await new Promise<void>((r) => fake.server.close(() => r()))
  assert.equal(backend.sendToSession(key, 'y', {}), true)
  await waitFor(() => reports.length === 2, 'the network failure report')
  assert.equal(reports[1][0], key)
  assert.ok(reports[1][1].length > 0, 'a network error gives its text')
  for (const [, reason] of reports) assert.equal(reason.includes(password), false)
})

test('two servers route separately: each key reaches its own serve', async (t) => {
  const s = await setup(t)
  await s.backend.startSession('alpha', '/home/u/alpha', [], 'token-alpha')
  await s.backend.startSession('beta', '/home/u/beta', [], 'token-beta')
  await waitFor(() => s.tmux.calls.filter((c) => c.args[0] === 'new-window').length === 2, 'two TUI windows')
  const [na, nb] = sessionsOf(s.tmux.calls)
  s.backend.bindToken('k-alpha', 'token-alpha')
  s.backend.bindToken('k-beta', 'token-beta')
  assert.equal(s.backend.sendToSession('k-alpha', 'to alpha', {}), true)
  assert.equal(s.backend.sendToSession('k-beta', 'to beta', {}), true)
  await waitFor(() => s.fake.seen.filter((x) => x.path.endsWith('/prompt')).length === 2, 'two prompts')
  const pa = s.fake.seen.find((x) => x.body?.text === OC_HEADER + 'to alpha')!
  const pb = s.fake.seen.find((x) => x.body?.text === OC_HEADER + 'to beta')!
  assert.equal(pa.origin, String(na.port))
  assert.equal(pa.path, `/api/session/ses_${na.port}/prompt`)
  assert.equal(pb.origin, String(nb.port))
  assert.equal(pb.path, `/api/session/ses_${nb.port}/prompt`)
})

test('the records survive a restart: a new backend on the same folder routes a bound token, and the file is 0600', async (t) => {
  const first = await started(t, 'stolik', '/home/u/stolik')
  const file = join(first.stateDir, SERVERS_FILE)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  const second = new OpencodeBackend({
    stateDir: first.stateDir,
    model: null,
    socketPath: SOCK,
    channelScript: CHANNEL,
    tmux: first.tmux.run,
    launcher: plainLauncher,
    fetchImpl: routedFetch(first.fake.port),
    onDeliveryError: () => {},
  })
  second.bindToken('k-restart', TOKEN)
  assert.equal(second.sendToSession('k-restart', 'after restart', {}), true)
  await waitFor(() => first.fake.seen.some((x) => x.body?.text === OC_HEADER + 'after restart'), 'the prompt after restart')
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test('an unbound key gets false; a bound one whose session is booting is queued, then goes straight through', async (t) => {
  const s = await setup(t)
  assert.equal(s.backend.sendToSession('nobody', 'hi', {}), false)
  await s.backend.startSession('stolik', '/home/u/stolik', [], TOKEN)
  s.backend.bindToken('k-early', TOKEN)
  assert.equal(s.backend.sendToSession('k-early', 'too early', {}), true, 'queued until the session exists')
  await waitFor(() => s.tmux.calls.some((c) => c.args[0] === 'new-window'), 'the TUI window')
  assert.equal(s.backend.sendToSession('k-early', 'now', {}), true)
})

test('a message bound before the session exists is posted after the create, in order', async (t) => {
  const s = await setup(t)
  await s.backend.startSession('stolik', '/home/u/stolik', [], TOKEN)
  s.backend.bindToken('k-queue', TOKEN)
  assert.equal(s.backend.sendToSession('k-queue', 'first', {}), true, 'queued while the session boots')
  assert.equal(s.backend.sendToSession('k-queue', 'second', {}), true)
  await waitFor(() => s.tmux.calls.some((c) => c.args[0] === 'new-window'), 'the TUI window')
  await waitFor(() => s.fake.seen.filter((x) => x.path.endsWith('/prompt')).length === 2, 'the two queued prompts')
  const prompts = s.fake.seen.filter((x) => x.path.endsWith('/prompt'))
  assert.deepEqual(prompts.map((x) => x.body.text), [OC_HEADER + 'first', OC_HEADER + 'second'])
  const create = s.fake.seen.findIndex((x) => x.method === 'POST' && x.path === '/api/session')
  assert.ok(create >= 0 && s.fake.seen.indexOf(prompts[0]) > create, 'the prompts follow the session create')
  assert.deepEqual(s.reports, [], 'nothing is reported')
})

test('a failed session create drops the queued messages: their key is reported once and no prompt is posted', async (t) => {
  const s = await setup(t)
  s.fake.createStatus = 500
  await s.backend.startSession('stolik', '/home/u/stolik', [], TOKEN)
  s.backend.bindToken('k-dead', TOKEN)
  assert.equal(s.backend.sendToSession('k-dead', 'one', {}), true)
  assert.equal(s.backend.sendToSession('k-dead', 'two', {}), true)
  await waitFor(() => s.reports.length === 1, 'the boot failure report')
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(s.reports, [['k-dead', 'opencode did not start']])
  assert.equal(s.fake.seen.some((x) => x.path.endsWith('/prompt')), false, 'the queued messages are dropped')
  assert.equal(s.backend.sendToSession('k-dead', 'three', {}), false, 'a session that never started takes no more messages')
})

test('ownsTmux: true for the tmux name of a record, false for other names; a killed session is no longer owned', async (t) => {
  const { backend, name } = await started(t, 'stolik', '/home/u/stolik')
  assert.equal(backend.ownsTmux(name), true)
  assert.equal(backend.ownsTmux('tg-stolik'), false)
  await backend.killSession(name)
  assert.equal(backend.ownsTmux(name), false)
})

test('killSession interrupts the session, kills its tmux session and forgets its record', async (t) => {
  const { backend, tmux, fake, stateDir, name } = await started(t, 'stolik', '/home/u/stolik')
  backend.bindToken('k-kill', TOKEN)
  await backend.killSession(name)
  assert.ok(fake.seen.some((x) => x.method === 'POST' && x.path.endsWith('/interrupt')))
  const kill = tmux.calls.find((c) => c.args[0] === 'kill-session')!.args
  assert.deepEqual(kill, ['kill-session', '-t', '=oc-stolik'])
  assert.equal(backend.sendToSession('k-kill', 'gone', {}), false)
  const saved = JSON.parse(readFileSync(join(stateDir, SERVERS_FILE), 'utf8'))
  assert.deepEqual(saved, [])
  assert.equal(existsSync(envFileOf(tmux.calls)), false, 'the env file is deleted with the session')
})

test('the skill PUT failing (500) is logged and the TUI still opens; prompts still go', async (t) => {
  const s = await setup(t)
  s.fake.putStatus = 500
  await s.backend.startSession('stolik', '/home/u/stolik', [], TOKEN)
  await waitFor(() => s.tmux.calls.some((c) => c.args[0] === 'new-window'), 'the TUI window despite the skill failure')
  const port = sessionsOf(s.tmux.calls)[0].port
  assert.ok(logged.some((l) => l.includes('runs without the stolik skill')), 'the skill failure is logged')
  assert.equal(logged.some((l) => l.includes(sessionsOf(s.tmux.calls)[0].password)), false, 'and the log has no password')
  const win = s.tmux.calls.find((c) => c.args[0] === 'new-window')!.args
  assert.ok(win[win.length - 1].includes(`--session ses_${port} `), 'the TUI names the session')
  s.backend.bindToken('k-skill', TOKEN)
  assert.equal(s.backend.sendToSession('k-skill', 'still works', {}), true)
  await waitFor(() => s.fake.seen.some((x) => x.body?.text === OC_HEADER + 'still works'), 'the prompt')
})

test('no tmux argv carries the password; the env file is 0600 and sources to the password', async (t) => {
  const { passwords, tmux, stateDir, backend, name } = await started(t, 'stolik', '/home/u/stolik')
  const [pw] = [...passwords.values()]
  assert.ok(pw.length > 0)
  for (const c of tmux.calls) assert.equal(c.args.join(' ').includes(pw), false, `argv of ${c.args[0]} has the password`)
  const file = envFileOf(tmux.calls)
  assert.equal(file.startsWith(stateDir), true)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  const sourced = execFileSync('sh', ['-c', `. ${shQuote(file)} && printf %s "$OPENCODE_PASSWORD"`], { encoding: 'utf8' })
  assert.equal(sourced, pw)
  assert.equal(JSON.stringify(backend.startCommand()).includes(pw), false)
  await backend.killSession(name)
})

test('shQuote: a word that holds quotes and spaces reaches the shell as one word', () => {
  for (const word of ["plain-word_1", "with space", "it's", "$HOME `x` \"q\"", "a'b'c"]) {
    const got = execFileSync('sh', ['-c', `printf %s ${shQuote(word)}`], { encoding: 'utf8' })
    assert.equal(got, word)
  }
})

test('a records file that does not parse is moved aside, and a later save keeps the moved copy', async (t) => {
  const stateDir = mkdtempSync(join(ISOLATED_ROOT, 'oc-corrupt-'))
  const file = join(stateDir, SERVERS_FILE)
  writeFileSync(file, '[{"token": "x", "password": "keep-me"')
  const s = await setup(t, { stateDir })
  assert.equal(existsSync(file), false, 'the damaged file is no longer in place')
  const bad = readdirSync(stateDir).filter((f) => f.startsWith(SERVERS_FILE + '.bad-'))
  assert.equal(bad.length, 1)
  assert.equal(readFileSync(join(stateDir, bad[0]), 'utf8'), '[{"token": "x", "password": "keep-me"')
  await s.backend.startSession('stolik', '/home/u/stolik', [], TOKEN)
  await waitFor(() => s.tmux.calls.some((c) => c.args[0] === 'new-window'), 'the TUI window')
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(readFileSync(join(stateDir, bad[0]), 'utf8'), '[{"token": "x", "password": "keep-me"', 'the moved copy is untouched')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 1)
})

test("the router reports a delivery error in the chat as Couldn't deliver to opencode", async () => {
  const h = harness()
  await h.router.start()
  await h.router.reportDeliveryError('nobody', 'HTTP 500')
  assert.ok(h.chat.texts().includes("Couldn't deliver to opencode: HTTP 500"), JSON.stringify(h.chat.texts()))
})

test('tmuxNewSessionArgs: a command and env replace the launcher, the defaults stay', () => {
  const args = tmuxNewSessionArgs('oc-x', '/d', [], '/run/user/1000/stolik.sock', null, ['opencode', 'serve'], ['STOLIK_AGENT=opencode'])
  assert.deepEqual(args.slice(0, 6), ['new-session', '-d', '-s', 'oc-x', '-c', '/d'])
  assert.ok(args.includes('STOLIK_AGENT=opencode'))
  assert.deepEqual(args.slice(-2), ['opencode', 'serve'])
})

test('pure helpers: the skill body, the model split, the agent, the attachments', () => {
  assert.equal(skillBody('---\nname: stolik\ndescription: x\n---\n\nUse it.\n'), 'Use it.')
  assert.equal(skillBody('no frontmatter'), 'no frontmatter')
  assert.deepEqual(splitModel('openrouter/qwen/qwen3-coder'), { providerID: 'openrouter', id: 'qwen/qwen3-coder' })
  assert.equal(splitModel(null), null)
  assert.equal(agentOfArgs(['--agent', 'plan']), 'plan')
  assert.equal(agentOfArgs([]), 'build')
  assert.deepEqual(attachments({ image_path: '/a/b.png' }), [{ uri: 'file:///a/b.png' }])
  assert.deepEqual(attachments({}), [])
})

test('resolveOpencodeBin: OPENCODE_BIN wins; then the first PATH hit; then ~/.opencode/bin; then the bare name', () => {
  const home = '/home/u'
  const onlyAt = (...paths: string[]) => (p: string) => paths.includes(p)
  // OPENCODE_BIN is used even when it does not exist and PATH and home have one
  assert.equal(resolveOpencodeBin({ OPENCODE_BIN: '/opt/oc', PATH: '/usr/bin' }, home, onlyAt('/usr/bin/opencode', '/home/u/.opencode/bin/opencode')), '/opt/oc')
  // the first PATH directory that has an opencode wins
  assert.equal(resolveOpencodeBin({ PATH: '/a:/usr/bin:/b' }, home, onlyAt('/usr/bin/opencode', '/b/opencode')), '/usr/bin/opencode')
  // not on PATH: the installer's location
  assert.equal(resolveOpencodeBin({ PATH: '/usr/bin' }, home, onlyAt('/home/u/.opencode/bin/opencode')), '/home/u/.opencode/bin/opencode')
  // nowhere: the bare name, so the spawn fails with the familiar error
  assert.equal(resolveOpencodeBin({ PATH: '/usr/bin' }, home, onlyAt()), 'opencode')
  assert.equal(resolveOpencodeBin({}, home, onlyAt()), 'opencode')
})
