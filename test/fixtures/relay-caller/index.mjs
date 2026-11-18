// Test fixture: an addon that calls ml-fake through the host, the way voice and voice-cleanup do (plan 3.1).
// Ops: media (transcribe via ml-fake), text-filter (clean via ml-fake, with the vocabulary the host sends),
// forbidden (calls an addon it does not require), and reply (answers with what it got back from a call).
import { createInterface } from 'node:readline'

const out = (s) => process.stdout.write(s)
let seq = 0
const waiting = new Map()

function call(addon, op, payload) {
  const id = ++seq
  out(JSON.stringify({ id, request: 'call', addon, op, payload, timeoutMs: 5000 }) + '\n')
  return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }))
}

function answer(id, body) {
  out(JSON.stringify({ id, ...body }) + '\n')
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  const msg = JSON.parse(line)
  if (typeof msg.op !== 'string') {
    // A reply to one of our calls.
    const w = waiting.get(msg.id)
    if (!w) return
    waiting.delete(msg.id)
    if (typeof msg.error === 'string') w.reject(new Error(msg.error))
    else w.resolve(msg.result)
    return
  }
  const { id, op, payload = {} } = msg
  try {
    if (op === 'media') {
      const r = await call('ml-fake', 'transcribe', { audioPath: payload.audioPath })
      return answer(id, { result: { text: r.text } })
    }
    if (op === 'text-filter') {
      const vocab = [...(payload.sessionNames ?? []), ...(payload.words ?? [])]
      const r = await call('ml-fake', 'clean', { text: payload.text, vocab })
      return answer(id, { result: { text: r.text, unpolished: r.text === '' || payload.text === 'FAIL' } })
    }
    if (op === 'forbidden') {
      await call('not-required', 'transcribe', { audioPath: '/x' })
      return answer(id, { result: 'should not happen' })
    }
    return answer(id, { error: `relay-caller does not handle ${op}` })
  } catch (e) {
    // The real voice-cleanup addon turns its own failure into an unpolished reply (plan 3.3).
    if (op === 'text-filter') return answer(id, { result: { text: payload.text, unpolished: true } })
    return answer(id, { error: e instanceof Error ? e.message : String(e) })
  }
})
