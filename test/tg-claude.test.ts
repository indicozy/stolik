// bin/tg-claude, run for real in bash with a fake `claude` on PATH that prints its argv one argument per line.
// Covers the default branch (unchanged) and the self-channel branch (TG_BRIDGE_CHANNEL=self).
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const LAUNCHER = join(REPO, 'bin', 'tg-claude')

// A value of undefined in `env` removes that variable for the run.
type RunEnv = Record<string, string | undefined>

function withFakeClaude(fn: (dir: string, run: (args: string[], env?: RunEnv) => string[]) => void): void {
  const dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.tmp-tgclaude-'))
  try {
    writeFileSync(join(dir, 'claude'), '#!/bin/sh\nprintf "%s\\n" "$@"\n')
    chmodSync(join(dir, 'claude'), 0o755)
    // The launcher asks uname for the OS; FAKE_UNAME (Darwin, Linux) picks the answer.
    writeFileSync(join(dir, 'uname'), '#!/bin/sh\nprintf "%s\\n" "${FAKE_UNAME:-Linux}"\n')
    chmodSync(join(dir, 'uname'), 0o755)
    const runtime = join(dir, 'runtime')
    mkdirSync(runtime)
    const run = (args: string[], env: RunEnv = {}): string[] => {
      const full: RunEnv = { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, XDG_RUNTIME_DIR: runtime, ...env }
      for (const [k, v] of Object.entries(full)) if (v === undefined) delete full[k]
      const out = execFileSync(LAUNCHER, args, { encoding: 'utf8', env: full as Record<string, string> })
      return out.split('\n').slice(0, -1)
    }
    fn(dir, run)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('tg-claude default: loads the user-scope server:tg-bridge, unchanged', () => {
  withFakeClaude((dir, run) => {
    assert.deepEqual(run(['--model', 'haiku']), ['--dangerously-load-development-channels', 'server:tg-bridge', '--model', 'haiku'])
    // The router's default socket is not a reason to switch.
    const defaultSock = join(dir, 'runtime', 'tg-bridge.sock')
    assert.deepEqual(run([], { TG_BRIDGE_SOCKET: defaultSock }).slice(0, 2), ['--dangerously-load-development-channels', 'server:tg-bridge'])
    // TG_BRIDGE_CHANNEL with another value is not the self channel either.
    assert.equal(run([], { TG_BRIDGE_CHANNEL: 'other' })[1], 'server:tg-bridge')
  })
})

test('tg-claude: a non-default TG_BRIDGE_SOCKET alone does not pick the self channel (only TG_BRIDGE_CHANNEL=self does)', () => {
  withFakeClaude((_dir, run) => {
    const argv = run([], { TG_BRIDGE_SOCKET: '/run/user/1000/tg-bridge-v3.sock' })
    assert.deepEqual(argv.slice(0, 2), ['--dangerously-load-development-channels', 'server:tg-bridge'])
  })
})

test('tg-claude self (TG_BRIDGE_CHANNEL=self with a socket): inline mcp config for tg-bridge-v3 only', () => {
  withFakeClaude((_dir, run) => {
    const sock = '/run/user/1000/tg-bridge-v3.sock'
    const argv = run(['--model', 'haiku'], { TG_BRIDGE_CHANNEL: 'self', TG_BRIDGE_SOCKET: sock })
    assert.equal(argv[0], '--mcp-config')
    const cfg = JSON.parse(argv[1])
    assert.deepEqual(Object.keys(cfg.mcpServers), ['tg-bridge-v3'])
    const s = cfg.mcpServers['tg-bridge-v3']
    assert.equal(s.command, join(REPO, 'bin', 'tg-plugin-node'))
    assert.deepEqual(s.args, [join(REPO, 'dist', 'channel.js')])
    assert.deepEqual(s.env, { TG_BRIDGE_SOCKET: sock, MCP_PROTOCOL_NEGOTIATION: 'legacy' })
    assert.deepEqual(argv.slice(2), [
      '--strict-mcp-config', '--dangerously-load-development-channels', 'server:tg-bridge-v3', '--model', 'haiku',
    ])
    assert.equal(argv.includes('server:tg-bridge'), false)
  })
})

test('tg-claude self (TG_BRIDGE_CHANNEL=self, no socket): the channel finds its own default socket', () => {
  withFakeClaude((_dir, run) => {
    const argv = run([], { TG_BRIDGE_CHANNEL: 'self' })
    const s = JSON.parse(argv[1]).mcpServers['tg-bridge-v3']
    assert.deepEqual(s.env, { MCP_PROTOCOL_NEGOTIATION: 'legacy' })
    assert.equal(argv[2], '--strict-mcp-config')
    assert.equal(argv[4], 'server:tg-bridge-v3')
  })
})

test('tg-claude self: JSON-escapes a socket path with quotes and backslashes', () => {
  withFakeClaude((_dir, run) => {
    const sock = '/run/user/1000/odd "name"\\x.sock'
    const s = JSON.parse(run([], { TG_BRIDGE_CHANNEL: 'self', TG_BRIDGE_SOCKET: sock })[1]).mcpServers['tg-bridge-v3']
    assert.equal(s.env.TG_BRIDGE_SOCKET, sock)
  })
})

test('tg-claude self: management and print subcommands still pass through unchanged', () => {
  withFakeClaude((_dir, run) => {
    const env = { TG_BRIDGE_CHANNEL: 'self' }
    assert.deepEqual(run(['mcp', 'list'], env), ['mcp', 'list'])
    assert.deepEqual(run(['-p', 'hi'], env), ['-p', 'hi'])
  })
})

test('tg-claude self: plugin mode is not used on the self branch (the self channel wins)', () => {
  withFakeClaude((_dir, run) => {
    const argv = run([], { TG_BRIDGE_CHANNEL: 'self', TG_BRIDGE_PLUGIN: '1' })
    assert.equal(argv[0], '--mcp-config')
    assert.equal(argv.some((a) => a.startsWith('plugin:')), false)
  })
})

