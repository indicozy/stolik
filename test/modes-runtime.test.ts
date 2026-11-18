// The modes addon's runtime pieces with the real shell, the real filesystem and a real child process: the hook self-test
// through `sh -c`, the shell helper's timeout, and the working folder and the run files a run sees.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ThreadMap, hookOutput, modesCwd, type ModeName } from '../src/brain/modes.ts'
import { Semaphore } from '../src/brain/concurrency.ts'
import { ModesService, type ServiceDeps } from '../src/addons/modes/service.ts'
import { runProcess, runShell } from '../src/addons/modes/run.ts'
import { ISOLATED_ROOT } from './helpers/isolate.ts'

const SID = '1ad1ce43-2b77-4566-a349-25c65eaa004d'

// A service over the real shell and the real filesystem; `request` answers the host calls, `command` is the hook command.
function realService(opts: { command: (mode: ModeName, policyPath: string) => string; request?: ServiceDeps['request'] }) {
  const stateDir = mkdtempSync(join(ISOLATED_ROOT, 'runtime-state-'))
  // A real home with the master project folder, since a read run spawns there.
  const home = mkdtempSync(join(ISOLATED_ROOT, 'runtime-home-'))
  mkdirSync(modesCwd(home), { recursive: true })
  const logs: string[] = []
  const sent: string[] = []
  const request: ServiceDeps['request'] =
    opts.request ??
    (async (op, payload) => {
      if (op === 'send') {
        sent.push(String(payload.text))
        return { messageIds: [sent.length + 500] }
      }
      if (op === 'quota') return { refuse: false }
      if (op === 'folders') return { folders: [] }
      return { ok: true }
    })
  const deps: ServiceDeps = {
    request,
    run: (args, timeoutMs, cwd) =>
      runProcess(process.execPath, ['-e', RUN_SCRIPT], {
        cwd,
        env: { ...(process.env as Record<string, string>), HOOKS_DIR: join(stateDir, 'hooks') },
        timeoutMs,
      }),
    hookCommand: opts.command,
    runHook: (command, stdin) => runShell(command, stdin, 5_000),
    stateDir,
    logRoot: '/logs/telegram',
    notesDir: '/notes',
    now: () => 1,
    home,
    threads: new ThreadMap(),
    saveThreads: () => {},
    newKey: () => 'aaaaaaaa',
    semaphore: new Semaphore(3),
    log: (m) => logs.push(m),
  }
  return { svc: new ModesService(deps), stateDir, home, logs, sent }
}

// A stand-in for `claude -p`: it answers with the working folder and the run files it sees (name and mode bits).
const RUN_SCRIPT = `
const fs = require('fs'), path = require('path');
const d = process.env.HOOKS_DIR;
const files = fs.existsSync(d) ? fs.readdirSync(d).sort().map((f) => f + ':' + (fs.statSync(path.join(d, f)).mode & 0o777).toString(8)) : [];
const result = JSON.stringify({ cwd: process.cwd(), files });
process.stdout.write(JSON.stringify({ subtype: 'success', is_error: false, result, session_id: '${SID}', num_turns: 1, total_cost_usd: 0 }));
`

async function settle(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 1000 && !cond(); i++) await new Promise((r) => setTimeout(r, 5))
  assert.ok(cond(), `settled: ${label}`)
}

test('runShell feeds stdin to the command and returns its stdout', async () => {
  assert.equal(await runShell('cat', 'hello from stdin', 5_000), 'hello from stdin')
  assert.equal(await runShell('echo out; exit 3', '', 5_000), 'out\n', 'the exit code is not an error here')
})

test('runShell kills a command that runs past its limit and returns what it printed', async () => {
  const started = Date.now()
  const out = await runShell('echo start; sleep 30', '', 300)
  assert.equal(out, 'start\n')
  assert.ok(Date.now() - started < 10_000, 'it did not wait for the sleep')
})

test('the hook self-test passes when the hook denies the secret read, and fails when it does not', async () => {
  const pass = realService({ command: () => `printf '%s' '${hookOutput({ allow: false, reason: 'refused in the self-test' })}'` })
  assert.equal(await pass.svc.selfTest(), true)
  assert.ok(pass.logs.some((l) => /self-test passed/.test(l)))
  assert.deepEqual(readdirSync(join(pass.stateDir, 'hooks')), [], 'the self-test policy is removed')

  const fail = realService({ command: () => 'echo nothing' })
  assert.equal(await fail.svc.selfTest(), false)
  assert.ok(fail.logs.some((l) => /self-test FAILED/.test(l)))
  const r = await fail.svc.onPrefix({ word: 'read', text: 'disk?', messageId: 'tg:7' })
  assert.match(r.reply ?? '', /safety check of the hook failed; read and web are off/)
})

test('a real run: quick and web run in the empty neutral folder; read runs in the master project', async () => {
  const h = realService({ command: () => `printf '%s' '${hookOutput({ allow: false, reason: 'refused in the self-test' })}'` })
  assert.equal(await h.svc.selfTest(), true)
  const neutral = join(h.stateDir, 'neutral')

  await h.svc.onPrefix({ word: 'quick', text: 'a', messageId: 'tg:7' })
  await settle(() => h.sent.length === 1, 'quick answer')
  assert.equal(JSON.parse(h.sent[0].split('\n\n')[0]).cwd, neutral)
  assert.deepEqual(readdirSync(neutral), [], 'the neutral folder has no files')

  await h.svc.onPrefix({ word: 'web', text: 'b', messageId: 'tg:8' })
  await settle(() => h.sent.length === 2, 'web answer')
  const web = JSON.parse(h.sent[1].split('\n\n')[0])
  assert.equal(web.cwd, neutral)
  // During the run: the policy (0600) and the settings (0600) are in the hooks folder.
  assert.equal(web.files.length, 2)
  for (const f of web.files) assert.match(f, /:600$/)
  // After the run: nothing is left.
  assert.deepEqual(readdirSync(join(h.stateDir, 'hooks')), [])

  await h.svc.onPrefix({ word: 'read', text: 'c', messageId: 'tg:9' })
  await settle(() => h.sent.length === 3, 'read answer')
  assert.equal(JSON.parse(h.sent[2].split('\n\n')[0]).cwd, modesCwd(h.home))
  assert.deepEqual(readdirSync(join(h.stateDir, 'hooks')), [], 'the read files are removed too')
})

test('the hooks and neutral folders are created private (0700)', async () => {
  const h = realService({ command: () => `printf '%s' '${hookOutput({ allow: false, reason: 'x' })}'` })
  await h.svc.selfTest()
  for (const d of ['hooks', 'neutral']) {
    assert.equal(statSync(join(h.stateDir, d)).mode & 0o777, 0o700, d)
  }
})
