// Spawn forensics (design §Observability): when a router-started session fails to start, a text file with what the start
// used is written under <stateDir>/forensics/, and the failure message and the Logs topic name it. Values of secrets are
// never written: the environment is recorded by variable name, with PATH as the one value.
import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { redact } from '../brain/common.ts'
import { buildForensics, forensicsFileName } from '../brain/observe.ts'
import { emit, errMsg } from './log.ts'

export type ForensicsRequest = {
  project: string
  // The folder the session was to start in.
  cwd: string
  // The command line of the start (tmux new-session, with the launcher and its arguments).
  argv: string[]
  tmuxName: string | null
  // The last lines of the pane, as the caller has them (empty when the session is gone).
  pane: string[]
  reason: string
}

export type ForensicsDeps = {
  // The forensics folder (<stateDir>/forensics).
  dir: string
  now: () => Date
  // Redacted from every line written.
  secrets: string[]
  env: NodeJS.ProcessEnv
  // `claude --version` (null when it cannot be run).
  claudeVersion: () => Promise<string | null>
}

// Writes the file and returns its path, or null when it could not be written (the start is reported either way).
export async function writeForensics(deps: ForensicsDeps, req: ForensicsRequest): Promise<string | null> {
  try {
    const ts = deps.now().toISOString()
    const version = await deps.claudeVersion().catch(() => null)
    const text = buildForensics({
      ts,
      project: req.project,
      cwd: req.cwd,
      argv: req.argv,
      tmuxName: req.tmuxName,
      envNames: Object.keys(deps.env).sort(),
      path: deps.env.PATH,
      pane: req.pane,
      claudeVersion: version,
      reason: req.reason,
    })
    mkdirSync(deps.dir, { recursive: true, mode: 0o700 })
    const file = join(deps.dir, forensicsFileName(ts, req.project))
    writeFileSync(file, redact(text, deps.secrets), { mode: 0o600 })
    return file
  } catch (e) {
    emit('error', 'spawn', `forensics not written: ${errMsg(e)}`, { project: req.project })
    return null
  }
}

// `claude --version`, first line, or null. Bounded to 10 s.
export function claudeVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('claude', ['--version'], { timeout: 10_000 }, (err, stdout) => {
      if (err) return resolve(null)
      const line = String(stdout).split('\n').find((l) => l.trim() !== '')
      resolve(line ? line.trim().slice(0, 200) : null)
    })
  })
}
