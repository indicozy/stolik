// The owner's desk or away mode, written by `ai-resources desk|away` to ~/.config/ai-resources/mode. Only the word
// "away" means away; a missing or unreadable file means desk (the default).
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ResourceMode } from '../../ports.ts'

export const RESOURCE_MODE_PATH = join(homedir(), '.config', 'ai-resources', 'mode')

export async function readResourceMode(path: string = RESOURCE_MODE_PATH): Promise<ResourceMode> {
  try {
    return (await readFile(path, 'utf8')).trim() === 'away' ? 'away' : 'desk'
  } catch {
    return 'desk'
  }
}
