// The speech-to-text client: a request that times out kills the worker, so the next request does not queue behind a
// hung job (review finding 9). The worker is a stand-in process that reads stdin and never answers.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Stt } from '../src/adapters/stt.ts'

test('a request that times out kills the worker, and the next request starts a fresh one', { timeout: 15_000 }, async () => {
  const hang = { file: process.execPath, args: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'] }
  const stt = new Stt({ requestTimeoutMs: 200, worker: hang })
  try {
    await assert.rejects(stt.transcribe('/nonexistent/a.ogg'), /timed out/)
    assert.equal((stt as unknown as { child: unknown }).child, null, 'the hung worker is no longer the current one')
  } finally {
    stt.close()
  }
})
