// Discord's direct send (batch D2): `tg-notify` DMs the owner with the REST API when the router is not running. Text
// only. notify.ts loads this module only when chat.app is 'discord'. Errors never carry the token.
import { DC_MAX_TEXT, contentOf, messageBody } from './discord-map.ts'
import type { DcRest } from './discord.ts'

// The REST the direct send needs. Tests pass a fake through makeRest.
export type DirectRest = Pick<DcRest, 'post'>

export type DirectOpts = { project: string | null; plain: boolean; silent: boolean }

// Splits text into pieces that each fit the message limit after escaping (plain text escapes Markdown, which adds
// characters). A piece that is still too long is split in half.
function fitChunks(text: string, format: 'plain' | 'markdown'): string[] {
  const chars = Array.from(text)
  const out: string[] = []
  for (let i = 0; i < chars.length; i += DC_MAX_TEXT) {
    out.push(...fit(chars.slice(i, i + DC_MAX_TEXT).join(''), format))
  }
  return out
}

function fit(piece: string, format: 'plain' | 'markdown'): string[] {
  try {
    contentOf(piece, format)
    return [piece]
  } catch {
    const chars = Array.from(piece)
    if (chars.length <= 1) throw new Error('a character does not fit the message limit')
    const half = Math.ceil(chars.length / 2)
    return [...fit(chars.slice(0, half).join(''), format), ...fit(chars.slice(half).join(''), format)]
  }
}

// Sends the text to the owner's DM. Returns null when sent, else a short error. Opens the DM channel once.
export async function sendDirectDiscord(
  cfg: { token: string; ownerId: string },
  text: string,
  opts: DirectOpts,
  makeRest: (token: string) => Promise<DirectRest> = defaultRest,
): Promise<string | null> {
  try {
    const rest = await makeRest(cfg.token)
    const format = opts.plain ? 'plain' : 'markdown'
    const full = opts.project ? `[${opts.project}] ${text}` : text
    const dm = (await rest.post('/users/@me/channels', { body: { recipient_id: cfg.ownerId } })) as { id?: unknown }
    if (typeof dm.id !== 'string') return 'could not open the direct message channel'
    for (const chunk of fitChunks(full, format)) {
      await rest.post(`/channels/${dm.id}/messages`, {
        body: messageBody(chunk, { format, silent: opts.silent }),
      })
    }
    return null
  } catch (e) {
    return redact((e as Error)?.message ?? 'network error', cfg.token)
  }
}

async function defaultRest(token: string): Promise<DirectRest> {
  const { createDiscordClient } = await import('./discord.ts')
  return (await createDiscordClient(token)).rest
}

function redact(text: string, token: string): string {
  return token ? text.split(token).join('[token]') : text
}
