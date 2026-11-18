// Telegram's direct send (plan 0e decision 7, inventory D): `tg-notify` posts with the Bot API when the router is not
// running. Text only (files need the router, so the outbound file denylist applies). Used by notify.ts; the chat app is
// picked by chat.app, and only Telegram has a direct path today.

import { mdToTelegramHtml, prefixLine, reopenFences } from '../../markdown.ts'

const TG_LIMIT = 4000
// Room for the HTML tags the converter adds to a markdown chunk.
const MD_CHUNK_LIMIT = TG_LIMIT - 600
const ROUTER_TIMEOUT_MS = 60_000
const API_TIMEOUT_MS = 20_000
// Telegram's limit on the HTML text of one message.
const TG_HTML_LIMIT = 4096

function chunkText(text: string, limit: number = TG_LIMIT): string[] {
  const chars = Array.from(text)
  const parts: string[] = []
  for (let i = 0; i < chars.length; i += limit) parts.push(chars.slice(i, i + limit).join(''))
  return parts
}

// Returns Telegram's error description only (never the URL, which contains the token).
async function tgCall(token: string, body: BodyInit): Promise<string | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    })
    const json = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null
    if (json?.ok === true) return null
    return json?.description ?? `HTTP ${res.status}`
  } catch (e: any) {
    return String(e?.cause?.code ?? e?.name ?? 'network error')
  }
}

// One chunk to one token. Markdown chunks go as HTML; Telegram refusing the HTML (or the HTML being empty or too
// long) sends the chunk as plain text instead.
async function sendChunk(token: string, chatId: string, chunk: string, plain: boolean, silent: boolean): Promise<string | null> {
  const params = (text: string, html: boolean): URLSearchParams =>
    new URLSearchParams({
      chat_id: chatId,
      text,
      disable_web_page_preview: 'true',
      ...(html ? { parse_mode: 'HTML' } : {}),
      ...(silent ? { disable_notification: 'true' } : {}),
    })
  if (!plain) {
    const html = mdToTelegramHtml(chunk)
    if (html.length <= TG_HTML_LIMIT && html.replace(/<[^>]*>/g, '').trim() !== '') {
      const err = await tgCall(token, params(html, true))
      if (err === null || !/can't parse entities/i.test(err)) return err
    }
  }
  return tgCall(token, params(chunk, false))
}

// The chunks of one direct send. Plain: as before, the project tag in front of the text. Markdown: the tag sits in
// front of the first chunk, and each chunk is fence-safe.
function directChunks(text: string, project: string | null, plain: boolean): string[] {
  if (plain) return chunkText(project ? `[${project}] ${text}` : text)
  const body = reopenFences(chunkText(text, MD_CHUNK_LIMIT))
  return body.map((c, i) => (i === 0 && project ? prefixLine(`[${project}]`, c) : c))
}

// The direct send of one text: every chunk to the first token that delivers it. Returns Telegram's error for the first
// chunk that no token could send (null when all were sent); never the token itself.
export async function sendDirect(
  cfg: { tokens: string[]; chatId: string },
  text: string,
  opts: { project: string | null; plain: boolean; silent: boolean },
): Promise<string | null> {
  for (const part of directChunks(text, opts.project, opts.plain)) {
    let lastErr: string | null = 'no token'
    let sent = false
    for (const token of cfg.tokens) {
      lastErr = await sendChunk(token, cfg.chatId, part, opts.plain, opts.silent)
      if (lastErr === null) {
        sent = true
        break
      }
    }
    if (!sent) return lastErr
  }
  return null
}
