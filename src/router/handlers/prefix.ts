// Router prefixes in General (design §4.3): "to <session>:" delivers to a session, "note:" saves to the notes inbox.
// new starts a session (route.ts). quick, read and web go to the modes addon through its prefix dispatch. Inside a
// session topic nothing is parsed (ticket 07), so this is only called for General messages.
import type { Inbound } from '../../brain/chat-types.ts'
import { matchName, type Prefix } from '../../brain/prefixes.ts'
import { deliver, prepare } from '../deliver.ts'
import { say, traceInbound } from '../send.ts'
import type { Prepared } from '../shared.ts'
import { liveSummary, type Session } from '../state.ts'
import { noteViaAddon, saveNote } from './notes.ts'
import { askWhich, runModeText, startNewFromPrefix } from './route.ts'
import type { Router } from '../core.ts'

export const TO_USAGE = 'Usage: to <name>: <text>. <name> is a session name (see /list).'

export async function runPrefix(router: Router, p: Prefix, m: Inbound, prepared?: Prepared): Promise<void> {
  switch (p.kind) {
    case 'note': {
      // The notes addon answers when it is enabled; otherwise the core saves the note (the fallback).
      const reply = await noteViaAddon(router, m, prepared)
      if (reply !== null) {
        traceInbound(router, m.messageId, { target: { type: 'note', name: 'inbox' } })
        return say(router, reply, m.messageId)
      }
      return saveNote(router, m, p.body)
    }
    case 'to':
      return runTo(router, p.name, p.body, m, prepared)
    case 'new':
      return startNewFromPrefix(router, p.name, p.body, m, prepared)
    case 'quick':
    case 'read':
    case 'web':
      return runModeText(router, p.kind, p.body, m)
  }
}

// Delivers the body to the one session the name matches. Several matches show the "Who is this for?" buttons; none is an
// error that lists the live sessions.
async function runTo(router: Router, name: string | undefined, body: string, m: Inbound, prepared?: Prepared): Promise<void> {
  if (name === undefined) return say(router, TO_USAGE, m.messageId)
  const live = router.registry.list()
  const found = matchName(name, live.map((s) => s.name))
  if (found === null) return say(router, `no session named "${name}". ${liveSummary(live)}`, m.messageId)
  if (body === '' && m.kind === 'text') return say(router, `Nothing to send after "to ${name}:".`, m.messageId)
  // The body is what follows the prefix. A voice message was transcribed with the prefix still in it, so reuse its
  // download and transcript but not its text.
  const ready: Prepared | null = prepared ? { body, meta: prepared.meta } : await prepare(router, m, body)
  if (!ready) return
  if ('ambiguous' in found) {
    const sessions = found.ambiguous.map((n) => live.find((s) => s.name === n)).filter((s): s is Session => s !== undefined)
    return askWhich(router, sessions, m, ready)
  }
  const target = live.find((s) => s.name === found.match)
  if (!target) return say(router, `no session named "${name}". ${liveSummary(live)}`, m.messageId)
  return deliver(router, target, m, body, ready)
}
