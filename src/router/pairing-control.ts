// The router's side of `tg-bridge setup --pair` (plan 0e, inventory B). The Telegram adapter consumes the code (see
// brain/pairing.ts) and reports the sender here. Setup asks with the `pair` ctl command and waits; the owner confirms
// with `pair_confirm`, and only then does the sender become the owner. Nothing is written to the config here: setup
// writes it after the confirmation.
import { attemptPairing, readPairing, type Verdict } from '../brain/pairing.ts'
import type { PairingHook } from '../adapters/chat/telegram.ts'

export type PairCandidate = { userId: string; name: string; username: string | null }
export type PairResult = { ok: true; candidate: PairCandidate } | { ok: false; error: string }

const FAILED: Partial<Record<Verdict, string>> = {
  expired: 'the pairing code expired: run tg-bridge setup --pair again',
  locked: 'too many wrong codes: the pairing is locked; run tg-bridge setup --pair again',
  closed: 'no pairing code is active: run tg-bridge setup --pair',
}

export class PairingControl {
  private waiter: ((r: PairResult) => void) | null = null
  private candidate: PairCandidate | null = null
  private readonly stateDir: string
  // Makes a confirmed sender the owner (the adapter and the router both).
  private readonly apply: (userId: string) => void
  private readonly now: () => number

  constructor(stateDir: string, apply: (userId: string) => void, now: () => number = () => Date.now()) {
    this.stateDir = stateDir
    this.apply = apply
    this.now = now
  }

  // What the Telegram adapter calls for each private text from a non-owner.
  hook(): PairingHook {
    return {
      attempt: (text) => {
        const verdict = attemptPairing(this.stateDir, text, this.now())
        if (verdict === 'expired' || verdict === 'locked') this.settle({ ok: false, error: FAILED[verdict] ?? verdict })
        return verdict
      },
      paired: (candidate) => {
        this.candidate = candidate
        this.settle({ ok: true, candidate })
      },
    }
  }

  // Resolves the waiting `pair` request (if any) with `r`.
  private settle(r: PairResult): void {
    const w = this.waiter
    this.waiter = null
    w?.(r)
  }

  // Waits for the code to match (or fail). Answers at once when there is no active pairing.
  wait(): Promise<PairResult> {
    if (this.candidate) return Promise.resolve({ ok: true, candidate: this.candidate })
    if (readPairing(this.stateDir) === null) return Promise.resolve({ ok: false, error: FAILED.closed ?? 'no pairing code is active' })
    // A second waiter replaces the first: its request gets the same answer through the new one.
    return new Promise((resolve) => {
      this.waiter?.({ ok: false, error: 'replaced by a newer pair request' })
      this.waiter = resolve
    })
  }

  // The owner's yes/no for the sender that paired. Yes makes the sender the owner in this process.
  confirm(userId: string, yes: boolean): { ok: true } | { ok: false; error: string } {
    if (this.candidate === null || this.candidate.userId !== userId) return { ok: false, error: 'no pairing waits for that user id' }
    this.candidate = null
    if (yes) this.apply(userId)
    return { ok: true }
  }
}
