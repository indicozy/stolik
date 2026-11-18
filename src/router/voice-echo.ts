// The voice echo in Telegram (plan 3.2, design §4.12). `🎙 "<text>"` is the clean transcript; a button shows the raw one
// and back. When cleanup gave up (unpolished), the raw text is shown and marked, and there is nothing to toggle. The
// router owns the echo: no addon sees it (protocol 2).
import type { MessageId } from '../brain/chat-types.ts'
import type { Rows } from './state.ts'

export type VoiceEcho = { raw: string; clean: string; unpolished: boolean }
export type Shown = 'clean' | 'raw'

// Callback data `vt:<message id>:raw|clean`. The message id is the opaque string the host gave the echoed voice message.
export const VOICE_CALLBACK_RE = /^vt:(.+):(raw|clean)$/

export function parseVoiceCallback(data: string): { messageId: MessageId; show: Shown } | null {
  const m = VOICE_CALLBACK_RE.exec(data)
  return m ? { messageId: m[1] as MessageId, show: m[2] as Shown } : null
}

// The text a message shows for one of its two versions.
export function echoShown(e: VoiceEcho, show: Shown): string {
  return e.unpolished ? e.raw : show === 'clean' ? e.clean : e.raw
}

export function echoText(e: VoiceEcho, show: Shown): string {
  return `🎙 "${echoShown(e, show)}"${e.unpolished ? ' (unpolished)' : ''}`
}

// One button that switches to the other version; none when there is only one to show.
export function echoRows(messageId: MessageId, e: VoiceEcho, show: Shown): Rows {
  if (e.unpolished || e.clean === e.raw) return []
  const other: Shown = show === 'clean' ? 'raw' : 'clean'
  return [[{ text: other, data: `vt:${messageId}:${other}` }]]
}
