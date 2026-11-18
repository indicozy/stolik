// Test fixture: a stand-in for the ml-worker addon. Ops: transcribe (text names the file), clean (vocabulary and text,
// or an error for the text FAIL, or an empty answer for EMPTY), and sleep (never answers).
import { createInterface } from 'node:readline'
import { basename } from 'node:path'

const out = (s) => process.stdout.write(s)
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, op, payload = {} } = JSON.parse(line)
  switch (op) {
    case 'transcribe':
      return out(JSON.stringify({ id, result: { text: `heard ${basename(String(payload.audioPath))}`, device: 'cpu', secs: 0 } }) + '\n')
    case 'clean': {
      if (payload.text === 'FAIL') return out(JSON.stringify({ id, error: 'model crashed' }) + '\n')
      const vocab = Array.isArray(payload.vocab) ? payload.vocab.join(',') : ''
      const text = payload.text === 'EMPTY' ? '' : `clean(${payload.text})[${vocab}]`
      return out(JSON.stringify({ id, result: { text, device: 'cpu', secs: 0 } }) + '\n')
    }
    case 'sleep':
      return
    default:
      return out(JSON.stringify({ id, error: `ml-fake does not handle ${op}` }) + '\n')
  }
})
