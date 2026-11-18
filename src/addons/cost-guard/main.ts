// cost-guard addon entry point. Holds a Telegram message to a session whose prompt cache has expired (the gate point), and
// answers the buttons on the notice. Stdout is the protocol channel; logs go to stderr only.
import { homedir } from 'node:os'
import { startAddon } from '../sdk.ts'
import { makeGuard } from './guard.ts'

startAddon((peer) => {
  const guard = makeGuard({
    host: peer,
    now: () => Date.now(),
    home: homedir(),
    log: (msg) => process.stderr.write(`${msg}\n`),
  })
  return {
    gate: (payload) => guard.gate(payload),
    callback: (payload) => guard.callback(payload),
  }
})
