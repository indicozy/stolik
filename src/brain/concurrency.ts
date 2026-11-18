// Async counting semaphore (plan 2.7). Pure: no timers, no I/O. Waiters are served FIFO. A permit is released in
// `finally` by `run`, and `acquire` returns a release function that is safe to call twice.
// Used by the modes addon (at most MODE_CONCURRENCY runs at once; the rest show "⏳ waiting").

export const MODE_CONCURRENCY = 3

export class Semaphore {
  private available: number
  private readonly waiters: Array<() => void> = []

  readonly capacity: number

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('semaphore capacity must be a positive integer')
    this.capacity = capacity
    this.available = capacity
  }

  // Callers waiting for a permit (the number behind "⏳ waiting").
  get waiting(): number {
    return this.waiters.length
  }

  // Permits in use right now.
  get active(): number {
    return this.capacity - this.available
  }

  acquire(): Promise<() => void> {
    const grant = (): (() => void) => {
      let released = false
      return () => {
        if (released) return
        released = true
        this.release()
      }
    }
    if (this.available > 0) {
      this.available--
      return Promise.resolve(grant())
    }
    return new Promise((resolve) => {
      this.waiters.push(() => resolve(grant()))
    })
  }

  // Runs `fn` holding one permit; the permit goes back however `fn` ends.
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next) {
      next() // the permit passes straight to the next waiter
    } else {
      this.available++
    }
  }
}
