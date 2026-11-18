// The words a chat app shows the owner (plan 0e decision 9): the app's name, what the lobby, the home and a thread are
// called there, and the sigil a command starts with. Telegram's values give today's text byte for byte; the brain takes
// them from the port's capabilities, so no platform word is written into the brain's own strings.
import type { Capabilities } from './chat-types.ts'

export type Words = { app: string; lobby: string; home: string; thread: string; sigil: string }

export function words(caps: Capabilities): Words {
  return { app: caps.displayName, lobby: caps.names.lobby, home: caps.names.home, thread: caps.names.thread, sigil: caps.commandSigil }
}

// A word with its first letter capitalised, for a sentence start ("Topics:").
export function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
