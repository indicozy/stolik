// The router's voice path (plan 3.2): a voice note becomes the echo (clean text with a raw toggle), both versions go to
// the chat log, and the toggle edits the echo. Fake addons port and fake Telegram (no files are downloaded).
import './helpers/isolate.ts'
import { tgMsg } from '../src/adapters/chat/tg-ids.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatLine } from '../src/brain/chatlog.ts'
import type { AddonInfo, AddonsPort, ChatLogPort } from '../src/ports.ts'
import { OWNER, harness } from './helpers/fakes.ts'

class RecordingLog implements ChatLogPort {
  readonly lines: ChatLine[] = []
  append(line: ChatLine): void {
    this.lines.push(line)
  }
  attachmentPath(): null {
    return null
  }
  recentExchanges(): ChatLine[] {
    return []
  }
}

// A voice addon and a cleanup addon, as fakes: the raw text, and what the cleanup makes of it.
class VoiceAddons implements AddonsPort {
  private readonly raw: string
  private readonly cleaned: { text: string; unpolished: boolean }

  constructor(raw: string, cleaned: { text: string; unpolished: boolean }) {
    this.raw = raw
    this.cleaned = cleaned
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  list(): AddonInfo[] {
    return []
  }
  async setEnabled(): Promise<string | null> {
    return null
  }
  async general(): Promise<string | null> {
    return null
  }
  async media(): Promise<{ addon: string; text: string }> {
    return { addon: 'voice', text: this.raw }
  }
  async cleanText(): Promise<{ text: string; unpolished: boolean }> {
    return this.cleaned
  }
}

const VOICE = {
  kind: 'voice' as const,
  messageId: tgMsg(77),
  text: '',
  replyToId: null,
  forwarded: false,
  from: 'owner',
  fromId: OWNER,
  fileRef: 'file-1',
  fileSize: 4000,
}

function voiceHarness(addons: AddonsPort) {
  const log = new RecordingLog()
  const h = harness({ chatLog: log, addons })
  // The voice file is not downloaded in tests: the addon gets a path, which is all it needs.
  h.chat.download = async () => {}
  return { ...h, log }
}

test('voice: the echo shows the clean text with a raw button, and both versions go to the chat log', async () => {
  const h = voiceHarness(new VoiceAddons('um so the the meeting is at four', { text: 'So the meeting is at four.', unpolished: false }))
  await h.router.start()
  await h.chat.inbound(VOICE)
  const echo = h.chat.sent.find((s) => s.text.startsWith('🎙'))
  assert.ok(echo, 'an echo was sent')
  assert.equal(echo.text, '🎙 "So the meeting is at four."')
  assert.deepEqual(echo.opts?.rows, [[{ text: 'raw', data: 'vt:tg:77:raw' }]])
  const line = h.log.lines.find((l) => l.dir === 'in')
  assert.equal(line?.text, 'So the meeting is at four.')
  assert.equal(line?.raw, 'um so the the meeting is at four')
})

test('voice: the raw button edits the echo to the raw text, and the clean button goes back', async () => {
  const h = voiceHarness(new VoiceAddons('um so the the meeting', { text: 'So the meeting.', unpolished: false }))
  await h.router.start()
  await h.chat.inbound(VOICE)
  const echo = h.chat.sent.find((s) => s.text.startsWith('🎙'))
  assert.ok(echo)
  await h.chat.callback({ pressId: 'cb-1', data: 'vt:tg:77:raw', message: echo.id, from: OWNER })
  const raw = h.chat.rowEdits.at(-1)
  assert.equal(raw?.text, '🎙 "um so the the meeting"')
  assert.deepEqual(raw?.rows, [[{ text: 'clean', data: 'vt:tg:77:clean' }]])
  await h.chat.callback({ pressId: 'cb-2', data: 'vt:tg:77:clean', message: echo.id, from: OWNER })
  assert.equal(h.chat.rowEdits.at(-1)?.text, '🎙 "So the meeting."')
})

test('voice: an unpolished cleanup shows the raw text marked, with no button', async () => {
  const h = voiceHarness(new VoiceAddons('uh hello', { text: 'uh hello', unpolished: true }))
  await h.router.start()
  await h.chat.inbound(VOICE)
  const echo = h.chat.sent.find((s) => s.text.startsWith('🎙'))
  assert.equal(echo?.text, '🎙 "uh hello" (unpolished)')
  assert.deepEqual(echo?.opts?.rows, [])
})

test('voice: a toggle on an echo the router does not remember says it expired', async () => {
  const h = voiceHarness(new VoiceAddons('x', { text: 'x', unpolished: false }))
  await h.router.start()
  await h.chat.callback({ pressId: 'cb-9', data: 'vt:tg:999:raw', message: tgMsg(5), from: OWNER })
  assert.deepEqual(h.chat.answers.at(-1), { id: 'cb-9', text: 'Expired.' })
})
