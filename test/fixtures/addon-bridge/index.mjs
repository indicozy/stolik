// Test fixture for the requests and buttons (protocol 2: ids are strings): the addon asks the host to send, tries a request it did not
// declare, answers a reply and a callback. Host requests carry `op`; host replies to the addon's requests do not.
import { createInterface } from 'node:readline'

let seq = 5000
const pending = new Map()
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const ask = (op, payload) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    out({ id, op, payload })
  })

createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line)
  if (m.op === undefined) {
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    if ('error' in m) p.reject(new Error(m.error))
    else p.resolve(m.result)
    return
  }
  const { id, op, payload = {} } = m
  try {
    if (op === 'prefix' && payload.text === 'spawn') {
      try {
        await ask('spawn', { dir: '/x', prompt: 'p', messageId: payload.messageId })
        return out({ id, result: { reply: 'spawned' } })
      } catch (e) {
        return out({ id, result: { reply: `error: ${e.message}` } })
      }
    }
    if (op === 'prefix') {
      const r = await ask('send', { text: 'hello', replyTo: payload.messageId })
      return out({ id, result: { reply: `sent ${r.messageIds[0]}` } })
    }
    if (op === 'reply') return out({ id, result: { handled: payload.replyTo === 'tg:5' } })
    if (op === 'callback') return out({ id, result: { toast: `got ${payload.data}` } })
    return out({ id, error: `no ${op}` })
  } catch (e) {
    out({ id, error: String(e.message) })
  }
})
