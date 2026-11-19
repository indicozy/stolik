// Remind addon entry point (plan Task 4). Answers /remind, /task and /reminders in General, and fires the due items on the
// one-minute tick (service.ts). Stdout is the protocol channel; logs go to stderr.
import { join } from 'node:path'
import { STATE_DIR } from '../../config.ts'
import { haikuPinning } from '../haiku.ts'
import { startAddon } from '../sdk.ts'
import { runHaiku } from './parse.ts'
import { remindHandlers } from './service.ts'

startAddon((peer) =>
  remindHandlers(peer, {
    now: Date.now,
    path: join(STATE_DIR, 'remind', 'items.json'),
    parse: (prompt) => runHaiku(prompt, haikuPinning()),
  }),
)
