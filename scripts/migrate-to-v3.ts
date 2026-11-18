// One-shot migration from the old (v2) state dir to the v3 state dir (plan R1, design §6.4).
//
// Reads the old files only, never writes under the old dir. Writes into --to (default: the v3 state dir, STATE_DIR):
//   tg-bridge.db  the SQLite store: `msgmap` (the message map in the v3 shape, brain/msgmap.ts) and `last-boot-id`
//                 (kv rows, the same keys SqliteStore reads). Entries that do not match are dropped and counted.
//   audit.log     copied as it is (v3 keeps the field names); the router appends to it from there.
// There is no session registry file in the old dir (sessions were never persisted there), so none is migrated.
// Notes inbox, attachments, the classifier folder (obsolete) and the group id (set by /bind) are not touched.
//
// Idempotent: a value already equal to what would be written is left alone. An existing v3 value that differs is a
// conflict: nothing is written and the run exits 3, unless --force. --dry-run prints the plan and writes nothing, and
// does not create the target or the database; an existing database is opened read-only to compare.
//
// Refuses to write while a router runs: the target folder holds its lock, or something answers on the socket.
//
// usage: node --experimental-strip-types scripts/migrate-to-v3.ts [--from <dir>] [--to <dir>] [--dry-run] [--force]
import { chmodSync, copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OLD_STATE_DIR, SOCKET_PATH, STATE_DIR } from '../src/config.ts'
import { loadMsgMap } from '../src/brain/msgmap.ts'
import { DB_FILE, KV, openDatabase, readKvReadOnly } from '../src/adapters/store-sqlite.ts'
import { routerLockHeld, socketAnswers } from '../src/adapters/instance-lock.ts'

export class MigrationError extends Error {}

export type Options = { from: string; to: string; dryRun: boolean; force: boolean }
export type FileOp = 'write' | 'overwrite' | 'unchanged' | 'conflict' | 'skip'
// A planned item: a kv row of the database (`kv` set) or a file (`path` set). `value` is what would be written.
// A file item is written from `value`, or copied from the file `from` (the audit log, which is not held in memory).
export type PlannedItem = { name: string; kv: string | null; op: FileOp; value: string | null; summary: string; from?: string }
export type Plan = { from: string; to: string; items: PlannedItem[]; notes: string[] }

type MsgEntry = { key: number | string; name: string; cwd: string }

// One message-map item in the v3 shape, or null when it does not match. A numeric string id is converted.
function v3Item(item: unknown): { id: number; entry: MsgEntry; converted: boolean } | null {
  if (!Array.isArray(item) || item.length !== 2) return null
  const [rawId, e] = item as [unknown, unknown]
  let id: number | null = null
  let converted = false
  if (typeof rawId === 'number' && Number.isSafeInteger(rawId)) id = rawId
  else if (typeof rawId === 'string' && /^\d{1,15}$/.test(rawId)) {
    id = Number(rawId)
    converted = true
  }
  if (id === null) return null
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null
  const o = e as Record<string, unknown>
  if ((typeof o.key !== 'number' && typeof o.key !== 'string') || typeof o.name !== 'string' || typeof o.cwd !== 'string') return null
  return { id, entry: { key: o.key, name: o.name, cwd: o.cwd }, converted }
}

// Old message map text -> v3 message map text, with counts. Throws when the text is not a JSON array at all.
export function convertMsgMap(raw: string): { json: string; entries: number; converted: number; dropped: number } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new MigrationError('msgmap.json is not valid JSON; not migrated (fix or remove it, then run again)')
  }
  if (!Array.isArray(parsed)) throw new MigrationError('msgmap.json is not a JSON array; not migrated')
  let converted = 0
  let dropped = 0
  const clean: [number, MsgEntry][] = []
  for (const item of parsed) {
    const v = v3Item(item)
    if (!v) {
      dropped++
      continue
    }
    if (v.converted) converted++
    clean.push([v.id, v.entry])
  }
  // loadMsgMap keeps the last entry per id and applies the cap, exactly as the router reads it.
  const map = loadMsgMap(JSON.stringify(clean))
  return { json: map.serialize(), entries: map.size(), converted, dropped }
}

function realOrResolved(p: string): string {
  return existsSync(p) ? realpathSync(p) : resolve(p)
}

function readTextOrNull(p: string): string | null {
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

// Non-empty lines of a file, streamed.
async function countLines(path: string): Promise<number> {
  let n = 0
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) if (line !== '') n++
  return n
}

// Byte comparison in chunks: 'same' when the files are identical, 'dst-extends' when dst starts with all of src and is
// longer, 'differs' otherwise.
async function comparePrefix(src: string, dst: string): Promise<'same' | 'dst-extends' | 'differs'> {
  const a = await open(src, 'r')
  const b = await open(dst, 'r')
  try {
    const sa = (await a.stat()).size
    const sb = (await b.stat()).size
    if (sb < sa) return 'differs'
    const bufA = Buffer.alloc(65536)
    const bufB = Buffer.alloc(65536)
    for (let pos = 0; pos < sa; ) {
      const n = Math.min(bufA.length, sa - pos)
      const ra = await a.read(bufA, 0, n, pos)
      const rb = await b.read(bufB, 0, n, pos)
      if (ra.bytesRead !== n || rb.bytesRead !== n || !bufA.subarray(0, n).equals(bufB.subarray(0, n))) return 'differs'
      pos += n
    }
    return sa === sb ? 'same' : 'dst-extends'
  } finally {
    await a.close()
    await b.close()
  }
}

// Works out what would be written, without writing anything. Reads the old dir, and the target database if one exists.
export async function planMigration(opts: Options): Promise<Plan> {
  const from = realOrResolved(opts.from)
  if (!existsSync(opts.from) || !statSync(opts.from).isDirectory()) {
    throw new MigrationError(`old state dir not found: ${opts.from}`)
  }
  const to = realOrResolved(opts.to)
  // The old dir is refused as a target whatever --from is: it is read only.
  for (const old of [from, realOrResolved(OLD_STATE_DIR)]) {
    if (to === old || to.startsWith(old + sep)) {
      throw new MigrationError(`--to ${opts.to} is the old state dir or inside it. The old files are read only; pass --to <new folder>.`)
    }
  }
  const notes: string[] = []
  const dbPath = join(to, DB_FILE)

  const items: PlannedItem[] = []
  const place = (name: string, kv: string | null, value: string | null, summary: string): void => {
    if (value === null) {
      items.push({ name, kv, op: 'skip', value: null, summary })
      return
    }
    const have = kv === null ? null : readKvReadOnly(dbPath, kv)
    if (have === null) {
      items.push({ name, kv, op: 'write', value, summary })
    } else if (have === value) {
      items.push({ name, kv, op: 'unchanged', value: null, summary: 'already up to date' })
    } else {
      items.push({ name, kv, op: opts.force ? 'overwrite' : 'conflict', value: opts.force ? value : null, summary: opts.force ? summary : 'a different v3 value exists; use --force to overwrite' })
    }
  }

  const msgRaw = readTextOrNull(join(from, 'msgmap.json'))
  if (msgRaw === null) {
    place('msgmap', KV.msgmap, null, 'not in the old dir')
  } else {
    const c = convertMsgMap(msgRaw)
    place('msgmap', KV.msgmap, c.json, `${c.entries} entries (${c.converted} ids converted, ${c.dropped} invalid dropped)`)
  }

  const bootRaw = readTextOrNull(join(from, 'last-boot-id'))
  const boot = bootRaw === null ? '' : bootRaw.trim()
  if (boot === '') place('last-boot-id', KV.bootId, null, bootRaw === null ? 'not in the old dir' : 'empty; not migrated')
  else place('last-boot-id', KV.bootId, boot, boot)

  // The audit log is a file in v3 too. Its target is compared byte by byte; a v3 copy that starts with the old log is the
  // same log, grown by new lines, and is kept. The old log is streamed, never held whole in memory.
  const auditSrc = join(from, 'audit.log')
  const auditPath = join(to, 'audit.log')
  if (!existsSync(auditSrc)) {
    items.push({ name: 'audit.log', kv: null, op: 'skip', value: null, summary: 'not in the old dir' })
  } else {
    const lines = await countLines(auditSrc)
    const have = existsSync(auditPath) ? await comparePrefix(auditSrc, auditPath) : null
    if (have === null) items.push({ name: 'audit.log', kv: null, op: 'write', value: null, from: auditSrc, summary: `${lines} lines, copied as it is` })
    else if (have !== 'differs') {
      items.push({ name: 'audit.log', kv: null, op: 'unchanged', value: null, summary: 'target already has the old log; its newer lines are kept' })
    } else if (opts.force) items.push({ name: 'audit.log', kv: null, op: 'overwrite', value: null, from: auditSrc, summary: `${lines} lines, copied as it is` })
    else items.push({ name: 'audit.log', kv: null, op: 'conflict', value: null, summary: 'a different v3 audit.log exists; use --force to overwrite' })
  }

  if (existsSync(join(from, 'classifier'))) notes.push('classifier/ in the old dir is obsolete: ignored')
  notes.push('no session registry file in the old dir: nothing to copy from it')
  return { from, to, items, notes }
}

// Writes the planned values: kv rows in one transaction, then the audit file (temp file, then rename). Inside the
// transaction each row is read again: a 'write' whose row has appeared with another value since the plan was made is a
// conflict, and nothing is committed.
export function executePlan(plan: Plan): void {
  mkdirSync(plan.to, { recursive: true, mode: 0o700 })
  const kvWrites = plan.items.filter((i) => i.kv !== null && (i.op === 'write' || i.op === 'overwrite') && i.value !== null)
  if (kvWrites.length > 0) {
    const db = openDatabase(join(plan.to, DB_FILE))
    try {
      db.exec('BEGIN IMMEDIATE')
      try {
        const current = db.prepare('SELECT value FROM kv WHERE key = ?')
        const stmt = db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
        for (const i of kvWrites) {
          const row = current.get(i.kv as string)
          const have = row ? String(row.value) : null
          if (have === i.value) continue
          if (i.op === 'write' && have !== null) {
            throw new MigrationError(`${i.name} changed in the v3 database while the migration ran; nothing written. Run again.`)
          }
          stmt.run(i.kv as string, i.value as string)
        }
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    } finally {
      db.close()
    }
  }
  for (const i of plan.items) {
    if (i.kv !== null || (i.op !== 'write' && i.op !== 'overwrite')) continue
    const dest = join(plan.to, i.name)
    const tmp = `${dest}.migrate-tmp`
    if (i.from !== undefined) {
      copyFileSync(i.from, tmp)
      chmodSync(tmp, 0o600)
    } else if (i.value !== null) {
      writeFileSync(tmp, i.value, { mode: 0o600 })
    } else {
      continue
    }
    renameSync(tmp, dest)
  }
}

// Owner-only files: the migration creates its files private. Called first thing by the entry point.
export function applyPrivateUmask(): void {
  process.umask(0o077)
}

// The reason the migration must not write, or null. The router owns the target database while it runs.
export async function routerRunningReason(stateDir: string, socketPath: string): Promise<string | null> {
  if (routerLockHeld(stateDir)) return `a tg-bridge router holds the lock in ${stateDir}. Stop it first, then run again.`
  if (await socketAnswers(socketPath)) return `a tg-bridge router answers on the socket ${socketPath}. Stop it first, then run again.`
  return null
}

export function formatPlan(plan: Plan, dryRun: boolean): string[] {
  const lines = [`migrate-to-v3: from ${plan.from} (read only)`, `              to   ${plan.to}`]
  for (const i of plan.items) {
    const verb = { write: 'write', overwrite: 'overwrite', unchanged: 'unchanged', conflict: 'CONFLICT', skip: 'skip' }[i.op]
    const where = i.kv !== null ? `${i.name} (db)` : i.name
    lines.push(`  ${where.padEnd(18)} ${verb.padEnd(10)} ${i.summary}`)
  }
  for (const n of plan.notes) lines.push(`  note: ${n}`)
  if (dryRun) lines.push('dry run: nothing written.')
  return lines
}

const USAGE = 'usage: node --experimental-strip-types scripts/migrate-to-v3.ts [--from <dir>] [--to <dir>] [--dry-run] [--force]'

// Exit codes: 0 done (or dry run), 1 usage or source error, 3 conflicts (nothing written).
export async function main(argv: string[]): Promise<number> {
  const opts: Options = { from: OLD_STATE_DIR, to: STATE_DIR, dryRun: false, force: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') opts.dryRun = true
    else if (a === '--force') opts.force = true
    else if (a === '--from' || a === '--to') {
      const v = argv[++i]
      if (!v) {
        process.stderr.write(`${USAGE}\n`)
        return 1
      }
      if (a === '--from') opts.from = v
      else opts.to = v
    } else {
      process.stderr.write(`${USAGE}\n`)
      return 1
    }
  }
  try {
    const plan = await planMigration(opts)
    const conflicts = plan.items.filter((i) => i.op === 'conflict')
    for (const l of formatPlan(plan, opts.dryRun)) process.stdout.write(`${l}\n`)
    if (conflicts.length > 0) {
      process.stderr.write(`${conflicts.length} v3 value(s) differ from the old state; nothing written. Re-run with --force to overwrite.\n`)
      return 3
    }
    if (opts.dryRun) return 0
    const busy = await routerRunningReason(plan.to, SOCKET_PATH)
    if (busy !== null) {
      process.stderr.write(`migrate-to-v3: ${busy} Nothing written.\n`)
      return 1
    }
    executePlan(plan)
    process.stdout.write('done.\n')
    return 0
  } catch (e) {
    if (e instanceof MigrationError) {
      process.stderr.write(`migrate-to-v3: ${e.message}\n`)
      return 1
    }
    throw e
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  applyPrivateUmask()
  process.exitCode = await main(process.argv.slice(2))
}
