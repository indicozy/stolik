// End-to-end driver support (docs/e2e.md). Off unless the router runs with STOLIK_E2E=1. When on, the router socket
// accepts synthetic inbound messages and button taps (router/handlers/e2e.ts), the Telegram adapter records what it sends
// in a ring buffer, and a local file can stand in for a downloaded voice or photo. Nothing here changes what the router
// does with a message: synthetic messages go through the same handlers as real ones.
import type { ChatRef } from '../brain/chat-types.ts'
import type { Btn } from './state.ts'
import type { MessageId } from '../brain/chat-types.ts'

export const E2E_ENV = 'STOLIK_E2E'
// Synthetic inbound message ids are negative, so they never collide with Telegram's positive ids.
export const SYNTHETIC_ID_BASE = 1_000_000_000
export const SENT_RING_CAPACITY = 200
// File ids and callback ids of synthetic messages carry these prefixes; the Telegram adapter treats them specially.
export const E2E_FILE_PREFIX = 'e2e-file:'
export const E2E_CALLBACK_PREFIX = 'e2e-cb-'

// The driver is enabled only by the exact value "1" (the same rule as the other STOLIK_* switches).
export function e2eEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[E2E_ENV] === '1'
}

export function isSyntheticMessageId(id: number): boolean {
  return Number.isInteger(id) && id < 0
}

// One outbound message the router sent, as the driver reports it. `buttons` are the keyboard rows (callback data included).
export type SentEntry = {
  messageId: number
  chat: ChatRef
  text: string
  buttons: Btn[][]
}

// Fixed-size record of the most recent outbound messages, oldest first. Recording never throws.
export class SentRing {
  private entries: SentEntry[] = []
  private readonly capacity: number

  constructor(capacity: number = SENT_RING_CAPACITY) {
    this.capacity = capacity
  }

  record(entry: SentEntry): void {
    this.entries.push(entry)
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity)
  }

  // Replaces the text and buttons of a recorded message (after an edit). Unknown ids are ignored.
  update(messageId: number, patch: { text?: string; buttons?: Btn[][] }): void {
    const e = this.find(messageId)
    if (!e) return
    if (patch.text !== undefined) e.text = patch.text
    if (patch.buttons !== undefined) e.buttons = patch.buttons
  }

  find(messageId: number): SentEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) if (this.entries[i].messageId === messageId) return this.entries[i]
    return undefined
  }

  // The last `n` messages, oldest first. A non-positive or missing `n` gives the default of 20.
  last(n: number = 20): SentEntry[] {
    const k = Number.isInteger(n) && n > 0 ? n : 20
    return this.entries.slice(-k).map((e) => ({ ...e, chat: { ...e.chat }, buttons: e.buttons.map((r) => r.map((b) => ({ ...b }))) }))
  }

  get size(): number {
    return this.entries.length
  }
}

// The driver's state, held by the router and shared with the Telegram adapter (which records sends and serves files).
export class E2e {
  readonly ring = new SentRing()
  // Local files standing in for Telegram file ids (voice, photo, document injected by the driver).
  readonly files = new Map<string, string>()
  private seq = 0

  nextMessageId(): number {
    return -(SYNTHETIC_ID_BASE + ++this.seq)
  }

  nextFileId(path: string): string {
    const id = `${E2E_FILE_PREFIX}${++this.seq}`
    this.files.set(id, path)
    return id
  }

  nextCallbackId(): string {
    return `${E2E_CALLBACK_PREFIX}${++this.seq}`
  }
}

export function isE2eCallbackId(id: string): boolean {
  return id.startsWith(E2E_CALLBACK_PREFIX)
}

export function isE2eFileId(id: string): boolean {
  return id.startsWith(E2E_FILE_PREFIX)
}

// Opaque ids of synthetic messages (plan 23 §2.1): "e2e:<n>", n a non-negative integer counter. Not used by callers yet:
// the numeric synthetic ids above still apply until chat connector step 0c-1 switches them.
export const E2E_ID_PREFIX = 'e2e:'
const E2E_NUMBER = /^\d+$/

export function e2eMsg(n: number): MessageId {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`e2e id number must be a non-negative integer: ${n}`)
  return `${E2E_ID_PREFIX}${n}` as MessageId
}

export function isE2eId(id: string): boolean {
  return id.startsWith(E2E_ID_PREFIX) && E2E_NUMBER.test(id.slice(E2E_ID_PREFIX.length))
}

// The counter inside an "e2e:<n>" id. Throws on anything else.
export function e2eNum(id: string): number {
  if (!isE2eId(id)) throw new Error(`not an e2e id: ${JSON.stringify(id)}`)
  return Number(id.slice(E2E_ID_PREFIX.length))
}
