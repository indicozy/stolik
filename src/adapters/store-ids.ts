// Store boundary for opaque chat ids (plan 23 §4.1). The SQLite and JSON stores keep numbers on disk until the schema
// migration (step 0c-2); they convert here. A store never parses an id itself.
//
// Numbers on disk: a Telegram id is its own number ("tg:-1001234" <-> -1001234). An e2e id "e2e:<n>" is stored as
// -(E2E_DB_BASE + n). Telegram never reaches E2E_DB_BASE in magnitude (supergroup ids are about -1e12), so the two
// ranges cannot collide. Decoding does not need the kind of id: the number alone says which platform it came from.
import type { MessageId, ThreadId, ChatId } from '../brain/chat-types.ts'
import { isE2eId, e2eNum, e2eMsg } from '../router/e2e.ts'
import { isTgId, tgNum, TG_PREFIX } from './chat/tg-ids.ts'

export const E2E_DB_BASE = 1_000_000_000_000_000

// True when an id has a number on disk: a Telegram id and an e2e id. The ids of other platforms (Discord) are strings
// only; the stores and the chat log keep them as they are.
export function hasDbNumber(id: string): boolean {
  return isTgId(id) || isE2eId(id)
}

// A name for an id in a file name (inbox and attachment stems) when the id has no number: ':' becomes '-', and every
// other character outside [A-Za-z0-9.] becomes "_" plus its hex code, so '_' and '-' never mean a separator.
export function idFileStem(id: string): string {
  return id.replace(/[^A-Za-z0-9.]/g, (c) => (c === ':' ? '-' : `_${c.charCodeAt(0).toString(16).padStart(2, '0')}`))
}

// Any chat, thread, message or user id (string) to the number stored on disk. null stays null.
export function toDbId(id: null): null
export function toDbId(id: string): number
export function toDbId(id: string | null): number | null
export function toDbId(id: string | null): number | null {
  if (id === null) return null
  if (isE2eId(id)) {
    const n = e2eNum(id)
    if (n >= E2E_DB_BASE) throw new Error(`e2e id too large to store: ${id}`)
    return -(E2E_DB_BASE + n)
  }
  if (!id.startsWith(TG_PREFIX)) throw new Error(`id has no storable form: ${JSON.stringify(id)}`)
  const n = tgNum(id)
  if (n <= -E2E_DB_BASE) throw new Error(`Telegram id collides with the e2e range: ${id}`)
  return n
}

// The id string for a stored number. Numbers at or below -E2E_DB_BASE are e2e ids; every other number is Telegram's.
function fromDbNum(n: number): string {
  if (!Number.isSafeInteger(n)) throw new Error(`stored id is not an integer: ${n}`)
  if (n <= -E2E_DB_BASE) return e2eMsg(-n - E2E_DB_BASE)
  return `${TG_PREFIX}${n}`
}

export function fromDbMsg(n: null): null
export function fromDbMsg(n: number): MessageId
export function fromDbMsg(n: number | null): MessageId | null
export function fromDbMsg(n: number | null): MessageId | null {
  if (n === null) return null
  return fromDbNum(n) as MessageId
}

export function fromDbThread(n: null): null
export function fromDbThread(n: number): ThreadId
export function fromDbThread(n: number | null): ThreadId | null
export function fromDbThread(n: number | null): ThreadId | null {
  if (n === null) return null
  return fromDbNum(n) as ThreadId
}

export function fromDbChat(n: null): null
export function fromDbChat(n: number): ChatId
export function fromDbChat(n: number | null): ChatId | null
export function fromDbChat(n: number | null): ChatId | null {
  if (n === null) return null
  return fromDbNum(n) as ChatId
}
