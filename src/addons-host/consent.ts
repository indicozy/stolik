// Pure helpers for installing an addon (plan 2.10): the access list in plain words, the listener warning, and the
// consent gate (only the typed word `yes` installs).
import { ACCESS_FIELDS, POINTS, type AccessField, type Manifest, type Point } from './manifest.ts'

const ACCESS_WORDS: Record<AccessField, string> = {
  'message.text': 'read the text of your messages (and change it, if it is a text filter)',
  'message.audio': 'read the audio of your voice notes and audio messages (it gets the file path)',
  'message.files': 'read the photos and documents you send (it gets the file path)',
  'sessions.names': 'see the names of your agent sessions',
  'chatlog.read': 'read the chat log of past days (whole days of your messages and the replies)',
  'sessions.read': 'see the names, folders and recent activity of your agent sessions and trusted folders',
  'messages.send': 'send messages and buttons to your General chat',
  'messages.gate': 'hold messages to a session before they are delivered, and read back and release or drop the ones it held',
  'sessions.spawn': 'list the folders stolik can start in, and start a full agent session in one',
  'usage.record': 'record what its runs cost, and read the weekly quota status',
  'usage.read': 'read what the mode runs cost today and this week',
}

const POINT_WORDS: Record<Point, string> = {
  media: 'turns voice, audio, photos or documents into text',
  'text-filter': 'rewrites your text before it is routed',
  prefix: 'answers messages that start with its prefix word',
  command: 'answers its /command or !command in General',
  router: 'scores agent sessions for messages that name none',
  schedule: 'runs a job on a schedule',
  listener: 'is shown every message, read-only',
  reply: 'answers swipe-replies to its own messages',
  route: 'picks the session or folder for a plain message that names none',
  gate: 'can hold a message to a session before it is delivered, until you release it or drop it',
}

// The access list of a manifest, as lines for the consent screen. Every field the addon may receive is named; with no
// declared access the addon gets only its own requests.
export function describeAccess(m: Manifest): string[] {
  const lines = [`Addon ${m.name} ${m.version} asks for:`]
  if (m.access.length === 0) lines.push('  - nothing beyond its own requests (it gets no message text or names)')
  for (const f of ACCESS_FIELDS) if (m.access.includes(f)) lines.push(`  - ${ACCESS_WORDS[f]}`)
  lines.push(`It runs this program in its own folder: ${m.command.join(' ')}`)
  lines.push(`It does: ${POINTS.filter((p) => m.provides.some((v) => v.point === p))
    .map((p) => `${p} (${POINT_WORDS[p]})`)
    .join('; ')}`)
  if (m.requires.length > 0) lines.push(`It needs these addons installed and enabled: ${m.requires.join(', ')}`)
  if (m.serves.length > 0) lines.push(`It answers these ops for the addons that require it: ${m.serves.join(', ')}`)
  lines.push('Addons run as your user with no sandbox. Install only what you trust.')
  return lines
}

// Loud warning for a listener addon (design §3.2): it reads every message. Null when the addon is not a listener.
export function listenerWarning(m: Manifest): string | null {
  if (!m.provides.some((p) => p.point === 'listener')) return null
  return '!! WARNING: ' + m.name + ' is a LISTENER. It is shown every message you send and every reply, read-only. Install it only if you trust its code.'
}

// The consent gate: true only for the exact typed word `yes` (surrounding spaces ignored). Anything else cancels.
export function consentGiven(answer: string): boolean {
  return answer.trim() === 'yes'
}

export const CONSENT_PROMPT = 'Type yes to install, anything else cancels: '
export const RECONSENT_PROMPT = 'Type yes to allow this version, anything else cancels: '
