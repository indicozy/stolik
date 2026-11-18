import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findClaudePid } from '../src/claudepid.ts'

test('findClaudePid returns a number or null without throwing', () => {
  const result = findClaudePid()
  assert.ok(result === null || typeof result === 'number', `unexpected result: ${String(result)}`)
})
