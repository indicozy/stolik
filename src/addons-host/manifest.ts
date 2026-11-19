// Addon manifest (`stolik-addon.json` at the addon root) and the access fields it may declare (plan 2.9, design §3.2).
// An addon gets only the payload fields its manifest declares; `KEY_ACCESS` says which payload key needs which field.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

export const MANIFEST_FILE = 'stolik-addon.json'
export const SUPPORTED_PROTOCOL = 2

// Every access field an addon can declare. An unknown field is a manifest error (a typo must not silently grant nothing).
export const ACCESS_FIELDS = [
  'message.text', // the text of the owner's messages (and captions, and what an addon is asked to transform)
  'message.audio', // the local path of a voice note or audio file, so an addon can read the file
  'message.files', // the local path of a photo or document
  'sessions.names', // the names of the agent sessions and trusted projects, and the words an addon is given as vocabulary
  'chatlog.read', // the chat log: the `chatlog` request reads whole days of it (the digest addon)
  'sessions.read', // the live sessions (name, folder, last activity) and the trusted folders, for the route point (the router addon)
  // Capabilities for requests an addon sends the host: what it may ask the router to do.
  'messages.send', // send text, with buttons, to the home chat (chunked, redacted by the router)
  // Hold a message to a session before it is delivered (the gate point, cost-guard). Also needed for the requests that
  // release, drop or read back a message this addon held. A gate provider must declare it (ManifestSchema).
  'messages.gate',
  'sessions.spawn', // list the startable folders and start a full agent session in one with a first prompt
  'usage.record', // record a mode run's cost and read the quota status
  'usage.read', // read the cost totals of mode runs today and this week (the `costs` request)
] as const
export type AccessField = (typeof ACCESS_FIELDS)[number]

export const MEDIA_KINDS = ['voice', 'audio', 'photo', 'document'] as const
export type MediaKind = (typeof MEDIA_KINDS)[number]

// The plug-in points (design §3.2). Each entry of `provides` is one of these, with its own parameters.
// `reply`: an addon that answers swipe-replies to its own messages (modes continue a thread).
// `route` (router addon): picks a live session or a trusted folder for a plain General message that names none.
// `gate` (protocol 2): may hold a message to a session before it is delivered (cost-guard). Needs messages.gate.
export const POINTS = ['media', 'text-filter', 'prefix', 'command', 'router', 'schedule', 'listener', 'reply', 'route', 'gate'] as const
export type Point = (typeof POINTS)[number]

const NAME_RE = /^[a-z][a-z0-9-]{1,39}$/
const SERVE_RE = /^[a-z][a-z0-9-]{1,31}$/
// Ops the host itself uses (the point ops, the callbacks, the events). An addon cannot serve one of these to another.
export const RESERVED_OPS: readonly string[] = [
  'prefix', 'reply', 'callback', 'tick', 'route', 'command', 'general', 'media', 'text-filter', 'event', 'router', 'gate',
]
const WORD_RE = /^[\p{L}\p{N}_]+$/u
const COMMAND_RE = /^[a-z][a-z0-9_]{0,31}$/

const ProvideSchema = z.discriminatedUnion('point', [
  z.object({ point: z.literal('media'), kinds: z.array(z.enum(MEDIA_KINDS)).min(1) }).strict(),
  z.object({ point: z.literal('text-filter') }).strict(),
  z
    .object({ point: z.literal('prefix'), words: z.array(z.string().regex(WORD_RE, 'a prefix word is one word')).min(1) })
    .strict(),
  z.object({ point: z.literal('command'), name: z.string().regex(COMMAND_RE, 'a command name is lowercase letters, digits or _') }).strict(),
  z.object({ point: z.literal('router') }).strict(),
  z.object({ point: z.literal('schedule'), everyMinutes: z.number().int().min(1).max(10080) }).strict(),
  z.object({ point: z.literal('listener') }).strict(),
  z.object({ point: z.literal('reply') }).strict(),
  z.object({ point: z.literal('route') }).strict(),
  z.object({ point: z.literal('gate') }).strict(),
])

export const ManifestSchema = z
  .object({
    name: z.string().regex(NAME_RE, 'lowercase letters, digits and dashes, 2 to 40 characters, starting with a letter'),
    version: z.string().min(1).max(40),
    protocol: z.number().int().refine((v) => v === SUPPORTED_PROTOCOL, `only protocol ${SUPPORTED_PROTOCOL} is supported`),
    command: z.array(z.string().min(1)).min(1, 'command needs at least the program name'),
    // Empty for a service addon: it provides nothing to users and only answers calls from addons that require it (plan 3.1).
    provides: z.array(ProvideSchema),
    access: z
      .array(z.enum(ACCESS_FIELDS))
      .default([])
      .refine((a) => new Set(a).size === a.length, 'an access field is listed twice'),
    requires: z.array(z.string().regex(NAME_RE, 'an addon name')).default([]),
    // The ops this addon answers for the addons that require it (plan 3.1). Any other op is refused.
    serves: z
      .array(z.string().regex(SERVE_RE, 'a served op is lowercase letters, digits or dashes, 2 to 32 characters'))
      .default([])
      .superRefine((ops, ctx) => {
        for (const op of ops) {
          if (RESERVED_OPS.includes(op)) ctx.addIssue({ code: 'custom', message: `${op} is a host op and cannot be served` })
        }
        if (new Set(ops).size !== ops.length) ctx.addIssue({ code: 'custom', message: 'a served op is listed twice' })
      }),
  })
  .strict()
  .superRefine((m, ctx) => {
    // A gate provider holds messages to sessions, so it must declare messages.gate (its access says what it may do with them).
    if (m.provides.some((p) => p.point === 'gate') && !m.access.includes('messages.gate')) {
      ctx.addIssue({ code: 'custom', path: ['access'], message: 'a gate provider needs messages.gate access' })
    }
  })

export type Manifest = z.infer<typeof ManifestSchema>
export type Provide = Manifest['provides'][number]

// The one message for a manifest written for another protocol. It is checked before the schema, so the reader sees this
// line alone (the schema would also flag the points and ids the old protocol used).
export function protocolRefusal(protocol: number): string {
  return `written for addon protocol ${protocol}; this stolik speaks protocol ${SUPPORTED_PROTOCOL} (ids are strings, point "thread" is now "reply"). Update the addon.`
}

// Validates a parsed JSON value. Throws an Error that names each bad field.
export function parseManifest(raw: unknown): Manifest {
  const other = raw && typeof raw === 'object' ? (raw as { protocol?: unknown }).protocol : undefined
  if (typeof other === 'number' && Number.isInteger(other) && other !== SUPPORTED_PROTOCOL) throw new Error(protocolRefusal(other))
  const r = ManifestSchema.safeParse(raw)
  if (r.success) return r.data
  throw new Error(r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '))
}

// Reads and validates `<dir>/stolik-addon.json`. Returns the error text instead of throwing (the host lists broken addons).
export function readManifest(dir: string): { manifest: Manifest } | { error: string } {
  let text: string
  try {
    text = readFileSync(join(dir, MANIFEST_FILE), 'utf8')
  } catch {
    return { error: `${MANIFEST_FILE} not found` }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { error: `${MANIFEST_FILE} is not valid JSON` }
  }
  try {
    return { manifest: parseManifest(raw) }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// Payload keys the host may send, and the access field each one needs. `null` means metadata that is always sent
// (the operation, sizes, words the addon itself declared). A key not listed here is never sent.
export const KEY_ACCESS: Readonly<Record<string, AccessField | null>> = {
  op: null,
  kind: null,
  size: null,
  mime: null,
  word: null,
  command: null,
  now: null,
  text: 'message.text',
  audioPath: 'message.audio',
  filePath: 'message.files',
  sessionNames: 'sessions.names',
  vocab: 'sessions.names',
  words: null,
  maxTokens: null,
  // The gate point's payload (cost-guard): the session it would deliver to, the message id and kind, its length. The
  // message text is never sent with it; the held text is read back with the `held` request.
  session: 'messages.gate',
  length: null,
  // The route point's payload: the live sessions and the trusted folders (names, folders, last activity).
  sessions: 'sessions.read',
  folders: 'sessions.read',
  chatlogLines: 'chatlog.read',
  // Metadata for the requests and buttons: a button's data, and the message ids of a question or a reply.
  data: null,
  messageId: null,
  replyTo: null,
  // The absolute time (epoch ms) by which the addon should answer: the host's clock now plus the call's timeout.
  deadline: null,
}

export function hasAccess(manifest: Pick<Manifest, 'access'>, field: AccessField): boolean {
  return manifest.access.includes(field)
}

// The fields of a manifest the owner agrees to. A change to any of them needs a new consent (host.ts refresh).
const CONSENT_FIELDS = ['name', 'version', 'command', 'provides', 'access', 'requires', 'serves'] as const

// SHA-256 of the canonical JSON (sorted object keys) of the consent fields of a parsed manifest.
export function consentHash(m: Manifest): string {
  const picked: Record<string, unknown> = {}
  for (const k of CONSENT_FIELDS) picked[k] = m[k]
  return createHash('sha256').update(canonicalJson(picked)).digest('hex')
}

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']'
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}'
  }
  return JSON.stringify(v)
}
