// Voice addon (plan 3.2): a media addon. A voice note's file goes to the ml-worker addon's transcribe op; the raw transcript
// comes back. The router then runs the text filters (voice cleanup), echoes the result and routes it as typed text.
import { startAddon } from '../sdk.ts'

const TRANSCRIBE_TIMEOUT_MS = 110_000

startAddon((peer) => ({
  media: async (payload) => {
    const audioPath = payload.audioPath
    if (typeof audioPath !== 'string' || audioPath === '') throw new Error('media needs audioPath')
    const r = (await peer.call('ml-worker', 'transcribe', { audioPath }, TRANSCRIBE_TIMEOUT_MS)) as { text?: unknown } | null
    if (typeof r?.text !== 'string') throw new Error('ml-worker gave no text')
    return { text: r.text }
  },
}))
