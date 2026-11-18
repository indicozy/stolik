import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Discord, routeDispatch, type DiscordClient } from '../src/adapters/chat/discord.ts'

// One dispatch listener on the gateway, whatever the number of events the adapter listens to (the adapter registers 11).
const DISPATCH = 'dispatch'

test('routeDispatch: one listener on the gateway; handlers run by event name, in registration order', () => {
  const gateway = new EventEmitter()
  const on = routeDispatch(gateway, DISPATCH)
  const seen: string[] = []
  on('MESSAGE_CREATE', (d) => seen.push(`a:${(d as { id: string }).id}`))
  on('MESSAGE_CREATE', (d) => seen.push(`b:${(d as { id: string }).id}`))
  on('GUILD_CREATE', () => seen.push('guild'))
  assert.equal(gateway.listenerCount(DISPATCH), 1)
  gateway.emit(DISPATCH, { t: 'MESSAGE_CREATE', d: { id: '7' } })
  gateway.emit(DISPATCH, { t: 'UNKNOWN', d: {} })
  gateway.emit(DISPATCH, { t: 'GUILD_CREATE', d: {} })
  assert.deepEqual(seen, ['a:7', 'b:7', 'guild'])
})

test('the Discord adapter registers at most 10 dispatch listeners at start (one, through routeDispatch)', () => {
  const gateway = new EventEmitter()
  const client = {
    rest: {},
    gateway: { on: routeDispatch(gateway, DISPATCH), connect: async () => {}, destroy: async () => {} },
  } as unknown as DiscordClient
  new Discord(client, {})
  assert.ok(gateway.listenerCount(DISPATCH) <= 10, `${gateway.listenerCount(DISPATCH)} dispatch listeners`)
  assert.equal(gateway.listenerCount(DISPATCH), 1)
})
