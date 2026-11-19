// Test helpers for the addon host: a fake clock (timers fire only when a test advances it), temp folders inside the
// worktree (test/.tmp-*, git-ignored, removed by the test), fixture copies, and a poll for asynchronous child events.
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Clock } from '../../src/ports.ts'
import type { AddonSettings } from '../../src/addons-host/settings.ts'
import { consentHash, readManifest } from '../../src/addons-host/manifest.ts'

const TEST_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
export const FIXTURES = join(TEST_DIR, 'fixtures')

// Timers fire only when `advance` moves the clock past their time (in order).
export class FakeClock implements Clock {
  t = 1_000_000
  private timers: Array<{ id: number; at: number; fn: () => void; every: number | null }> = []
  private nextId = 1

  now(): number {
    return this.t
  }

  date(): Date {
    return new Date(this.t)
  }

  setTimer(fn: () => void, ms: number): unknown {
    const id = this.nextId++
    this.timers.push({ id, at: this.t + ms, fn, every: null })
    return id
  }

  clearTimer(handle: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== handle)
  }

  setRepeating(fn: () => void, ms: number): unknown {
    const id = this.nextId++
    this.timers.push({ id, at: this.t + ms, fn, every: ms })
    return id
  }

  pendingTimers(): number {
    return this.timers.length
  }

  advance(ms: number): void {
    const end = this.t + ms
    for (;;) {
      const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (!due) break
      this.t = due.at
      if (due.every === null) this.timers = this.timers.filter((x) => x.id !== due.id)
      else due.at = this.t + due.every
      due.fn()
    }
    this.t = end
  }
}

export class MemorySettings implements AddonSettings {
  readonly values = new Map<string, boolean>()
  readonly flags = new Set<string>()
  readonly consents = new Map<string, string>()
  isEnabled(name: string): boolean {
    return this.values.get(name) === true
  }
  setEnabled(name: string, on: boolean): void {
    this.values.set(name, on)
  }
  hasChoice(name: string): boolean {
    return this.values.has(name)
  }
  getFlag(key: string): boolean {
    return this.flags.has(key)
  }
  setFlag(key: string): void {
    this.flags.add(key)
  }
  consentHash(name: string): string | null {
    return this.consents.get(name) ?? null
  }
  setConsentHash(name: string, hash: string): void {
    this.consents.set(name, hash)
  }
}

export function recordingLogger() {
  const lines: string[] = []
  return {
    lines,
    logger: { log: (m: string) => lines.push(m), debug: (m: string) => lines.push(m) },
  }
}

// A fresh folder inside test/ (git-ignored as test/.tmp-*). Callers remove it with `rmSync` in `after`.
export function tmpDir(label: string): string {
  mkdirSync(TEST_DIR, { recursive: true })
  return mkdtempSync(join(TEST_DIR, `.tmp-${label}-`))
}

// Records the owner's consent to every user addon in the folder as it is now (what `stolik addon consent` records).
export function allowUserAddons(addonsDir: string, settings: AddonSettings): void {
  for (const name of readdirSync(addonsDir)) {
    const r = readManifest(join(addonsDir, name))
    if ('manifest' in r) settings.setConsentHash(name, consentHash(r.manifest))
  }
}

export function copyFixture(name: string, into: string): string {
  const dest = join(into, name)
  cpSync(join(FIXTURES, name), dest, { recursive: true })
  return dest
}

// A minimal addon folder (manifest only) whose command runs the echo fixture. Overrides merge into the manifest.
export function writeEchoLike(addonsDir: string, name: string, overrides: Record<string, unknown> = {}): string {
  const dir = join(addonsDir, name)
  mkdirSync(dir, { recursive: true })
  const manifest = {
    name,
    version: '0.1.0',
    protocol: 2,
    command: ['node', join(FIXTURES, 'addon-echo', 'index.mjs')],
    provides: [{ point: 'text-filter' }],
    access: ['message.text'],
    requires: [],
    ...overrides,
  }
  writeFileSync(join(dir, 'stolik-addon.json'), JSON.stringify(manifest, null, 2))
  return dir
}

// Polls a condition until it holds (real time, not the fake clock).
export async function waitFor(cond: () => boolean, label: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}
