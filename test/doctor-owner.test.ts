import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configOwnerPaired } from '../src/cli/doctor.ts'

test('configOwnerPaired: a Telegram config reads the top-level owner', () => {
  assert.equal(configOwnerPaired({ ownerUserId: '123' }), true)
  assert.equal(configOwnerPaired({ ownerUserId: null }), false)
})

test('configOwnerPaired: a paired Discord config reads discord.ownerUserId, not the null top-level one', () => {
  assert.equal(configOwnerPaired({ ownerUserId: null, discord: { ownerUserId: '99', homeId: null } }), true)
  assert.equal(configOwnerPaired({ ownerUserId: null, discord: { ownerUserId: null, homeId: null } }), false)
})
