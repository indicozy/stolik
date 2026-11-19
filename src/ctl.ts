// stolik-ctl: local kill switch. Talks to the router over its unix socket (bin/stolik-ctl wraps this).
// Usage: stolik-ctl lock|unlock|status
import { oneShot } from './adapters/channel/ipc.ts'

const cmd = process.argv[2]
if (cmd !== 'lock' && cmd !== 'unlock' && cmd !== 'status') {
  process.stderr.write('usage: stolik-ctl lock|unlock|status\n')
  process.exit(2)
}

const reply = await oneShot({ t: 'ctl', cmd }, 5000)
if (!reply || reply.t !== 'ctl_result') {
  process.stderr.write('stolik-ctl: the router is not running or not reachable\n')
  process.exit(1)
}
if (!reply.ok) {
  process.stderr.write(`stolik-ctl: ${reply.error ?? 'failed'}\n`)
  process.exit(1)
}
process.stdout.write(reply.locked ? 'locked\n' : 'unlocked\n')
