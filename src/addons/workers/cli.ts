// ai-workers: prints the AI workers report (report.ts). --no-llm skips the Haiku summary pass; --send hands the text to
// tg-notify --raw (direct Bot API send, no router).
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildWorkersReport, configSecrets } from './report.ts'

const USAGE = 'usage: ai-workers [--no-llm] [--send]\n'
const KNOWN = new Set(['--no-llm', '--send', '-h', '--help'])

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(USAGE)
    return 0
  }
  const bad = args.filter((a) => !KNOWN.has(a))
  if (bad.length > 0) {
    process.stderr.write(`ai-workers: unknown argument ${bad[0]}\n${USAGE}`)
    return 2
  }
  const text = await buildWorkersReport({ secrets: configSecrets(), llm: !args.includes('--no-llm') })
  process.stdout.write(`${text}\n`)
  if (args.includes('--send')) {
    // dist/addons/workers/cli.js: three levels up is the repo root.
    const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
    const r = spawnSync(join(repo, 'bin', 'tg-notify'), ['--raw', text], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 90_000 })
    if (r.status !== 0) {
      process.stderr.write('ai-workers: send failed\n')
      return 1
    }
  }
  return 0
}

main().then(
  (code) => process.exit(code),
  () => {
    process.stderr.write('ai-workers: failed\n')
    process.exit(1)
  },
)
