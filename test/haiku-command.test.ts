// The addons' one-shot Haiku call takes its pinning from the machine config (src/addons/haiku.ts).
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HAIKU_ARGS, haikuCommand } from '../src/addons/haiku.ts'

test('no cpuAffinity: claude runs with no taskset in its argv', () => {
  const c = haikuCommand({ nice: null, cpuAffinity: null })
  assert.deepEqual(c, { file: 'claude', args: HAIKU_ARGS })
  assert.ok(!c.args.includes('taskset'))
  assert.ok(!c.args.includes('nice'))
})

test('nice alone: nice wraps claude, no taskset', () => {
  assert.deepEqual(haikuCommand({ nice: 19, cpuAffinity: null }), { file: 'nice', args: ['-n', '19', 'claude', ...HAIKU_ARGS] })
})

test('a cpuAffinity setting is honoured, not the old hardcoded 8-19', () => {
  assert.deepEqual(haikuCommand({ nice: 19, cpuAffinity: '2-5' }), { file: 'nice', args: ['-n', '19', 'taskset', '-c', '2-5', 'claude', ...HAIKU_ARGS] })
  assert.deepEqual(haikuCommand({ nice: null, cpuAffinity: '0-3' }), { file: 'taskset', args: ['-c', '0-3', 'claude', ...HAIKU_ARGS] })
})

test('the argv is the one-shot form: Haiku, one turn, no tools, no MCP, no session file', () => {
  const a = HAIKU_ARGS
  assert.deepEqual(a.slice(0, 4), ['-p', '--model', 'haiku', '--output-format'])
  assert.ok(a.includes('--no-session-persistence') && a.includes('--strict-mcp-config'))
  const i = a.indexOf('--tools')
  assert.equal(a[i + 1], '')
})
