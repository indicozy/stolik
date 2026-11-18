import { existsSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { envFilePath, loadConfig, tgConfigPath } from './config.ts'
import { findClaudePid } from './claudepid.ts'
import { oneShot } from './adapters/channel/ipc.ts'
import type { NotifyMsg } from './adapters/channel/protocol.ts'
import { NOTIFY_USAGE, parseNotifyArgs, type NotifyArgs } from './notify-args.ts'
import { pingFor } from './brain/notify-level.ts'
import { sendDirect } from './adapters/chat/telegram-direct.ts'

// tg-notify replacement: `node dist/notify.js [--raw] [--plain] [--silent|--critical] [--file <path>]... [message...]`, or
// message on stdin. Normal path: ask the router to send (kind 'requested'). If the router is unreachable, send directly
// with the Bot API (text only; files need the router so the outbound file denylist applies). --silent sends without a
// ping there too (disable_notification); --critical always pings.
// The text is Markdown, sent as Telegram HTML; --plain sends it as plain text. A chunk Telegram refuses as HTML is sent plain.

const ROUTER_TIMEOUT_MS = 60_000

function usage(): never {
  process.stderr.write(NOTIFY_USAGE)
  process.exit(2)
}

function die(msg: string, code = 1): never {
  process.stderr.write(`tg-notify: ${msg}\n`)
  process.exit(code)
}

function readStdin(): Promise<string> {
  return new Promise((resolveText, reject) => {
    const chunks: Buffer[] = []
    process.stdin.on('data', (c: Buffer) => chunks.push(c))
    process.stdin.once('end', () => resolveText(Buffer.concat(chunks).toString('utf8')))
    process.stdin.once('error', reject)
  })
}

// Project name: basename of the nearest ancestor holding a .git entry, else basename of cwd.
function projectName(cwd: string): string {
  let dir = cwd
  for (;;) {
    if (existsSync(join(dir, '.git'))) return basename(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return basename(cwd)
}

// The direct path: the chat app's own sender (adapters/chat/telegram-direct.ts) with the config's token and DM id.
async function sendDirectly(text: string, project: string | null, plain: boolean, silent: boolean): Promise<void> {
  const { readChatSettings } = await import('./adapters/chat/discord-setup.ts')
  const chat = readChatSettings(envFilePath(), tgConfigPath())
  if (chat.app === 'discord') {
    if (!chat.token || !chat.ownerId) die('Discord is not set up (no token or owner); run tg-bridge setup --chat discord', 2)
    const { sendDirectDiscord } = await import('./adapters/chat/discord-direct.ts')
    const err = await sendDirectDiscord({ token: chat.token, ownerId: chat.ownerId }, text, { project, plain, silent })
    if (err !== null) die(`send failed: ${err}`)
    process.stdout.write('tg-notify: sent\n')
    return
  }
  let cfg: ReturnType<typeof loadConfig>
  try {
    cfg = loadConfig()
  } catch (e: any) {
    die(`router not reachable and ${e?.message ?? 'config missing'}`, 2)
  }
  const tokens = [cfg.token, cfg.oldToken].filter((t): t is string => !!t)
  const err = await sendDirect({ tokens, chatId: cfg.chatId }, text, { project, plain, silent })
  if (err !== null) die(`send failed: ${err}`)
  process.stdout.write('tg-notify: sent\n')
}

async function main(): Promise<void> {
  let args: NotifyArgs
  try {
    args = parseNotifyArgs(process.argv.slice(2))
  } catch (e: any) {
    process.stderr.write(NOTIFY_USAGE)
    die(String(e?.message ?? e), 2)
  }
  let text = args.words.join(' ')
  if (args.words.length === 0 && !process.stdin.isTTY) text = await readStdin()
  if (args.words.length === 0 && process.stdin.isTTY) usage()
  if (!text.trim()) die('empty message', 2)

  const files = args.files.map((f) => resolve(f))
  for (const f of files) {
    if (!existsSync(f) || !statSync(f).isFile()) die(`not a file: ${f}`, 2)
  }

  const cwd = process.cwd()
  const project = projectName(cwd)

  // --raw is plain text without the [project] tag; the router always tags, so raw bypasses it.
  if (!args.raw) {
    const msg: NotifyMsg = {
      t: 'notify',
      claudePid: findClaudePid(),
      cwd,
      text,
      kind: 'requested',
      level: args.level,
      ...(files.length ? { files } : {}),
      ...(args.plain ? { plain: true } : {}),
    }
    const reply = await oneShot(msg, ROUTER_TIMEOUT_MS)
    if (reply) {
      if (reply.t === 'ok' && reply.delivered !== false) {
        process.stdout.write('tg-notify: sent\n')
        return
      }
      die(reply.error ? `router: ${reply.error}` : 'router did not deliver')
    }
  }

  if (files.length) die('files need the router (not available with --raw, or the router is down)')
  await sendDirectly(text, args.raw ? null : project, args.plain, !pingFor(args.level, false))
}

main().catch((e: any) => die(String(e?.message ?? e)))
