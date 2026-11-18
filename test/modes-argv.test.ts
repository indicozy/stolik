// The argv of each mode, against the strings verified on the installed CLI (ticket 08 and the plan-2.11 checks).
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { MAX_TURNS, MODE_TIMEOUT_MS, SYSTEM_PROMPTS, hookCommand, hookSettings, modeArgv, modeForWord, modesCwd, quotaGatePath, readAllowEntries } from '../src/brain/modes.ts'

const HOME = '/home/u'
const SETTINGS = '/state/hooks/read.json'
// Read mode's roots are folders that exist (only directories become --add-dir); the test machine always has this one.
const ROOT = tmpdir()
const SID = '6d727728-f50d-46d9-83b5-b3e4f9e5a0a8'
const QG = `${HOME}/.claude/skills/quota-gate/scripts/quota-gate`

test('quick: haiku, no tools, strict MCP, json output', () => {
  assert.deepEqual(modeArgv('quick', { prompt: 'what is 2+2', home: HOME }), [
    '-p', '--model', 'haiku', '--output-format', 'json', '--strict-mcp-config', '--tools', '',
    '--append-system-prompt', SYSTEM_PROMPTS.quick, '--', 'what is 2+2',
  ])
})

test('read: sonnet, read tools, the allowlist, dontAsk, 30 steps, the hook settings', () => {
  const argv = modeArgv('read', { prompt: 'disk?', settingsPath: SETTINGS, home: HOME, roots: [ROOT] })
  assert.deepEqual(argv.slice(0, 14), [
    '-p', '--model', 'sonnet', '--output-format', 'json', '--strict-mcp-config',
    '--tools', 'Read,Grep,Glob,Bash',
    '--allowedTools', readAllowEntries(HOME).join(','),
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
  ])
  // Each read root is one --add-dir, then the settings, the system prompt, and the prompt last after `--`.
  assert.deepEqual(argv.slice(14), [
    '--max-turns', '30', '--add-dir', ROOT, '--settings', SETTINGS, '--append-system-prompt', SYSTEM_PROMPTS.read, '--', 'disk?',
  ])
  // The allowlist, as the CLI gets it: the read tools and the Bash prefixes (owner-accepted, design §4.10).
  const allowed = readAllowEntries(HOME)
  assert.ok(allowed.includes('Read') && allowed.includes('Grep') && allowed.includes('Glob'))
  assert.ok(allowed.includes('Bash(git status:*)') && allowed.includes('Bash(systemctl --user status:*)'))
  assert.ok(allowed.includes(`Bash(${QG}:*)`))
  assert.ok(!allowed.some((e) => /Bash\((touch|curl|rm|git push)/.test(e)))
})

test('web: WebSearch and WebFetch only, same permission flags, 30 steps', () => {
  assert.deepEqual(modeArgv('web', { prompt: 'news', settingsPath: SETTINGS, home: HOME }), [
    '-p', '--model', 'sonnet', '--output-format', 'json', '--strict-mcp-config',
    '--tools', 'WebSearch,WebFetch',
    '--allowedTools', 'WebSearch,WebFetch',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--max-turns', '30', '--settings', SETTINGS,
    '--append-system-prompt', SYSTEM_PROMPTS.web, '--', 'news',
  ])
})

test('a thread continues with --resume before the prompt, same mode flags', () => {
  const argv = modeArgv('quick', { prompt: 'and in French?', resumeId: SID, home: HOME })
  assert.deepEqual(argv.slice(-6), ['--append-system-prompt', SYSTEM_PROMPTS.quick, '--resume', SID, '--', 'and in French?'])
  assert.deepEqual(argv.slice(0, 8), ['-p', '--model', 'haiku', '--output-format', 'json', '--strict-mcp-config', '--tools', ''])
})

test('add-dir is for read only: quick and web get none, and read gets one per root from the options', () => {
  assert.equal(modeArgv('quick', { prompt: 'x', home: HOME }).includes('--add-dir'), false)
  assert.equal(modeArgv('web', { prompt: 'x', settingsPath: SETTINGS, home: HOME }).includes('--add-dir'), false)
  const other = modeArgv('read', { prompt: 'x', settingsPath: SETTINGS, home: '/home/other', roots: [ROOT, HOME] })
  // HOME does not exist on the test machine, so it is not a directory and gets no flag.
  assert.deepEqual(other.filter((a, i) => other[i - 1] === '--add-dir'), [ROOT])
  assert.equal(other.includes('/home/other'), false, 'the home folder is not added by itself')
})

test('read refuses to build without roots; read and web refuse without the hook settings file', () => {
  assert.throws(() => modeArgv('read', { prompt: 'x', settingsPath: SETTINGS, home: HOME }), /roots/)
  assert.throws(() => modeArgv('read', { prompt: 'x', home: HOME, roots: [ROOT] }), /settings file/)
  assert.throws(() => modeArgv('web', { prompt: 'x', home: HOME }), /settings file/)
})

test('a resume id must be a session id', () => {
  assert.throws(() => modeArgv('quick', { prompt: 'x', resumeId: '--help', home: HOME }), /session id/)
})

// Review finding 7: a follow-up or Continue text that starts with a dash is the prompt, not a CLI flag. The prompt
// comes after `--`, last.
test('a prompt that starts with a dash follows --, in every mode and with --resume', () => {
  for (const mode of ['quick', 'read', 'web'] as const) {
    const argv = modeArgv(mode, { prompt: '--dangerously-skip-permissions', settingsPath: SETTINGS, home: HOME, roots: [ROOT] })
    assert.deepEqual(argv.slice(-2), ['--', '--dangerously-skip-permissions'], mode)
  }
  const resumed = modeArgv('quick', { prompt: '-Continue.', resumeId: SID, home: HOME })
  assert.deepEqual(resumed.slice(-2), ['--', '-Continue.'])
  assert.equal(resumed.filter((a) => a === '--').length, 1, 'one end-of-options marker')
})

test('limits and models per mode (design §4.10)', () => {
  assert.equal(MODE_TIMEOUT_MS.quick, 60_000)
  assert.equal(MODE_TIMEOUT_MS.read, 300_000)
  assert.equal(MODE_TIMEOUT_MS.web, 300_000)
  assert.equal(MAX_TURNS.read, 30)
  assert.equal(MAX_TURNS.web, 30)
  assert.equal(MAX_TURNS.quick, null)
})

test('prefix words map to modes, including the Russian and synonym forms', () => {
  assert.equal(modeForWord('quick'), 'quick')
  assert.equal(modeForWord('Question'), 'quick')
  assert.equal(modeForWord('вопрос'), 'quick')
  assert.equal(modeForWord('быстро'), 'quick')
  assert.equal(modeForWord('check'), 'read')
  assert.equal(modeForWord('почитай'), 'read')
  assert.equal(modeForWord('проверь'), 'read')
  assert.equal(modeForWord('search'), 'web')
  assert.equal(modeForWord('поиск'), 'web')
  assert.equal(modeForWord('загугли'), 'web')
  assert.equal(modeForWord('note'), null)
})

test('the run folder and the quota-gate path are under the home folder', () => {
  assert.equal(modesCwd(HOME), '/home/u/Documents/projects/master')
  assert.equal(quotaGatePath(HOME), QG)
})

test('hook command: the node binary, the hook script, the mode and the policy file, and a failing hook blocks (|| exit 2)', () => {
  assert.equal(
    hookCommand('/usr/bin/node', '/x/hook.js', 'read', '/state/policy.json'),
    "'/usr/bin/node' '/x/hook.js' 'read' '/state/policy.json' || exit 2",
  )
})

test('hook settings: one PreToolUse command hook for every tool', () => {
  const s = JSON.parse(hookSettings('node /x/hook.js read')) as { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> } }
  assert.deepEqual(s.hooks.PreToolUse, [{ matcher: '*', hooks: [{ type: 'command', command: 'node /x/hook.js read' }] }])
})
