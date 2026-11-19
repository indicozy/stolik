// The one-time offer of the built-in addons (addons-host). Posted once: after /bind, and on the first start in DM mode
// when the owner has never chosen a built-in addon. "Enable all" turns them on in dependency order through the same path
// /addons uses (setEnabled, audited the same way), so the consent is recorded identically. An addon the owner chose
// before is never touched by it.
import type { ButtonPress } from '../../brain/chat-types.ts'
import type { BuiltinAddon } from '../../ports.ts'
import { errMsg } from '../log.ts'
import type { Rows } from '../state.ts'
import type { Router } from '../core.ts'
import { sendAddonMenu } from './addons.ts'

export const BUILTIN_BLURBS: Readonly<Record<string, string>> = {
  modes: 'answers quick:, read: and web: questions with a model run',
  notes: 'saves note: messages to your notes inbox',
  'ml-worker': 'runs the local models for voice, voice cleanup and digest',
  voice: 'turns your voice notes into text',
  'voice-cleanup': 'tidies the text of voice notes before it is routed',
  digest: '/digest: a summary of your chat, on request or on a schedule',
  router: 'picks the session or folder for a message that names none',
  'usage-watch': 'a daily check of your Claude usage, sent only when a limit is crossed',
  workers: '/workers: what your Claude sessions, subagents, heavy jobs and GPUs are doing now',
}

// Access fields in a few words each, for one line per addon.
const ACCESS_SHORT: Readonly<Record<string, string>> = {
  'message.text': 'reads your messages',
  'message.audio': 'reads your voice notes',
  'message.files': 'reads your photos and files',
  'sessions.names': 'sees your session names',
  'sessions.read': 'sees your sessions and folders',
  'chatlog.read': 'reads the chat log',
  'sessions.spawn': 'starts sessions',
  'usage.record': 'records run costs',
  'usage.read': 'reads run costs',
}

export const BO_ALL = 'bo:all'
export const BO_CHOOSE = 'bo:choose'

export function parseBuiltinsCallback(data: string): 'all' | 'choose' | null {
  if (data === BO_ALL) return 'all'
  if (data === BO_CHOOSE) return 'choose'
  return null
}

// Built-ins in an order where every addon comes after the addons it requires (ties by name). A cycle keeps its members
// at the end, where the host refuses them with its own reason.
export function enableOrder(list: readonly BuiltinAddon[]): BuiltinAddon[] {
  const byName = new Map(list.map((b) => [b.name, b] as const))
  const out: BuiltinAddon[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (b: BuiltinAddon): void => {
    if (state.has(b.name)) return
    state.set(b.name, 'visiting')
    for (const r of b.requires) {
      const d = byName.get(r)
      if (d && state.get(d.name) !== 'visiting') visit(d)
    }
    state.set(b.name, 'done')
    out.push(b)
  }
  for (const b of [...list].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) visit(b)
  return out
}

// `lobby` is the chat app's name for the lobby (Telegram "General", Discord "the lobby channel").
export function offerText(list: readonly BuiltinAddon[], lobby: string): string {
  const lines = list.map((b) => {
    const what = BUILTIN_BLURBS[b.name] ?? b.provides.join(', ')
    const access = b.access.map((f) => (f === 'messages.send' ? `sends to ${lobby}` : (ACCESS_SHORT[f] ?? f)))
    return `- ${b.name}: ${what}. ${access.length > 0 ? 'Access: ' + access.join('; ') : 'Access: its own requests only'}.`
  })
  return [
    'stolik has built-in addons. Each one is off until you turn it on:',
    ...lines,
    'Choose in /addons turns on only the ones you pick.',
  ].join('\n')
}

// The offer's one button. "Enable all" (BO_ALL) is no longer offered; a tap on an older offer still turns them on.
export function offerRows(): Rows {
  return [[{ text: 'Choose in /addons', data: BO_CHOOSE }]]
}

// Posts the offer once (the store flag records it). `dmStart` (the first start in DM mode) offers only when the owner
// has not chosen a built-in addon before; after /bind the offer is made regardless.
export async function offerBuiltins(router: Router, opts: { dmStart?: boolean } = {}): Promise<void> {
  if (!router.paired) return
  const addons = router.addons
  if (!addons?.builtins || !addons.builtinsOffered || !addons.markBuiltinsOffered) return
  if (addons.builtinsOffered()) return
  const list = addons.builtins()
  if (list.length === 0) return
  if (opts.dmStart && list.some((b) => b.choice)) return
  addons.markBuiltinsOffered()
  await router.chat.sendText(offerText(list, router.chat.capabilities.names.lobby), { rows: offerRows() }).catch((e) => router.logger.log(`builtins offer failed: ${errMsg(e)}`))
}

// The taps on the offer. Owner only (callbacks.ts checks it before this runs).
export async function onBuiltinsCallback(router: Router, cb: ButtonPress, action: 'all' | 'choose'): Promise<void> {
  const answer = (t?: string) => router.chat.ackButton(cb.pressId, t).catch(() => {})
  if (!router.addons?.builtins || !router.addons.setEnabled) return answer('Addons are not set up.')
  if (action === 'choose') {
    if (cb.message !== null) await sendAddonMenu(router, cb.message)
    return answer()
  }
  const addons = router.addons
  const results: string[] = []
  for (const b of enableOrder(addons.builtins?.() ?? [])) {
    if (b.choice && b.enabled) {
      results.push(`${b.name}: on`)
      continue
    }
    if (b.choice) {
      results.push(`${b.name}: left off (you turned it off before)`)
      continue
    }
    const refusal = await addons.setEnabled(b.name, true)
    router.audit.event({ event: 'addon_toggle', addon: b.name, on: true, refused: refusal !== null })
    results.push(refusal === null ? `${b.name}: enabled` : `${b.name}: failed: ${refusal}`)
  }
  if (cb.message !== null) {
    await router.chat
      .editRows(cb.message, ['Built-in addons:', ...results.map((r) => `- ${r}`), 'Turn any of them off in /addons.'].join('\n'), [])
      .catch(() => {})
  }
  return answer('Done.')
}
