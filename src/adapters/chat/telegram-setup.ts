// The Telegram part of `stolik setup` (plan 0e, inventory B). Setup asks this module to make the pairing code, to wait
// for the owner to send it, and to give the owner's answer back. Two ways to wait: a running router listens (the `pair`
// ctl command, the router owns the bot's poller), or, with no router running, setup polls the bot itself for a short time.
import { Api, GrammyError } from 'grammy'
import { attemptPairing, PAIR_TTL_MS, readPairing, startPairing } from '../../brain/pairing.ts'
import type { PairCandidate } from '../../router/pairing-control.ts'
import { oneShot } from '../channel/ipc.ts'
import { routerLockHeld } from '../instance-lock.ts'

// The group steps of setup, step 3 (text as shown to the owner).
export const TELEGRAM_GROUP_STEPS = [
  'Group. The bot talks to you in a private supergroup with Topics: one topic per folder.',
  '  a. In Telegram, create a new group. Open its settings and turn Topics on (this makes it a supergroup).',
  '  b. Add the bot to the group and make it an admin with "Manage topics" and "Delete messages".',
  '  c. In the group, send /bind. The bot checks that the sender is you and stores the group id.',
  '  Until /bind, the bot works in its private chat (DM mode).',
]

export type PairResult = { ok: true; candidate: PairCandidate } | { ok: false; error: string }

// What setup needs for pairing. `token` is the bot token (typed, or the saved one).
export type PairingDriver = {
  // Writes a new code and returns it with the bot's @name ('' when getMe cannot be reached).
  begin(token: string): Promise<{ code: string; bot: string }>
  // Resolves when the code arrives (or fails: expired, locked, another poller, no answer).
  wait(token: string): Promise<PairResult>
  // Gives the owner's yes or no to the router. Setup writes the config itself.
  confirm(userId: string, yes: boolean): Promise<void>
}

// The state folder and the socket a running router answers on.
export type TelegramPairingPaths = { stateDir: string; socketPath: string }

// A pairing driver for the real setup: the router path or the self-poll path, chosen at wait().
export function makeTelegramPairing(paths: TelegramPairingPaths): PairingDriver {
  return {
    async begin(token) {
      const code = startPairing(paths.stateDir, 'telegram')
      let bot = ''
      try {
        const me = await new Api(token).getMe()
        bot = me.username ? `@${me.username}` : ''
      } catch {
        // The name is for the owner's convenience only; the code works without it.
      }
      return { code, bot }
    },
    async wait(token) {
      if (routerLockHeld(paths.stateDir)) {
        const reply = await oneShot({ t: 'ctl', cmd: 'pair' }, PAIR_TTL_MS + 10_000)
        if (!reply) return { ok: false, error: 'the router is running but did not answer; stop it or try again' }
        if (reply.ok === true && reply.pair) return { ok: true, candidate: reply.pair as PairCandidate }
        return { ok: false, error: typeof reply.error === 'string' ? reply.error : 'pairing failed' }
      }
      return pollOwnPairing(token, paths.stateDir)
    },
    async confirm(userId, yes) {
      if (!routerLockHeld(paths.stateDir)) return
      await oneShot({ t: 'ctl', cmd: 'pair_confirm', userId, yes }, 5_000)
    },
  }
}

// Setup polls the bot itself while the code is active. Telegram allows one poller per token: a 409 ends this with a
// message, never a retry loop. Every private text counts as an attempt; the reply "Paired." goes to the sender.
export async function pollOwnPairing(token: string, stateDir: string, api: Api = new Api(token)): Promise<PairResult> {
  let offset: number | undefined
  let failures = 0
  while (readPairing(stateDir) !== null) {
    let updates: Awaited<ReturnType<Api['getUpdates']>>
    try {
      updates = await api.getUpdates({ offset, timeout: 10, allowed_updates: ['message'] })
      failures = 0
    } catch (e) {
      if (e instanceof GrammyError && e.error_code === 409) {
        return { ok: false, error: 'another process polls this bot: stop the router or use stolik service first' }
      }
      failures += 1
      if (failures >= 3) return { ok: false, error: `cannot reach Telegram: ${(e as Error).message}` }
      await new Promise((r) => setTimeout(r, 2000))
      continue
    }
    for (const u of updates) {
      offset = u.update_id + 1
      const m = u.message
      if (!m || m.chat.type !== 'private' || typeof m.text !== 'string' || !m.from) continue
      const verdict = attemptPairing(stateDir, m.text)
      if (verdict === 'paired') {
        await api.sendMessage(m.chat.id, 'Paired.').catch(() => {})
        const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ')
        return { ok: true, candidate: { userId: String(m.from.id), name, username: m.from.username ?? null } }
      }
      if (verdict === 'expired' || verdict === 'locked') {
        return { ok: false, error: verdict === 'locked' ? 'too many wrong codes: pairing is locked; run setup --pair again' : 'the pairing code expired; run setup --pair again' }
      }
    }
  }
  return { ok: false, error: 'the pairing code expired; run setup --pair again' }
}
