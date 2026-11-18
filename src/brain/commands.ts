// The bot's command menu (plan 2.16). Each name is a router command or `to` (test/help.test.ts checks this). The chat
// adapter sets it on the platform through ChatPort.setCommands.
export const BOT_COMMANDS: ReadonlyArray<{ command: string; description: string }> = [
  { command: 'list', description: 'Live sessions and folders to start one in' },
  { command: 'to', description: 'Send to a session: /to <name> <text>' },
  { command: 'resume', description: 'Continue an ended session' },
  { command: 'usage', description: 'Mode runs, cost and quota pace' },
  { command: 'model', description: 'Model new sessions start with: /model [name|default]' },
  { command: 'addons', description: 'List, enable or disable addons' },
  { command: 'away', description: 'Send everything here' },
  { command: 'here', description: 'Stop messages until you touch the desktop' },
  { command: 'lock', description: 'Ignore all messages until unlocked at the desk' },
  { command: 'debug', description: 'Router status; /debug on [minutes] for debug logs' },
  { command: 'help', description: 'What this bot can do' },
]

// One reader for a typed command (plan 0e decision 8): `/x` as Telegram writes it, or `!x` on the apps that use it. An
// optional `@bot` may follow the word (Telegram's group form). Returns the word as typed (the caller decides the case)
// and the text after it, trimmed; null when the text does not start with a command. `!x` is never a command in a
// forwarded message: the owner forwarded it, it is data. `/x` keeps its old reading in every case.
export type CommandWord = { word: string; arg: string }
const COMMAND_WORD_RE = /^([/!])([A-Za-z]+)(?:@\S+)?(?:\s+([\s\S]*))?$/

export function parseCommandWord(text: string, forwarded = false): CommandWord | null {
  const m = COMMAND_WORD_RE.exec(text.trim())
  if (!m) return null
  if (m[1] === '!' && forwarded) return null
  return { word: m[2], arg: (m[3] ?? '').trim() }
}
