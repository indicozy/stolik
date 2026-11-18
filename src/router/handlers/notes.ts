// Router "note" messages: saved to the notes inbox, with attachments.
import { join } from 'node:path'
import type { Inbound } from '../../brain/chat-types.ts'
import { errMsg } from '../log.ts'
import { attachmentFileName, formatNoteEntry, type NoteAttachment } from '../notes.ts'
import { logOutgoing, say, traceInbound } from '../send.ts'
import { MAX_INBOUND_BYTES, type Prepared } from '../shared.ts'
import { isImagePath, sanitizeFileName } from '../state.ts'
import type { Router } from '../core.ts'
import type { MessageId } from '../../brain/chat-types.ts'
import { hasDbNumber, idFileStem, toDbId } from '../../adapters/store-ids.ts'

// The notes addon (src/addons/notes) takes a "note" message when it is installed and enabled. Its reply goes to General.
// Null when no addon claims the word: the core saves the note (the fallback, so nothing is lost before the addon exists).
// The file of the message is downloaded only when an addon has claimed it.
export async function noteViaAddon(router: Router, m: Inbound, prepared?: Prepared): Promise<string | null> {
  if (!router.addons) return null
  const text = prepared ? prepared.body : m.text
  try {
    return await router.addons.general(text, m.messageId, () => noteFile(router, m))
  } catch (e) {
    return `note not saved: ${errMsg(e)}`
  }
}

// The local file of a note's media: a voice note was downloaded for transcription; a photo or file is downloaded now,
// into the Telegram inbox folder of the message (the notes addon copies it to its attachments).
async function noteFile(router: Router, m: Inbound): Promise<{ filePath: string; kind: string } | null> {
  if (m.kind === 'text') return null
  if (m.fileSize !== undefined && m.fileSize > MAX_INBOUND_BYTES) throw new Error('File is over the 20 MB Bot API limit')
  if (m.kind === 'voice') {
    const path = voiceInboxPath(router, m)
    if (router.platform.fileInfo(path) === null) await router.chat.download(m.fileRef ?? '', path, MAX_INBOUND_BYTES)
    return { filePath: path, kind: 'voice' }
  }
  const name = m.kind === 'photo' ? 'photo.jpg' : sanitizeFileName(m.fileName ?? `${m.kind}.bin`)
  const dest = join(inboxDir(router, m), `${msgStem(m.messageId)}_${name}`)
  await router.chat.download(m.fileRef ?? '', dest, MAX_INBOUND_BYTES)
  return { filePath: dest, kind: m.kind }
}

// A "note" message is saved to NOTES_DIR. Nothing is sent to a session, and it works with no session live.
export async function saveNote(router: Router, m: Inbound, text: string): Promise<void> {
  if (m.kind === 'text' && text === '') return say(router, 'Nothing to save after "note".', m.messageId)
  const now = router.clock.date()
  const attachments: NoteAttachment[] = []
  if (m.kind !== 'text') {
    const att = await saveNoteAttachment(router, m, now)
    if (!att) return
    attachments.push(att)
  }
  try {
    router.store.appendNote(formatNoteEntry(now, text, attachments))
  } catch (e) {
    return say(router, `note not saved: ${errMsg(e)}`, m.messageId)
  }
  router.audit.event({ event: 'note', length: text.length, kind: m.kind })
  traceInbound(router, m.messageId, { target: { type: 'note', name: 'inbox' } })
  await router.chat
    .sendText('📝 saved', { replyTo: m.messageId, silent: true })
    .then((id) => logOutgoing(router, { kind: 'notice', text: '📝 saved', tg_message_id: id }))
    .catch((e) => router.logger.log(`note reply failed: ${errMsg(e)}`))
}

// The number that names a message's files in the inbox and attachments ("<n>_<name>"): the store's number for it.
// Ids of other platforms have no number: their file stem is the id made file-safe (store-ids idFileStem).
function msgStem(id: MessageId): string {
  return hasDbNumber(id) ? String(toDbId(id)) : idFileStem(id)
}

// Where media of one Telegram message is downloaded (see mediaBody).
export function inboxDir(router: Router, m: Inbound): string {
  return router.store.inboxPath(msgStem(m.messageId))
}

export function voiceInboxPath(router: Router, m: Inbound): string {
  return join(inboxDir(router, m), `${msgStem(m.messageId)}_voice.oga`)
}

// Copies a voice message's .oga from the inbox (it was downloaded for transcription), or downloads the file.
// Null when it failed; the user is told why.
export async function saveNoteAttachment(router: Router, m: Inbound, now: Date): Promise<NoteAttachment | null> {
  if (m.fileSize !== undefined && m.fileSize > MAX_INBOUND_BYTES) {
    await say(router, 'File is over the 20 MB Bot API limit; note not saved.', m.messageId)
    return null
  }
  const name = m.kind === 'photo' ? 'photo.jpg' : m.kind === 'voice' ? 'voice.oga' : sanitizeFileName(m.fileName ?? `${m.kind}.bin`)
  try {
    let file = attachmentFileName(now, name)
    if (router.store.attachmentExists(file)) file = attachmentFileName(now, `${msgStem(m.messageId)}_${name}`)
    if (m.kind === 'voice' && router.platform.fileInfo(voiceInboxPath(router, m)) !== null) await router.store.saveAttachment(voiceInboxPath(router, m), file)
    else await router.chat.download(m.fileRef ?? '', router.store.attachmentPath(file), MAX_INBOUND_BYTES)
    return {
      path: `attachments/${file}`,
      label: m.kind === 'photo' ? 'photo' : name,
      image: m.kind === 'photo' || isImagePath(name),
    }
  } catch (e) {
    await say(router, `note not saved: ${errMsg(e)}`, m.messageId)
    return null
  }
}
