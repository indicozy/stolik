// macOS platform facts (plan P4). Parsers run on fixture text; no command is run, so this passes on Linux too.
// UNVERIFIED on a real Mac: the fixtures are the output shapes the plan names, not captured output.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseHidIdleMs,
  parseKernBoottime,
  parsePsComm,
  parsePsLine,
  parseScreenLocked,
  walkClaudePid,
} from '../src/adapters/platform/macos.ts'
import { createPlatform, presenceSource } from '../src/adapters/platform/index.ts'

test('parsePsLine: lstart, ppid and argv from `ps -o lstart=,ppid=,args=`; padded days parse', () => {
  const p = parsePsLine('Sat Nov 14 10:31:02 2026     4000 /Users/u/.local/bin/claude --resume abc\n')
  assert.deepEqual(p, {
    startedAt: new Date(2026, 10, 14, 10, 31, 2).getTime(),
    ppid: 4000,
    args: ['/Users/u/.local/bin/claude', '--resume', 'abc'],
  })
  const padded = parsePsLine('Mon Nov  4 09:00:00 2026      1 /sbin/launchd')
  assert.equal(padded?.startedAt, new Date(2026, 10, 4, 9, 0, 0).getTime())
  assert.deepEqual(padded?.args, ['/sbin/launchd'])
  assert.equal(parsePsLine(''), null)
  assert.equal(parsePsLine('garbage line'), null)
})

test('parsePsComm: ppid and the executable path (spaces allowed); callers take the basename', () => {
  assert.deepEqual(parsePsComm('  4000 /Applications/Some App/claude\n'), { ppid: 4000, comm: '/Applications/Some App/claude' })
  assert.deepEqual(parsePsComm('1 /sbin/launchd'), { ppid: 1, comm: '/sbin/launchd' })
  assert.equal(parsePsComm('x y'), null)
})

test('parseKernBoottime: seconds from `sysctl -n kern.boottime`', () => {
  assert.equal(parseKernBoottime('{ sec = 1794600000, usec = 123456 } Sat Nov 14 10:00:00 2026\n'), 1794600000)
  assert.equal(parseKernBoottime('no boot time here'), null)
})

test('parseHidIdleMs: HIDIdleTime is nanoseconds; the result is whole milliseconds', () => {
  const ioreg = [
    '+-o IOHIDSystem  <class IOHIDSystem>',
    '    {',
    '      "IOClass" = "IOHIDSystem"',
    '      "HIDIdleTime" = 4315218000',
    '    }',
  ].join('\n')
  assert.equal(parseHidIdleMs(ioreg), 4315)
  assert.equal(parseHidIdleMs('"HIDIdleTime" = 0'), 0)
  assert.equal(parseHidIdleMs('nothing'), null)
})

test('parseScreenLocked: CGSSessionScreenIsLocked = Yes means locked; No or absent means not', () => {
  assert.equal(parseScreenLocked('"CGSSessionScreenIsLocked" = Yes'), true)
  assert.equal(parseScreenLocked('"CGSSessionScreenIsLocked" = No'), false)
  assert.equal(parseScreenLocked('{ "IOConsoleUsers" = () }'), false)
})

test('walkClaudePid: first ancestor whose name or argv[0] basename is claude; null when none within the hops', () => {
  const table: Record<number, { ppid: number; names: string[] }> = {
    300: { ppid: 200, names: ['/bin/zsh', '-zsh'] },
    200: { ppid: 100, names: ['/opt/homebrew/bin/claude', '2.1.325'] },
    100: { ppid: 1, names: ['/sbin/tmux', ''] },
  }
  assert.equal(walkClaudePid(300, (pid) => table[pid] ?? null), 200)
  // Found through argv[0] when the executable name is a version number (native installs).
  assert.equal(walkClaudePid(100, (pid) => ({ 100: { ppid: 1, names: ['2.1.325', '/x/claude'] } })[pid] ?? null), 100)
  assert.equal(walkClaudePid(300, (pid) => (pid === 300 ? { ppid: 1, names: ['/bin/zsh'] } : null)), null)
  assert.equal(walkClaudePid(300, () => null), null)
  // Limit: a long chain of non-claude ancestors stops at maxHops.
  assert.equal(walkClaudePid(5000, (pid) => ({ ppid: pid - 1, names: ['zsh'] }), 3), null)
})

test('presence: macOS always gets its own source, whatever the presence config names', () => {
  assert.equal(presenceSource({ presence: 'logind' }, {}, 'darwin').name, 'macos')
  assert.equal(presenceSource({ presence: 'x11' }, {}, 'darwin').name, 'macos')
  assert.equal(presenceSource({ presence: 'x11' }, {}, 'linux').name, 'x11')
})

test('platform port on macOS: no CPU pinning (no-op, no taskset call)', () => {
  const port = createPlatform({ presence: 'logind' }, {}, 'darwin')
  assert.doesNotThrow(() => port.pinCpus([8, 9]))
  const u = port.uptimeSeconds()
  assert.ok(u === null || (typeof u === 'number' && u >= 0))
})
