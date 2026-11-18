// Child process of test/discord-lazy.test.ts: builds the router for one chat app (no start, no network) and exits.
// argv[2] is 'telegram' or 'discord'.
import { buildRouter } from '../../src/app.ts'
import type { Config } from '../../src/config.ts'

const discord = process.argv[2] === 'discord'
const cfg: Config = discord
  ? { token: 'DISCORD-PROBE-TOKEN', chatId: '', ownerUserId: null, discord: { ownerUserId: '800000000000000001', homeId: null } }
  : { token: '123456:PROBE-TOKEN', chatId: '', ownerUserId: null }
await buildRouter(cfg)
process.stdout.write('built\n')
process.exit(0)
