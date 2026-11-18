// tmuxNewSessionArgs: the environment a router-spawned session gets. tmux's server env would win over the router's own,
// so the socket (and, for a non-default router, the self channel) travel as `-e` arguments.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { REPO_DIR, SOCKET_PATH } from '../src/config.ts'
import { defaultSocketPath, tmuxNewSessionArgs } from '../src/adapters/tmux.ts'

function withEnv(over: Record<string, string | undefined>, fn: () => void): void {
  const saved = { ...process.env }
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    fn()
  } finally {
    for (const k of Object.keys(over)) delete process.env[k]
    Object.assign(process.env, saved)
  }
}

const LAUNCHER = join(REPO_DIR, 'bin', 'tg-claude')

test('tmuxNewSessionArgs: always carries the router socket as -e before the launcher', () => {
  withEnv({ TG_BRIDGE_SOCKET: undefined, TG_BRIDGE_CHANNEL: undefined, TG_BRIDGE_ENV_FILE: undefined }, () => {
    assert.deepEqual(tmuxNewSessionArgs('tg-alpha', '/home/u/alpha'), [
      'new-session', '-d', '-s', 'tg-alpha', '-c', '/home/u/alpha',
      '-e', `TG_BRIDGE_SOCKET=${SOCKET_PATH}`,
      LAUNCHER,
    ])
  })
})

test('tmuxNewSessionArgs: a non-default router socket also passes TG_BRIDGE_CHANNEL=self and its env file', () => {
  const sock = '/run/user/1000/tg-bridge-v3.sock'
  withEnv({ TG_BRIDGE_ENV_FILE: '/home/u/.config/tg-bridge-v3.env' }, () => {
    assert.deepEqual(tmuxNewSessionArgs('tg-alpha', '/home/u/alpha', ['--resume', 'x'], sock), [
      'new-session', '-d', '-s', 'tg-alpha', '-c', '/home/u/alpha',
      '-e', `TG_BRIDGE_SOCKET=${sock}`,
      '-e', 'TG_BRIDGE_CHANNEL=self',
      '-e', 'TG_BRIDGE_ENV_FILE=/home/u/.config/tg-bridge-v3.env',
      LAUNCHER, '--resume', 'x',
    ])
  })
})

test('tmuxNewSessionArgs: a non-default socket without an env file adds only the channel flag', () => {
  withEnv({ TG_BRIDGE_ENV_FILE: undefined }, () => {
    const args = tmuxNewSessionArgs('tg-alpha', '/home/u/alpha', [], '/srv/tg/router.sock')
    assert.ok(args.includes('TG_BRIDGE_CHANNEL=self'))
    assert.equal(args.some((a) => a.startsWith('TG_BRIDGE_ENV_FILE=')), false)
    assert.equal(args[args.length - 1], LAUNCHER)
  })
})

test('tmuxNewSessionArgs: the default socket gets no channel flag, whatever the environment says', () => {
  const dflt = defaultSocketPath()
  withEnv({ TG_BRIDGE_CHANNEL: undefined, TG_BRIDGE_ENV_FILE: '/home/u/.config/tg-bridge-v3.env' }, () => {
    const args = tmuxNewSessionArgs('tg-alpha', '/home/u/alpha', [], dflt)
    assert.equal(args.includes('TG_BRIDGE_CHANNEL=self'), false)
    assert.equal(args.some((a) => a.startsWith('TG_BRIDGE_ENV_FILE=')), false)
  })
})

test('defaultSocketPath: $XDG_RUNTIME_DIR/tg-bridge.sock', () => {
  assert.equal(defaultSocketPath({ XDG_RUNTIME_DIR: '/run/user/1000' }), '/run/user/1000/tg-bridge.sock')
})
