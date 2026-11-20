// Router side of the addons' requests and buttons (plan 2.8, 2.11). The modes addon asks for: sending text and buttons
// to the home chat, the startable folders, starting a full session, recording a run's cost, and the quota gate. Buttons
// it sends are laid out for the chat app (buttons capability), their data kept in the host's token table (tokens.ts),
// and come back as `ax:<token>`, routed to the addon. The request handler is wired in app.ts.
import { basename, join } from 'node:path'
import type { ButtonPress, Inbound } from '../brain/chat-types.ts'
import type { Capabilities, ChatId, MessageId, UserId } from '../brain/chat-types.ts'
import { redact } from '../brain/common.ts'
import {
  alertDue, dayKey, formatUsage, paceAlert, parseUsageEvent, refusal, USAGE_KEEP_DAYS, USAGE_KEEP_RECORDS, UsageLog, type QuotaStatus,
  type Refusal, type UsageSummary,
} from '../brain/usage.ts'
import { MAX_CHAT_DAYS, parseDayRequest } from '../brain/chat-days.ts'
import type { ChatLine } from '../brain/chatlog.ts'
import { BUTTON_DATA_MAX, TOKEN_RE } from '../addons-host/tokens.ts'
import { errMsg, warn } from './log.ts'
import type { DbStorePort } from '../ports.ts'
import type { Router } from './core.ts'
import { send, startableDirs } from './deliver.ts'
import type { Hold } from './gate.ts'
import { MAX_SPAWNED_SESSIONS, textLimit, chunkText, type Rows } from './state.ts'
import { layoutButtonRows } from '../brain/chat-layout.ts'
import { runningSpawns, spawnFor } from './spawn.ts'
import { logOutgoing } from './send.ts'

export type UsagePort = { report(): Promise<string> }

// The usage rows and the once-a-day alert day live in the store (`usage` table, and one addon-settings row under the
// scope below, so no extra table is needed).
const ALERT_SCOPE = '_router'
const ALERT_KEY = 'usage-alert-day'
const DAY_MS = 86_400_000

export type BridgeOptions = {
  db: Pick<DbStorePort, 'addUsage' | 'listUsage' | 'pruneUsage' | 'getAddonSetting' | 'setAddonSetting'>
  weeklyLimitPct: number
  // The quota now (cached by the caller). Null when it cannot be read.
  quota: () => Promise<QuotaStatus | null>
  now: () => number
  // The chat-log lines of `days` local days from `from` (`YYYY-MM-DD`), oldest first (adapters/files.ts readChatDays).
  readChat?: (from: string, days: number) => ChatLine[]
}

// `ax:<token>` from one of an addon's buttons, or null. The token is looked up in the router's table (tokens.ts).
export function parseBridgeCallback(data: string): { token: string } | null {
  return data.startsWith('ax:') && TOKEN_RE.test(data.slice(3)) ? { token: data.slice(3) } : null
}

// A message id an addon sends back (protocol 2): the opaque string the host handed out, echoed as it came. A number is the
// protocol 1 shape and is refused; so is anything that is not a short non-empty string.
const ID_MAX = 200
export function wireId(v: unknown): MessageId {
  if (typeof v === 'number') throw new Error('ids are strings in protocol 2')
  if (typeof v !== 'string' || v === '' || v.length > ID_MAX) throw new Error(`a message id is a string of 1 to ${ID_MAX} characters`)
  return v as MessageId
}

// A chat-log line for an addon: the chat app's ids (topic_id, tg_message_id) stay in the router.
type AddonChatLine = Omit<ChatLine, 'topic_id' | 'tg_message_id'>
function addonLine({ topic_id: _topic, tg_message_id: _msg, ...line }: ChatLine): AddonChatLine {
  return line
}

type ButtonRows = Array<Array<{ text: string; data: string }>>
type InlineButtons = Extract<Capabilities['buttons'], { kind: 'inline' }>

// The rows an addon asked for, checked. Data is any string of 1 to BUTTON_DATA_MAX characters; a label is never empty.
function parseRows(raw: unknown): ButtonRows | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new Error('rows must be a list of button rows')
  return raw.map((row) => {
    if (!Array.isArray(row)) throw new Error('each row must be a list of buttons')
    return row.map((b: unknown) => {
      const btn = b as { text?: unknown; data?: unknown }
      if (typeof btn.text !== 'string' || btn.text === '' || typeof btn.data !== 'string' || btn.data === '') {
        throw new Error('a button needs text and data')
      }
      if (Array.from(btn.data).length > BUTTON_DATA_MAX) throw new Error(`button data is too long (max ${BUTTON_DATA_MAX})`)
      return { text: btn.text, data: btn.data }
    })
  })
}

// The rows as this chat app shows them: each label cut to labelChars, a row longer than maxPerRow split (order kept), and
// rows past maxRows dropped (the count comes back so the caller can log it).
function layoutRows(rows: ButtonRows, caps: InlineButtons): { rows: ButtonRows; dropped: number } {
  return layoutButtonRows(rows, caps)
}

export class AddonBridge implements UsagePort {
  private router: Router | null = null
  private alertDay: string | null
  private readonly opts: BridgeOptions
  // The addons whose buttons were dropped because the chat app has none (logged once each).
  private readonly noButtonsLogged = new Set<string>()

  constructor(opts: BridgeOptions) {
    this.opts = opts
    this.alertDay = opts.db.getAddonSetting(ALERT_SCOPE, ALERT_KEY)
  }

  // The usage of the retained window, as a log.
  private usageLog(): UsageLog {
    return UsageLog.fromRecords(this.opts.db.listUsage(this.opts.now() - USAGE_KEEP_DAYS * DAY_MS))
  }

  attach(router: Router): void {
    this.router = router
  }

  private get r(): Router {
    if (!this.router) throw new Error('the router is not ready')
    return this.router
  }

  // Answers one addon request. The addon's access was checked by the host already.
  async request(addon: string, op: string, payload: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case 'send':
        return this.send(addon, payload)
      case 'folders':
        return { folders: this.folders() }
      case 'spawn':
        return this.spawn(addon, payload)
      case 'usage':
        return this.recordUsage(payload)
      case 'quota':
        return this.quotaGate()
      case 'chatlog':
        return this.chatDays(payload)
      case 'costs':
        return this.costTotals()
      case 'release':
        return this.release(addon, payload)
      case 'drop':
        return this.drop(addon, payload)
      case 'held':
        return this.held(addon, payload)
      default:
        throw new Error(`unknown request ${op}`)
    }
  }

  private async send(addon: string, payload: Record<string, unknown>): Promise<{ messageIds: MessageId[] }> {
    const text = typeof payload.text === 'string' ? payload.text : ''
    if (text.trim() === '') throw new Error('nothing to send')
    const replyTo = payload.replyTo === undefined || payload.replyTo === null ? undefined : wireId(payload.replyTo)
    const rows = this.buttonRows(addon, payload.rows)
    const parts = chunkText(redact(text, this.r.secrets), textLimit(this.r.chat))
    // One group: the chunks go out in order, the buttons (if any) on the last one, the reply on the first.
    const ids = await this.r.chat.sendChunks(parts, { replyTo, ...(rows ? { rows } : {}) })
    parts.forEach((part, i) => {
      // Every message the bot sends is logged (design §4.11), addon answers included, with an outbound audit event.
      logOutgoing(this.r, { kind: 'addon', text: part, tg_message_id: ids[i] })
      this.r.audit.event({ event: 'outbound', kind: 'addon', session: addon, length: part.length, files: 0, message_id: ids[i] })
    })
    return { messageIds: ids }
  }

  // The addon's buttons as the chat app gets them: none when the app has no buttons, else laid out and tokenised.
  private buttonRows(addon: string, raw: unknown): Rows | undefined {
    const parsed = parseRows(raw)
    if (!parsed) return undefined
    const caps = this.r.chat.capabilities.buttons
    if (caps.kind === 'none') {
      if (!this.noButtonsLogged.has(addon)) {
        this.noButtonsLogged.add(addon)
        this.r.logger.log(`addon ${addon}: ${this.r.chat.capabilities.displayName} has no buttons; the addon's buttons are not sent`)
      }
      return undefined
    }
    const laid = layoutRows(parsed, caps)
    if (laid.dropped > 0) this.r.logger.log(`addon ${addon}: ${laid.dropped} button row(s) past the limit of ${caps.maxRows} were not sent`)
    return laid.rows.map((row) => row.map((b) => ({ text: b.text, data: `ax:${this.r.addonButtons.issue(addon, b.data)}` })))
  }

  // Startable folders, the master project first.
  folders(): Array<{ name: string; path: string }> {
    const dirs = startableDirs(this.r)
    const master = join(this.r.home, 'Documents', 'projects', 'master')
    const ordered = [...dirs.filter((d) => d === master), ...dirs.filter((d) => d !== master)]
    return ordered.map((d) => ({ name: basename(d), path: d }))
  }

  // Starts a full session in a folder with a first prompt. Uses the router's spawn path (trust, spawn cap, tmux). The
  // session's first message says it came from the calling addon (`from`, shown to the agent as the user).
  private async spawn(addon: string, payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    const dir = typeof payload.dir === 'string' ? payload.dir : ''
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : ''
    // The message the spawn answers (status lines reply to it).
    const messageId = wireId(payload.messageId)
    const real = this.r.platform.realpath(dir)
    if (!real || prompt === '') return { ok: false, error: 'bad request' }
    if (!startableDirs(this.r).includes(real)) return { ok: false, error: 'that folder is not one stolik can start in' }
    if (!this.r.agent.isTrusted(real)) return { ok: false, error: 'that folder is not trusted yet' }
    if (runningSpawns(this.r) >= MAX_SPAWNED_SESSIONS) return { ok: false, error: `${MAX_SPAWNED_SESSIONS} router-started sessions are already running` }
    // A router-started session is written from the owner's DM; the DM's id is never read (only home chats are compared).
    const m: Inbound = { kind: 'text', messageId, text: prompt, replyToId: null, replyToText: null, forwarded: false, from: addon, fromId: this.r.ownerId as UserId, origin: 'addon', chat: { kind: 'dm', id: '' as ChatId, thread: null } }
    await spawnFor(this.r, basename(real), real, m, prompt)
    return { ok: true }
  }

  private recordUsage(payload: Record<string, unknown>): { ok: true } {
    const rec = parseUsageEvent(payload, this.opts.now())
    if (!rec) throw new Error('bad usage record')
    this.opts.db.addUsage(rec)
    this.prune()
    return { ok: true }
  }

  // Chat-log lines of whole days (access chatlog.read). The request is checked here; a bad one is refused.
  private chatDays(payload: Record<string, unknown>): { lines: AddonChatLine[] } {
    const req = parseDayRequest(payload)
    if (!req) throw new Error(`chatlog needs from (YYYY-MM-DD) and days (1 to ${MAX_CHAT_DAYS})`)
    if (!this.opts.readChat) throw new Error('the chat log is not available')
    return { lines: this.opts.readChat(req.from, req.days).map(addonLine) }
  }

  // Mode-run cost totals today and this week (access usage.read), the figures `/usage` prints.
  private costTotals(): UsageSummary {
    return this.usageLog().summary(new Date(this.opts.now()))
  }

  // The quota gate (the modes check), with the week's used and pace percentages when the quota could be read (cost-guard
  // quotes them in its notice). The pace is the used share minus how far ahead of the weekly pace it is.
  private async quotaGate(): Promise<{ refuse: boolean; reason?: string; usedPct?: number; pacePct?: number }> {
    let status: { q: QuotaStatus | null; r: Refusal }
    try {
      status = await this.gateStatus()
    } catch (e) {
      return { refuse: true, reason: `the quota could not be read (${errMsg(e)}), so modes are paused` }
    }
    const { q, r } = status
    const pct = q ? { usedPct: q.weeklyUsedPct, pacePct: Math.round(q.weeklyUsedPct - q.aheadBy) } : {}
    return r.refuse ? { refuse: true, reason: r.reason, ...pct } : { refuse: false, ...pct }
  }

  // The quota gate for runs the router itself starts: null when a run may go on, else the reason it may not. It reads the
  // quota the way the quota request does (same cache, same refusal rule). A quota that cannot be read refuses (fail closed).
  async quotaRefusal(): Promise<string | null> {
    try {
      const r: Refusal = await this.gate()
      return r.refuse ? r.reason : null
    } catch (e) {
      return `the quota could not be read (${errMsg(e)}), so modes are paused`
    }
  }

  private async gate(): Promise<Refusal> {
    return (await this.gateStatus()).r
  }

  // The quota now, with the refusal it implies (and the once-a-day alert, as before).
  private async gateStatus(): Promise<{ q: QuotaStatus | null; r: Refusal }> {
    const q = await this.opts.quota()
    await this.maybeAlert(q)
    const r = refusal(q, this.opts.weeklyLimitPct)
    if (r.refuse) warn(`quota block: ${r.reason}`, 'quota')
    return { q, r }
  }

  // The held message this addon made, by its Telegram message id. Another addon's hold is not found.
  private ownHold(addon: string, payload: Record<string, unknown>): { id: MessageId; hold: Hold } | { error: string } {
    const id = wireId(payload.messageId)
    const hold = this.r.holds.get(id)
    if (!hold || hold.addon !== addon) return { error: 'no message of yours is held with that id' }
    return { id, hold }
  }

  // Delivers a held message to its session now, once (the gate is skipped). When the session is gone or not connected the
  // hold stays, so the addon can drop it. A failed delivery puts the hold back.
  private async release(addon: string, payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    const own = this.ownHold(addon, payload)
    if ('error' in own) return { ok: false, error: own.error }
    const s = this.r.registry.get(own.hold.sessionKey)
    if (!s || !this.r.agentFor(own.hold.sessionKey).isConnected(own.hold.sessionKey)) return { ok: false, error: 'the session is gone or not connected' }
    this.r.holds.take(own.id)
    if (await send(this.r, s, own.hold.m, own.hold.p, { bypassGate: true })) return { ok: true }
    this.r.holds.put(own.hold)
    return { ok: false, error: 'the message was not delivered' }
  }

  // Forgets a held message. Its hold reaction (😴) stays: the Telegram port can only set a reaction, not clear one.
  private drop(addon: string, payload: Record<string, unknown>): { ok: boolean; error?: string } {
    const own = this.ownHold(addon, payload)
    if ('error' in own) return { ok: false, error: own.error }
    this.r.holds.take(own.id)
    return { ok: true }
  }

  // The text of a held message and its session (null when the session is gone), for a new session started from it.
  private held(addon: string, payload: Record<string, unknown>):
    { ok: boolean; error?: string; text?: string; session?: { name: string; cwd: string; backendSessionId: string | null } | null } {
    const own = this.ownHold(addon, payload)
    if ('error' in own) return { ok: false, error: own.error }
    const s = this.r.registry.get(own.hold.sessionKey)
    const session = s ? { name: s.name, cwd: s.cwd, backendSessionId: s.backendSessionId } : null
    return { ok: true, text: own.hold.p.body, session }
  }

  // One alert a day in General, when the week is ahead of the pace.
  private async maybeAlert(q: QuotaStatus | null): Promise<void> {
    if (!q) return
    const today = dayKey(new Date(this.opts.now()))
    if (!alertDue(q.aheadBy, today, this.alertDay)) return
    this.alertDay = today
    this.opts.db.setAddonSetting(ALERT_SCOPE, ALERT_KEY, today)
    await this.r.chat.sendText(paceAlert(q)).catch((e: unknown) => this.r.logger.log(`pace alert failed: ${errMsg(e)}`))
  }

  // The text of `/usage`.
  async report(): Promise<string> {
    const q = await this.opts.quota()
    await this.maybeAlert(q)
    return formatUsage(this.usageLog().summary(new Date(this.opts.now())), q, this.opts.weeklyLimitPct)
  }

  // Drops the rows past the retention window and keeps only the newest ones.
  private prune(): void {
    this.opts.db.pruneUsage(this.opts.now() - USAGE_KEEP_DAYS * DAY_MS, USAGE_KEEP_RECORDS)
  }
}

// A tap on one of an addon's buttons, answered with the addon's toast. An unknown or expired token never reaches the addon.
export async function onBridgeCallback(router: Router, cb: ButtonPress, token: string): Promise<void> {
  const answer = (t?: string) => router.chat.ackButton(cb.pressId, t).catch(() => {})
  const hit = router.addonButtons.resolve(token)
  if (!hit) return answer('This button has expired.')
  const { addon, data } = hit
  if (!router.addons?.callback) return answer('Not available.')
  try {
    const r = await router.addons.callback(addon, data, cb.message ?? undefined)
    return answer(r?.toast)
  } catch (e) {
    router.logger.log(`addon ${addon}: button failed: ${errMsg(e)}`)
    return answer('That did not work.')
  }
}
