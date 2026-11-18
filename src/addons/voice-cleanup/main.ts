// Voice-cleanup addon (plan 3.3): a text filter. The router runs it on a voice transcript only. It asks the ml-worker
// addon to clean the text with the vocabulary, then applies the guard. Any failure keeps the raw text, marked unpolished.
// There is no hosted fallback.
import { startAddon } from '../sdk.ts'
import { guardClean, vocabulary } from './clean.ts'

startAddon((peer) => ({
  'text-filter': async (payload) => {
    const text = typeof payload.text === 'string' ? payload.text : ''
    const vocab = vocabulary(payload.sessionNames, payload.words)
    try {
      const r = (await peer.call('ml-worker', 'clean', { text, vocab })) as { text?: unknown } | null
      if (typeof r?.text !== 'string') throw new Error('ml-worker gave no text')
      return guardClean(text, r.text)
    } catch (e) {
      process.stderr.write(`voice-cleanup: ${e instanceof Error ? e.message : String(e)}\n`)
      return { text, unpolished: true }
    }
  },
}))
