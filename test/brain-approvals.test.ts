import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PERMISSION_TTL_MS, permissionExpired } from '../src/brain/approvals.ts'
import { MINUTE } from '../src/brain/common.ts'

test('permissionExpired: not expired up to the TTL, expired after it', () => {
  const p = { createdAt: 1_000 }
  assert.equal(permissionExpired(p, 1_000 + PERMISSION_TTL_MS), false)
  assert.equal(permissionExpired(p, 1_000 + PERMISSION_TTL_MS + 1), true)
})

test('permissionExpired: the TTL can be passed (an ask uses its own)', () => {
  const p = { createdAt: 0 }
  assert.equal(permissionExpired(p, 11 * MINUTE, 10 * MINUTE), true)
  assert.equal(permissionExpired(p, 9 * MINUTE, 10 * MINUTE), false)
})
