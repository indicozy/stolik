// Policy and pure checks for the PreToolUse / PostToolUse hook of the read and web modes (design §4.10). No I/O here:
// the hook script (src/addons/modes/hook.ts) reads the policy file and the per-run log, and appends the audit.
import { posix } from 'node:path'
import { hookOutput, type ModeName, type ToolDecision, type ToolPolicy } from './modes.ts'

export type HookPolicy = ToolPolicy & {
  mode: ModeName
  // Hosts named in the owner's question: allowed for WebFetch in this run.
  webHosts: string[]
  // Per-run file where PostToolUse writes the hosts seen in WebSearch results (one host per line), or null.
  webLog: string | null
  // Append-only audit of every URL decision, or null (tests).
  auditFile: string | null
  // Per-run file where every refused call adds one `tool<TAB>folder` line (denialLine), or null. The addon counts them.
  deniedLog: string | null
}

const MODES: readonly string[] = ['quick', 'read', 'web']
const POLICY_KEYS = ['mode', 'home', 'cwd', 'roots', 'webHosts', 'webLog', 'auditFile', 'deniedLog'] as const
const HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/

// Fail closed: any missing, extra or wrongly typed field gives null.
export function parseHookPolicy(text: string): HookPolicy | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const keys = Object.keys(o)
  if (keys.length !== POLICY_KEYS.length || !POLICY_KEYS.every((k) => keys.includes(k))) return null

  const isAbs = (v: unknown): v is string => typeof v === 'string' && v.startsWith('/') && !v.includes('\0')
  const isAbsOrNull = (v: unknown): v is string | null => v === null || isAbs(v)
  if (typeof o.mode !== 'string' || !MODES.includes(o.mode)) return null
  if (!isAbs(o.home) || !isAbs(o.cwd)) return null
  if (!Array.isArray(o.roots) || !o.roots.every(isAbs)) return null
  if (!Array.isArray(o.webHosts) || !o.webHosts.every((h) => typeof h === 'string' && HOST_RE.test(h))) return null
  if (!isAbsOrNull(o.webLog) || !isAbsOrNull(o.auditFile) || !isAbsOrNull(o.deniedLog)) return null

  return {
    mode: o.mode as ModeName,
    home: o.home,
    cwd: o.cwd,
    roots: o.roots as string[],
    webHosts: o.webHosts as string[],
    webLog: o.webLog as string | null,
    auditFile: o.auditFile as string | null,
    deniedLog: o.deniedLog as string | null,
  }
}

const DENIED_FOLDER_MAX = 200

// One line of the denied log for a refused call: the tool and the folder it reached for, never the file name, the command
// or the content. A file path gives its folder; a Grep or Glob path is already a folder; a Bash call has none ('-').
// The home folder shows as ~. Control characters are dropped, and the folder is cut to DENIED_FOLDER_MAX characters.
// Grep and Glob take a folder or a file in `path`: only a folder (isDirectory, the hook asks the disk) is its own folder.
export function denialLine(
  tool: string,
  input: Record<string, unknown>,
  home: string,
  isDirectory: (path: string) => boolean = () => false,
): string {
  const name = tool.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || '?'
  let folder = '-'
  const path = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : ''
  if (path !== '' && tool !== 'Bash') {
    const abs = posix.normalize(path.startsWith('/') ? path : '/' + path)
    const ownFolder = (tool === 'Grep' || tool === 'Glob') && typeof input.path === 'string' && isDirectory(path)
    folder = ownFolder ? abs : posix.dirname(abs)
    if (folder === home) folder = '~'
    else if (folder.startsWith(home + '/')) folder = '~' + folder.slice(home.length)
    folder = folder.replace(/[\x00-\x1f\x7f]/g, '').slice(0, DENIED_FOLDER_MAX)
  }
  return `${name}\t${folder}`
}

// A Read of /proc/self/environ: the hook must deny it. The addon runs it at start and refuses to run the mode if the
// hook does not answer with the deny JSON.
// The event carries hook_event_name, as the CLI sends it: the hook refuses an event it does not know (it reads that
// field), so without it the self-test would fail on a missing field and never reach the guard.
export function selfTestInput(_home: string): { hook_event_name: string; tool_name: string; tool_input: Record<string, unknown> } {
  return { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/proc/self/environ' } }
}

// The reason the hook gives when it cannot read its policy or input (it fails closed). It is not a check of the guard.
export const HOOK_CHECK_FAILED = 'the hook could not check this call'

// True only when stdout is exactly the deny JSON that hookOutput gives for the reason it carries, and that reason is a
// real refusal (a policy the hook could not read also denies, and must not pass as a working guard).
export function selfTestPasses(stdout: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    return false
  }
  if (typeof parsed !== 'object' || parsed === null) return false
  const inner = (parsed as Record<string, unknown>).hookSpecificOutput
  if (typeof inner !== 'object' || inner === null) return false
  const reason = (inner as Record<string, unknown>).permissionDecisionReason
  if (typeof reason !== 'string' || reason === HOOK_CHECK_FAILED) return false
  return stdout.trim() === hookOutput({ allow: false, reason })
}

const QUERY_MAX = 100
const SEGMENT_MAX = 64
const ENCODED_RE = /^[A-Za-z0-9+/_=-]{40,}$/

function looksEncoded(s: string): boolean {
  return ENCODED_RE.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s)
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

// One WebFetch decision (design §4.10, finding 7). Pure: the caller writes the audit line.
// seenHosts: hosts from prior WebSearch results of this run (the webLog lines).
export function decideWebFetch(url: string, policy: HookPolicy, seenHosts: ReadonlySet<string>): ToolDecision {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { allow: false, reason: 'the URL does not parse' }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { allow: false, reason: 'only http and https URLs are allowed' }
  if (u.username !== '' || u.password !== '') return { allow: false, reason: 'URLs with user:pass@ are not allowed' }

  const host = u.hostname.toLowerCase()
  const named = policy.webHosts.includes(host)
  if (!named && !seenHosts.has(host)) {
    return { allow: false, reason: `host ${host} is not in the question or in a search result of this run` }
  }

  if (u.search.slice(1).length > QUERY_MAX) return { allow: false, reason: `query string longer than ${QUERY_MAX} characters` }

  for (const seg of u.pathname.split('/')) {
    if (seg === '') continue
    const decoded = decodeSegment(seg)
    if (seg.length > SEGMENT_MAX || decoded.length > SEGMENT_MAX) {
      return { allow: false, reason: `path segment longer than ${SEGMENT_MAX} characters` }
    }
    if (looksEncoded(seg) || looksEncoded(decoded)) return { allow: false, reason: 'path segment looks like encoded data' }
  }

  return { allow: true, reason: named ? 'host named in the question' : 'host seen in a search result of this run' }
}

// Lower-case hosts of the http(s) URLs in a text, each once.
export function hostsInText(text: string): string[] {
  const found = new Set<string>()
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'`\\()[\]{}]+/gi)) {
    try {
      const h = new URL(m[0]).hostname.toLowerCase()
      if (h !== '') found.add(h)
    } catch {
      // not a URL: skip
    }
  }
  return [...found]
}

// Hosts of every http(s) URL in a WebSearch tool_response.
export function hostsFromToolResponse(response: unknown): string[] {
  let text: string
  if (typeof response === 'string') text = response
  else {
    try {
      text = JSON.stringify(response) ?? ''
    } catch {
      text = ''
    }
  }
  return hostsInText(text)
}

// One audit line: ts, mode, allow|deny, URL (capped at 500 characters), reason; tab separated, no line breaks.
export function auditLine(ts: string, mode: string, url: string, allowed: boolean, reason: string): string {
  const clean = (s: string): string => s.replace(/[\x00-\x1f\x7f]/g, ' ')
  return [ts, mode, allowed ? 'allow' : 'deny', clean(url).slice(0, 500), clean(reason)].join('\t')
}
