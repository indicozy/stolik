import { findClaudePid, isInteractiveClaude, readCmdline } from '../../claudepid.ts'
import { oneShot, request } from '../channel/ipc.ts'
import type { AskMsg, AskResolvedMsg, HookMsg, PermResolvedPayload } from '../channel/protocol.ts'
import { callKey } from '../../brain/posttool.ts'

// Claude Code hook entrypoint: `node dist/hook.js <Event>`, payload JSON on stdin. PostToolUse is only sent through
// bin/tg-posttool-hook, which forwards it while a permission prompt is pending.
// Must always exit 0 and finish fast even if the router is down. Prints nothing to stdout, except for
// PermissionRequest (every tool), where the router may answer the dialog (see askTerminal).
// That request waits for the user (up to ASK_TIMEOUT_MS) and only while the user is away from the desk.

const EVENTS = new Set(['UserPromptSubmit', 'Stop', 'Notification', 'PermissionRequest', 'PostToolUse', 'PermResolved', 'AskResolved'])
const ASK_TIMEOUT_MS = 3500_000
const MAX_STDIN = 1_000_000
// PostToolUse carries tool_response too (a large Bash output, a big file), so its payload may be far larger. The input is
// reduced to a key before anything is sent, so only this read limit applies to it. PermResolved carries the tool input.
const MAX_STDIN_POSTTOOL = 32_000_000
const MAX_TEXT = 12_000
const STDIN_TIMEOUT_MS = 500
const STDIN_TIMEOUT_POSTTOOL_MS = 2000
const SEND_TIMEOUT_MS = 1200

function readStdin(maxBytes: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('')
    let size = 0
    const chunks: Buffer[] = []
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      process.stdin.removeListener('data', onData)
      process.stdin.removeListener('end', finish)
      process.stdin.removeListener('error', finish)
      process.stdin.pause()
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const onData = (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) return finish()
      chunks.push(chunk)
    }
    const timer = setTimeout(finish, timeoutMs)
    process.stdin.on('data', onData)
    process.stdin.once('end', finish)
    process.stdin.once('error', finish)
  })
}

function str(v: unknown, max = 2000): string | undefined {
  return typeof v === 'string' ? v.slice(0, max) : undefined
}

// Forwards a permission prompt (any tool, AskUserQuestion and ExitPlanMode included) to Telegram. The router answers
// with a decision when the user is away, or with nothing (then the terminal dialog shows).
async function askTerminal(claudePid: number | null, cwd: string, payload: any, race: boolean, raceId?: string): Promise<void> {
  const tool = typeof payload.tool_name === 'string' ? payload.tool_name : ''
  const msg: AskMsg = {
    t: 'ask', claudePid, cwd, tool_name: tool, tool_input: payload.tool_input,
    ...(race ? { race: true } : {}), ...(raceId ? { raceId } : {}),
  }
  const res = await request(msg, ASK_TIMEOUT_MS)
  const decision = res && typeof res === 'object' ? res.decision : undefined
  if (decision && typeof decision === 'object') {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }) + '\n')
  }
}

// The fields a PostToolUse event carries to the router: which tool ran, and a key of its input (plan 1.2). The input
// itself and tool_response are not sent: the key is a hash of the whole input plus its first characters.
function postToolUseFields(payload: any): { tool_name?: string; tool_use_id?: string; input_hash?: string; input_head?: string } {
  const out: { tool_name?: string; tool_use_id?: string; input_hash?: string; input_head?: string } = {
    tool_name: str(payload.tool_name, 200),
    tool_use_id: str(payload.tool_use_id, 200),
  }
  if (payload.tool_input !== undefined) {
    const key = callKey(payload.tool_input)
    out.input_hash = key.hash
    out.input_head = key.head
  }
  return out
}

// The fields a PermResolved event carries: the tool, the key of its input (as postToolUseFields), and the verdict. Null
// when the verdict is not 'allowed' or 'denied', or the tool or its input is missing: nothing is sent then.
export function permResolvedFields(payload: any): PermResolvedPayload | null {
  const verdict = payload.verdict
  const tool_name = str(payload.tool_name, 200)
  if ((verdict !== 'allowed' && verdict !== 'denied') || tool_name === undefined || payload.tool_input === undefined) return null
  const key = callKey(payload.tool_input)
  return { tool_name, input_hash: key.hash, input_head: key.head, verdict }
}

// The terminal answered a raced dialog: the router drops that ask's Telegram buttons (AskResolved, sent by the mod).
async function askResolved(raceId: string | undefined, verdict: string): Promise<void> {
  if (!raceId) return
  const msg: AskResolvedMsg = { t: 'ask_resolved', raceId, verdict }
  await oneShot(msg, SEND_TIMEOUT_MS)
}

// The value of `--race-id=<id>` in the hook's arguments, capped to a sane length.
function raceIdArg(): string | undefined {
  const arg = process.argv.slice(3).find((a) => a.startsWith('--race-id='))
  const id = arg?.slice('--race-id='.length).slice(0, 100)
  return id || undefined
}

async function main(): Promise<void> {
  const event = process.argv[2] ?? ''
  if (!EVENTS.has(event)) return
  // Print-mode claude runs (claude -p from other tools) are not sessions: exit before connecting.
  // An unreadable cmdline counts as interactive.
  const claudePid = findClaudePid()
  if (claudePid !== null) {
    const argv = readCmdline(claudePid)
    if (argv && !isInteractiveClaude(argv)) return
  }
  let payload: any = {}
  try {
    const parsed = JSON.parse(
      event === 'PostToolUse' || event === 'PermResolved' ? await readStdin(MAX_STDIN_POSTTOOL, STDIN_TIMEOUT_POSTTOOL_MS) : await readStdin(MAX_STDIN, STDIN_TIMEOUT_MS),
    )
    if (parsed && typeof parsed === 'object') payload = parsed
  } catch {
    // no or invalid payload: still forward the event with the process cwd
  }
  const cwd = str(payload.cwd, 4096) || process.cwd()
  if (event === 'PermResolved') {
    const fields = permResolvedFields(payload)
    if (fields) await oneShot({ t: 'hook', event: 'PermResolved', claudePid, cwd, payload: fields }, SEND_TIMEOUT_MS)
    return
  }
  if (event === 'PermissionRequest') return askTerminal(claudePid, cwd, payload, process.argv.slice(3).includes('--race'), raceIdArg())
  if (event === 'AskResolved') return askResolved(raceIdArg(), str(payload.verdict, 1000) ?? '')
  const msg: HookMsg = {
    t: 'hook',
    event: event as HookMsg['event'],
    claudePid,
    cwd,
    payload: {
      session_id: str(payload.session_id, 200),
      stop_hook_active: payload.stop_hook_active === true,
      last_assistant_message: str(payload.last_assistant_message, MAX_TEXT),
      notification_type: str(payload.notification_type, 200),
      message: str(payload.message, 2000),
      title: str(payload.title, 500),
      ...(event === 'PostToolUse' ? postToolUseFields(payload) : {}),
    },
  }
  await oneShot(msg, SEND_TIMEOUT_MS)
}

main()
  .catch(() => {})
  .finally(() => process.exit(0))
