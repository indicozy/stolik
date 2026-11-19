// stolik E2E driver CLI (docs/e2e.md). Drives a router started with STOLIK_E2E=1 through its socket, so a run can
// send messages, tap buttons and read the replies without a person typing. Only node built-ins; run with:
//   STOLIK_SOCKET=<router socket> node --experimental-strip-types scripts/e2e.ts <command> [args]
import { createConnection } from 'node:net'
import { pathToFileURL } from 'node:url'

export const USAGE = `usage: e2e <command>
  send <text> [--topic <session>] [--reply <id>] [--from <username>] [--forwarded]  an owner text message (General, or a session's topic); --from sets the sender name sessions see; --forwarded marks it as forwarded (treated as data)
  voice <file> [--topic <session>] [--reply <id>]    a voice message (.ogg, .oga, .opus, .wav, .mp3, .m4a)
  photo <file> [--topic <session>] [--reply <id>]    a photo
  file <file> [--topic <session>] [--reply <id>]     a document
  tap <messageId> <button text or index>             tap a button of a sent message (index is 0-based)
  sent [n] [--json]                                  the last n outbound messages (default 20)
  wait <regex> [--timeout <seconds>] [--json]        wait for a new outbound message whose text matches (default 60 s)
STOLIK_SOCKET must name the router socket.`

export type Sent = { messageId: number; chat: { kind: string; id: string; threadId: number | null }; text: string; buttons: Array<Array<{ text: string; data: string }>> }

export type Parsed = { cmd: string; positional: string[]; flags: Record<string, string | true> }

// Splits argv into the command, positional arguments and --flag [value] pairs. A flag that takes a value and has none is an error.
export function parseArgs(argv: string[], valueFlags: readonly string[] = ['topic', 'reply', 'timeout', 'from']): Parsed {
  const [cmd = '', ...rest] = argv
  const positional: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a.startsWith('--')) {
      const name = a.slice(2)
      if (valueFlags.includes(name)) {
        const v = rest[++i]
        if (v === undefined || v.startsWith('--')) throw new Error(`--${name} needs a value`)
        flags[name] = v
      } else {
        flags[name] = true
      }
    } else {
      positional.push(a)
    }
  }
  return { cmd, positional, flags }
}

// The socket message for an injected send, voice, photo or file. Exactly one media field is set, and only for its own command:
// a send carries text (and forwarded when asked), never a file.
export function injectBody(
  cmd: string,
  arg: string,
  o: { topic?: string; reply?: number; from?: string; forwarded?: boolean },
): Record<string, unknown> {
  const body: Record<string, unknown> = { op: 'inbound', topic: o.topic, reply: o.reply, from: o.from }
  if (cmd === 'send') {
    body.text = arg
    if (o.forwarded) body.forwarded = true
  } else if (cmd === 'voice') body.voice = arg
  else if (cmd === 'photo') body.photo = arg
  else body.document = arg
  return body
}

// One request, one reply line. Rejects when the router is unreachable, silent or closes the connection.
export function request(socketPath: string, msg: Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const reqId = Math.random().toString(36).slice(2)
    const sock = createConnection(socketPath)
    let buf = ''
    let settled = false
    const finish = (err: Error | null, value?: Record<string, any>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      if (err) reject(err)
      else resolve(value as Record<string, any>)
    }
    const timer = setTimeout(() => finish(new Error('no reply from the router')), timeoutMs)
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(JSON.stringify({ t: 'e2e', ...msg, reqId }) + '\n'))
    sock.on('data', (chunk: string) => {
      buf += chunk
      const i = buf.indexOf('\n')
      if (i < 0) return
      try {
        const reply = JSON.parse(buf.slice(0, i))
        if (reply.t !== 'e2e_result') finish(new Error(`unexpected reply ${String(reply.t)}`))
        else finish(null, reply)
      } catch {
        finish(new Error('the router sent a reply that is not JSON'))
      }
    })
    sock.on('error', (e) => finish(new Error(`cannot reach the router at ${socketPath}: ${e.message}`)))
    sock.on('close', () => finish(new Error('the router closed the connection')))
  })
}

function where(s: Sent): string {
  if (s.chat.kind === 'private') return 'DM'
  return s.chat.threadId === null ? 'General' : `topic ${s.chat.threadId}`
}

// One message as text: its id, where it went, its text and its buttons with their indices.
export function formatSent(s: Sent): string {
  const head = `#${s.messageId} [${where(s)}] ${s.text.length > 300 ? s.text.slice(0, 300) + '…' : s.text}`
  const flat = s.buttons.flat()
  return [head, ...flat.map((b, i) => `    [${i}] ${b.text}  (${b.data})`)].join('\n')
}

// Waits for a message sent after the call started. Messages already in the buffer never match.
export async function waitFor(
  pattern: RegExp,
  timeoutMs: number,
  poll: () => Promise<Sent[]>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Sent | null> {
  const seen = new Set((await poll()).map((s) => s.messageId))
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    await sleep(1000)
    for (const s of await poll()) {
      if (seen.has(s.messageId)) continue
      seen.add(s.messageId)
      if (pattern.test(s.text)) return s
    }
  }
  return null
}

function fail(msg: string, code = 1): number {
  process.stderr.write(`e2e: ${msg}\n`)
  return code
}

async function main(argv: string[]): Promise<number> {
  let p: Parsed
  try {
    p = parseArgs(argv)
  } catch (e) {
    return fail((e as Error).message, 2)
  }
  if (p.cmd === '' || p.cmd === 'help' || p.cmd === '--help') {
    process.stdout.write(USAGE + '\n')
    return p.cmd === '' ? 2 : 0
  }
  const socket = process.env.STOLIK_SOCKET
  if (!socket) return fail('STOLIK_SOCKET is not set (the router socket)', 2)
  const topic = typeof p.flags.topic === 'string' ? p.flags.topic : undefined
  const reply = typeof p.flags.reply === 'string' ? Number(p.flags.reply) : undefined
  if (reply !== undefined && !Number.isInteger(reply)) return fail('--reply needs a message id', 2)
  const json = p.flags.json === true
  try {
    switch (p.cmd) {
      case 'send':
      case 'voice':
      case 'photo':
      case 'file': {
        const arg = p.positional.join(' ')
        if (p.positional.length === 0 && p.cmd !== 'send') return fail(`${p.cmd} needs a file path`, 2)
        if (p.cmd === 'send' && arg === '') return fail('send needs text', 2)
        const body = injectBody(p.cmd, arg, { topic, reply, from: typeof p.flags.from === 'string' ? p.flags.from : undefined, forwarded: p.flags.forwarded === true })
        const r = await request(socket, body)
        if (!r.ok) return fail(r.error)
        process.stdout.write(json ? JSON.stringify(r) + '\n' : `injected message ${r.messageId}\n`)
        return 0
      }
      case 'tap': {
        const [id, which] = p.positional
        if (id === undefined || which === undefined) return fail('tap needs <messageId> <button text or index>', 2)
        const r = await request(socket, { op: 'callback', messageId: Number(id), button: which })
        if (!r.ok) return fail(r.error)
        process.stdout.write(json ? JSON.stringify(r) + '\n' : `tapped ${which} on ${id}: ${r.data}\n`)
        return 0
      }
      case 'sent': {
        const n = p.positional[0] === undefined ? 20 : Number(p.positional[0])
        if (!Number.isInteger(n) || n < 1) return fail('sent needs a positive count', 2)
        const r = await request(socket, { op: 'sent', n })
        if (!r.ok) return fail(r.error)
        const sent = r.sent as Sent[]
        process.stdout.write(json ? JSON.stringify(sent) + '\n' : sent.map(formatSent).join('\n') + (sent.length ? '\n' : ''))
        return 0
      }
      case 'wait': {
        if (p.positional.length === 0) return fail('wait needs a regular expression', 2)
        let pattern: RegExp
        try {
          pattern = new RegExp(p.positional.join(' '), 'i')
        } catch {
          return fail('the pattern is not a valid regular expression', 2)
        }
        const seconds = typeof p.flags.timeout === 'string' ? Number(p.flags.timeout) : 60
        if (!(seconds > 0)) return fail('--timeout needs seconds', 2)
        const poll = async () => ((await request(socket, { op: 'sent', n: 200 })).sent ?? []) as Sent[]
        const hit = await waitFor(pattern, seconds * 1000, poll)
        if (!hit) return fail(`no message matched ${pattern.source} within ${seconds} s`)
        process.stdout.write(json ? JSON.stringify(hit) + '\n' : formatSent(hit) + '\n')
        return 0
      }
      default:
        return fail(`unknown command ${p.cmd}\n${USAGE}`, 2)
    }
  } catch (e) {
    return fail((e as Error).message)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
