// Dispatch for the six plug-in points (plan 2.9, design §3.2). Every point asks the running addons that provide it, in
// manifest name order (folder name order, which is the order `list` shows). The first answer that counts wins where
// one answer is needed (media, route, prefix, command). Text filters run in turn, each on the previous output.
// A failing or silent addon is logged and skipped; it never stops a message.
import type { AddonHost } from './host.ts'
import type { MediaKind, Point, Provide } from './manifest.ts'
import type { RouteAnswer, RoutePayload } from '../ports.ts'
import { afterSeparator } from '../brain/prefixes.ts'
import type { MessageId } from '../brain/chat-types.ts'

export const MEDIA_TIMEOUT_MS = 120_000
export const ROUTE_TIMEOUT_MS = 10_000
// A cleanup on the CPU can take a while for a long voice note; the host waits this long before it gives up.
export const TEXT_FILTER_TIMEOUT_MS = 120_000

type ProvideOf<P extends Point> = Extract<Provide, { point: P }>
export type Provider<P extends Point> = { name: string; index: number; provide: ProvideOf<P> }

// Running addons that provide `point`, in name order, then manifest order within an addon.
export function providers<P extends Point>(host: Pick<AddonHost, 'running'>, point: P): Provider<P>[] {
  const out: Provider<P>[] = []
  for (const r of host.running()) {
    r.manifest.provides.forEach((p, index) => {
      if (p.point === point) out.push({ name: r.name, index, provide: p as ProvideOf<P> })
    })
  }
  return out
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// A General message that starts with a prefix word, then a separator: a colon, a comma, or a dash followed by a space
// ("note - buy milk", "quick- x"). A dash inside the word is not a separator ("quick-fix the bug" is not a prefix).
// The separator rule is the one in brain/prefixes.ts (afterSeparator), so both parsers agree. No separator: no prefix.
const WORD_RE = /^[^\s:,\-–—]+/u
export function parsePrefix(text: string): { word: string; rest: string } | null {
  const t = text.trim()
  const w = WORD_RE.exec(t)
  if (!w) return null
  const after = afterSeparator(t.slice(w[0].length))
  if (after === null) return null
  return { word: w[0].toLowerCase(), rest: after.trim() }
}

// A General message that is a command: `/word` or `!word` (the sigil of the chat app, protocol 2 accepts both), optionally
// `@bot`-suffixed, then the argument. The addon gets the bare word.
const COMMAND_RE = /^[\/!]([A-Za-z][A-Za-z0-9_]*)(?:@\S+)?(?:\s+([\s\S]*))?$/
export function parseCommand(text: string): { command: string; arg: string } | null {
  const m = COMMAND_RE.exec(text.trim())
  if (!m) return null
  return { command: m[1].toLowerCase(), arg: (m[2] ?? '').trim() }
}

// What `general` returns when the addon took the message and sends its own answer later (with `handled: true`).
export const ASYNC_REPLY = ''

// One reply from a prefix or command addon, or a note that it did not answer.
async function askForReply(host: AddonHost, name: string, op: string, payload: Record<string, unknown>): Promise<string> {
  try {
    const r = (await host.call(name, op, payload)) as { reply?: unknown; handled?: unknown } | null
    if (r?.handled === true) return ASYNC_REPLY
    return typeof r?.reply === 'string' && r.reply.trim() !== '' ? r.reply : `${name} sent no reply.`
  } catch (e) {
    host.log(`addon ${name}: ${op} failed: ${errText(e)}`)
    return `${name} did not answer: ${errText(e)}`
  }
}

// The reply of the addon whose command or prefix matches a General message, or null when none matches. A command
// (`/word`) is tried first, then a prefix (`word:`). Only the first match in name order answers.
// `messageId` is the owner's message (sent to prefix addons, so an answer can reply to it). `file` is fetched only once
// an addon has claimed the message.
export async function general(
  host: AddonHost,
  text: string,
  messageId?: MessageId,
  file?: () => Promise<Record<string, unknown> | null>,
): Promise<string | null> {
  const cmd = parseCommand(text)
  if (cmd) {
    const hit = providers(host, 'command').find((p) => p.provide.name === cmd.command)
    if (hit) return askForReply(host, hit.name, 'command', { command: cmd.command, text: cmd.arg })
  }
  const pre = parsePrefix(text)
  if (pre) {
    const hit = providers(host, 'prefix').find((p) => p.provide.words.some((w) => w.toLowerCase() === pre.word))
    if (hit) {
      // The file (if any) is fetched only now, when an addon has claimed the message. Keys the manifest does not
      // declare are dropped by the access filter.
      const extra = (file ? await file() : null) ?? {}
      const payload: Record<string, unknown> = { word: pre.word, text: pre.rest, ...extra }
      // The id is the opaque string the host handed out; the addon echoes it back.
      if (messageId !== undefined) payload.messageId = messageId
      return askForReply(host, hit.name, 'prefix', payload)
    }
  }
  return null
}

export const REPLY_TIMEOUT_MS = 10_000
// The gate point answers before a message reaches the agent, so the wait is short. Any error or timeout passes the message.
export const GATE_TIMEOUT_MS = 3_000

// Asks each running gate provider in turn (name order) whether to hold a message to a session. The first `hold: true`
// wins and its addon is returned. A provider that fails or times out lets the message pass (fail open), and the reason is
// logged. `payload` is what the router sends (session, message id, kind, length); the host filters it by access.
export async function gate(host: AddonHost, payload: Record<string, unknown>): Promise<{ addon: string } | null> {
  for (const p of providers(host, 'gate')) {
    try {
      const r = (await host.call(p.name, 'gate', payload, GATE_TIMEOUT_MS)) as { hold?: unknown } | null
      if (r?.hold === true) return { addon: p.name }
    } catch (e) {
      host.log(`addon ${p.name}: gate failed, message passes: ${errText(e)}`)
    }
  }
  return null
}

// The addon that took a swipe-reply to one of its messages (the `reply` point), or null. The addon answers with
// `handled` and sends its own reply. `replyTo` is the message replied to, `messageId` the reply itself (both ids as the
// host has them: opaque strings).
export async function replyPoint(host: AddonHost, text: string, replyTo: MessageId, messageId: MessageId): Promise<string | null> {
  for (const p of providers(host, 'reply')) {
    try {
      const r = (await host.call(p.name, 'reply', { text, replyTo, messageId }, REPLY_TIMEOUT_MS)) as { handled?: unknown } | null
      if (r?.handled === true) return p.name
    } catch (e) {
      host.log(`addon ${p.name}: reply failed: ${errText(e)}`)
    }
  }
  return null
}

export type MediaFile = { kind: MediaKind; size: number; mime: string; path: string }

// Text for a voice, audio, photo or document, from the first media addon that takes its kind; null when none does.
export async function media(host: AddonHost, file: MediaFile): Promise<{ addon: string; text: string } | null> {
  for (const p of providers(host, 'media')) {
    if (!p.provide.kinds.includes(file.kind)) continue
    const isAudio = file.kind === 'voice' || file.kind === 'audio'
    const payload: Record<string, unknown> = {
      kind: file.kind,
      size: file.size,
      mime: file.mime,
      ...(isAudio ? { audioPath: file.path } : { filePath: file.path }),
    }
    try {
      const r = (await host.call(p.name, 'media', payload, MEDIA_TIMEOUT_MS)) as { text?: unknown } | null
      if (typeof r?.text === 'string') return { addon: p.name, text: r.text }
      host.log(`addon ${p.name}: media gave no text`)
    } catch (e) {
      host.log(`addon ${p.name}: media failed: ${errText(e)}`)
    }
  }
  return null
}

// What a text filter is told besides the text: the session and project names, which the cleanup addon uses as vocabulary.
export type FilterContext = { sessionNames: string[] }
export type CleanResult = { text: string; unpolished: boolean }

// Runs every text filter in name order, each on the previous output. A filter that fails leaves the text as it was. A
// filter that answers `unpolished: true` marks the text so (the voice cleanup guard, plan 3.3). The prefix words of the
// running addons go along as vocabulary.
export async function cleanText(host: AddonHost, text: string, ctx: FilterContext): Promise<CleanResult> {
  let out = text
  let unpolished = false
  const words = prefixWords(host)
  for (const p of providers(host, 'text-filter')) {
    try {
      const r = (await host.call(p.name, 'text-filter', { text: out, sessionNames: ctx.sessionNames, words }, TEXT_FILTER_TIMEOUT_MS)) as {
        text?: unknown
        unpolished?: unknown
      } | null
      if (typeof r?.text === 'string') out = r.text
      if (r?.unpolished === true) unpolished = true
    } catch (e) {
      host.log(`addon ${p.name}: text-filter failed: ${errText(e)}`)
    }
  }
  return { text: out, unpolished }
}

export async function textFilters(host: AddonHost, text: string): Promise<string> {
  return (await cleanText(host, text, { sessionNames: [] })).text
}

// The prefix words of every running addon, in provider order (vocabulary for the cleanup addon).
export function prefixWords(host: Pick<AddonHost, 'running'>): string[] {
  return providers(host, 'prefix').flatMap((p) => p.provide.words)
}

// Scores for sessions from the first router addon that answers with valid scores; null when none does.
export async function routeScores(
  host: AddonHost,
  text: string,
  sessionNames: string[],
): Promise<{ addon: string; scores: Record<string, number> } | null> {
  for (const p of providers(host, 'router')) {
    try {
      const r = (await host.call(p.name, 'route', { text, sessionNames }, ROUTE_TIMEOUT_MS)) as { scores?: unknown } | null
      const s = r?.scores
      if (!s || typeof s !== 'object' || Array.isArray(s)) continue
      const scores: Record<string, number> = {}
      for (const [k, v] of Object.entries(s)) if (typeof v === 'number' && Number.isFinite(v)) scores[k] = v
      return { addon: p.name, scores }
    } catch (e) {
      host.log(`addon ${p.name}: route failed: ${errText(e)}`)
    }
  }
  return null
}

// The route point (the router addon): its answer for a plain message, from the first route provider that gives a valid one.
// Null when no addon answers, the answer is malformed, or the call fails or times out.
export const ROUTE_CALL_TIMEOUT_MS = 30_000

export async function routeMessage(host: AddonHost, payload: RoutePayload): Promise<(RouteAnswer & { addon: string }) | null> {
  for (const p of providers(host, 'route')) {
    try {
      const r = await host.call(p.name, 'route', payload, ROUTE_CALL_TIMEOUT_MS)
      const answer = parseRouteAnswer(r)
      if (answer) return { ...answer, addon: p.name }
      host.log(`addon ${p.name}: route gave no valid answer`)
    } catch (e) {
      host.log(`addon ${p.name}: route failed: ${errText(e)}`)
    }
    return null
  }
  return null
}

// Strict check of a route answer: a target of kind session (with a name) or new (with a folder), or null; a confidence
// from 0 to 1. Anything else is not an answer.
export function parseRouteAnswer(raw: unknown): RouteAnswer | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const c = r.confidence
  if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 1) return null
  let target: RouteAnswer['target'] = null
  if (r.target !== null) {
    const t = r.target as Record<string, unknown> | undefined
    if (!t || typeof t !== 'object') return null
    if (t.kind === 'session' && typeof t.name === 'string' && t.name !== '') target = { kind: 'session', name: t.name }
    else if (t.kind === 'new' && typeof t.folder === 'string' && t.folder.startsWith('/')) target = { kind: 'new', folder: t.folder }
    else return null
  }
  return { target, confidence: c, reason: typeof r.reason === 'string' ? r.reason.slice(0, 200) : '' }
}

// Schedules that are due at `now`. `lastRun` maps "addon#index" to the last tick time; a schedule never run is due.
export function dueSchedules(host: Pick<AddonHost, 'running'>, now: number, lastRun: ReadonlyMap<string, number>): string[] {
  const due: string[] = []
  for (const p of providers(host, 'schedule')) {
    const key = `${p.name}#${p.index}`
    const last = lastRun.get(key)
    if (last === undefined || now - last >= p.provide.everyMinutes * 60_000) due.push(key)
  }
  return due
}

// Sends `tick` to every due schedule and records the time. Returns the keys that were ticked.
export async function tickSchedules(host: AddonHost, now: number, lastRun: Map<string, number>): Promise<string[]> {
  const ticked = dueSchedules(host, now, lastRun)
  for (const key of ticked) {
    lastRun.set(key, now)
    const name = key.slice(0, key.lastIndexOf('#'))
    try {
      await host.call(name, 'tick', { now })
    } catch (e) {
      host.log(`addon ${name}: tick failed: ${errText(e)}`)
    }
  }
  return ticked
}

// Tells every listener about a message. Fire and forget: nothing waits for it and nothing is sent back.
export function emitEvent(host: AddonHost, event: { kind: 'inbound' | 'outbound'; text: string }): void {
  for (const p of providers(host, 'listener')) {
    host.call(p.name, 'event', { kind: event.kind, text: event.text }).catch((e) => {
      host.log(`addon ${p.name}: listener failed: ${errText(e)}`)
    })
  }
}
