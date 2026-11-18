import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mlStep } from '../src/cli/setup.ts'

// The ML step is numbered by its place in the setup it belongs to: 5 for Telegram (after the plugin at 4), 6 for Discord
// (after the lobby at 4 and the plugin at 5). The owner says no to every question, so nothing is installed.
async function headerOf(step?: number): Promise<string> {
  const lines: string[] = []
  const deps = { out: (l: string) => lines.push(l), ask: async () => 'n' }
  await (step === undefined ? mlStep(deps as never, {} as never) : mlStep(deps as never, {} as never, step))
  return lines.find((l) => /ML worker/.test(l)) ?? ''
}

test('setup: the ML step is step 5 by default (Telegram) and takes the number it is given (Discord: 6)', async () => {
  assert.match(await headerOf(), /^5\. ML worker \(optional\)\./)
  assert.match(await headerOf(6), /^6\. ML worker \(optional\)\./)
})
