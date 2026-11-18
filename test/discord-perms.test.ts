// The bot's effective permissions (adapters/chat/discord-perms.ts): Discord's order of roles and overwrites, and the
// names of the missing rights. Pure tables, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BRIDGE_PERMS_INTEGER, FOLDER_EXTRA_PERMS, LOBBY_PERMS, effectivePerms, missingPerms } from '../src/adapters/chat/discord-perms.ts'

const G = '900000000000000001'
const BOT = '600000000000000002'
const ROLE = '700000000000000001'
const VIEW = 1024n
const SEND = 2048n
const ADMIN = 8n
const guild = (everyone: bigint, roles: Array<{ id: string; permissions: bigint }> = []) => ({
  id: G,
  owner_id: '800000000000000001',
  roles: [{ id: G, permissions: everyone.toString() }, ...roles.map((r) => ({ id: r.id, permissions: r.permissions.toString() }))],
})

test('effective permissions: @everyone and the member roles are summed', () => {
  const g = guild(VIEW, [{ id: ROLE, permissions: SEND }])
  assert.equal(effectivePerms(g, [], { id: '1' }, BOT), VIEW)
  assert.equal(effectivePerms(g, [ROLE], { id: '1' }, BOT), VIEW | SEND)
})

test('effective permissions: ADMINISTRATOR and the server owner have every right', () => {
  assert.equal(effectivePerms(guild(ADMIN), [], { id: '1', permission_overwrites: [{ id: G, type: 0, allow: '0', deny: '2048' }] }, BOT), (1n << 64n) - 1n)
  assert.equal(effectivePerms({ ...guild(0n), owner_id: BOT }, [], { id: '1' }, BOT), (1n << 64n) - 1n)
})

test('effective permissions: overwrites apply in order (everyone, roles, member)', () => {
  const g = guild(VIEW | SEND, [{ id: ROLE, permissions: 0n }])
  // @everyone denies Send; a role allows it; the member's own overwrite denies View.
  const channel = {
    id: '1',
    permission_overwrites: [
      { id: G, type: 0, allow: '0', deny: SEND.toString() },
      { id: ROLE, type: 0, allow: SEND.toString(), deny: '0' },
      { id: BOT, type: 1, allow: '0', deny: VIEW.toString() },
    ],
  }
  assert.equal(effectivePerms(g, [ROLE], channel, BOT), SEND)
  // Without the role, Send stays denied.
  assert.equal(effectivePerms(g, [], channel, BOT), 0n)
})

test('missingPerms lists the wanted rights the bot lacks, in table order', () => {
  assert.deepEqual(missingPerms(0n, LOBBY_PERMS), LOBBY_PERMS.map(([name]) => name))
  const all = LOBBY_PERMS.reduce((acc, [, bit]) => acc | bit, 0n)
  assert.deepEqual(missingPerms(all, LOBBY_PERMS), [])
  assert.deepEqual(missingPerms(all & ~32768n, LOBBY_PERMS), ['Attach Files'])
  assert.deepEqual(missingPerms(BRIDGE_PERMS_INTEGER, FOLDER_EXTRA_PERMS), [])
  assert.deepEqual(missingPerms(BRIDGE_PERMS_INTEGER & ~16n, FOLDER_EXTRA_PERMS), ['Manage Channels'])
  assert.equal(BRIDGE_PERMS_INTEGER, 70368744279120n, 'the invite integer: lobby set, Manage Channels, Send Voice Messages')
})
