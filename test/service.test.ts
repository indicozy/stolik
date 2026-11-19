// Service templates (plan P3): the systemd unit text, the LaunchAgent plist (checked as XML by python3 plistlib when
// present), argument parsing, and runService with a fake `run` in a temp HOME. Nothing here touches the real systemd
// or launchd: every command goes through the fake.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  labelFor,
  parseServiceArgs,
  plistFilePath,
  renderLaunchAgentPlist,
  renderSystemdUnit,
  runService,
  unitFilePath,
  type RunResult,
  type ServiceDeps,
} from '../src/cli/service.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const NODE = '/home/u/.asdf/installs/nodejs/22.13.0/bin/node'
const SCRIPT = '/home/u/Documents/projects/stolik/dist/router/main.js'

test('systemd unit: default config gives the base unit (no CPU or nice lines, logind has no DISPLAY)', () => {
  const text = renderSystemdUnit({ nodePath: NODE, scriptPath: SCRIPT, presence: 'logind', cpuAffinity: null, nice: null })
  assert.equal(
    text,
    [
      '[Unit]',
      'Description=stolik Telegram router for Claude Code',
      'StartLimitIntervalSec=600',
      'StartLimitBurst=5',
      '',
      '[Service]',
      `ExecStart="${NODE}" "${SCRIPT}"`,
      `Environment="PATH=${dirname(NODE)}:%h/.local/bin:/usr/local/bin:/usr/bin"`,
      'KillMode=process',
      'Restart=always',
      'RestartSec=3',
      'RestartPreventExitStatus=78 75',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n'),
  )
})

test('systemd unit: no After= on user units; the PATH keeps ~/.local/bin where tg-claude lives', () => {
  const text = renderSystemdUnit({ nodePath: NODE, scriptPath: SCRIPT, presence: 'logind', cpuAffinity: null, nice: null })
  assert.equal(text.split('\n').some((l) => l.startsWith('After=')), false)
  assert.ok(text.includes('%h/.local/bin'))
})

test('systemd unit: CPUAffinity, Nice and DISPLAY appear only when configured', () => {
  const text = renderSystemdUnit({ nodePath: NODE, scriptPath: SCRIPT, presence: 'x11', cpuAffinity: '8-19', nice: 19 })
  const lines = text.split('\n')
  assert.ok(lines.includes('Environment=DISPLAY=:0'))
  assert.ok(lines.includes('CPUAffinity=8-19'))
  assert.ok(lines.includes('Nice=19'))
  assert.equal(lines.filter((l) => l.startsWith('CPUAffinity=')).length, 1)
})

test('systemd unit: ExecStart is the absolute node path; percent signs are escaped, %h kept for the PATH', () => {
  const text = renderSystemdUnit({ nodePath: '/opt/50%/node', scriptPath: '/r/dist/router/main.js', presence: 'logind', cpuAffinity: null, nice: null })
  assert.ok(text.includes('ExecStart="/opt/50%%/node" "/r/dist/router/main.js"'))
  assert.ok(text.includes('Environment="PATH=/opt/50%%:%h/.local/bin'))
})

test('LaunchAgent plist: program arguments, PATH, log file, KeepAlive; Nice only when set; XML escaped', () => {
  const base = {
    label: labelFor('router'),
    nodePath: '/opt/homebrew/bin/node',
    scriptPath: '/Users/u/stolik/dist/router/main.js',
    pathValue: '/opt/homebrew/bin:/usr/bin',
    logPath: '/Users/u/Library/Logs/stolik.log',
    nice: null,
  }
  const text = renderLaunchAgentPlist(base)
  assert.match(text, /<key>Label<\/key>\n  <string>com\.stolik\.router<\/string>/)
  assert.match(text, /<key>ProgramArguments<\/key>\n  <array>\n    <string>\/opt\/homebrew\/bin\/node<\/string>\n    <string>\/Users\/u\/stolik\/dist\/router\/main\.js<\/string>/)
  assert.match(text, /<key>KeepAlive<\/key>\n  <true\/>/)
  assert.match(text, /<key>RunAtLoad<\/key>\n  <true\/>/)
  assert.equal(text.includes('<key>Nice</key>'), false)
  const niced = renderLaunchAgentPlist({ ...base, nodePath: '/a&b/node', nice: 19 })
  assert.ok(niced.includes('<string>/a&amp;b/node</string>'))
  assert.match(niced, /<key>Nice<\/key>\n  <integer>19<\/integer>/)
})

test('LaunchAgent plist parses as a property list (python3 plistlib), when python3 is present', (t) => {
  const py = spawnSync('python3', ['-c', 'import plistlib,sys; print(plistlib.loads(sys.stdin.buffer.read())["Label"])'], {
    input: renderLaunchAgentPlist({
      label: 'com.stolik.router',
      nodePath: '/a&b/node',
      scriptPath: '/s/main.js',
      pathValue: '/bin',
      logPath: '/l.log',
      nice: 19,
    }),
    encoding: 'utf8',
  })
  if (py.error) return t.skip('python3 not available')
  assert.equal(py.status, 0, py.stderr)
  assert.equal(py.stdout.trim(), 'com.stolik.router')
})

test('parseServiceArgs: actions, --name, --start and --stop only where they apply', () => {
  assert.deepEqual(parseServiceArgs(['install', '--start']), { action: 'install', name: null, start: true, stop: false })
  assert.deepEqual(parseServiceArgs(['install', '--name', 'stolik-v2']), { action: 'install', name: 'stolik-v2', start: false, stop: false })
  assert.deepEqual(parseServiceArgs(['uninstall', '--name=x', '--stop']), { action: 'uninstall', name: 'x', start: false, stop: true })
  assert.deepEqual(parseServiceArgs(['status']), { action: 'status', name: null, start: false, stop: false })
  assert.equal(typeof parseServiceArgs(['start']), 'string')
  assert.equal(typeof parseServiceArgs(['install', '--name', '../evil']), 'string')
  assert.equal(typeof parseServiceArgs(['install', '--bogus']), 'string')
  assert.equal(typeof parseServiceArgs(['status', '--start']), 'string')
  assert.equal(typeof parseServiceArgs(['install', '--stop']), 'string')
})

test('path helpers: unit under XDG_CONFIG_HOME when absolute, else ~/.config; plist under ~/Library/LaunchAgents', () => {
  assert.equal(unitFilePath('/h', 'stolik'), '/h/.config/systemd/user/stolik.service')
  assert.equal(unitFilePath('/h', 'stolik', '/x'), '/x/systemd/user/stolik.service')
  assert.equal(unitFilePath('/h', 'stolik', 'rel'), '/h/.config/systemd/user/stolik.service')
  assert.equal(plistFilePath('/h', labelFor('router')), '/h/Library/LaunchAgents/com.stolik.router.plist')
})

// ---- runService with a fake run ----

type Call = { file: string; args: string[] }

function withHome(fn: (home: string, deps: (over: Partial<ServiceDeps>) => ServiceDeps, calls: Call[], out: string[]) => void): void {
  const home = mkdtempSync(join(HERE, '.tmp-service-'))
  const scriptDir = join(home, 'repo', 'dist', 'router')
  mkdirSync(scriptDir, { recursive: true })
  writeFileSync(join(scriptDir, 'main.js'), '')
  const script = join(home, 'repo', 'dist', 'router', 'main.js')
  const calls: Call[] = []
  const out: string[] = []
  const make = (over: Partial<ServiceDeps>): ServiceDeps => ({
    platform: 'linux',
    home,
    xdgConfigHome: undefined,
    uid: 501,
    nodePath: NODE,
    scriptPath: script,
    presence: 'logind',
    cpuAffinity: '8-19',
    nice: 19,
    exists: (p) => existsSync(p),
    out: (l) => out.push(l),
    err: (l) => out.push('ERR ' + l),
    run: (file, args): RunResult => {
      calls.push({ file, args })
      return { status: 0, stdout: '', stderr: '' }
    },
    ...over,
  })
  try {
    fn(home, make, calls, out)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('linux install without --start: writes the unit, runs no systemctl', () => {
  withHome((home, make, calls) => {
    const code = runService({ action: 'install', name: null, start: false, stop: false }, make({}))
    assert.equal(code, 0)
    const file = join(home, '.config', 'systemd', 'user', 'stolik.service')
    assert.equal(readFileSync(file, 'utf8').includes('CPUAffinity=8-19'), true)
    assert.equal(calls.length, 0)
  })
})

test('linux install --start on a stopped unit: daemon-reload, then enable --now the named unit', () => {
  withHome((home, make, calls) => {
    // is-active exits 3 when the unit is not active
    const run = (file: string, args: string[]): RunResult => {
      calls.push({ file, args })
      return { status: args[1] === 'is-active' ? 3 : 0, stdout: '', stderr: '' }
    }
    assert.equal(runService({ action: 'install', name: 'stolik', start: true, stop: false }, make({ run })), 0)
    assert.ok(existsSync(join(home, '.config', 'systemd', 'user', 'stolik.service')))
    assert.deepEqual(calls, [
      { file: 'systemctl', args: ['--user', 'daemon-reload'] },
      { file: 'systemctl', args: ['--user', 'is-active', '--quiet', 'stolik.service'] },
      { file: 'systemctl', args: ['--user', 'enable', '--now', 'stolik.service'] },
    ])
  })
})

test('linux install --start on a running unit: daemon-reload, then restart so the new unit applies', () => {
  withHome((_home, make, calls) => {
    assert.equal(runService({ action: 'install', name: null, start: true, stop: false }, make({})), 0)
    assert.deepEqual(calls, [
      { file: 'systemctl', args: ['--user', 'daemon-reload'] },
      { file: 'systemctl', args: ['--user', 'is-active', '--quiet', 'stolik.service'] },
      { file: 'systemctl', args: ['--user', 'restart', 'stolik.service'] },
    ])
  })
})

test('linux install --start stops with exit 1 when restart fails', () => {
  withHome((_home, make, _calls, out) => {
    const run = (_f: string, args: string[]): RunResult =>
      args[1] === 'restart' ? { status: 1, stdout: '', stderr: 'Job failed' } : { status: 0, stdout: '', stderr: '' }
    assert.equal(runService({ action: 'install', name: null, start: true, stop: false }, make({ run })), 1)
    assert.ok(out.includes('ERR Job failed'))
  })
})

test('linux install refuses when the router is not built, and writes nothing', () => {
  withHome((home, make, calls, out) => {
    const code = runService({ action: 'install', name: null, start: true, stop: false }, make({ scriptPath: join(home, 'nope.js') }))
    assert.equal(code, 1)
    assert.ok(out.some((l) => /run npm run build first/.test(l)))
    assert.equal(existsSync(join(home, '.config', 'systemd')), false)
    assert.equal(calls.length, 0)
  })
})

test('linux uninstall: plain disables and reloads (running unit keeps running); --stop uses disable --now', () => {
  withHome((home, make, calls) => {
    runService({ action: 'install', name: null, start: false, stop: false }, make({}))
    const file = join(home, '.config', 'systemd', 'user', 'stolik.service')
    assert.equal(runService({ action: 'uninstall', name: null, start: false, stop: false }, make({})), 0)
    assert.equal(existsSync(file), false)
    assert.deepEqual(calls, [
      { file: 'systemctl', args: ['--user', 'disable', 'stolik.service'] },
      { file: 'systemctl', args: ['--user', 'daemon-reload'] },
    ])
    runService({ action: 'install', name: null, start: false, stop: false }, make({}))
    calls.length = 0
    assert.equal(runService({ action: 'uninstall', name: null, start: false, stop: true }, make({})), 0)
    assert.deepEqual(calls, [
      { file: 'systemctl', args: ['--user', 'disable', '--now', 'stolik.service'] },
      { file: 'systemctl', args: ['--user', 'daemon-reload'] },
    ])
  })
})

test('linux uninstall still removes the file when disable fails (unit not loaded)', () => {
  withHome((home, make, _calls, out) => {
    runService({ action: 'install', name: null, start: false, stop: false }, make({}))
    const run = (): RunResult => ({ status: 1, stdout: '', stderr: 'No such file' })
    assert.equal(runService({ action: 'uninstall', name: null, start: false, stop: false }, make({ run })), 0)
    assert.equal(existsSync(join(home, '.config', 'systemd', 'user', 'stolik.service')), false)
    assert.ok(out.some((l) => /note: No such file/.test(l)))
  })
})

test('linux status only reads: show, no changes', () => {
  withHome((_home, make, calls) => {
    runService({ action: 'status', name: null, start: false, stop: false }, make({}))
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].args.slice(0, 2), ['--user', 'show'])
  })
})

test('macOS install --start on a loaded agent: print, bootout, enable, then bootstrap the plist into the gui domain', () => {
  withHome((home, make, calls) => {
    const deps = make({ platform: 'darwin', uid: 501 })
    assert.equal(runService({ action: 'install', name: null, start: true, stop: false }, deps), 0)
    const plist = join(home, 'Library', 'LaunchAgents', 'com.stolik.router.plist')
    assert.ok(existsSync(plist))
    const text = readFileSync(plist, 'utf8')
    assert.ok(text.includes(`<string>${NODE}</string>`))
    assert.ok(text.includes('<key>Nice</key>'))
    assert.deepEqual(calls, [
      { file: 'launchctl', args: ['print', 'gui/501/com.stolik.router'] },
      { file: 'launchctl', args: ['bootout', 'gui/501/com.stolik.router'] },
      { file: 'launchctl', args: ['enable', 'gui/501/com.stolik.router'] },
      { file: 'launchctl', args: ['bootstrap', 'gui/501', plist] },
    ])
  })
})

test('macOS install --start on an agent that is not loaded: no bootout, just enable and bootstrap', () => {
  withHome((_home, make, calls) => {
    const run = (file: string, args: string[]): RunResult => {
      calls.push({ file, args })
      return { status: args[0] === 'print' ? 113 : 0, stdout: '', stderr: '' }
    }
    assert.equal(runService({ action: 'install', name: null, start: true, stop: false }, make({ platform: 'darwin', uid: 501, run })), 0)
    assert.deepEqual(
      calls.map((c) => c.args[0]),
      ['print', 'enable', 'bootstrap'],
    )
    assert.equal(calls.some((c) => c.args[0] === 'bootout'), false)
  })
})

test('macOS install without --start only writes the plist; uninstall disables, --stop also boots it out', () => {
  withHome((home, make, calls) => {
    runService({ action: 'install', name: null, start: false, stop: false }, make({ platform: 'darwin' }))
    assert.equal(calls.length, 0)
    const plist = join(home, 'Library', 'LaunchAgents', 'com.stolik.router.plist')
    assert.ok(existsSync(plist))
    assert.equal(runService({ action: 'uninstall', name: null, start: false, stop: false }, make({ platform: 'darwin' })), 0)
    assert.equal(existsSync(plist), false)
    assert.deepEqual(calls, [{ file: 'launchctl', args: ['disable', 'gui/501/com.stolik.router'] }])
    calls.length = 0
    runService({ action: 'install', name: null, start: false, stop: false }, make({ platform: 'darwin' }))
    calls.length = 0
    assert.equal(runService({ action: 'uninstall', name: null, start: false, stop: true }, make({ platform: 'darwin' })), 0)
    assert.deepEqual(calls, [
      { file: 'launchctl', args: ['bootout', 'gui/501/com.stolik.router'] },
      { file: 'launchctl', args: ['disable', 'gui/501/com.stolik.router'] },
    ])
  })
})

test('other platforms are refused', () => {
  withHome((_home, make, calls, out) => {
    assert.equal(runService({ action: 'install', name: null, start: true, stop: false }, make({ platform: 'win32' })), 1)
    assert.ok(out.some((l) => /supports Linux .* and macOS/.test(l)))
    assert.equal(calls.length, 0)
  })
})
