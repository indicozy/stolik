// A fake clock for the outbound queue: time moves only on `advance`, which fires due timers in order and lets
// promise callbacks settle between them.
import type { QueueClock } from '../../src/brain/outbound-queue.ts'

// Lets queued promise callbacks run to completion.
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

export class FakeQueueClock implements QueueClock {
  t = 1_000_000
  private timers: Array<{ id: number; at: number; fn: () => void }> = []
  private nextId = 1

  now(): number {
    return this.t
  }

  setTimer(fn: () => void, ms: number): unknown {
    const id = this.nextId++
    this.timers.push({ id, at: this.t + ms, fn })
    return id
  }

  clearTimer(handle: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== handle)
  }

  // Moves time forward by `ms`, firing every timer that comes due on the way.
  async advance(ms: number): Promise<void> {
    const end = this.t + ms
    for (;;) {
      await settle()
      const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (!due) break
      this.timers = this.timers.filter((x) => x !== due)
      this.t = due.at
      due.fn()
    }
    await settle()
    this.t = end
  }
}
