// PreToolUse / PostToolUse hook for the read and web modes (design §4.10). The CLI passes the hook event as JSON on stdin;
// argv[2] is the mode (quick | read | web), argv[3] the policy file (HookPolicy JSON, src/brain/hook-policy.ts).
// It prints the deny JSON or nothing. It never allows by itself: the CLI flags stay the first layer. PreToolUse fails
// closed (any error is a deny); PostToolUse exits 0 silently on any error.
import { appendFileSync, readFileSync, statSync } from 'node:fs'
import { hookOutput, decideTool, type ModeName, type ToolDecision } from '../../brain/modes.ts'
import {
  auditLine,
  decideWebFetch,
  HOOK_CHECK_FAILED,
  denialLine,
  hostsFromToolResponse,
  parseHookPolicy,
  type HookPolicy,
} from '../../brain/hook-policy.ts'

const MODE_LIST: readonly string[] = ['quick', 'read', 'web']
const deny = (reason: string): string => hookOutput({ allow: false, reason })

// Lines of the per-run log (hosts seen in WebSearch results). A missing log is an empty set.
function seenFromLog(path: string | null): Set<string> {
  if (path === null) return new Set()
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
    throw err
  }
  return new Set(
    text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== ''),
  )
}

function audit(policy: HookPolicy, url: string, d: ToolDecision): void {
  if (policy.auditFile === null) return
  appendFileSync(policy.auditFile, auditLine(new Date().toISOString(), policy.mode, url, d.allow, d.reason) + '\n')
}

function preToolUse(mode: ModeName, policy: HookPolicy, input: Record<string, unknown>): string {
  const tool = typeof input.tool_name === 'string' ? input.tool_name : ''
  const toolInput =
    input.tool_input && typeof input.tool_input === 'object' ? (input.tool_input as Record<string, unknown>) : {}

  if (mode === 'web') {
    if (tool === 'WebSearch') return ''
    if (tool === 'WebFetch') {
      const url = typeof toolInput.url === 'string' ? toolInput.url : ''
      const seen = new Set([...policy.webHosts, ...seenFromLog(policy.webLog)])
      const d = decideWebFetch(url, policy, seen)
      audit(policy, url, d)
      return d.allow ? '' : deny(d.reason)
    }
    return deny(`${tool} is not allowed in web mode`)
  }

  if (tool !== 'Read' && tool !== 'Grep' && tool !== 'Glob' && tool !== 'Bash') {
    return deny(`${tool} is not allowed in ${mode} mode`)
  }
  const d = decideTool(mode, tool, toolInput, policy)
  return d.allow ? '' : deny(d.reason)
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// Adds one line to the run's denied log for a refused call (the addon counts and reports them). Never changes the decision:
// a failed write is ignored, and the deny still goes out.
function recordDenial(policy: HookPolicy, input: Record<string, unknown>): void {
  if (policy.deniedLog === null) return
  const tool = typeof input.tool_name === 'string' ? input.tool_name : ''
  const toolInput =
    input.tool_input && typeof input.tool_input === 'object' ? (input.tool_input as Record<string, unknown>) : {}
  try {
    appendFileSync(policy.deniedLog, denialLine(tool, toolInput, policy.home, isDirectory) + '\n')
  } catch {
    // Counting is best effort.
  }
}

function postToolUse(mode: ModeName, policy: HookPolicy, input: Record<string, unknown>): void {
  if (mode !== 'web' || input.tool_name !== 'WebSearch' || policy.webLog === null) return
  const hosts = hostsFromToolResponse(input.tool_response)
  if (hosts.length > 0) appendFileSync(policy.webLog, hosts.map((h) => h + '\n').join(''))
}

// Event of the hook call, or '' when stdin is not JSON.
function eventOf(raw: string): string {
  try {
    const v = JSON.parse(raw) as { hook_event_name?: unknown }
    return typeof v.hook_event_name === 'string' ? v.hook_event_name : ''
  } catch {
    return ''
  }
}

// Returns the text to print. Throws on any problem; the caller turns that into a deny (PreToolUse) or silence (PostToolUse).
function run(argvMode: string, policyPath: string, raw: string): string {
  if (!MODE_LIST.includes(argvMode)) throw new Error('unknown mode')
  const mode = argvMode as ModeName
  const policy = parseHookPolicy(readFileSync(policyPath, 'utf8'))
  if (policy === null) throw new Error('invalid policy file')
  if (policy.mode !== mode) throw new Error('policy mode does not match argv mode')
  const input = JSON.parse(raw) as Record<string, unknown>
  if (typeof input !== 'object' || input === null) throw new Error('hook input is not an object')
  const event = eventOf(raw)
  if (event === 'PostToolUse') {
    postToolUse(mode, policy, input)
    return ''
  }
  if (event !== 'PreToolUse') throw new Error('unknown hook event')
  const out = preToolUse(mode, policy, input)
  if (out !== '') recordDenial(policy, input)
  return out
}

let data = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c: string) => {
  data += c
})
process.stdin.on('error', () => {
  process.stdout.write(deny('could not read the hook input'), () => process.exit(0))
})
process.stdin.on('end', () => {
  let out = ''
  try {
    out = run(process.argv[2] ?? '', process.argv[3] ?? '', data)
  } catch {
    // PreToolUse: deny. PostToolUse: silence.
    out = eventOf(data) === 'PostToolUse' ? '' : deny(HOOK_CHECK_FAILED)
  }
  process.stdout.write(out, () => process.exit(0))
})
