// Messages held by the gate point (protocol 2; cost-guard). A held message is kept here, keyed by its message id, until its addon releases it (delivered once), drops it, or the cap pushes it out. The router owns the
// store: an addon can only act on a hold it made (addon-bridge.ts checks the `addon` field).
import type { SessionKey } from '../brain/sessions.ts'
import type { Inbound } from '../brain/chat-types.ts'
import type { MessageId } from '../brain/chat-types.ts'
import type { Prepared } from './shared.ts'

// Holds kept at once. Past this, the oldest hold is dropped (its message is simply not delivered any more).
export const HOLD_CAP = 50

export type Hold = {
  sessionKey: SessionKey
  m: Inbound
  p: Prepared
  // The addon that held it. Only that addon may release, drop or read it.
  addon: string
  heldAt: number
}

export class Holds {
  private readonly byId = new Map<MessageId, Hold>()

  private readonly cap: number

  constructor(cap: number = HOLD_CAP) {
    this.cap = cap
  }

  // Stores a hold. A hold past the cap pushes out the oldest one (insertion order).
  put(h: Hold): void {
    this.byId.delete(h.m.messageId)
    this.byId.set(h.m.messageId, h)
    while (this.byId.size > this.cap) {
      const oldest = this.byId.keys().next().value as MessageId
      this.byId.delete(oldest)
    }
  }

  get(messageId: MessageId): Hold | undefined {
    return this.byId.get(messageId)
  }

  // Removes and returns a hold (null when none). A release takes it first, so a second release finds nothing.
  take(messageId: MessageId): Hold | undefined {
    const h = this.byId.get(messageId)
    if (h) this.byId.delete(messageId)
    return h
  }

  get size(): number {
    return this.byId.size
  }
}
