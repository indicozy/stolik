// The one-shot Haiku call the addons make (remind's parse, the workers summary): `claude -p` with no tools, no MCP and no
// session file. Its argv is pinned by the machine config (nice and cpuAffinity, see pinned in config.ts), so a machine
// without pinning runs it unpinned.
import { currentTgConfig, pinned, type TgConfig } from '../config.ts'

export const HAIKU_ARGS = [
  '-p', '--model', 'haiku', '--output-format', 'text', '--max-turns', '1',
  '--tools', '', '--strict-mcp-config', '--no-session-persistence',
]

export function haikuCommand(cfg: Pick<TgConfig, 'nice' | 'cpuAffinity'>): { file: string; args: string[] } {
  return pinned(cfg, 'claude', HAIKU_ARGS)
}

// The pinning in force now. A config that cannot be read means no pinning (the call still runs, and never throws).
export function haikuPinning(): Pick<TgConfig, 'nice' | 'cpuAffinity'> {
  try {
    const c = currentTgConfig()
    return { nice: c.nice, cpuAffinity: c.cpuAffinity }
  } catch {
    return { nice: null, cpuAffinity: null }
  }
}
