// Addon host (plan 2.9): finds addons under the addons folder, starts the enabled ones (dependencies first), talks to
// each over NDJSON, filters what each may see, and isolates crashes. The bot keeps running when an addon dies.
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AddonInfo, AddonsPort, BuiltinAddon, Clock, DeclaringAddon, Logger, RouteAnswer, RoutePayload } from '../ports.ts'
import { currentTrace, newTraceId, runTraced, stderrLevel, traceFromPayload, type Level } from '../brain/observe.ts'
import type { MessageId } from '../brain/chat-types.ts'
import { filterPayload } from './access.ts'
import { consentHash, hasAccess, readManifest, type AccessField, type Manifest } from './manifest.ts'
import {
  LineFramer, encodeCallReply, encodeHostReply, encodeRequest, parseAddonCall, parseAddonLine, type AddonCallRequest, type AddonRequest,
} from './protocol.ts'
import type { AddonSettings } from './settings.ts'
import {
  cleanText, gate, general, media, routeMessage, replyPoint, tickSchedules as tickDue, type CleanResult, type FilterContext, type MediaFile,
} from './points.ts'

export const CALL_TIMEOUT_MS = 30_000
// The longest an addon may ask the host to wait for another addon (a slow transcription on the CPU).
export const RELAY_TIMEOUT_MAX_MS = 300_000
// Delay before the restart after the 1st and the 2nd crash in the window (1 s, then 5 s). The 3rd crash in the window
// disables the addon instead, so there is no later step.
export const BACKOFF_MS: readonly number[] = [1_000, 5_000]
export const CRASH_WINDOW_MS = 10 * 60_000
// Crashes within CRASH_WINDOW_MS that disable the addon (and send one alert).
export const CRASH_LIMIT = 3
export const CALLBACK_TIMEOUT_MS = 10_000
// Stop: an addon gets this long after SIGTERM to exit, then SIGKILL, then this long more to be reaped (on the clock).
export const ADDON_STOP_GRACE_MS = 3_000
export const ADDON_KILL_WAIT_MS = 1_000
// The one-time built-ins offer (router/handlers/builtins.ts) is made once; this flag records it.
export const BUILTINS_OFFERED_FLAG = 'builtins-offered'

// Requests an addon may send the host (protocol 2), and the access field each one needs (manifest.ts).
export const REQUEST_ACCESS: Readonly<Record<string, AccessField>> = {
  send: 'messages.send',
  folders: 'sessions.spawn',
  spawn: 'sessions.spawn',
  usage: 'usage.record',
  quota: 'usage.record',
  chatlog: 'chatlog.read',
  costs: 'usage.read',
  // The gate point's held messages (cost-guard): release one (delivered once), drop one, or read its text back.
  release: 'messages.gate',
  drop: 'messages.gate',
  held: 'messages.gate',
}
// The router's answer to an addon request. The router supplies it (src/router/addon-bridge.ts).
export type AddonRequestHandler = (addon: string, op: string, payload: Record<string, unknown>) => Promise<unknown>

// The part of a child process the host uses (node's ChildProcess satisfies it at run time).
export type ChildLike = {
  stdin: { write(chunk: string): boolean; on(event: 'error', fn: (e: Error) => void): unknown }
  stdout: { setEncoding(enc: 'utf8'): unknown; on(event: 'data', fn: (chunk: string) => void): unknown }
  stderr: { setEncoding(enc: 'utf8'): unknown; on(event: 'data', fn: (chunk: string) => void): unknown }
  on(event: 'exit' | 'error', fn: (arg: unknown) => void): unknown
  kill(signal?: string): boolean
}
export type SpawnFn = (file: string, args: string[], opts: { cwd: string; env: Record<string, string> }) => ChildLike
// Wraps the addon's argv in the machine's CPU pinning (config.ts pinned). Tests pass the identity.
export type PinFn = (file: string, args: string[]) => { file: string; args: string[] }

export type HostOptions = {
  // Folder with one sub-folder per addon (`<config dir>/addons`). Missing folder = no addons.
  addonsDir: string
  settings: AddonSettings
  clock: Clock
  logger: Logger
  // Sends one line to the home chat (the crash alert). Errors are swallowed by the host.
  alert: (text: string) => void
  pin: PinFn
  // Command words the core owns (/list, /to ...). An addon command with one of these names is refused.
  reservedCommands?: readonly string[]
  // Answers requests from addons (see REQUEST_ACCESS). Without it every request is refused.
  requests?: AddonRequestHandler
  // A read-only folder of addons shipped with stolik (`src/addons`). A folder of the same name under addonsDir wins.
  builtinDir?: string
  // Extra environment for every addon (GPU settings from the machine config).
  env?: Record<string, string>
  spawn?: SpawnFn
  // Each line an addon writes to stderr, with its level (src/router/log.ts writes <stateDir>/logs/addons/<name>.log).
  addonLog?: (name: string, level: Level, msg: string) => void
}

type Pending = { timer: unknown; finish: (err: Error | null, value?: unknown) => void }

type Entry = {
  // The folder name, which must equal the manifest name.
  name: string
  dir: string
  manifest: Manifest | null
  error: string | null
  enabled: boolean
  child: ChildLike | null
  framer: LineFramer
  pending: Map<number, Pending>
  crashes: number[]
  restartTimer: unknown
  // Set when the host is stopping this addon (shutdown, disable, removal). An exit while it is set is an intended stop:
  // it is not counted or logged as a crash, and no restart is scheduled. launch() clears it.
  stopping: boolean
  // Why the addon is not running, shown in /addons ("restarting in 5 s", "disabled after crashes").
  note: string
  // Shipped with stolik (the folder under builtinDir, not shadowed by a user folder of the same name).
  builtin: boolean
  // Restarts after crashes since the router started, and the reason of the last crash (for /debug).
  restarts: number
  lastError: string | null
  // A user addon whose manifest is not the one the owner allowed (or that has no allowance yet). It is stopped and
  // cannot be enabled until `stolik addon consent <name>` on the PC. Built-ins never need it.
  needsConsent: boolean
}

// A user folder whose name is a built-in's: ignored, and listed with this status.
type Shadow = { name: string; dir: string }

// The status (and refusal) text of a user addon whose manifest is not the one the owner allowed.
export const reconsentText = (name: string): string => `needs re-consent: run stolik addon consent ${name} on the PC`

// Keys of the parent environment an addon may inherit. Everything else (tokens included) is left behind.
const BASE_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'USER', 'TMPDIR', 'HF_HOME'] as const

export function defaultSpawn(file: string, args: string[], opts: { cwd: string; env: Record<string, string> }): ChildLike {
  return spawn(file, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as ChildLike
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// Folder names directly under `root`, hidden folders and staging folders skipped. A missing root has none.
function listFolders(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
  } catch {
    return []
  }
}

export class AddonHost implements AddonsPort {
  private readonly entries = new Map<string, Entry>()
  // Last tick time per schedule ("addon#index"), kept in memory: after a restart every schedule is due at its first tick.
  private readonly lastTick = new Map<string, number>()
  private readonly spawnFn: SpawnFn
  private readonly opts: HostOptions
  private seq = 0
  // Children whose 'exit' has fired. stop() waits only for the ones that have not.
  private readonly exited = new WeakSet<ChildLike>()
  // User folders ignored because a built-in has their name (re-read on each refresh).
  private shadows: Shadow[] = []
  // Built-in names whose shadowing was already reported (log and alert once per run).
  private readonly shadowReported = new Set<string>()

  constructor(opts: HostOptions) {
    this.opts = opts
    this.spawnFn = opts.spawn ?? defaultSpawn
  }

  // Re-reads the addons folders. New folders join (disabled unless settings say on); removed folders stop. A built-in
  // wins over a user folder of the same name (the user folder is ignored and reported). A user addon whose manifest is
  // not the one the owner allowed is stopped and disabled until it is allowed again (`stolik addon consent`).
  refresh(): void {
    const found = new Map<string, string>()
    this.shadows = []
    if (this.opts.builtinDir) for (const name of listFolders(this.opts.builtinDir)) found.set(name, join(this.opts.builtinDir, name))
    for (const name of listFolders(this.opts.addonsDir)) {
      const dir = join(this.opts.addonsDir, name)
      if (found.has(name)) {
        this.shadows.push({ name, dir })
        continue
      }
      found.set(name, dir)
    }
    this.reportShadows()
    const folders = [...found.keys()].sort()
    const seen = new Set(folders)
    for (const name of folders) {
      const dir = found.get(name) as string
      const r = readManifest(dir)
      let entry = this.entries.get(name)
      if (!entry) {
        entry = {
          name,
          dir,
          manifest: null,
          error: null,
          enabled: this.opts.settings.isEnabled(name),
          child: null,
          framer: new LineFramer(),
          pending: new Map(),
          crashes: [],
          stopping: false,
          restartTimer: null,
          note: '',
          builtin: false,
          restarts: 0,
          lastError: null,
          needsConsent: false,
        }
        this.entries.set(name, entry)
      }
      entry.dir = dir
      entry.builtin = this.opts.builtinDir !== undefined && dir === join(this.opts.builtinDir, name)
      if ('error' in r) {
        entry.manifest = null
        entry.error = r.error
        entry.needsConsent = false
      } else if (r.manifest.name !== name) {
        entry.manifest = null
        entry.error = `the folder must be named ${r.manifest.name}`
        entry.needsConsent = false
      } else {
        entry.manifest = r.manifest
        entry.error = null
        this.checkConsent(entry, r.manifest)
      }
    }
    for (const [name, entry] of [...this.entries]) {
      if (seen.has(name)) continue
      this.stopEntry(entry)
      this.entries.delete(name)
    }
  }

  // Built-ins ship with the code: their manifest is trusted and its hash follows it. A user addon needs its hash to match
  // the one the owner allowed; when it does not, a running one is stopped and switched off.
  private checkConsent(e: Entry, m: Manifest): void {
    const hash = consentHash(m)
    if (e.builtin) {
      if (this.opts.settings.consentHash(e.name) !== hash) this.opts.settings.setConsentHash(e.name, hash)
      e.needsConsent = false
      return
    }
    e.needsConsent = this.opts.settings.consentHash(e.name) !== hash
    if (!e.needsConsent) return
    if (e.enabled) {
      this.opts.logger.log(`addon ${e.name}: its manifest is not the one you allowed; stopped until stolik addon consent ${e.name}`)
      e.enabled = false
      e.note = ''
      this.opts.settings.setEnabled(e.name, false)
      this.stopEntry(e)
    }
  }

  // One line to the log and one alert per built-in name a user folder shadows.
  private reportShadows(): void {
    for (const sh of this.shadows) {
      if (this.shadowReported.has(sh.name)) continue
      this.shadowReported.add(sh.name)
      this.opts.logger.log(`addon folder ${sh.dir} shadows the built-in ${sh.name}: ignored`)
      try {
        this.opts.alert(`⚠️ A folder named ${sh.name} in your addons folder shadows the built-in addon ${sh.name}. It is ignored. Remove it with stolik addon remove ${sh.name}.`)
      } catch {
        // The alert is best effort.
      }
    }
  }

  // Starts every enabled addon, dependencies first.
  async start(): Promise<void> {
    this.refresh()
    this.startEnabled()
  }

  // Marks every addon as stopping, synchronously. The router calls this first thing on shutdown. systemd does not signal
  // the addons (the unit sets KillMode=process, src/cli/service.ts): the router signals them in stop(). Until then an
  // addon can still exit on its own (during the drain), and that exit is an intended stop, so the mark comes first.
  beginStop(): void {
    for (const e of this.entries.values()) e.stopping = true
  }

  // Stops every addon and waits until each has exited: SIGTERM, then SIGKILL after ADDON_STOP_GRACE_MS. Their settings
  // stay as they are.
  async stop(): Promise<void> {
    this.beginStop()
    const children: ChildLike[] = []
    for (const e of this.entries.values()) {
      if (e.child) children.push(e.child)
      this.stopEntry(e)
    }
    await this.waitExit(children, ADDON_STOP_GRACE_MS)
    const alive = children.filter((c) => !this.exited.has(c))
    for (const c of alive) {
      try {
        c.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }
    await this.waitExit(alive, ADDON_KILL_WAIT_MS)
  }

  // Resolves when every child in `children` has exited, or when `ms` has passed on the clock.
  private waitExit(children: ChildLike[], ms: number): Promise<void> {
    const waiting = children.filter((c) => !this.exited.has(c))
    if (waiting.length === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let timer: unknown = null
      const finish = (): void => {
        if (timer !== null) this.opts.clock.clearTimer(timer)
        resolve()
      }
      let left = waiting.length
      for (const c of waiting) {
        c.on('exit', () => {
          left -= 1
          if (left === 0) finish()
        })
      }
      timer = this.opts.clock.setTimer(finish, ms)
    })
  }

  // Installed addons, re-read from disk, in name order. A user folder that a built-in shadows is listed too, as ignored.
  list(): AddonInfo[] {
    this.refresh()
    const rows: AddonInfo[] = [...this.entries.values()].map((e) => this.info(e))
    for (const sh of this.shadows) {
      rows.push({
        name: sh.name,
        version: '?',
        enabled: false,
        running: false,
        status: `shadows built-in ${sh.name}, ignored`,
        provides: [],
        shadowed: true,
      })
    }
    return rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  // Enables (and starts) or disables (and stops) an addon. Null on success, else the reason it was refused.
  async setEnabled(name: string, on: boolean): Promise<string | null> {
    this.refresh()
    const e = this.entries.get(name)
    if (!e) return `No addon named ${name}.`
    if (!e.manifest) return `${name} has an invalid manifest: ${e.error}`
    if (on) {
      // Only the owner, on the PC, can allow a changed manifest (stolik addon consent). Nothing here can.
      if (e.needsConsent) return `${name} ${reconsentText(name)}.`
      const missing = this.missingRequirements(e)
      if (missing.length > 0) return `${name} needs ${missing.join(', ')} installed and enabled first.`
      const clash = e.manifest.provides.flatMap((p) => (p.point === 'command' ? [p.name] : [])).find((c) => this.reserved().includes(c))
      if (clash) return `The command /${clash} is used by stolik itself. ${name} cannot use it.`
      e.enabled = true
      e.crashes = []
      e.note = ''
      this.opts.settings.setEnabled(name, true)
      this.startEnabled()
      return null
    }
    const dependents = [...this.entries.values()]
      .filter((d) => d.enabled && d.manifest?.requires.includes(name))
      .map((d) => d.name)
    if (dependents.length > 0) return `${dependents.join(', ')} needs ${name}. Turn ${dependents.length > 1 ? 'them' : 'it'} off first.`
    e.enabled = false
    e.note = ''
    this.opts.settings.setEnabled(name, false)
    this.stopEntry(e)
    return null
  }

  // The installed addon that declares `word` as a prefix or a command, enabled or not (a valid manifest only).
  declaring(kind: 'prefix' | 'command', word: string): DeclaringAddon | null {
    this.refresh()
    const w = word.toLowerCase()
    for (const e of [...this.entries.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (!e.manifest) continue
      const hit = e.manifest.provides.some((p) =>
        kind === 'prefix' ? p.point === 'prefix' && p.words.some((x) => x.toLowerCase() === w) : p.point === 'command' && p.name === w,
      )
      if (hit) return { name: e.name, enabled: e.enabled, running: e.child !== null, status: this.info(e).status }
    }
    return null
  }

  // The built-in addons, in name order, with what the owner is asked to allow and whether the owner chose one before.
  builtins(): BuiltinAddon[] {
    this.refresh()
    return [...this.entries.values()]
      .filter((e): e is Entry & { manifest: Manifest } => e.builtin && e.manifest !== null)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((e) => ({
        name: e.name,
        version: e.manifest.version,
        enabled: e.enabled,
        choice: this.opts.settings.hasChoice(e.name),
        access: [...e.manifest.access],
        requires: [...e.manifest.requires],
        provides: e.manifest.provides.map((p) => p.point),
      }))
  }

  builtinsOffered(): boolean {
    return this.opts.settings.getFlag(BUILTINS_OFFERED_FLAG)
  }

  markBuiltinsOffered(): void {
    this.opts.settings.setFlag(BUILTINS_OFFERED_FLAG)
  }

  // The route point: the router addon's answer for a plain message (points.ts routeMessage), or null.
  async route(payload: RoutePayload): Promise<(RouteAnswer & { addon: string }) | null> {
    return routeMessage(this, payload)
  }

  // Sends `tick` to every schedule that is due (points.ts). The router calls it on a timer. Returns the keys ticked.
  async tickSchedules(now: number = this.opts.clock.now()): Promise<string[]> {
    return tickDue(this, now, this.lastTick)
  }

  // The reply of the addon whose prefix or command matches a home-chat message (points.ts), or null. An empty string
  // means the addon took the message and will send its own answer. `file`, when given, is fetched only once an addon
  // has matched; its fields go with the prefix call.
  async general(text: string, messageId?: MessageId, file?: () => Promise<Record<string, unknown> | null>): Promise<string | null> {
    return general(this, text, messageId, file)
  }

  // Whether `name` is an installed addon folder (no re-read of the folders: it runs for every gated message).
  isAddon(name: string): boolean {
    return this.entries.has(name)
  }

  // The gate point (points.ts): the addon that holds a message to a session, or null (pass).
  async gate(payload: Record<string, unknown>): Promise<{ addon: string } | null> {
    return gate(this, payload)
  }

  // The text of a voice or audio file from the first media addon that takes it (points.ts), or null.
  async media(file: MediaFile): Promise<{ addon: string; text: string } | null> {
    return media(this, file)
  }

  // The text after the text filters, and whether one of them marked it unpolished (points.ts).
  async cleanText(text: string, ctx: FilterContext): Promise<CleanResult> {
    return cleanText(this, text, ctx)
  }

  // A swipe-reply to a message an addon sent (the `reply` point). True when an addon took it.
  async reply(text: string, replyTo: MessageId, messageId: MessageId): Promise<boolean> {
    return (await replyPoint(this, text, replyTo, messageId)) !== null
  }

  // A tap on one of an addon's buttons. `data` is the part the addon wrote (the router strips `ax:<addon>:`);
  // `messageId` is the message the button was on.
  callback(name: string, data: string, messageId?: MessageId): Promise<{ toast?: string } | null> {
    const payload: Record<string, unknown> = { data }
    if (messageId !== undefined) payload.messageId = messageId
    return this.call(name, 'callback', payload, CALLBACK_TIMEOUT_MS) as Promise<{ toast?: string } | null>
  }

  // Calls one addon. The payload is filtered to the fields its manifest declares. Rejects on a timeout, on an error
  // reply, or when the addon is not running (a crash rejects every call that was waiting on it).
  call(name: string, op: string, payload: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    const e = this.entries.get(name)
    if (!e?.manifest) return Promise.reject(new Error(`no addon named ${name}`))
    const child = e.child
    if (!child) return Promise.reject(new Error(`addon ${name} is not running`))
    const clock = this.opts.clock
    // The deadline travels with every call (the addon may give up after it); it is not an access field (KEY_ACCESS).
    const { payload: filtered, dropped } = filterPayload({ ...payload, deadline: clock.now() + timeoutMs }, e.manifest)
    if (dropped.length > 0) this.opts.logger.debug(`addon ${name}: not sent ${dropped.join(', ')} (not declared)`)
    // The trace of the flow that asks (protocol 2, optional): the addon can log it and pass it back on its requests.
    const trace = currentTrace()
    const sent: Record<string, unknown> = trace ? { ...filtered, trace } : filtered
    const id = ++this.seq
    return new Promise<unknown>((resolve, reject) => {
      const timer = clock.setTimer(() => {
        if (!e.pending.delete(id)) return
        reject(new Error(`addon ${name} did not answer ${op} in ${Math.round(timeoutMs / 1000)} s`))
      }, timeoutMs)
      e.pending.set(id, {
        timer,
        finish: (err, value) => {
          clock.clearTimer(timer)
          if (err) reject(err)
          else resolve(value)
        },
      })
      try {
        child.stdin.write(encodeRequest(id, op, sent))
      } catch (err) {
        e.pending.delete(id)
        clock.clearTimer(timer)
        reject(new Error(`addon ${name}: write failed: ${errText(err)}`))
      }
    })
  }

  // Calls an addon op for the router (the /debug report reads the ML worker's status this way).
  query(name: string, op: string, payload: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    return this.call(name, op, payload, timeoutMs)
  }

  // A line for the router log (addon names and reasons only, never message text).
  log(msg: string): void {
    this.opts.logger.log(msg)
  }

  // Enabled addons that are running now, in name order. The dispatch in points.ts reads this.
  running(): Array<{ name: string; manifest: Manifest }> {
    return [...this.entries.values()]
      .filter((e): e is Entry & { manifest: Manifest } => e.enabled && e.child !== null && e.manifest !== null)
      .map((e) => ({ name: e.name, manifest: e.manifest }))
  }

  private reserved(): readonly string[] {
    return this.opts.reservedCommands ?? []
  }

  private info(e: Entry): AddonInfo {
    const provides = e.manifest ? e.manifest.provides.map((p) => p.point) : []
    const version = e.manifest?.version ?? '?'
    let status: string
    if (e.error) status = `invalid manifest: ${e.error}`
    else if (e.needsConsent) status = reconsentText(e.name)
    else if (!e.enabled) status = e.note || 'off'
    else if (e.child) status = 'running'
    else if (e.note) status = e.note
    else status = 'waiting to start'
    return { name: e.name, version, enabled: e.enabled, running: e.child !== null, status, provides, restarts: e.restarts, lastError: e.lastError }
  }

  // Required addons that are missing, invalid or switched off.
  private missingRequirements(e: Entry): string[] {
    if (!e.manifest) return []
    return e.manifest.requires.filter((r) => {
      const d = this.entries.get(r)
      return !d || !d.manifest || !d.enabled
    })
  }

  // Start order: every addon after the addons it requires. A dependency cycle leaves its addons out (with a note).
  private order(): Entry[] {
    const out: Entry[] = []
    const state = new Map<string, 'visiting' | 'done'>()
    const visit = (e: Entry): boolean => {
      const s = state.get(e.name)
      if (s === 'done') return true
      if (s === 'visiting') return false
      state.set(e.name, 'visiting')
      for (const r of e.manifest?.requires ?? []) {
        const d = this.entries.get(r)
        if (d && !visit(d)) return false
      }
      state.set(e.name, 'done')
      out.push(e)
      return true
    }
    for (const e of this.entries.values()) {
      if (!visit(e)) e.note = 'requirements form a cycle'
    }
    return out
  }

  private startEnabled(): void {
    for (const e of this.order()) if (e.enabled) this.launch(e)
  }

  private launch(e: Entry): void {
    if (!e.manifest || !e.enabled || e.needsConsent || e.child || e.restartTimer) return
    const missing = this.missingRequirements(e)
    if (missing.length > 0) {
      e.note = `waiting for ${missing.join(', ')}`
      return
    }
    const [first, ...args] = e.manifest.command
    // A bare `node` runs with the bot's own Node binary (PATH under systemd may not have it).
    const cmd = first === 'node' ? process.execPath : first
    const pinned = this.opts.pin(cmd, args)
    let child: ChildLike
    e.stopping = false
    try {
      child = this.spawnFn(pinned.file, pinned.args, { cwd: e.dir, env: this.childEnv(e.name) })
    } catch (err) {
      this.crashed(e, `could not start: ${errText(err)}`)
      return
    }
    e.child = child
    e.framer = new LineFramer()
    e.note = ''
    child.stdin.on('error', () => {
      // A write to a dead addon fails here; its exit is handled below.
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(e, child, chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) if (line.trim()) this.addonStderr(e.name, line.trim().slice(0, 300))
    })
    child.on('error', (err) => this.childGone(e, child, errText(err)))
    child.on('exit', (code: unknown) => {
      this.exited.add(child)
      this.childGone(e, child, `exited (code ${String(code)})`)
    })
    this.opts.logger.log(`addon ${e.name} started`)
  }

  private onStdout(e: Entry, child: ChildLike, chunk: string): void {
    if (e.child !== child) return
    let lines: string[]
    try {
      lines = e.framer.push(chunk)
    } catch (err) {
      this.childGone(e, child, errText(err))
      try {
        child.kill('SIGTERM')
      } catch {
        // Already gone.
      }
      return
    }
    for (const line of lines) {
      // Addon-to-addon calls first: their lines also carry `op`, which parseAddonLine would read as a host request.
      const call = parseAddonCall(line)
      if (call) {
        void runTraced(traceFromPayload(call.payload.trace) ?? newTraceId(), () => this.serveCall(e, child, call))
        continue
      }
      const parsed = parseAddonLine(line)
      if (!parsed) {
        this.opts.logger.debug(`addon ${e.name}: a stdout line that is not a reply was ignored`)
        continue
      }
      if (parsed.kind === 'request') {
        void runTraced(traceFromPayload(parsed.payload.trace) ?? newTraceId(), () => this.onRequest(e, child, parsed))
        continue
      }
      const reply = parsed.reply
      const p = e.pending.get(reply.id)
      if (!p) continue
      e.pending.delete(reply.id)
      if (reply.ok) p.finish(null, reply.result)
      else p.finish(new Error(reply.error))
    }
  }

  // An addon asked for a call to another addon (plan 3.1). Only an addon it lists in `requires` may make it. The answer
  // goes back on the caller's stdin, unless the caller is gone by then.
  private async serveCall(e: Entry, child: ChildLike, req: AddonCallRequest): Promise<void> {
    const reply = (outcome: { result: unknown } | { error: string }): void => {
      if (e.child !== child) return
      try {
        child.stdin.write(encodeCallReply(req.id, outcome))
      } catch {
        // The caller died while waiting; its exit is handled elsewhere.
      }
    }
    if (!e.manifest?.requires.includes(req.addon)) {
      this.opts.logger.log(`addon ${e.name}: call to ${req.addon} refused (not in requires)`)
      return reply({ error: `${e.name} may not call ${req.addon}: it is not in its requires` })
    }
    // Requiring an addon is not enough: it answers only the ops it lists in `serves`.
    if (!this.entries.get(req.addon)?.manifest?.serves.includes(req.op)) {
      this.opts.logger.log(`addon ${e.name}: call to ${req.addon}.${req.op} refused (not served)`)
      return reply({ error: `${req.addon} does not serve ${req.op} to other addons` })
    }
    const timeoutMs = Math.min(Math.max(req.timeoutMs ?? CALL_TIMEOUT_MS, 1_000), RELAY_TIMEOUT_MAX_MS)
    try {
      reply({ result: await this.call(req.addon, req.op, req.payload, timeoutMs) })
    } catch (err) {
      reply({ error: errText(err) })
    }
  }

  // An addon's request: checked against its declared access, answered by the router, and the answer written back to
  // the addon's stdin. A refused or failing request gets an error reply; nothing else changes.
  private async onRequest(e: Entry, child: ChildLike, req: AddonRequest): Promise<void> {
    const answer = (outcome: { ok: true; result: unknown } | { ok: false; error: string }): void => {
      if (e.child !== child) return
      try {
        child.stdin.write(encodeHostReply(req.id, outcome))
      } catch {
        // The addon is gone; its exit is handled elsewhere.
      }
    }
    const field = REQUEST_ACCESS[req.op]
    if (!field) return answer({ ok: false, error: `unknown request ${req.op}` })
    if (!e.manifest || !hasAccess(e.manifest, field)) return answer({ ok: false, error: `${e.name} did not declare ${field}` })
    if (!this.opts.requests) return answer({ ok: false, error: 'the host has no request handler' })
    try {
      answer({ ok: true, result: await this.opts.requests(e.name, req.op, req.payload) })
    } catch (err) {
      this.opts.logger.log(`addon ${e.name}: request ${req.op} failed: ${errText(err)}`)
      answer({ ok: false, error: errText(err) })
    }
  }

  // The child is gone (exit, error or protocol failure). Its waiting calls fail; the addon is restarted or disabled.
  private childGone(e: Entry, child: ChildLike, reason: string): void {
    if (e.child !== child) return
    e.child = null
    this.failPending(e, `addon ${e.name} stopped: ${reason}`)
    if (e.stopping) return // an intended stop, not a crash
    this.crashed(e, reason)
  }

  // One stderr line of an addon: its own log file, and the journal. A warning or an error also goes to the Logs topic.
  private addonStderr(name: string, text: string): void {
    const level = stderrLevel(text)
    this.opts.addonLog?.(name, level, text)
    const line = `addon ${name}: ${text}`
    if (level === 'info') return this.opts.logger.log(line)
    const sink = level === 'error' ? this.opts.logger.error : this.opts.logger.warn
    if (sink) sink.call(this.opts.logger, text, `addon:${name}`)
    else this.opts.logger.log(line)
  }

  // A warning or an error through the logger's own level when it has one (the Logs topic), else as a log line.
  private report(level: 'warn' | 'error', msg: string, component: string): void {
    const fn = this.opts.logger[level]
    if (fn) fn.call(this.opts.logger, msg, component)
    else this.opts.logger.log(msg)
  }

  private crashed(e: Entry, reason: string): void {
    if (!e.enabled || e.stopping) return
    const now = this.opts.clock.now()
    e.crashes = e.crashes.filter((t) => now - t < CRASH_WINDOW_MS)
    e.crashes.push(now)
    e.lastError = reason.slice(0, 300)
    this.report('warn', `addon ${e.name} crashed (${e.crashes.length} in 10 min): ${reason}`, 'addons')
    if (e.crashes.length >= CRASH_LIMIT) {
      e.enabled = false
      e.note = 'disabled after 3 crashes in 10 minutes'
      this.opts.settings.setEnabled(e.name, false)
      this.report('error', `addon ${e.name} disabled after 3 crashes in 10 minutes: ${reason}`, 'addons')
      try {
        this.opts.alert(`⚠️ Addon ${e.name} crashed 3 times in 10 minutes and is now disabled. Turn it on again in /addons.`)
      } catch {
        // The alert is best effort.
      }
      return
    }
    // Crashes 1 and 2 restart after BACKOFF_MS[0] and [1]. Crash 3 (CRASH_LIMIT) disabled the addon above.
    const delay = BACKOFF_MS[Math.min(e.crashes.length - 1, BACKOFF_MS.length - 1)]
    e.restarts++
    e.note = `restarting in ${delay / 1000} s`
    e.restartTimer = this.opts.clock.setTimer(() => {
      e.restartTimer = null
      this.launch(e)
    }, delay)
  }

  // Intentional stop (disable, remove, router shutdown). Not a crash.
  private stopEntry(e: Entry): void {
    e.stopping = true
    if (e.restartTimer) {
      this.opts.clock.clearTimer(e.restartTimer)
      e.restartTimer = null
    }
    const child = e.child
    e.child = null
    this.failPending(e, `addon ${e.name} was stopped`)
    if (child) {
      try {
        child.kill('SIGTERM')
      } catch {
        // Already gone.
      }
    }
  }

  private failPending(e: Entry, msg: string): void {
    const waiting = [...e.pending.values()]
    e.pending.clear()
    for (const p of waiting) p.finish(new Error(msg))
  }

  private childEnv(name: string): Record<string, string> {
    const env: Record<string, string> = {}
    for (const k of BASE_ENV_KEYS) {
      const v = process.env[k]
      if (v !== undefined) env[k] = v
    }
    return { ...env, ...(this.opts.env ?? {}), STOLIK_ADDON: name }
  }
}
