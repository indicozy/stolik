// Remind service: `/remind`, `/task` and `/reminders` (commands), the Save/Cancel/folder/Delete/Done/Snooze buttons
// (callbacks), and the one-minute tick that fires the due items. Pure apart from the peer (host requests) and the deps it
// is given (clock, store path, the Haiku call), so the flow test drives it through a fake host.
import { basename } from 'node:path'
import { BUTTON_DATA_MAX } from '../../addons-host/tokens.ts'
import type { AddonPeer, Handler } from '../sdk.ts'
import { buildParsePrompt, checkParse } from './parse.ts'
import { describeSchedule, fmtWhen, nextRun as nextRunOf, type Schedule } from './cron.ts'
import { newId, loadItems, saveItems, takeDue, type Item } from './store.ts'

export const PARSE_FAILED = "Couldn't read a time from that. Try e.g. /remind tomorrow 9:00 call mom"
const PENDING_MS = 15 * 60_000
const SNOOZE_MS = 3_600_000
const FIRED_MS = 24 * 3_600_000
const MAX_FOLDER_BUTTONS = 8
const LABEL = { remind: 'Remind', task: 'Task' } as const
const USAGE = {
  remind: 'Say what and when, e.g. /remind tomorrow 9:00 call mom',
  task: 'Say what and when, e.g. /task friday 9:00 in stolik summarise the inbox',
} as const

export type RemindDeps = {
  now: () => number
  // The items file (STATE_DIR/remind/items.json in production).
  path: string
  // One Haiku call: the prompt in, the model's reply out (null on failure).
  parse: (prompt: string) => Promise<string | null>
}

type Folder = { name: string; path: string }
type Btn = { text: string; data: string }
type Rows = Btn[][]

// A reminder or task waiting for Save. Folder choices are kept with it, so `f:<id>:<index>` stays stable.
type Pending = {
  kind: 'remind' | 'task'
  text: string
  schedule: Schedule
  folders: Folder[]
  dir?: string
  dirName?: string
  expires: number
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const log = (msg: string): void => {
  process.stderr.write(`remind: ${msg}\n`)
}

// A button whose data must be 1 to BUTTON_DATA_MAX characters (the host tokenises it). Data that does not fit is a bug here, so it throws.
function btn(text: string, data: string): Btn {
  if (data.length < 1 || data.length > BUTTON_DATA_MAX) throw new Error(`button data is too long: ${data}`)
  return { text, data }
}

export function remindHandlers(peer: AddonPeer, deps: RemindDeps): Record<string, Handler> {
  const pending = new Map<string, Pending>()
  // The text of each reminder that fired, for Snooze: a fired once item is dropped from the store.
  const fired = new Map<string, { text: string; expires: number }>()
  let busy = false

  const send = (text: string, rows?: Rows): Promise<{ messageIds?: string[] } | null> =>
    peer.request('send', rows ? { text, rows } : { text }) as Promise<{ messageIds?: string[] } | null>

  const folders = async (): Promise<Folder[]> => {
    const r = (await peer.request('folders', {})) as { folders?: Folder[] } | null
    return Array.isArray(r?.folders) ? r.folders : []
  }

  const prune = (now: number): void => {
    for (const [id, p] of pending) if (p.expires < now) pending.delete(id)
    for (const [id, f] of fired) if (f.expires < now) fired.delete(id)
  }

  // The pending entry for an id, or null when it is unknown or has expired.
  const getPending = (id: string): Pending | null => {
    const p = pending.get(id)
    if (!p) return null
    if (p.expires < deps.now()) {
      pending.delete(id)
      return null
    }
    return p
  }

  const confirmText = (p: Pending, now: number): string => {
    const head = `${LABEL[p.kind]}: ${p.text}\n${describeSchedule(p.schedule, now)}`
    return p.kind === 'task' && p.dirName ? `${head}\nIn: ${p.dirName}` : head
  }

  const sendConfirm = (id: string, p: Pending): Promise<unknown> =>
    send(confirmText(p, deps.now()), [[btn('Save', `s:${id}`), btn('Cancel', `c:${id}`)]])

  // Parses the owner's words with Haiku, then asks for Save (or for the folder, for a task that names none).
  async function propose(kind: 'remind' | 'task', words: string): Promise<void> {
    const now = deps.now()
    const list = kind === 'task' ? await folders() : []
    const names = list.map((f) => f.name)
    const raw = await deps.parse(buildParsePrompt(words, kind, new Date(now), names))
    const parsed = checkParse(raw ?? '', now, names)
    if (!parsed) {
      await send(PARSE_FAILED)
      return
    }
    prune(now)
    const id = newId()
    const entry: Pending = { kind, text: parsed.text, schedule: parsed.schedule, folders: list, expires: now + PENDING_MS }
    if (kind === 'task') {
      const named = parsed.project ? list.find((f) => f.name === parsed.project) : undefined
      if (named) {
        entry.dir = named.path
        entry.dirName = named.name
      } else {
        if (list.length === 0) {
          await send('No folder to start in.')
          return
        }
        pending.set(id, entry)
        const rows: Rows = list.slice(0, MAX_FOLDER_BUTTONS).map((f, i) => [btn(f.name, `f:${id}:${i}`)])
        await send('Which folder?', rows)
        return
      }
    }
    pending.set(id, entry)
    await sendConfirm(id, entry)
  }

  // Save: the item goes into the store in one synchronous step (load, push, save), so no other handler interleaves.
  function save(id: string): string {
    const p = getPending(id)
    if (!p) return 'Expired, send it again'
    pending.delete(id)
    const now = deps.now()
    const at = nextRunOf(p.schedule, now)
    if (at === null) return 'That time has passed, send it again'
    const item: Item = {
      id: newId(),
      kind: p.kind,
      text: p.text,
      schedule: p.schedule,
      nextRun: at,
      createdAt: now,
      ...(p.dir ? { dir: p.dir } : {}),
    }
    const items = loadItems(deps.path)
    items.push(item)
    saveItems(deps.path, items)
    return 'Saved'
  }

  function remove(id: string): string {
    const items = loadItems(deps.path)
    const keep = items.filter((i) => i.id !== id)
    if (keep.length === items.length) return 'Already gone'
    saveItems(deps.path, keep)
    return 'Deleted'
  }

  // Snooze: a one-time copy of the reminder, due in an hour. The text comes from the fired memory, or from the store for a
  // repeating item that is still there.
  function snooze(id: string): string {
    const now = deps.now()
    const f = fired.get(id)
    let text = f && f.expires >= now ? f.text : undefined
    if (text === undefined) text = loadItems(deps.path).find((i) => i.id === id)?.text
    if (text === undefined) return 'Too old to snooze'
    const at = now + SNOOZE_MS
    const items = loadItems(deps.path)
    items.push({ id: newId(), kind: 'remind', text, schedule: { kind: 'once', at }, nextRun: at, createdAt: now })
    saveItems(deps.path, items)
    fired.delete(id)
    return 'Snoozed 1h'
  }

  async function listItems(): Promise<void> {
    const now = deps.now()
    const items = loadItems(deps.path).sort((a, b) => a.nextRun - b.nextRun)
    if (items.length === 0) {
      await send('No reminders.')
      return
    }
    const lines = items.map((it, i) => `${i + 1}. ${LABEL[it.kind]} ${it.text} · ${describeSchedule(it.schedule, now)}`)
    const rows: Rows = items.map((it, i) => [btn(`Delete ${i + 1}`, `d:${it.id}`)])
    await send(lines.join('\n'), rows)
  }

  // One item that is due. A reminder is sent with Done and Snooze. A task checks the quota gate, announces the start, and
  // then starts the session. Each step that can fail says so in General.
  async function fireOne(item: Item, late: boolean, now: number): Promise<void> {
    if (item.kind === 'remind') {
      fired.set(item.id, { text: item.text, expires: now + FIRED_MS })
      const suffix = late ? ` (late, was due ${fmtWhen(item.nextRun)})` : ''
      await send(`⏰ ${item.text}${suffix}`, [[btn('Done', `k:${item.id}`), btn('Snooze 1h', `z:${item.id}`)]])
      return
    }
    const dir = item.dir ?? ''
    const quota = (await peer.request('quota', {})) as { refuse?: boolean; reason?: string } | null
    if (!quota || quota.refuse) {
      await send(`Task skipped: ${item.text} (${quota?.reason ?? 'the quota could not be read'})`)
      return
    }
    const started = await send(`Task started: ${item.text} (in ${basename(dir)})`)
    const messageId = started?.messageIds?.[0]
    if (typeof messageId !== 'string') throw new Error('the start message has no id')
    const spawn = (await peer.request('spawn', { dir, prompt: item.text, messageId })) as { ok?: boolean; error?: string } | null
    if (!spawn?.ok) await send(`Task failed to start: ${item.text} (${spawn?.error ?? 'no answer'})`)
  }

  // Saves the rest of the store before anything is sent, so a crash never fires an item twice. Each fire has its own
  // try, so one failed send does not stop the others.
  async function fireDue(): Promise<void> {
    const now = deps.now()
    const { fire, keep } = takeDue(loadItems(deps.path), now)
    if (fire.length === 0) return
    saveItems(deps.path, keep)
    for (const { item, late } of fire) {
      try {
        await fireOne(item, late, now)
      } catch (e) {
        log(`firing "${item.text}" failed: ${errText(e)}`)
      }
    }
  }

  async function tickPass(): Promise<void> {
    try {
      await fireDue()
    } catch (e) {
      log(`tick failed: ${errText(e)}`)
    } finally {
      busy = false
    }
  }

  return {
    command: async (payload) => {
      const name = str(payload.command)
      const words = str(payload.text).trim()
      if (name === 'reminders') {
        void listItems().catch((e: unknown) => log(`reminders failed: ${errText(e)}`))
        return { handled: true }
      }
      const kind = name === 'task' ? 'task' : 'remind'
      if (words === '') return { reply: USAGE[kind] }
      void propose(kind, words).catch(async (e: unknown) => {
        log(`${name} failed: ${errText(e)}`)
        await send(PARSE_FAILED).catch(() => {})
      })
      return { handled: true }
    },
    callback: async (payload) => {
      const [op = '', id = '', index = ''] = str(payload.data).split(':')
      switch (op) {
        case 's':
          return { toast: save(id) }
        case 'c':
          pending.delete(id)
          return { toast: 'Cancelled' }
        case 'f': {
          const p = getPending(id)
          const folder = p?.folders[Number(index)]
          if (!p || !folder) return { toast: 'Expired, send it again' }
          p.dir = folder.path
          p.dirName = folder.name
          void sendConfirm(id, p).catch((e: unknown) => log(`confirm failed: ${errText(e)}`))
          return { toast: 'Folder set' }
        }
        case 'd':
          return { toast: remove(id) }
        case 'k':
          return { toast: 'Done' }
        case 'z':
          return { toast: snooze(id) }
        default:
          return { toast: 'Not available.' }
      }
    },
    tick: async () => {
      if (busy) return { started: false }
      busy = true
      void tickPass()
      return { started: true }
    },
  }
}
