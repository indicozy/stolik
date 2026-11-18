// The host's button table (protocol 2). An addon writes its button data as any string; the router never puts that string
// on the chat app's wire. It stores {addon, data, expiresAt} here under a random token and sends `ax:<token>` instead, so
// the wire data is the same short size on every chat app. A tap looks the token up. The table is in memory only: the
// router strips every addon keyboard at start (core.ts), so nothing that was issued before a restart can be pressed.
import { randomInt } from 'node:crypto'

export const TOKEN_LENGTH = 10
export const TOKEN_TTL_MS = 24 * 60 * 60 * 1000
export const TOKEN_CAP = 2000
export const BUTTON_DATA_MAX = 256

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
export const TOKEN_RE = new RegExp(`^[A-Za-z0-9]{${TOKEN_LENGTH}}$`)

type Entry = { addon: string; data: string; expiresAt: number }

export class ButtonTokens {
  private readonly entries = new Map<string, Entry>()

  private readonly now: () => number
  private readonly ttlMs: number
  private readonly cap: number

  constructor(now: () => number, ttlMs = TOKEN_TTL_MS, cap = TOKEN_CAP) {
    this.now = now
    this.ttlMs = ttlMs
    this.cap = cap
  }

  // The token for one of an addon's button data. Expired entries go first; past the cap the oldest one is evicted.
  issue(addon: string, data: string): string {
    this.prune()
    let token: string
    do {
      token = randomToken()
    } while (this.entries.has(token))
    this.entries.set(token, { addon, data, expiresAt: this.now() + this.ttlMs })
    while (this.entries.size > this.cap) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    return token
  }

  // The addon and its data behind a token, or null when the token is unknown or expired.
  resolve(token: string): { addon: string; data: string } | null {
    const e = this.entries.get(token)
    if (!e) return null
    if (e.expiresAt <= this.now()) {
      this.entries.delete(token)
      return null
    }
    return { addon: e.addon, data: e.data }
  }

  get size(): number {
    return this.entries.size
  }

  private prune(): void {
    const t = this.now()
    for (const [token, e] of this.entries) if (e.expiresAt <= t) this.entries.delete(token)
  }
}

function randomToken(): string {
  let s = ''
  for (let i = 0; i < TOKEN_LENGTH; i++) s += ALPHABET[randomInt(ALPHABET.length)]
  return s
}
