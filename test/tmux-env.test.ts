// The tmux server's launch: systemd-run scope when the user manager answers, the login PATH, a fallback PATH, and one
// read of each probe per process. Every probe and runner is injected, so nothing here starts tmux or talks to systemd.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServerLauncher, fallbackPath, loginPathFrom, resetLaunchWarnings, startTmux, type LaunchDeps } from '../src/adapters/tmux.ts'
import { configureLog, type LogRecord } from '../src/router/log.ts'
import type { TmuxRun } from '../src/adapters/tmux.ts'

const ARGS = ['new-session', '-d', '-s', 'tg-alpha', '-c', '/home/u/alpha', '/repo/bin/tg-claude']

function fakeDeps(over: Partial<LaunchDeps> = {}) {
  const counts = { hasSystemdRun: 0, userManagerUp: 0, loginPath: 0 }
  const deps: LaunchDeps = {
    hasSystemdRun: () => {
      counts.hasSystemdRun++
      return true
    },
    userManagerUp: async () => {
      counts.userManagerUp++
      return true
    },
    loginPath: async () => {
      counts.loginPath++
      return '/home/u/.asdf/shims:/usr/bin'
    },
    ...over,
  }
  return { deps, counts }
}

test('server starts in its own systemd scope with the login PATH when the user manager answers', async () => {
  const { deps } = fakeDeps()
  const launch = createServerLauncher(deps)
  const got = await launch(ARGS)
  const unit = /^--unit=(tg-tmux-[0-9a-f]{8})$/.exec(got.args[5] ?? '')?.[1]
  assert.ok(unit, `a named transient unit: ${got.args.join(' ')}`)
  assert.deepEqual(got, {
    file: 'env',
    args: ['PATH=/home/u/.asdf/shims:/usr/bin', 'systemd-run', '--user', '--scope', '--quiet', `--unit=${unit}`, '--', 'tmux', ...ARGS],
  })
})

test('every scoped start names its own unit, so a leftover unit never makes a later start fail with "already loaded"', async () => {
  const { deps } = fakeDeps()
  const launch = createServerLauncher(deps)
  const units = new Set<string>()
  for (let i = 0; i < 20; i++) {
    const unit = (await launch(ARGS)).args.find((a) => a.startsWith('--unit='))
    assert.ok(unit)
    units.add(unit)
  }
  assert.equal(units.size, 20)
})

test('no systemd-run: plain tmux with the login PATH, and the user manager is not probed', async () => {
  const { deps, counts } = fakeDeps({ hasSystemdRun: () => false })
  assert.deepEqual(await createServerLauncher(deps)(ARGS), {
    file: 'env',
    args: ['PATH=/home/u/.asdf/shims:/usr/bin', 'tmux', ...ARGS],
  })
  assert.equal(counts.userManagerUp, 0)
})

test('systemd-run present but the user manager does not answer: plain tmux', async () => {
  const { deps } = fakeDeps({ userManagerUp: async () => false })
  const args = (await createServerLauncher(deps)(ARGS)).args
  assert.equal(args.includes('systemd-run'), false)
  assert.equal(args[args.length - ARGS.length - 1], 'tmux')
})

test('the probes and the login PATH are read once per process', async () => {
  const { deps, counts } = fakeDeps()
  const launch = createServerLauncher(deps)
  await launch(ARGS)
  await launch(['new-session', '-d', '-s', 'tg-beta'])
  await Promise.all([launch(ARGS), launch(ARGS)])
  assert.deepEqual(counts, { hasSystemdRun: 1, userManagerUp: 1, loginPath: 1 })
})

test('fallbackPath: the unit PATH, then ~/.local/bin and /usr/local/bin, without repeats', () => {
  assert.equal(
    fallbackPath('/opt/node/bin:/usr/bin:/usr/local/bin', '/home/u'),
    '/opt/node/bin:/usr/bin:/usr/local/bin:/home/u/.local/bin',
  )
  assert.equal(fallbackPath(undefined, '/home/u'), '/home/u/.local/bin:/usr/local/bin')
  assert.equal(fallbackPath('/usr/bin::/bin', '/h'), '/usr/bin:/bin:/h/.local/bin:/usr/local/bin')
})

test('loginPathFrom: uses the shell output; falls back when the shell fails or prints nothing', async () => {
  const calls: Array<[string, string[]]> = []
  const ok = async (file: string, args: string[]) => {
    calls.push([file, args])
    return { code: 0, stdout: '/a/bin:/b/bin\n', stderr: '' }
  }
  assert.equal(await loginPathFrom(ok, '/bin/zsh', 'FALLBACK'), '/a/bin:/b/bin')
  assert.deepEqual(calls, [['/bin/zsh', ['-lc', 'printf %s "$PATH"']]])

  const failed = async () => ({ code: 1, stdout: '/x', stderr: 'boom' })
  assert.equal(await loginPathFrom(failed, '/bin/zsh', 'FALLBACK'), 'FALLBACK')

  const timedOut = async () => ({ code: -1, stdout: '', stderr: '' })
  assert.equal(await loginPathFrom(timedOut, '/bin/zsh', 'FALLBACK'), 'FALLBACK')

  const blank = async () => ({ code: 0, stdout: '  \n', stderr: '' })
  assert.equal(await loginPathFrom(blank, '/bin/zsh', 'FALLBACK'), 'FALLBACK')
})

// The warnings of the launch reach the logger's sink (the Logs topic) at warn level. A capture of them, reset per test.
function captureWarnings(): { warnings: LogRecord[]; restore: () => void } {
  const warnings: LogRecord[] = []
  resetLaunchWarnings()
  configureLog({
    file: false,
    sink: (r) => {
      if (r.level === 'warn') warnings.push(r)
    },
  })
  return {
    warnings,
    restore: () => {
      configureLog({ file: true, sink: null })
      resetLaunchWarnings()
    },
  }
}

// A runner for startTmux: the scoped start (systemd-run in argv) fails when `scopeFails`; plain tmux succeeds.
function tmuxRunner(scopeFails: boolean) {
  const starts: string[][] = []
  const run: TmuxRun = async (cmd, args) => {
    if (args[0] === 'has-session') return { code: 1, stdout: '', stderr: '' }
    if (args[0] === 'new-session' || args.includes('new-session')) starts.push([cmd, ...args])
    const scoped = args.includes('systemd-run')
    if (scoped && scopeFails) return { code: 1, stdout: '', stderr: 'Failed to start transient scope unit' }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { run, starts }
}

test('a refused scoped start is tried once more under a new unit name, then falls back to plain tmux', async () => {
  const cap = captureWarnings()
  try {
    const launcher = createServerLauncher(fakeDeps().deps)
    const first = tmuxRunner(true)
    assert.equal(await startTmux('alpha', '/home/u/alpha', [], first.run, null, launcher), 'tg-alpha')
    assert.equal(first.starts.length, 3, 'the scoped start, the scoped retry, then the plain one')
    const [a, b] = [first.starts[0], first.starts[1]]
    assert.equal(a.includes('systemd-run') && b.includes('systemd-run'), true)
    assert.notEqual(a.find((x) => x.startsWith('--unit=')), b.find((x) => x.startsWith('--unit=')), 'the retry has a new unit name')
    assert.equal(first.starts[2].includes('systemd-run'), false)
    assert.equal(first.starts[2].includes('tmux'), true)
    const second = tmuxRunner(true)
    await startTmux('beta', '/home/u/beta', [], second.run, null, launcher)
    assert.equal(cap.warnings.length, 1, 'one warning per process, not per start')
    assert.equal(cap.warnings[0].component, 'tmux')
    assert.match(cap.warnings[0].msg, /systemd-run could not start the tmux server/)
  } finally {
    cap.restore()
  }
})

test('a scoped start that left the session running is not repeated: the start counts as done', async () => {
  const cap = captureWarnings()
  try {
    const launcher = createServerLauncher(fakeDeps().deps)
    const created = new Set<string>()
    const starts: string[][] = []
    const run: TmuxRun = async (cmd, args) => {
      if (args[0] === 'has-session') return { code: created.has(args[2]) ? 0 : 1, stdout: '', stderr: '' }
      if (args.includes('new-session')) starts.push([cmd, ...args])
      if (args.includes('systemd-run')) {
        // The session was made, but the scoped command reported a failure afterwards.
        created.add('=tg-alpha')
        return { code: 1, stdout: '', stderr: 'late error' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    assert.equal(await startTmux('alpha', '/home/u/alpha', [], run, null, launcher), 'tg-alpha')
    assert.equal(starts.length, 1, 'no second start')
    assert.equal(cap.warnings.length, 0)
  } finally {
    cap.restore()
  }
})

test('a scope that works is used: no fallback and no warning', async () => {
  const cap = captureWarnings()
  try {
    const launcher = createServerLauncher(fakeDeps().deps)
    const r = tmuxRunner(false)
    await startTmux('alpha', '/home/u/alpha', [], r.run, null, launcher)
    assert.equal(r.starts.length, 1)
    assert.equal(r.starts[0].includes('systemd-run'), true)
    assert.equal(cap.warnings.length, 0)
  } finally {
    cap.restore()
  }
})

test('no systemd-run on PATH: plain tmux from the start, and the missing piece is warned about once', async () => {
  const cap = captureWarnings()
  try {
    const launcher = createServerLauncher(fakeDeps({ hasSystemdRun: () => false }).deps)
    const r = tmuxRunner(false)
    await startTmux('alpha', '/home/u/alpha', [], r.run, null, launcher)
    await startTmux('beta', '/home/u/beta', [], r.run, null, launcher)
    assert.equal(r.starts.every((argv) => !argv.includes('systemd-run')), true)
    assert.equal(cap.warnings.length, 1)
    assert.match(cap.warnings[0].msg, /systemd-run is not on PATH/)
  } finally {
    cap.restore()
  }
})
