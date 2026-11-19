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
  withEnv({ STOLIK_SOCKET: undefined, STOLIK_CHANNEL: undefined, STOLIK_ENV_FILE: undefined }, () => {
    assert.deepEqual(tmuxNewSessionArgs('tg-alpha', '/home/u/alpha'), [
      'new-session', '-d', '-s', 'tg-alpha', '-c', '/home/u/alpha',
      '-e', `STOLIK_SOCKET=${SOCKET_PATH}`,
      LAUNCHER,
    ])
  })
})

test('tmuxNewSessionArgs: a non-default router socket also passes STOLIK_CHANNEL=self and its env file', () => {
  const sock = '/run/user/1000/stolik.sock'
  withEnv({ STOLIK_ENV_FILE: '/home/u/.config/stolik.env' }, () => {
    assert.deepEqual(tmuxNewSessionArgs('tg-alpha', '/home/u/alpha', ['--resume', 'x'], sock), [
      'new-session', '-d', '-s', 'tg-alpha', '-c', '/home/u/alpha',
      '-e', `STOLIK_SOCKET=${sock}`,
      '-e', 'STOLIK_CHANNEL=self',
      '-e', 'STOLIK_ENV_FILE=/home/u/.config/stolik.env',
      LAUNCHER, '--resume', 'x',
    ])
  })
})

test('tmuxNewSessionArgs: a non-default socket without an env file adds only the channel flag', () => {
  withEnv({ STOLIK_ENV_FILE: undefined }, () => {
    const args = tmuxNewSessionArgs('tg-alpha', '/home/u/alpha', [], '/srv/tg/router.sock')
    assert.ok(args.includes('STOLIK_CHANNEL=self'))
    assert.equal(args.some((a) => a.startsWith('STOLIK_ENV_FILE=')), false)
    assert.equal(args[args.length - 1], LAUNCHER)
  })
})

test('tmuxNewSessionArgs: the default socket gets no channel flag, whatever the environment says', () => {
  const dflt = defaultSocketPath()
  withEnv({ STOLIK_CHANNEL: undefined, STOLIK_ENV_FILE: '/home/u/.config/stolik.env' }, () => {
    const args = tmuxNewSessionArgs('tg-alpha', '/home/u/alpha', [], dflt)
    assert.equal(args.includes('STOLIK_CHANNEL=self'), false)
    assert.equal(args.some((a) => a.startsWith('STOLIK_ENV_FILE=')), false)
  })
})

test('defaultSocketPath: $XDG_RUNTIME_DIR/stolik.sock', () => {
  assert.equal(defaultSocketPath({ XDG_RUNTIME_DIR: '/run/user/1000' }), '/run/user/1000/stolik.sock')
})
