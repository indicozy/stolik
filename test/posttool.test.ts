// Prompts answered at the desk (plan 1.2): the pure match of a PostToolUse event to a pending permission prompt.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ANSWERED_AT_DESK_TEXT, HEAD_CHARS, answeredAtDesk, callKey, previewMatches } from '../src/brain/posttool.ts'

test('previewMatches: the same JSON input matches, whatever the whitespace', () => {
  assert.equal(previewMatches('{"command":"ls -la"}', callKey({ command: 'ls -la' })), true)
  assert.equal(previewMatches('{\n  "command": "ls -la"\n}', callKey({ command: 'ls -la' })), true)
})

test('previewMatches: a different input does not match', () => {
  assert.equal(previewMatches('{"command":"ls"}', callKey({ command: 'rm -rf /' })), false)
  assert.equal(previewMatches('{"command":"ls"}', callKey({ command: 'ls -la' })), false, 'a longer command is not the same call')
})

test('previewMatches: a shorter command is not matched by a preview of a longer one (the value is only contained in it)', () => {
  assert.equal(previewMatches('{"command":"ls -la && rm -rf /"}', callKey({ command: 'ls -la' })), false)
  assert.equal(previewMatches('{"command":"ls -la && rm -rf /"}', callKey({ command: 'ls' })), false)
})

test('previewMatches: an empty input matches only the empty preview', () => {
  assert.equal(previewMatches('{}', callKey({})), true)
  assert.equal(previewMatches('{"command":"ls"}', callKey({})), false)
})

test('previewMatches: a cut preview (at the cap) matches by the head of the input, and not by a different head', () => {
  const big = { content: 'x'.repeat(5000) }
  const cut = JSON.stringify(big).slice(0, 3500) // the channel's preview of a large input, cut at its cap
  assert.equal(previewMatches(cut, callKey(big)), true)
  const other = { content: 'y'.repeat(5000) }
  assert.equal(previewMatches(cut, callKey(other)), false)
})

test('callKey: the head is the first HEAD_CHARS characters of the canonical text, the hash covers all of it', () => {
  const k = callKey({ content: 'a'.repeat(5000) })
  assert.equal(k.head.length, HEAD_CHARS)
  assert.match(k.hash, /^[0-9a-f]{64}$/)
  assert.notEqual(callKey({ content: 'a'.repeat(5000) }).hash, callKey({ content: 'a'.repeat(4999) + 'b' }).hash)
})

test('answeredAtDesk: the oldest pending prompt with the same tool and input is the answered one', () => {
  const prompts = [
    { id: 'aaaaa', tool_name: 'Bash', input_preview: '{"command":"make"}' },
    { id: 'bbbbb', tool_name: 'Bash', input_preview: '{"command":"ls"}' },
    { id: 'ccccc', tool_name: 'Bash', input_preview: '{"command":"ls"}' },
  ]
  assert.equal(answeredAtDesk(prompts, { tool_name: 'Bash', key: callKey({ command: 'ls' }) }), 'bbbbb')
})

test('answeredAtDesk: the tool name must match too', () => {
  const prompts = [{ id: 'aaaaa', tool_name: 'Write', input_preview: '{"file_path":"/x/a.txt"}' }]
  assert.equal(answeredAtDesk(prompts, { tool_name: 'Edit', key: callKey({ file_path: '/x/a.txt' }) }), null)
  assert.equal(answeredAtDesk(prompts, { tool_name: 'Write', key: callKey({ file_path: '/x/a.txt' }) }), 'aaaaa')
})

test('answeredAtDesk: nothing pending, or nothing matching, gives null', () => {
  assert.equal(answeredAtDesk([], { tool_name: 'Bash', key: callKey({ command: 'ls' }) }), null)
  assert.equal(answeredAtDesk([{ id: 'aaaaa', tool_name: 'Bash', input_preview: '{"command":"pwd"}' }], { tool_name: 'Bash', key: callKey({ command: 'ls' }) }), null)
})

test('the text that replaces the buttons says the prompt was answered at the desk', () => {
  assert.equal(ANSWERED_AT_DESK_TEXT, '✅ Answered at the desk')
})
