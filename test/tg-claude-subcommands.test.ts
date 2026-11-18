// bin/tg-claude: subcommands are passed through from `claude --help` (cached, re-read daily), with the fixed list as the
// fallback. Runs the launcher with a fake `claude` on PATH whose --help prints a fixture; the fake counts its --help calls.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const LAUNCHER = join(REPO, 'bin', 'tg-claude')
const CHANNEL_ARGS = ['--dangerously-load-development-channels', 'server:tg-bridge']

// The Commands section of `claude --help`, as the real binary prints it (aliases joined with |, wrapped descriptions).
const HELP = `Usage: claude [options] [command] [prompt]

Options:
  -d, --debug [filter]                  Enable debug mode

Commands:
  agents [options]                      Manage background agents
  attach <id|name>                      Open a background session in this
                                        terminal. <id> is the short id that
                                        \`claude --bg\` prints
  doctor                                Check the health of your Claude Code
                                        installation.
  frobnicate [options] [target]         A subcommand this launcher does not know
  plugin|plugins                        Manage Claude Code plugins
  stop|kill <id>                        Stop a background session.
`

function withHelpClaude(opts: { help: string | null }, fn: (run: (args: string[], env?: Record<string, string>) => string[], dir: string) => void): void {
  const dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.tmp-tgclaude-sub-'))
  try {
    if (opts.help !== null) writeFileSync(join(dir, 'help.txt'), opts.help)
    const helpBody = opts.help !== null ? `cat "${dir}/help.txt"` : 'exit 1'
    writeFileSync(
      join(dir, 'claude'),
      `#!/bin/sh\nif [ "$1" = "--help" ]; then echo x >> "${dir}/helpcalls"; ${helpBody}; fi\nprintf "%s\\n" "$@"\n`,
    )
    chmodSync(join(dir, 'claude'), 0o755)
    const runtime = join(dir, 'runtime')
    mkdirSync(runtime)
    const run = (args: string[], env: Record<string, string> = {}): string[] => {
      const out = execFileSync(LAUNCHER, args, {
        encoding: 'utf8',
        env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, XDG_RUNTIME_DIR: runtime, ...env },
      })
      return out.split('\n').slice(0, -1)
    }
    fn(run, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const helpCalls = (dir: string): number => (existsSync(join(dir, 'helpcalls')) ? readFileSync(join(dir, 'helpcalls'), 'utf8').split('\n').filter(Boolean).length : 0)
const cachePath = (dir: string): string => join(dir, '.local', 'state', 'tg-bridge-v3', 'claude-subcommands')

test('tg-claude: a subcommand listed by claude --help passes through unchanged', () => {
  withHelpClaude({ help: HELP }, (run) => {
    assert.deepEqual(run(['frobnicate', '--x']), ['frobnicate', '--x'])
    assert.deepEqual(run(['agents']), ['agents'])
  })
})

test('tg-claude: an alias in a "a|b" entry passes through for each name', () => {
  withHelpClaude({ help: HELP }, (run) => {
    assert.deepEqual(run(['plugins', 'list']), ['plugins', 'list'])
    assert.deepEqual(run(['kill', 'abc']), ['kill', 'abc'])
  })
})

test('tg-claude: words that are not subcommands, and prompts, still get the channel', () => {
  withHelpClaude({ help: HELP }, (run) => {
    assert.deepEqual(run(['zeta']).slice(0, 2), CHANNEL_ARGS)
    assert.deepEqual(run(['fix the build']).slice(0, 2), CHANNEL_ARGS)
    // Lines in the description column are not names: "terminal." and "prints" are not subcommands.
    assert.deepEqual(run(['terminal.']).slice(0, 2), CHANNEL_ARGS)
    assert.deepEqual(run(['prints']).slice(0, 2), CHANNEL_ARGS)
  })
})

test('tg-claude: the fixed list still passes through when claude --help cannot be read', () => {
  withHelpClaude({ help: null }, (run) => {
    assert.deepEqual(run(['doctor']), ['doctor'])
    assert.deepEqual(run(['setup-token']), ['setup-token'])
    assert.deepEqual(run(['migrate-installer', 'x']), ['migrate-installer', 'x'])
    assert.deepEqual(run(['frobnicate']).slice(0, 2), CHANNEL_ARGS)
  })
})

test('tg-claude: the parsed names are cached, and a fresh cache is not read from claude --help again', () => {
  withHelpClaude({ help: HELP }, (run, dir) => {
    run(['zeta'])
    assert.equal(helpCalls(dir), 1)
    const cached = readFileSync(cachePath(dir), 'utf8').split('\n')
    assert.ok(cached.includes('frobnicate'))
    assert.ok(cached.includes('plugins'))
    assert.ok(cached.includes('kill'))
    assert.equal(cached.includes('terminal.'), false)
    assert.deepEqual(run(['frobnicate']), ['frobnicate'])
    assert.equal(helpCalls(dir), 1, 'the cache is fresh, so no second help call')
  })
})

test('tg-claude: an old cache is refreshed from claude --help', () => {
  withHelpClaude({ help: HELP }, (run, dir) => {
    mkdirSync(join(dir, '.local', 'state', 'tg-bridge-v3'), { recursive: true })
    writeFileSync(cachePath(dir), 'stale-name\n')
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    utimesSync(cachePath(dir), old, old)
    assert.deepEqual(run(['frobnicate']), ['frobnicate'])
    assert.equal(helpCalls(dir), 1)
    assert.ok(readFileSync(cachePath(dir), 'utf8').includes('frobnicate'))
  })
})

test('tg-claude: a fresh cache is used even when claude --help would now fail', () => {
  withHelpClaude({ help: null }, (run, dir) => {
    mkdirSync(join(dir, '.local', 'state', 'tg-bridge-v3'), { recursive: true })
    writeFileSync(cachePath(dir), 'frobnicate\n')
    assert.deepEqual(run(['frobnicate']), ['frobnicate'])
  })
})

test('tg-claude: -p and the version flags are unaffected by the subcommand lookup', () => {
  withHelpClaude({ help: HELP }, (run) => {
    assert.deepEqual(run(['--version']), ['--version'])
    assert.deepEqual(run(['frobnicate', '-p', 'hi']), ['frobnicate', '-p', 'hi'])
    assert.deepEqual(run(['-p', 'hi']), ['-p', 'hi'])
  })
})

test('tg-claude: a failed claude --help is tried once a day, not on every launch', () => {
  withHelpClaude({ help: null }, (run, dir) => {
    assert.deepEqual(run(['zeta']).slice(0, 2), CHANNEL_ARGS)
    assert.deepEqual(run(['zeta']).slice(0, 2), CHANNEL_ARGS)
    assert.equal(helpCalls(dir), 1)
  })
})
