// `/workers` (plan 3.7): the command returns at once and the report is collected in the background, as /usagecheck does.
// If collection is still running after 3 s, "Collecting…" is sent first; then the report, or `workers failed: <reason>`.
// Sent to General with the host's send request (the host redacts it). Pure apart from the peer and the build function it
// is given, so the flow test can drive it through a fake host.
import type { AddonPeer, Handler } from '../sdk.ts'

export const COLLECTING_NOTE_MS = 3_000
export const COLLECTING_TEXT = 'Collecting…'

const log = (msg: string): void => {
  process.stderr.write(`workers: ${msg}\n`)
}

export function workersHandlers(peer: AddonPeer, build: () => Promise<string>, noteMs = COLLECTING_NOTE_MS): Record<string, Handler> {
  const send = (text: string): Promise<unknown> => peer.request('send', { text })
  const run = async (): Promise<void> => {
    const note = setTimeout(() => {
      send(COLLECTING_TEXT).catch((e: unknown) => log(`note not sent: ${e instanceof Error ? e.message : String(e)}`))
    }, noteMs)
    let text: string
    try {
      text = await build()
    } catch (e) {
      text = `workers failed: ${e instanceof Error ? e.message : String(e)}`
    } finally {
      clearTimeout(note)
    }
    await send(text).catch((e: unknown) => log(`report not sent: ${e instanceof Error ? e.message : String(e)}`))
  }
  return {
    command: async () => {
      void run()
      return { handled: true }
    },
  }
}
