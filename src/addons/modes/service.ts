// The modes addon's logic (plan 2.11): a prefix or a swipe-reply starts a headless run; the answer goes to General with
// its footer and buttons; Continue resumes a run that hit its limit; Upgrade starts a full session in a folder.
// Everything that touches the world goes through `ServiceDeps`, so the tests drive it with fakes.
// Host calls that can be slow (the quota check, a run, a folder pick) happen after the callback has answered: the router
// waits about 10 s for a reply, and a swipe-reply that is also routed elsewhere would be handled twice.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  KEY_RE,
  MODE_TIMEOUT_MS,
  classifyRun,
  dropSecretLines,
  estimateCostUsd,
  formatFooter,
  hookSettings,
  modeArgv,
  modeForWord,
  modesCwd,
  readRoots,
  upgradePrompt,
  type ModeName,
  type ThreadEntry,
  ThreadMap,
} from '../../brain/modes.ts'
import { hostsInText, selfTestInput, selfTestPasses, type HookPolicy } from '../../brain/hook-policy.ts'
import type { Semaphore } from '../../brain/concurrency.ts'
import type { RawRun } from './run.ts'
import type { MessageId } from '../../brain/chat-types.ts'

export type Btn = { text: string; data: string }
export type Rows = Btn[][]
export type Reply = { reply?: string; handled?: boolean }
export type Folder = { name: string; path: string }

export type ServiceDeps = {
  // Asks the host (send, folders, spawn, usage, quota).
  request(op: string, payload: Record<string, unknown>): Promise<unknown>
  // Runs `claude` with these arguments in `cwd` (pinned, environment and timeout are the caller's concern).
  run(args: string[], timeoutMs: number, cwd: string): Promise<RawRun>
  // The hook command for a read or web run, given the policy file it reads.
  hookCommand(mode: ModeName, policyPath: string): string
  // Runs a command through `sh -c` with `stdin` text and returns its stdout (the hook self-test).
  runHook(command: string, stdin: string): Promise<string>
  // The modes state folder: run files under hooks/, the neutral working folder, the web audit log.
  stateDir: string
  // Read roots besides the project: the chat-log folder and the notes folder.
  logRoot: string
  notesDir: string
  now(): number
  home: string
  threads: ThreadMap
  saveThreads(): void
  newKey(): string
  semaphore: Semaphore
  log(msg: string): void
}

export const MAX_FOLDER_BUTTONS = 8
// Runs that may wait for a slot at once; the next one is refused (so a flood cannot queue without end).
export const MAX_WAITERS = 10
export const TOO_MANY_WAITING = 'Too many mode runs are waiting. Try again later.'
export const HOOK_OFF = 'Modes are paused: the safety check of the hook failed; read and web are off.'
const CONTINUE_PROMPT = 'Continue.'

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// The ids the host sends are opaque strings (protocol 2); the addon never parses them, it echoes them back as they came.
const wireMsg = (v: unknown): MessageId | undefined => (typeof v === 'string' && v !== '' ? (v as MessageId) : undefined)

// The text of an answer that was withheld for naming a secret path. With refusals, the count follows (the guard's view).
export function withheldText(refusals: number): string {
  const base = 'The answer named a secret path or file, so it was withheld.'
  if (refusals === 0) return base
  return `${base} The read-mode guard refused ${refusals} ${refusals === 1 ? 'file read' : 'file reads'}.`
}

export class ModesService {
  private readonly deps: ServiceDeps
  // read and web stay off until the hook passes its self-test (fail closed).
  private hookSafe = false

  constructor(deps: ServiceDeps) {
    this.deps = deps
  }

  // A General message `word: question`. Answers at once with `handled`; the run's answer follows in General.
  async onPrefix(payload: Record<string, unknown>): Promise<Reply> {
    const word = typeof payload.word === 'string' ? payload.word : ''
    const mode = modeForWord(word)
    if (!mode) return { reply: `No mode named ${word}.` }
    const question = typeof payload.text === 'string' ? payload.text.trim() : ''
    const replyTo = wireMsg(payload.messageId)
    if (question === '') return { reply: `Write the question after the colon, for example: ${word}: what is using the disk?` }
    if (question.startsWith('-')) return { reply: 'The question cannot start with a dash.' }
    return this.start(mode, question, { replyTo })
  }

  // A swipe-reply to one of this addon's answers continues that thread (`--resume`). False when the message is not one
  // of ours, so the router routes it as usual. The work runs in the background: the router must not wait for it.
  async onReply(payload: Record<string, unknown>): Promise<{ handled: boolean }> {
    const replyTo = wireMsg(payload.replyTo) ?? null
    const messageId = wireMsg(payload.messageId)
    if (replyTo === null) return { handled: false }
    const entry = this.deps.threads.get(replyTo)
    if (!entry) return { handled: false }
    const text = typeof payload.text === 'string' ? payload.text.trim() : ''
    this.inBackground('reply', async () => {
      if (text === '') {
        await this.sendText('Write the follow-up as a message.', messageId)
        return
      }
      const r = await this.start(entry.mode, text, { replyTo: messageId, base: entry, resumeId: entry.sessionId })
      if (r.reply) await this.sendText(r.reply, messageId)
    })
    return { handled: true }
  }

  // A tap on one of this addon's buttons: Continue, Upgrade, or a folder for Upgrade. Answers with a toast at once; the
  // work follows in the background and posts its own messages.
  async onCallback(payload: Record<string, unknown>): Promise<{ toast?: string }> {
    const data = typeof payload.data === 'string' ? payload.data : ''
    const messageId = wireMsg(payload.messageId)
    const cont = /^c:([0-9a-f]{8})$/.exec(data)
    if (cont && KEY_RE.test(cont[1])) {
      const entry = this.deps.threads.byKey(cont[1])
      if (!entry) return { toast: 'That answer is too old. Ask again.' }
      this.inBackground('continue', async () => {
        const r = await this.start(entry.mode, CONTINUE_PROMPT, { replyTo: messageId, base: entry, resumeId: entry.sessionId })
        if (r.reply) await this.sendText(r.reply, messageId)
      })
      return { toast: 'Continuing.' }
    }
    const up = /^u:([0-9a-f]{8})$/.exec(data)
    if (up && KEY_RE.test(up[1])) {
      const entry = this.deps.threads.byKey(up[1])
      if (!entry) return { toast: 'That answer is too old. Ask again.' }
      this.inBackground('upgrade', async () => {
        const folders = await this.folders()
        if (folders.length === 0) {
          await this.sendText('No folder to start in.', messageId)
          return
        }
        const rows: Rows = folders.slice(0, MAX_FOLDER_BUTTONS).map((f, i) => [{ text: f.name, data: `p:${entry.key}:${i}` }])
        await this.send('Start a full session in which folder? Its first message carries the question and the answer.', rows, messageId)
      })
      return { toast: 'Pick a folder.' }
    }
    const pick = /^p:([0-9a-f]{8}):(\d{1,2})$/.exec(data)
    if (pick && KEY_RE.test(pick[1])) {
      const entry = this.deps.threads.byKey(pick[1])
      if (!entry) return { toast: 'That choice is too old. Ask again.' }
      const index = Number(pick[2])
      this.inBackground('pick', async () => {
        const folder = (await this.folders())[index]
        if (!folder) {
          await this.sendText('That choice is too old. Ask again.', messageId)
          return
        }
        await this.upgrade(entry, folder, messageId)
      })
      return { toast: 'Starting.' }
    }
    return { toast: 'Unknown button.' }
  }

  // Runs the hook once on a known secret read and checks that it refuses it. read and web stay off unless it passes.
  // Called once at start; the result is logged.
  async selfTest(): Promise<boolean> {
    const runId = randomUUID()
    let ok = false
    try {
      this.ensureDirs()
      const policyPath = join(this.hooksDir, `${runId}.json`)
      writeFileSync(policyPath, JSON.stringify(this.buildPolicy('read', '', null, [])), { mode: 0o600 })
      const stdout = await this.deps.runHook(this.deps.hookCommand('read', policyPath), JSON.stringify(selfTestInput(this.deps.home)))
      ok = selfTestPasses(stdout)
    } catch (e) {
      this.deps.log(`hook self-test error: ${errText(e)}`)
    } finally {
      this.removeRunFiles(runId)
    }
    this.hookSafe = ok
    this.deps.log(ok ? 'hook self-test passed: read and web are on' : 'hook self-test FAILED: read and web are off')
    return ok
  }

  // Runs the work in the background; a failure is logged, never thrown into the router.
  private inBackground(label: string, work: () => Promise<void>): void {
    work().catch((e: unknown) => this.deps.log(`${label} failed: ${errText(e)}`))
  }

  // Runs one mode if the quota allows and a slot or a waiting place is free; the run itself goes on in the background and
  // posts its own answer.
  private async start(
    mode: ModeName,
    prompt: string,
    opts: { replyTo?: MessageId; base?: ThreadEntry; resumeId?: string },
  ): Promise<Reply> {
    if ((mode === 'read' || mode === 'web') && !this.hookSafe) return { reply: HOOK_OFF }
    const gate = await this.quotaGate()
    if (gate.refuse) return { reply: `Modes are paused: ${gate.reason}.` }
    const sem = this.deps.semaphore
    const busy = sem.active >= sem.capacity
    if (busy && sem.waiting >= MAX_WAITERS) return { reply: TOO_MANY_WAITING }
    // execute() takes its place in the semaphore queue before its first await, so the count above stays right.
    this.inBackground(`mode ${mode}`, () => this.execute(mode, prompt, opts))
    if (busy) await this.sendText(`⏳ waiting: ${sem.capacity} mode runs are already going. This one starts when one finishes.`, opts.replyTo)
    return { handled: true }
  }

  private async execute(
    mode: ModeName,
    prompt: string,
    opts: { replyTo?: MessageId; base?: ThreadEntry; resumeId?: string },
  ): Promise<void> {
    const release = await this.deps.semaphore.acquire()
    const runId = randomUUID()
    try {
      // The quota can change while this run waited for its slot.
      const gate = await this.quotaGate()
      if (gate.refuse) {
        await this.sendText(`Modes are paused: ${gate.reason}.`, opts.replyTo)
        return
      }
      const question = opts.base ? `${opts.base.question}\n\n${prompt}` : prompt
      const { cwd, roots, settingsPath } = await this.writeRunFiles(mode, question, runId)
      const args = modeArgv(mode, { prompt, resumeId: opts.resumeId, settingsPath, roots, home: this.deps.home })
      const raw = await this.deps.run(args, MODE_TIMEOUT_MS[mode], cwd)
      const refused = mode === 'read' ? this.readRefusals(runId) : []
      this.logRefusals(mode, refused)
      if (raw.timedOut) {
        await this.recordUsage(mode, estimateCostUsd(mode, raw.durationMs), raw.durationMs, 'error')
        await this.sendText(`Stopped: the ${mode} run ran past its time limit and was cut off. Ask again, or make the question narrower.`, opts.replyTo)
        return
      }
      const out = classifyRun(raw.stdout)
      if (out.kind === 'error') {
        await this.recordUsage(mode, out.costUsd, raw.durationMs, 'error')
        await this.sendText(`Could not answer: ${out.message}`, opts.replyTo)
        return
      }
      const text = dropSecretLines(out.text)
      await this.recordUsage(mode, out.costUsd, raw.durationMs, out.kind)
      const partial = out.kind === 'limit'
      // An answer whose every line named a secret path is withheld as a whole: say so, rather than an empty answer.
      const body =
        text !== ''
          ? text
          : out.text.trim() !== ''
            ? withheldText(refused.length)
            : partial
              ? `No answer before the step limit (${out.numTurns} steps).`
              : '(the answer had no text)'
      const footer = formatFooter(out.costUsd, raw.durationMs)
      // A session id is needed for Continue and swipe-replies; without one the answer is shown with no buttons.
      const sessionId = out.sessionId !== '' ? out.sessionId : (opts.base?.sessionId ?? '')
      const key = this.deps.newKey()
      const buttons: Btn[] = []
      if (partial && sessionId !== '') buttons.push({ text: 'Continue', data: `c:${key}` })
      if (mode === 'read' && sessionId !== '') buttons.push({ text: 'Upgrade', data: `u:${key}` })
      const rows: Rows = buttons.length > 0 ? [buttons] : []
      const answer = opts.base ? `${opts.base.answer}\n\n${text}`.trim() : text
      const ids = await this.send(`${body}\n\n${footer}`, rows, opts.replyTo)
      if (sessionId !== '') {
        const entry: ThreadEntry = { key, mode, sessionId, question, answer, partial, ts: this.deps.now() }
        for (const id of ids) this.deps.threads.set(id, entry)
        this.deps.saveThreads()
      }
    } finally {
      this.removeRunFiles(runId)
      release()
    }
  }

  // The refused calls of a read run, from its denied log: one `tool<TAB>folder` entry per line. A missing log is none.
  private readRefusals(runId: string): Array<{ tool: string; folder: string }> {
    let text: string
    try {
      text = readFileSync(join(this.hooksDir, `${runId}.denied.log`), 'utf8')
    } catch {
      return []
    }
    return text
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => {
        const [tool = '?', folder = '-'] = l.split('\t')
        return { tool, folder }
      })
  }

  // One warning per refused call, by tool and folder (the Logs topic gets them: the line starts with "warning:").
  private logRefusals(mode: ModeName, refused: Array<{ tool: string; folder: string }>): void {
    for (const r of refused) {
      this.deps.log(`warning: ${mode}-mode guard refused ${r.tool}${r.folder === '-' ? '' : ` in ${r.folder}`}`)
    }
  }

  private get hooksDir(): string {
    return join(this.deps.stateDir, 'hooks')
  }

  // The folder quick and web run in: empty, so no CLAUDE.md or memory of the master project is loaded.
  private get neutralDir(): string {
    return join(this.deps.stateDir, 'neutral')
  }

  private get auditFile(): string {
    return join(this.deps.stateDir, 'web-audit.log')
  }

  private ensureDirs(): void {
    mkdirSync(this.hooksDir, { recursive: true, mode: 0o700 })
    mkdirSync(this.neutralDir, { recursive: true, mode: 0o700 })
  }

  private buildPolicy(
    mode: 'read' | 'web',
    question: string,
    webLog: string | null,
    trustedDirs: string[],
    deniedLog: string | null = null,
  ): HookPolicy {
    const home = this.deps.home
    if (mode === 'read') {
      return {
        home,
        cwd: modesCwd(home),
        roots: readRoots({ home, logRoot: this.deps.logRoot, notesDir: this.deps.notesDir, trustedDirs }),
        mode,
        webHosts: [],
        webLog: null,
        auditFile: this.auditFile,
        deniedLog,
      }
    }
    return { home, cwd: this.neutralDir, roots: [], mode, webHosts: hostsInText(question), webLog, auditFile: this.auditFile, deniedLog }
  }

  // Writes the hook policy and the settings for a read or web run (mode 0600). quick has neither: it runs in the neutral
  // folder with no tools. Returns the working folder, the read roots (read only) and the settings file.
  private async writeRunFiles(
    mode: ModeName,
    question: string,
    runId: string,
  ): Promise<{ cwd: string; roots?: string[]; settingsPath?: string }> {
    this.ensureDirs()
    if (mode === 'quick') return { cwd: this.neutralDir }
    const trustedDirs = mode === 'read' ? (await this.folders()).map((f) => f.path) : []
    const webLog = mode === 'web' ? join(this.hooksDir, `${runId}.web.log`) : null
    const deniedLog = mode === 'read' ? join(this.hooksDir, `${runId}.denied.log`) : null
    const policy = this.buildPolicy(mode, question, webLog, trustedDirs, deniedLog)
    const policyPath = join(this.hooksDir, `${runId}.json`)
    writeFileSync(policyPath, JSON.stringify(policy), { mode: 0o600 })
    const settingsPath = join(this.hooksDir, `${runId}.settings.json`)
    writeFileSync(settingsPath, hookSettings(this.deps.hookCommand(mode, policyPath)), { mode: 0o600 })
    return { cwd: policy.cwd, roots: mode === 'read' ? policy.roots : undefined, settingsPath }
  }

  // Removes the run's policy, settings and web log files. Missing files are fine.
  private removeRunFiles(runId: string): void {
    for (const name of [`${runId}.json`, `${runId}.settings.json`, `${runId}.web.log`, `${runId}.denied.log`]) {
      try {
        rmSync(join(this.hooksDir, name), { force: true })
      } catch (e) {
        this.deps.log(`could not remove a run file: ${errText(e)}`)
      }
    }
  }

  private async upgrade(entry: ThreadEntry, folder: Folder, messageId: MessageId | undefined): Promise<void> {
    const gate = await this.quotaGate()
    if (gate.refuse) {
      await this.sendText(`Modes are paused: ${gate.reason}.`, messageId)
      return
    }
    const prompt = upgradePrompt(entry.question, entry.answer)
    let result: { ok?: boolean; error?: string } | null = null
    try {
      result = (await this.deps.request('spawn', { dir: folder.path, prompt, messageId })) as { ok?: boolean; error?: string } | null
    } catch (e) {
      result = { ok: false, error: errText(e) }
    }
    if (result?.ok) {
      await this.sendText(`Starting a full session in ${folder.name}. Its topic has the question and the answer.`, messageId)
      return
    }
    await this.sendText(`Could not start ${folder.name}: ${result?.error ?? 'no answer from the router'}`, messageId)
  }

  private async folders(): Promise<Folder[]> {
    try {
      const r = (await this.deps.request('folders', {})) as { folders?: unknown } | null
      if (!Array.isArray(r?.folders)) return []
      return r.folders.filter(
        (f): f is Folder => !!f && typeof (f as Folder).name === 'string' && typeof (f as Folder).path === 'string',
      )
    } catch (e) {
      this.deps.log(`folders failed: ${errText(e)}`)
      return []
    }
  }

  // The router's answer on the quota. Allowed only when the answer says refuse === false; anything else refuses
  // (fail closed).
  private async quotaGate(): Promise<{ refuse: boolean; reason?: string }> {
    try {
      const r = (await this.deps.request('quota', {})) as { refuse?: unknown; reason?: unknown } | null
      if (r?.refuse === false) return { refuse: false }
      if (r?.refuse === true) return { refuse: true, reason: typeof r.reason === 'string' ? r.reason : 'the quota is at its limit' }
      return { refuse: true, reason: 'the quota could not be read' }
    } catch (e) {
      return { refuse: true, reason: `the quota could not be checked (${errText(e)})` }
    }
  }

  private async recordUsage(mode: ModeName, costUsd: number, durationMs: number, outcome: 'answer' | 'limit' | 'error'): Promise<void> {
    try {
      await this.deps.request('usage', { mode, costUsd, durationMs, outcome })
    } catch (e) {
      this.deps.log(`usage not recorded: ${errText(e)}`)
    }
  }

  private async sendText(text: string, replyTo: MessageId | undefined): Promise<void> {
    await this.send(text, [], replyTo)
  }

  // Sends text (and buttons on the last part) through the router. Returns the Telegram message ids of the parts.
  private async send(text: string, rows: Rows, replyTo: MessageId | undefined): Promise<MessageId[]> {
    const payload: Record<string, unknown> = { text }
    if (replyTo !== undefined) payload.replyTo = replyTo
    if (rows.length > 0) payload.rows = rows
    try {
      const r = (await this.deps.request('send', payload)) as { messageIds?: unknown } | null
      return Array.isArray(r?.messageIds) ? r.messageIds.filter((x): x is MessageId => typeof x === 'string') : []
    } catch (e) {
      this.deps.log(`send failed: ${errText(e)}`)
      return []
    }
  }
}
