// The agent kind: the config keys defaultAgent and opencodeModel, and the agent a new session carries.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTgConfig } from '../src/config.ts'
import { newSession } from '../src/brain/sessions.ts'

test('config: defaultAgent is claude and opencodeModel is null when the keys are absent', () => {
  const cfg = parseTgConfig({})
  assert.equal(cfg.defaultAgent, 'claude')
  assert.equal(cfg.opencodeModel, null)
})

test('config: defaultAgent opencode and a provider/model opencodeModel parse', () => {
  const cfg = parseTgConfig({ defaultAgent: 'opencode', opencodeModel: 'openrouter/qwen/qwen3-coder' })
  assert.equal(cfg.defaultAgent, 'opencode')
  assert.equal(cfg.opencodeModel, 'openrouter/qwen/qwen3-coder')
})

test('config: an unknown defaultAgent is rejected', () => {
  assert.throws(() => parseTgConfig({ defaultAgent: 'gpt' }), /defaultAgent/)
})

test('config: an opencodeModel without a provider prefix is rejected', () => {
  assert.throws(() => parseTgConfig({ opencodeModel: 'noslash' }), /opencodeModel/)
})

test('config: an opencodeModel whose provider starts with a dash is rejected', () => {
  assert.throws(() => parseTgConfig({ opencodeModel: '--x/y' }), /opencodeModel/)
})

test('newSession: a new session is a claude session', () => {
  const s = newSession(1, 'proj', '/home/u/proj', 4242, 0)
  assert.equal(s.agent, 'claude')
})
