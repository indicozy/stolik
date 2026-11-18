// Router addon (the route point). For a plain General message that names no session or folder, it asks the local model
// (ml-worker `generate`) to pick a live session or a trusted folder. It never sends anything itself, and the router never
// acts on its answer without a confirm button: the answer only preselects (see src/router/handlers/route.ts).
import { startAddon } from '../sdk.ts'
import { fromChoice, options, parseChoice, prompt, type RouteInput, type RouteResult } from './route.ts'

// The model may take a while to load on the CPU; the router waits up to 30 s for this addon, so the model gets 20 s.
export const MODEL_TIMEOUT_MS = 20_000
const MODEL_TOKENS = 16

const log = (msg: string): void => {
  process.stderr.write(`router: ${msg}\n`)
}

// The payload of a route call, checked: anything else is refused (the router then uses its buttons).
function readInput(p: Record<string, unknown>): RouteInput | null {
  if (typeof p.text !== 'string') return null
  const sessions = Array.isArray(p.sessions) ? p.sessions : []
  const folders = Array.isArray(p.folders) ? p.folders : []
  const okSessions = sessions.every(
    (s) => s && typeof s === 'object' && typeof (s as { name?: unknown }).name === 'string' && typeof (s as { folder?: unknown }).folder === 'string' && typeof (s as { lastActiveAt?: unknown }).lastActiveAt === 'number',
  )
  const okFolders = folders.every(
    (f) => f && typeof f === 'object' && typeof (f as { name?: unknown }).name === 'string' && typeof (f as { path?: unknown }).path === 'string',
  )
  if (!okSessions || !okFolders) return null
  return { text: p.text, sessions: sessions as RouteInput['sessions'], folders: folders as RouteInput['folders'] }
}

startAddon((peer) => ({
  route: async (payload): Promise<RouteResult | null> => {
    const input = readInput(payload)
    if (!input) return null
    const opts = options(input)
    if (opts.length === 0) return { target: null, confidence: 0, reason: 'no session or folder to choose' }
    let answer: string
    try {
      const r = await withTimeout(
        peer.call('ml-worker', 'generate', { text: prompt(input.text, opts), maxTokens: MODEL_TOKENS }, MODEL_TIMEOUT_MS),
        MODEL_TIMEOUT_MS,
      )
      answer = typeof (r as { text?: unknown } | null)?.text === 'string' ? (r as { text: string }).text : ''
    } catch (e) {
      log(`model not used: ${e instanceof Error ? e.message : String(e)}`)
      return null
    }
    const choice = parseChoice(answer, opts.length)
    if (!choice) {
      log('model answer not in the expected form; not used')
      return null
    }
    return fromChoice(opts, choice)
  },
}))

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('the model did not answer in time')), ms)
  })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}
