// tg-notify's command line (src/notify.ts): flags and words. Pure, so the flags can be tested without a router.
import type { NotifyLevel } from './brain/notify-level.ts'

export const NOTIFY_USAGE = 'usage: tg-notify [--raw] [--plain] [--silent | --critical] [--file <path>]... <message> | <cmd> | tg-notify\n'

export type NotifyArgs = { raw: boolean; plain: boolean; level: NotifyLevel; files: string[]; words: string[] }

// Throws an Error with the reason when a flag is bad (the caller prints NOTIFY_USAGE).
export function parseNotifyArgs(argv: string[]): NotifyArgs {
  const out: NotifyArgs = { raw: false, plain: false, level: 'default', files: [], words: [] }
  let silent = false
  let critical = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--raw') out.raw = true
    else if (a === '--plain') out.plain = true
    else if (a === '--silent') silent = true
    else if (a === '--critical') critical = true
    else if (a === '--file') {
      const v = argv[++i]
      if (!v) throw new Error('--file needs a path')
      out.files.push(v)
    } else if (a.startsWith('--file=')) out.files.push(a.slice('--file='.length))
    else out.words.push(a)
  }
  if (silent && critical) throw new Error('--silent and --critical cannot be used together')
  out.level = critical ? 'critical' : silent ? 'silent' : 'default'
  return out
}
