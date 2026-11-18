// cost-guard's handlers (the gate point and the buttons on a held message). The host is injected, so the tests drive
// them with a fake peer. Slow host work (the quota, a new session) runs after the answer: the gate has 3 s and a button
// about 10 s. The gate answers {hold} first, then the notice goes out.
import { basename } from 'node:path'
import { analyzeTranscript, transcriptPath, type Analysis } from './transcript.ts'
import { decide, holdNotice, newSessionPrompt } from './decide.ts'

// What the host gives the addon (the AddonPeer of ../sdk.ts satisfies it).
export type GuardHost = {
  request(op: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
}

export type GuardDeps = {
  host: GuardHost
  now: () => number
  // The owner's home folder (the transcripts live under it).
  home: string
  // Reads a transcript's analysis. Defaults to analyzeTranscript; the tests replace it.
  analyze?: (path: string) => Analysis | null
  log: (msg: string) => void
}

export type SessionInfo = { name: string; cwd: string; backendSessionId: string | null }

// The gate's payload from the router (session, message id, kind, length).
type GateRequest = { session: SessionInfo; messageId: string }

// Long enough for a tmux start (the router waits up to 90 s for the session to connect).
const SPAWN_TIMEOUT_MS = 150_000
const QUOTA_TIMEOUT_MS = 8_000
// Held messages remembered here (for the release marking); the router keeps its own, capped list.
const HELD_KEEP = 50

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function parseSession(raw: unknown): SessionInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  if (typeof s.name !== 'string' || typeof s.cwd !== 'string') return null
  const sid = s.backendSessionId
  if (sid !== null && typeof sid !== 'string') return null
  return { name: s.name, cwd: s.cwd, backendSessionId: sid }
}

function parseGate(payload: Record<string, unknown>): GateRequest | null {
  const session = parseSession(payload.session)
  if (!session || typeof payload.messageId !== 'string' || payload.messageId === '') return null
  return { session, messageId: payload.messageId }
}

export function makeGuard(deps: GuardDeps) {
  const analyze = deps.analyze ?? analyzeTranscript
  // Held messages this addon made: the session's backend id, for marking a release.
  const held = new Map<string, { backendSessionId: string | null }>()
  // The last release per backend session id (epoch ms). A release lets that session's follow-ups through for a while.
  const released = new Map<string, number>()
  const jobs = new Set<Promise<void>>()

  // Runs `job` after the current answer has been written, and keeps it for idle() to await.
  function later(job: () => Promise<void>): void {
    const p: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
      .then(job)
      .catch((e: unknown) => deps.log(`cost-guard: ${errText(e)}`))
      .finally(() => jobs.delete(p))
    jobs.add(p)
  }

  // Sends a plain line to General, replying to the held message.
  async function say(text: string, replyTo: string): Promise<void> {
    await deps.host.request('send', { text, replyTo })
  }

  // The week's used and pace percentages from the router's quota, or undefined when they cannot be read.
  async function weekPct(): Promise<{ usedPct: number; pacePct: number } | undefined> {
    try {
      const r = (await deps.host.request('quota', {}, QUOTA_TIMEOUT_MS)) as { usedPct?: unknown; pacePct?: unknown } | null
      if (typeof r?.usedPct === 'number' && typeof r?.pacePct === 'number') return { usedPct: r.usedPct, pacePct: r.pacePct }
    } catch (e) {
      deps.log(`cost-guard: quota unavailable: ${errText(e)}`)
    }
    return undefined
  }

  // The notice with its three buttons. If it cannot be sent, the message is released (the guard fails open) rather than
  // left held with nobody to choose.
  async function notify(req: GateRequest, idleMs: number, contextTokens: number): Promise<void> {
    const id = req.messageId
    const week = await weekPct()
    const text = holdNotice({ name: req.session.name, idleMs, contextTokens, week })
    const rows = [
      [
        { text: 'Send anyway', data: `release:${id}` },
        { text: 'New session', data: `new:${id}` },
      ],
      [{ text: 'Cancel', data: `cancel:${id}` }],
    ]
    try {
      await deps.host.request('send', { text, replyTo: id, rows })
    } catch (e) {
      deps.log(`cost-guard: the notice failed, releasing the message: ${errText(e)}`)
      held.delete(id)
      await deps.host.request('release', { messageId: id }).catch((err: unknown) => deps.log(`cost-guard: release failed: ${errText(err)}`))
    }
  }

  // The gate: hold only when decide() says so. A payload that does not parse passes.
  async function gate(payload: Record<string, unknown>): Promise<{ hold: boolean }> {
    const req = parseGate(payload)
    if (!req) return { hold: false }
    const sid = req.session.backendSessionId
    const path = transcriptPath(deps.home, req.session.cwd, sid)
    const analysis = path === null ? null : analyze(path)
    const d = decide({ backendSessionId: sid, analysis, now: deps.now(), releasedAt: sid === null ? undefined : released.get(sid) })
    if (!d.hold) return { hold: false }
    held.set(req.messageId, { backendSessionId: sid })
    if (held.size > HELD_KEEP) held.delete(held.keys().next().value as string)
    later(() => notify(req, d.idleMs, d.contextTokens))
    return { hold: true }
  }

  // Release: the router delivers the message once; the session is then marked released.
  async function release(id: string): Promise<string> {
    let r: { ok?: unknown; error?: unknown } | null
    try {
      r = (await deps.host.request('release', { messageId: id })) as { ok?: unknown; error?: unknown } | null
    } catch (e) {
      return `Not sent: ${errText(e)}`
    }
    if (r?.ok !== true) return `Not sent: ${typeof r?.error === 'string' ? r.error : 'unknown error'}`
    const sid = held.get(id)?.backendSessionId
    if (sid) released.set(sid, deps.now())
    held.delete(id)
    return 'sent'
  }

  // Drop: forgets the held message. It is not delivered.
  async function drop(id: string): Promise<string> {
    let r: { ok?: unknown; error?: unknown } | null
    try {
      r = (await deps.host.request('drop', { messageId: id })) as { ok?: unknown; error?: unknown } | null
    } catch (e) {
      return `Not cancelled: ${errText(e)}`
    }
    if (r?.ok !== true) return `Not cancelled: ${typeof r?.error === 'string' ? r.error : 'unknown error'}`
    held.delete(id)
    return 'cancelled'
  }

  // New session: starts a session in the held message's folder with the message as its first prompt, then drops the held
  // message. Runs after the toast. If the start fails, the message stays held and the failure is said in General.
  async function newSession(id: string): Promise<void> {
    try {
      await startFromHeld(id)
    } catch (e) {
      await say(`Could not start a new session: ${errText(e)}. The message is still held.`, id)
    }
  }

  async function startFromHeld(id: string): Promise<void> {
    const h = (await deps.host.request('held', { messageId: id })) as { ok?: unknown; error?: unknown; text?: unknown; session?: unknown } | null
    if (h?.ok !== true || typeof h.text !== 'string') {
      await say(`Could not start a new session: ${typeof h?.error === 'string' ? h.error : 'the message is not held any more'}.`, id)
      return
    }
    const session = parseSession(h.session)
    if (!session) {
      await say('Could not start a new session: the session is gone.', id)
      return
    }
    const prompt = newSessionPrompt(transcriptPath(deps.home, session.cwd, session.backendSessionId), h.text)
    const s = (await deps.host.request('spawn', { dir: session.cwd, prompt, messageId: id }, SPAWN_TIMEOUT_MS)) as { ok?: unknown; error?: unknown } | null
    if (s?.ok !== true) {
      await say(`Could not start a new session: ${typeof s?.error === 'string' ? s.error : 'unknown error'}. The message is still held.`, id)
      return
    }
    await deps.host.request('drop', { messageId: id })
    held.delete(id)
    await say(`New session started in ${basename(session.cwd)}.`, id)
  }

  // A tap on one of the notice's buttons. The toast is the answer; slow work goes after it.
  async function callback(payload: Record<string, unknown>): Promise<{ toast: string }> {
    const m = /^(release|new|cancel):([\s\S]+)$/.exec(typeof payload.data === 'string' ? payload.data : '')
    if (!m) return { toast: 'Not available.' }
    const id = m[2]
    if (m[1] === 'release') return { toast: await release(id) }
    if (m[1] === 'cancel') return { toast: await drop(id) }
    later(() => newSession(id))
    return { toast: 'Starting a new session…' }
  }

  // Resolves when every job started after an answer has finished (the tests wait on it).
  async function idle(): Promise<void> {
    while (jobs.size > 0) await Promise.all([...jobs])
  }

  return { gate, callback, idle }
}

export type Guard = ReturnType<typeof makeGuard>
