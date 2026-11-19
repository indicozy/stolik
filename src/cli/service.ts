// `stolik service install | uninstall | status` (plan P3, design §5.1). Writes the user-level service definition:
// a systemd --user unit on Linux, a LaunchAgent plist on macOS (plan P4). The renderers are pure templates (unit tests
// compare their output). Nothing is loaded or started unless --start is given. uninstall disables the unit (so it does
// not come back at logon) and stops it only with --stop.
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from './setup.ts'
import { NPX_SERVICE_MESSAGE, isNpxInstall } from './install-location.ts'

export const DEFAULT_UNIT = 'stolik'
// macOS label is com.stolik.<name>; the default name keeps the plist path com.stolik.router.plist.
export const DEFAULT_MAC_NAME = 'router'
export const LABEL_PREFIX = 'com.stolik.'

export type Presence = 'x11' | 'logind'

// Everything a template needs. Paths are absolute. cpuAffinity and nice come from config.json (null = not set).
export type ServiceInput = {
  nodePath: string
  scriptPath: string
  presence: Presence
  cpuAffinity: string | null
  nice: number | null
}

// A systemd unit value: quoted, with backslash and double quote escaped.
function systemdQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

// Doubles % so systemd does not read it as a specifier (absolute paths only; %h is written on purpose).
function escapeSpecifiers(s: string): string {
  return s.replace(/%/g, '%%')
}

// PATH entries for the router: its own node's folder (so `node` is found), ~/.local/bin (claude), then the system dirs.
export function systemdPathValue(nodePath: string): string {
  const entries = [dirname(nodePath), '%h/.local/bin', '/usr/local/bin', '/usr/bin']
  return entries.map((e) => (e.startsWith('%h') ? e : escapeSpecifiers(e))).join(':')
}

// The systemd --user unit (replaces systemd/stolik.service, which keeps its values as the example).
export function renderSystemdUnit(i: ServiceInput): string {
  const lines = [
    '[Unit]',
    'Description=stolik Telegram router for Claude Code',
    // No After=: user units have no network-online.target, and the router retries its connections itself.
    'StartLimitIntervalSec=600',
    'StartLimitBurst=5',
    '',
    '[Service]',
    `ExecStart=${systemdQuote(escapeSpecifiers(i.nodePath))} ${systemdQuote(escapeSpecifiers(i.scriptPath))}`,
    `Environment=${systemdQuote('PATH=' + systemdPathValue(i.nodePath))}`,
  ]
  if (i.presence === 'x11') lines.push('Environment=DISPLAY=:0')
  // CPUAffinity and Nice apply to the router only: the tmux server is started in its own scope (see tmux.ts).
  if (i.cpuAffinity !== null) lines.push(`CPUAffinity=${i.cpuAffinity}`)
  if (i.nice !== null) lines.push(`Nice=${i.nice}`)
  // KillMode=process: a router restart must not kill the tmux sessions and the Claude Code sessions in them.
  // Exit 78 (config error) and 75 (another router is running) are not retried.
  lines.push(
    'KillMode=process',
    'Restart=always',
    'RestartSec=3',
    'RestartPreventExitStatus=78 75',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  )
  return lines.join('\n')
}

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

// PATH for the LaunchAgent: node's folder, ~/.local/bin, Homebrew (Apple silicon and Intel), then the system dirs.
export function macPathValue(nodePath: string, home: string): string {
  return [dirname(nodePath), `${home}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':')
}

export type PlistInput = {
  label: string
  nodePath: string
  scriptPath: string
  pathValue: string
  logPath: string
  nice: number | null
}

// The LaunchAgent plist (~/Library/LaunchAgents/<label>.plist). Starts at logon and is kept alive, like the systemd unit.
export function renderLaunchAgentPlist(i: PlistInput): string {
  const str = (s: string) => `<string>${xmlEscape(s)}</string>`
  const entries: Array<[string, string]> = [
    ['Label', str(i.label)],
    ['ProgramArguments', `<array>\n    ${str(i.nodePath)}\n    ${str(i.scriptPath)}\n  </array>`],
    ['EnvironmentVariables', `<dict>\n    <key>PATH</key>\n    ${str(i.pathValue)}\n  </dict>`],
    ['RunAtLoad', '<true/>'],
    ['KeepAlive', '<true/>'],
    ['ThrottleInterval', '<integer>3</integer>'],
    ['StandardOutPath', str(i.logPath)],
    ['StandardErrorPath', str(i.logPath)],
  ]
  if (i.nice !== null) entries.push(['Nice', `<integer>${i.nice}</integer>`])
  const body = entries.map(([k, v]) => `  <key>${k}</key>\n  ${v}`).join('\n')
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n<dict>\n' +
    body +
    '\n</dict>\n</plist>\n'
  )
}

export function unitFilePath(home: string, name: string, xdgConfigHome?: string): string {
  const base = xdgConfigHome && xdgConfigHome.startsWith('/') ? xdgConfigHome : join(home, '.config')
  return join(base, 'systemd', 'user', `${name}.service`)
}

export function labelFor(name: string): string {
  return LABEL_PREFIX + name
}

export function plistFilePath(home: string, label: string): string {
  return join(home, 'Library', 'LaunchAgents', `${label}.plist`)
}

export type ServiceAction = 'install' | 'uninstall' | 'status'
export type ServiceArgs = { action: ServiceAction; name: string | null; start: boolean; stop: boolean }

// Parses `install|uninstall|status [--name N] [--start | --stop]`. Returns an error message as a string when bad.
export function parseServiceArgs(args: string[]): ServiceArgs | string {
  const [action, ...rest] = args
  if (action !== 'install' && action !== 'uninstall' && action !== 'status') {
    return 'usage: stolik service install [--name N] [--start] | uninstall [--name N] [--stop] | status [--name N]'
  }
  const out: ServiceArgs = { action, name: null, start: false, stop: false }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--start') out.start = true
    else if (a === '--stop') out.stop = true
    else if (a === '--name' || a.startsWith('--name=')) {
      const value = a === '--name' ? rest[++i] : a.slice('--name='.length)
      if (!value || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) return '--name needs a plain name such as stolik'
      out.name = value
    } else return `unknown option: ${a}`
  }
  if (out.start && action !== 'install') return '--start only applies to install'
  if (out.stop && action !== 'uninstall') return '--stop only applies to uninstall'
  return out
}

export type RunResult = { status: number | null; stdout: string; stderr: string }

export type ServiceDeps = {
  platform: NodeJS.Platform
  home: string
  xdgConfigHome: string | undefined
  uid: number
  // The node and the router script to run (<repo>/dist/router/main.js).
  nodePath: string
  scriptPath: string
  presence: Presence
  cpuAffinity: string | null
  nice: number | null
  exists(path: string): boolean
  out(line: string): void
  err(line: string): void
  run(file: string, args: string[]): RunResult
}

function report(deps: ServiceDeps, r: RunResult): boolean {
  if (r.status === 0) return true
  const msg = (r.stderr || r.stdout).trim() || `exit ${r.status}`
  deps.err(msg)
  return false
}

function linuxService(args: ServiceArgs, deps: ServiceDeps): number {
  const name = args.name ?? DEFAULT_UNIT
  const unit = `${name}.service`
  const file = unitFilePath(deps.home, name, deps.xdgConfigHome)
  const systemctl = (...a: string[]) => deps.run('systemctl', ['--user', ...a])

  if (args.action === 'install') {
    if (!deps.exists(deps.scriptPath)) {
      deps.err(`${deps.scriptPath} is missing: run npm run build first`)
      return 1
    }
    const text = renderSystemdUnit({
      nodePath: deps.nodePath,
      scriptPath: deps.scriptPath,
      presence: deps.presence,
      cpuAffinity: deps.cpuAffinity,
      nice: deps.nice,
    })
    writeFileAtomic(file, text, 0o644)
    deps.out(`wrote ${file}`)
    if (!args.start) {
      deps.out(`not started. Run: systemctl --user daemon-reload && systemctl --user enable --now ${unit}  (or add --start)`)
      return 0
    }
    if (!report(deps, systemctl('daemon-reload'))) return 1
    // A running unit keeps its old definition until it restarts, so restart it; otherwise enable and start it.
    const active = systemctl('is-active', '--quiet', unit).status === 0
    if (active) {
      if (!report(deps, systemctl('restart', unit))) return 1
      deps.out(`restarted ${unit} with the new definition`)
    } else {
      if (!report(deps, systemctl('enable', '--now', unit))) return 1
      deps.out(`started ${unit}`)
    }
    return 0
  }

  if (args.action === 'uninstall') {
    // Not being loaded is not an error for uninstall, so these only print a note.
    const r = args.stop ? systemctl('disable', '--now', unit) : systemctl('disable', unit)
    if (r.status !== 0) deps.out(`note: ${(r.stderr || r.stdout).trim() || 'not loaded'}`)
    if (deps.exists(file)) {
      rmSync(file)
      deps.out(`removed ${file}`)
    } else deps.out(`no unit file at ${file}`)
    systemctl('daemon-reload')
    if (!args.stop) deps.out(`unit ${unit} still runs if it was running; add --stop to stop it now`)
    return 0
  }

  deps.out(`unit file: ${file} (${deps.exists(file) ? 'present' : 'missing'})`)
  const r = systemctl('show', unit, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'UnitFileState', '-p', 'MainPID')
  deps.out((r.stdout || r.stderr).trim())
  return 0
}

function macService(args: ServiceArgs, deps: ServiceDeps): number {
  const name = args.name ?? DEFAULT_MAC_NAME
  const label = labelFor(name)
  const file = plistFilePath(deps.home, label)
  const domain = `gui/${deps.uid}`
  const target = `${domain}/${label}`
  const launchctl = (...a: string[]) => deps.run('launchctl', a)

  if (args.action === 'install') {
    if (!deps.exists(deps.scriptPath)) {
      deps.err(`${deps.scriptPath} is missing: run npm run build first`)
      return 1
    }
    const text = renderLaunchAgentPlist({
      label,
      nodePath: deps.nodePath,
      scriptPath: deps.scriptPath,
      pathValue: macPathValue(deps.nodePath, deps.home),
      logPath: join(deps.home, 'Library', 'Logs', 'stolik.log'),
      nice: deps.nice,
    })
    mkdirSync(join(deps.home, 'Library', 'Logs'), { recursive: true })
    writeFileAtomic(file, text, 0o644)
    deps.out(`wrote ${file}`)
    if (!args.start) {
      deps.out(`not loaded. Run: launchctl bootstrap ${domain} ${file}  (or add --start)`)
      return 0
    }
    // A loaded copy is booted out first so the new plist is read; then it is enabled (a disabled agent does not load)
    // and bootstrapped.
    if (launchctl('print', target).status === 0) launchctl('bootout', target)
    launchctl('enable', target)
    if (!report(deps, launchctl('bootstrap', domain, file))) return 1
    deps.out(`loaded ${label}`)
    return 0
  }

  if (args.action === 'uninstall') {
    // Disable keeps it from loading at logon (the macOS counterpart of systemctl disable); bootout stops it now.
    if (args.stop) {
      const r = launchctl('bootout', target)
      if (r.status !== 0) deps.out(`note: ${(r.stderr || r.stdout).trim() || 'not loaded'}`)
    }
    const d = launchctl('disable', target)
    if (d.status !== 0) deps.out(`note: ${(d.stderr || d.stdout).trim() || 'could not disable'}`)
    if (deps.exists(file)) {
      rmSync(file)
      deps.out(`removed ${file}`)
    } else deps.out(`no plist at ${file}`)
    return 0
  }

  deps.out(`plist: ${file} (${deps.exists(file) ? 'present' : 'missing'})`)
  const r = launchctl('print', target)
  if (r.status !== 0) deps.out(`${label}: not loaded`)
  else {
    const keep = r.stdout.split('\n').filter((l) => /\b(state|pid|last exit code) =/.test(l))
    deps.out(`${label}: loaded`)
    for (const l of keep) deps.out(l.trim())
  }
  return 0
}

// Runs one service action. Returns the exit code.
export function runService(args: ServiceArgs, deps: ServiceDeps): number {
  if (args.action === 'install' && isNpxInstall(deps.scriptPath)) {
    deps.err(NPX_SERVICE_MESSAGE)
    return 1
  }
  if (deps.platform === 'linux') return linuxService(args, deps)
  if (deps.platform === 'darwin') return macService(args, deps)
  deps.err('stolik service supports Linux (systemd --user) and macOS (LaunchAgent) only')
  return 1
}
