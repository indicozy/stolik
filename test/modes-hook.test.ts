// Hook policy and the hook script (design §4.10, finding 15): parseHookPolicy, the start-up self-test, and end-to-end
// runs of src/addons/modes/hook.ts as a child process with a temporary policy file.
import './helpers/isolate.ts'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hookOutput } from '../src/brain/modes.ts'
import { HOOK_CHECK_FAILED, denialLine, parseHookPolicy, selfTestInput, selfTestPasses, type HookPolicy } from '../src/brain/hook-policy.ts'
import { selfTestPolicy } from '../src/cli/doctor.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOOK = join(HERE, '..', 'src', 'addons', 'modes', 'hook.ts')
// Temporary files for this file: a fresh folder under the OS temp dir, removed in `after`.
const SCRATCH = mkdtempSync(join(tmpdir(), 'tgb-hook-'))
after(() => rmSync(SCRATCH, { recursive: true, force: true }))

const VALID = {
  mode: 'read',
  home: '/home/test',
  cwd: '/home/test/Documents/projects/master',
  roots: ['/home/test/Documents/projects/master'],
  webHosts: ['docs.example.org'],
  webLog: null,
  auditFile: null,
  deniedLog: null,
}

test('parseHookPolicy accepts a complete policy', () => {
  const p = parseHookPolicy(JSON.stringify(VALID))
  assert.deepEqual(p, VALID as HookPolicy)
})

test('parseHookPolicy accepts a web policy with a log and an audit file', () => {
  const p = parseHookPolicy(JSON.stringify({ ...VALID, mode: 'web', webLog: '/run/x.log', auditFile: '/run/audit.log' }))
  assert.equal(p?.mode, 'web')
  assert.equal(p?.webLog, '/run/x.log')
})

test('parseHookPolicy refuses a missing field', () => {
  const { webHosts: _omit, ...rest } = VALID
  assert.equal(parseHookPolicy(JSON.stringify(rest)), null)
})

test('parseHookPolicy refuses a field of the wrong type', () => {
  assert.equal(parseHookPolicy(JSON.stringify({ ...VALID, mode: 'admin' })), null)
  assert.equal(parseHookPolicy(JSON.stringify({ ...VALID, roots: '/home/test' })), null)
  assert.equal(parseHookPolicy(JSON.stringify({ ...VALID, webHosts: [42] })), null)
  assert.equal(parseHookPolicy(JSON.stringify({ ...VALID, webLog: 7 })), null)
  assert.equal(parseHookPolicy(JSON.stringify({ ...VALID, home: 'relative/home' })), null)
  assert.equal(parseHookPolicy(JSON.stringify({ ...VALID, webHosts: ['Not A Host'] })), null)
})

test('parseHookPolicy refuses an extra field, bad JSON, and non-object JSON', () => {
  assert.equal(parseHookPolicy(JSON.stringify({ ...VALID, extra: true })), null)
  assert.equal(parseHookPolicy('{not json'), null)
  assert.equal(parseHookPolicy('[]'), null)
  assert.equal(parseHookPolicy('null'), null)
  assert.equal(parseHookPolicy(''), null)
})

test('selfTestInput is a PreToolUse event for a Read of /proc/self/environ', () => {
  assert.deepEqual(selfTestInput('/home/test'), {
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: '/proc/self/environ' },
  })
})

test('selfTestPasses is true only for the deny JSON from hookOutput', () => {
  const deny = hookOutput({ allow: false, reason: 'secret path' })
  assert.equal(selfTestPasses(deny), true)
  assert.equal(selfTestPasses(deny + '\n'), true)
  assert.equal(selfTestPasses(''), false)
  assert.equal(selfTestPasses(hookOutput({ allow: true, reason: 'allowed' })), false)
  assert.equal(selfTestPasses('deny'), false)
  assert.equal(selfTestPasses('{"hookSpecificOutput":{"permissionDecision":"allow"}}'), false)
  assert.equal(
    selfTestPasses('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"x"},"extra":1}'),
    false,
  )
})

// ---------- end-to-end: the hook as a child process ----------

const readPolicy = {
  ...VALID,
  roots: [join(SCRATCH, 'project')],
  cwd: join(SCRATCH, 'project'),
  home: SCRATCH,
}

function writePolicy(name: string, policy: unknown): string {
  mkdirSync(SCRATCH, { recursive: true })
  const p = join(SCRATCH, name)
  writeFileSync(p, JSON.stringify(policy))
  return p
}

function runHook(mode: string, policyPath: string, stdin: string): { stdout: string; status: number | null } {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', HOOK, mode, policyPath], {
    input: stdin,
    encoding: 'utf8',
    timeout: 30_000,
  })
  return { stdout: r.stdout, status: r.status }
}

test('hook e2e: the self-test input itself is denied for the guard, not for a failed check', () => {
  // The self-test sends selfTestInput as it is (no extra fields): the hook must reach the guard and refuse the secret path.
  const p = writePolicy('read-policy.json', readPolicy)
  const r = runHook('read', p, JSON.stringify(selfTestInput(SCRATCH)))
  assert.equal(r.status, 0)
  assert.equal(selfTestPasses(r.stdout), true)
  assert.notEqual(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, HOOK_CHECK_FAILED)
})

test('hook e2e: a Read of /proc/self/environ is denied with the deny JSON', () => {
  const p = writePolicy('read-policy.json', readPolicy)
  const event = { hook_event_name: 'PreToolUse', ...selfTestInput(SCRATCH) }
  const r = runHook('read', p, JSON.stringify(event))
  assert.equal(r.status, 0)
  assert.equal(selfTestPasses(r.stdout), true)
})

test('hook e2e: a Grep with glob .* is denied', () => {
  const p = writePolicy('read-policy-grep.json', readPolicy)
  const event = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Grep',
    tool_input: { pattern: 'token', path: join(SCRATCH, 'project'), glob: '.*' },
  }
  const r = runHook('read', p, JSON.stringify(event))
  assert.equal(r.status, 0)
  const parsed = JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string } }
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny')
})

// The deny the hook gives when it could not check a call (a broken policy or input): exactly that deny, not a refusal.
function failedClosed(stdout: string): boolean {
  return stdout.trim() === hookOutput({ allow: false, reason: HOOK_CHECK_FAILED })
}

test('hook e2e: a broken policy path gives a deny on PreToolUse and exit code 0', () => {
  const missing = join(SCRATCH, 'does-not-exist.json')
  const event = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/home/test/x' } }
  const r = runHook('read', missing, JSON.stringify(event))
  assert.equal(r.status, 0)
  assert.equal(failedClosed(r.stdout), true)
})

test('hook e2e: an unknown hook event is denied, and a garbled stdin is denied', () => {
  const p = writePolicy('read-policy-event.json', readPolicy)
  const r1 = runHook('read', p, JSON.stringify({ hook_event_name: 'SessionStart', tool_name: 'Read', tool_input: {} }))
  assert.equal(r1.status, 0)
  assert.equal(failedClosed(r1.stdout), true)
  const r2 = runHook('read', p, '{not json')
  assert.equal(r2.status, 0)
  assert.equal(failedClosed(r2.stdout), true)
})

test('hook e2e: a policy whose mode differs from argv is denied', () => {
  const p = writePolicy('read-policy-mismatch.json', readPolicy)
  const event = { hook_event_name: 'PreToolUse', tool_name: 'Glob', tool_input: { path: join(SCRATCH, 'project') } }
  const r = runHook('web', p, JSON.stringify(event))
  assert.equal(failedClosed(r.stdout), true)
})

test('hook e2e: web run; WebSearch hosts go to the log, WebFetch to them is allowed, others denied and audited', () => {
  const webLog = join(SCRATCH, 'web-run.log')
  const auditFile = join(SCRATCH, 'web-audit.log')
  const p = writePolicy('web-policy.json', { ...VALID, mode: 'web', webLog, auditFile, webHosts: ['docs.example.org'] })

  const post = {
    hook_event_name: 'PostToolUse',
    tool_name: 'WebSearch',
    tool_input: { query: 'q' },
    tool_response: { results: [{ url: 'https://news.example.net/a' }] },
  }
  const rp = runHook('web', p, JSON.stringify(post))
  assert.equal(rp.status, 0)
  assert.equal(rp.stdout, '')
  assert.equal(readFileSync(webLog, 'utf8'), 'news.example.net\n')

  const allowed = runHook('web', p, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url: 'https://news.example.net/a' } }))
  assert.equal(allowed.stdout, '')

  const denied = runHook('web', p, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url: 'https://evil.test/?q=1' } }))
  assert.equal(selfTestPasses(denied.stdout), true)

  const audit = readFileSync(auditFile, 'utf8').trim().split('\n')
  assert.equal(audit.length, 2)
  assert.equal(audit[0].split('\t')[2], 'allow')
  assert.equal(audit[1].split('\t')[2], 'deny')
  assert.equal(audit[1].split('\t')[3], 'https://evil.test/?q=1')
})

test('hook e2e: PostToolUse with a broken policy is silent and exits 0', () => {
  const r = runHook('web', join(SCRATCH, 'missing.json'), JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'WebSearch' }))
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
})

test('parseHookPolicy needs deniedLog: a path or null, and refuses any other type', () => {
  const { deniedLog: _omit, ...noField } = VALID
  assert.equal(parseHookPolicy(JSON.stringify(noField)), null)
  assert.equal(parseHookPolicy(JSON.stringify({ ...VALID, deniedLog: '/run/denied.log' }))?.deniedLog, '/run/denied.log')
  assert.equal(parseHookPolicy(JSON.stringify({ ...VALID, deniedLog: 7 })), null)
  assert.equal(parseHookPolicy(JSON.stringify({ ...VALID, deniedLog: 'relative.log' })), null)
})

test('denialLine: the tool and the folder of its path (a file: its folder; a folder: itself), home as ~; Bash has no folder', () => {
  const home = '/home/test'
  const isDir = (p: string) => p === '/home/test/Documents' || p === '/home/test/.aws'
  assert.equal(denialLine('Read', { file_path: '/home/test/.ssh/id_rsa' }, home), 'Read\t~/.ssh')
  assert.equal(denialLine('Read', { file_path: '/proc/self/environ' }, home), 'Read\t/proc/self')
  assert.equal(denialLine('Grep', { path: '/home/test/.aws', pattern: 'key' }, home, isDir), 'Grep\t~/.aws')
  assert.equal(denialLine('Glob', { path: '/home/test/Documents', pattern: '**/.env*' }, home, isDir), 'Glob\t~/Documents')
  assert.equal(denialLine('Bash', { command: 'cat ~/.netrc' }, home), 'Bash\t-')
  assert.equal(denialLine('Read', {}, home), 'Read\t-')
})

test('denialLine: a Grep or Glob path that is a file gives its folder, never the file name', () => {
  const home = '/home/test'
  const isFile = () => false
  assert.equal(denialLine('Grep', { path: '/home/test/.ssh/id_rsa', pattern: 'x' }, home, isFile), 'Grep\t~/.ssh')
  assert.equal(denialLine('Grep', { path: '/home/test/.npmrc' }, home, isFile), 'Grep\t~')
  assert.equal(denialLine('Glob', { path: '/home/test/.ssh/id_ed25519' }, home), 'Glob\t~/.ssh', 'the default says not a folder')
  const isDir = () => true
  assert.equal(denialLine('Grep', { path: '/home/test/.ssh/id_rsa' }, home, isDir), 'Grep\t~/.ssh/id_rsa', 'a folder is its own folder')
})

test('the self-test policy the doctor writes is a valid policy, so the hook really runs its check', () => {
  const p = parseHookPolicy(JSON.stringify(selfTestPolicy('/home/test')))
  assert.notEqual(p, null)
  assert.equal(p?.deniedLog, null)
})

test('selfTestPasses refuses the hook\'s fail-closed deny: a policy the hook could not read is not a passing check', () => {
  assert.equal(selfTestPasses(hookOutput({ allow: false, reason: HOOK_CHECK_FAILED })), false)
})

test('denialLine never carries the file name, the command or a control character', () => {
  const line = denialLine('Read', { file_path: '/home/test/notes/secret\nname\t.txt' }, '/home/test')
  assert.equal(line, 'Read\t~/notes')
  assert.ok(!line.includes('secret'))
  const long = denialLine('Read', { file_path: '/home/test/' + 'a'.repeat(500) + '/x' }, '/home/test')
  assert.ok(long.length <= 'Read\t'.length + 200)
})

test('hook e2e: a denied read is appended to the denied log by folder; an allowed read is not', () => {
  const deniedLog = join(SCRATCH, 'denied-run.log')
  const p = writePolicy('read-denied.json', { ...VALID, deniedLog })
  const secret = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/home/test/.ssh/id_rsa' } }
  const denied = runHook('read', p, JSON.stringify(secret))
  assert.equal(selfTestPasses(denied.stdout), true)
  assert.equal(readFileSync(deniedLog, 'utf8'), 'Read\t~/.ssh\n')

  const ok = runHook('read', p, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/home/test/Documents/projects/master/README.md' } }))
  assert.equal(ok.stdout, '')
  assert.equal(readFileSync(deniedLog, 'utf8'), 'Read\t~/.ssh\n', 'an allowed call adds no line')
})
