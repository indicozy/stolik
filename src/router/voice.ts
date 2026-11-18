// Router side of voice messages (plan 3.2, design §4.12): the transcript comes from the voice addon when one is on (else
// the built-in whisper worker, as before), then the text filters (voice cleanup), then the echo with its raw toggle.
// Both versions go to the chat log. The echo's text is then routed like typed text (deliver.ts, inbound.ts).
import type { ButtonPress, Inbound } from '../brain/chat-types.ts'
import type { MessageId } from '../brain/chat-types.ts'
import { echoRows, echoText, type Shown, type VoiceEcho } from './voice-echo.ts'
import { inboundTarget } from './topics.ts'
import type { Router } from './core.ts'

// The echoes of this router's voice messages, by the voice message id, so the raw toggle can show either version. In
// memory: after a restart an old toggle says it expired.
const ECHO_MAX = 200
const echoes = new WeakMap<Router, Map<MessageId, VoiceEcho>>()

function echoMap(router: Router): Map<MessageId, VoiceEcho> {
  let m = echoes.get(router)
  if (!m) {
    m = new Map()
    echoes.set(router, m)
  }
  return m
}

// The names the cleanup may spell as written: session names and trusted project folder names.
export function vocabNames(router: Router): string[] {
  const names = router.registry.list().map((s) => s.name)
  for (const dir of router.agent.trustedFolders()) {
    const base = dir.split('/').filter(Boolean).pop()
    if (base) names.push(base)
  }
  return names
}

// The transcript of a voice file, raw and cleaned. Null when there is no speech. Throws when transcription fails.
export async function transcribeVoice(router: Router, m: Inbound, path: string): Promise<VoiceEcho | null> {
  const media = router.addons ? await router.addons.media({ kind: 'voice', size: m.fileSize ?? 0, mime: 'audio/ogg', path }) : null
  const raw = ((media ? media.text : await router.ml.transcribe(path)) ?? '').trim()
  if (raw === '') return null
  if (!router.addons) return { raw, clean: raw, unpolished: false }
  const cleaned = await router.addons.cleanText(raw, { sessionNames: vocabNames(router) })
  // Unpolished means the cleaner gave up: the raw text is what goes on, marked (design §4.12).
  const clean = cleaned.unpolished ? raw : cleaned.text.trim() || raw
  return { raw, clean, unpolished: cleaned.unpolished }
}

// The raw transcript of a voice message this router echoed, or null (not echoed, or forgotten). Prefixes are read from it.
export function voiceRawTranscript(router: Router, messageId: MessageId): string | null {
  return echoMap(router).get(messageId)?.raw ?? null
}

// Sends the echo (with its toggle when the two versions differ) and remembers it for the toggle.
export async function sendVoiceEcho(router: Router, m: Inbound, echo: VoiceEcho): Promise<void> {
  const map = echoMap(router)
  if (map.size >= ECHO_MAX) map.delete(map.keys().next().value as MessageId)
  map.set(m.messageId, echo)
  await router.chat
    .sendText(echoText(echo, 'clean'), { replyTo: m.messageId, rows: echoRows(m.messageId, echo, 'clean'), ...inboundTarget(router, m) })
    .catch(() => {})
}

// The raw / clean toggle on an echo: edits the echo to show the other version and its button. `c.messageId` is the voice
// message's id, as the echo's button carried it (see echoRows).
export async function onVoiceCallback(router: Router, cb: ButtonPress, c: { messageId: MessageId; show: Shown }): Promise<void> {
  const answer = (t?: string) => router.chat.ackButton(cb.pressId, t).catch(() => {})
  const echo = echoMap(router).get(c.messageId)
  if (!echo || cb.message === null) return answer('Expired.')
  await router.chat.editRows(cb.message, echoText(echo, c.show), echoRows(c.messageId, echo, c.show)).catch(() => {})
  return answer()
}
