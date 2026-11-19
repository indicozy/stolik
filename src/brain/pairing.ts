// Owner pairing (plan 0e, inventory B). `stolik setup` writes a one-time code to <stateDir>/pairing.json; the owner
// sends it in a private chat with the bot, and the adapter that polls the bot consumes the attempt here. The file keeps
// only a salted hash of the code, so reading the state folder does not reveal it. Pure logic first; the file helpers
// at the bottom are the only I/O.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { readFileSync, rmSync, writeFileSync, renameSync, chmodSync, existsSync } from 'node:fs'

export const PAIR_TTL_MS = 5 * 60 * 1000
export const PAIR_MAX_WRONG = 5

export type PairingFile = {
  app: string
  saltHex: string
  codeHash: string
  expiresAt: number
  wrong: number
  created: number
}

// Result of one DM text: paired (the code matched), wrong (counted), expired or locked (the file is gone now), closed
// (no pairing is active: the text is not an attempt at all).
export type Verdict = 'paired' | 'wrong' | 'expired' | 'locked' | 'closed'

// A six-digit code. crypto.randomInt is uniform; the injected source is for tests.
export function makeCode(rand: (max: number) => number = randomInt): string {
  return String(rand(1_000_000)).padStart(6, '0')
}

export function hashCode(code: string, saltHex: string): string {
  return createHash('sha256').update(saltHex).update(':').update(code.trim()).digest('hex')
}

export function newPairing(app: string, code: string, now: number, saltHex: string = randomBytes(16).toString('hex')): PairingFile {
  return { app, saltHex, codeHash: hashCode(code, saltHex), expiresAt: now + PAIR_TTL_MS, wrong: 0, created: now }
}

// One DM text against an active pairing. `next` is the file to keep, or null when the file must be deleted (paired,
// expired, locked). The compare is constant time (timingSafeEqual on the hashes).
export function checkAttempt(file: PairingFile, text: string, now: number): { verdict: Verdict; next: PairingFile | null } {
  if (now >= file.expiresAt) return { verdict: 'expired', next: null }
  if (file.wrong >= PAIR_MAX_WRONG) return { verdict: 'locked', next: null }
  const attempt = Buffer.from(hashCode(text, file.saltHex), 'hex')
  const stored = Buffer.from(file.codeHash, 'hex')
  if (attempt.length === stored.length && timingSafeEqual(attempt, stored)) return { verdict: 'paired', next: null }
  const wrong = file.wrong + 1
  if (wrong >= PAIR_MAX_WRONG) return { verdict: 'locked', next: null }
  return { verdict: 'wrong', next: { ...file, wrong } }
}

// ---------- files ----------

export function pairingPath(stateDir: string): string {
  return join(stateDir, 'pairing.json')
}

// Writes the file with mode 600 in one step (temp file, then rename).
function writePairing(stateDir: string, file: PairingFile): void {
  const path = pairingPath(stateDir)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(file) + '\n', { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

// Starts a pairing: writes the file and returns the code to show the owner. Replaces an earlier pairing.
export function startPairing(stateDir: string, app: string, now: number = Date.now(), code: string = makeCode()): string {
  writePairing(stateDir, newPairing(app, code, now))
  return code
}

// The active pairing, or null when there is none or the file cannot be read.
export function readPairing(stateDir: string): PairingFile | null {
  const path = pairingPath(stateDir)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<PairingFile>
    if (typeof raw.app !== 'string' || typeof raw.saltHex !== 'string' || typeof raw.codeHash !== 'string') return null
    if (typeof raw.expiresAt !== 'number' || typeof raw.wrong !== 'number' || typeof raw.created !== 'number') return null
    return raw as PairingFile
  } catch {
    return null
  }
}

// Consumes one DM text against the active pairing (if any), keeps or deletes the file, and returns the verdict.
export function attemptPairing(stateDir: string, text: string, now: number = Date.now()): Verdict {
  const file = readPairing(stateDir)
  if (file === null) return 'closed'
  const { verdict, next } = checkAttempt(file, text, now)
  if (next === null) rmSync(pairingPath(stateDir), { force: true })
  else writePairing(stateDir, next)
  return verdict
}

export function cancelPairing(stateDir: string): void {
  rmSync(pairingPath(stateDir), { force: true })
}
