// Terminal prompts for `tg-bridge setup`. Lines are queued as they arrive, so piped or pasted answers are not lost.
// A secret prompt turns the echo off, so the token is never shown on screen.
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'

export type Prompter = { ask(question: string): Promise<string>; askSecret(question: string): Promise<string>; close(): void }

// One readline interface for the whole session. Resolves '' when stdin closes before an answer.
export function createPrompter(input: NodeJS.ReadStream = process.stdin, stdout: NodeJS.WriteStream = process.stdout): Prompter {
  const lines: string[] = []
  const waiting: Array<(line: string) => void> = []
  let closed = false
  let muted = false
  // readline echoes typed input through this stream; it is silenced while a secret is typed.
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) stdout.write(chunk)
      cb()
    },
  })
  const rl = createInterface({ input, output, terminal: input.isTTY === true })
  rl.on('line', (line) => {
    const next = waiting.shift()
    if (next) next(line)
    else lines.push(line)
  })
  rl.on('close', () => {
    closed = true
    while (waiting.length) waiting.shift()!('')
  })
  const question = (q: string, hidden: boolean): Promise<string> =>
    new Promise((resolve) => {
      stdout.write(q)
      muted = hidden
      const done = (answer: string) => {
        muted = false
        if (hidden) stdout.write('\n')
        resolve(answer)
      }
      if (lines.length > 0) return done(lines.shift()!)
      if (closed) return done('')
      waiting.push(done)
    })
  return {
    ask: (q) => question(q, false),
    askSecret: (q) => question(q, true),
    close: () => rl.close(),
  }
}
