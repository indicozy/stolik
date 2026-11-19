// Test fixture: a small addon for the host tests. Answers each request line with one reply line.
// Ops: echo (returns what it received), split (one reply in three writes), joined (junk line and reply in one write),
// sleep (never answers), crash (exits), stderr (writes to stderr, then answers), plus the six point ops.
import { createInterface } from 'node:readline'

const NAME = process.env.STOLIK_ADDON ?? 'addon-echo'
const out = (s) => process.stdout.write(s)
const reply = (id, result) => JSON.stringify({ id, result }) + '\n'

createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line)
  const { id, op, payload = {} } = req
  switch (op) {
    case 'sleep':
      return
    case 'crash':
      process.exit(3)
      return
    case 'split': {
      const s = reply(id, { op, received: payload })
      out(s.slice(0, 5))
      setTimeout(() => out(s.slice(5, 12)), 10)
      setTimeout(() => out(s.slice(12)), 20)
      return
    }
    case 'joined':
      out('this line is not a reply\n' + reply(id, { op, received: payload }))
      return
    case 'stderr':
      process.stderr.write('a line for stderr\n')
      out(reply(id, { op }))
      return
    case 'media':
      return out(reply(id, { text: `spoken by ${NAME}` }))
    case 'text-filter':
      return out(reply(id, { text: `${payload.text}|${NAME}` }))
    case 'prefix':
      return out(reply(id, { reply: `echo: ${payload.text}` }))
    case 'command':
      return out(reply(id, { reply: `cmd ${payload.command}: ${payload.text}` }))
    case 'route':
      return out(reply(id, { scores: Object.fromEntries((payload.sessionNames ?? []).map((n) => [n, 0.5])) }))
    case 'tick':
    case 'event':
      return out(reply(id, null))
    default:
      return out(reply(id, { op, received: payload }))
  }
})
