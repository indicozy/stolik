// General prefixes end to end through the router with fake ports: "to <session>:", "note:", the not-yet prefixes,
// no-separator text, and the chat log lines these produce. Real files only in a temp folder under test/.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FilesChatLog } from '../src/adapters/files.ts'
import { localMonth, type ChatLine } from '../src/brain/chatlog.ts'
import type { ChatLogPort } from '../src/ports.ts'
import { FakeConn, HOME, flush, harness, textFrom } from './helpers/fakes.ts'
import { tgMsg } from '../src/adapters/chat/tg-ids.ts'

class RecordingLog implements ChatLogPort {
  readonly lines: ChatLine[] = []
  append(line: ChatLine): void {
    this.lines.push(line)
  }
  attachmentPath(): null {
    return null
  }
  recentExchanges(): ChatLine[] {
    return []
  }
}

// Two live sessions, named alpha and alphabet (so "alph" is ambiguous and "alpha" is exact).
async function two(chatLog?: ChatLogPort) {
  const h = harness({ chatLog })
  await h.router.start()
  for (const [cwd, pid] of [[`${HOME}/alpha`, 4001], [`${HOME}/alphabet`, 4002]] as const) {
    h.platform.dirs.add(cwd)
    h.agent.receive(new FakeConn(), { t: 'register', claudePid: pid, cwd })
  }
  await flush()
  return h
}

test('"to <name>:" delivers the rest of the message to that session, without the prefix', async () => {
  const h = await two()
  await h.chat.inbound(textFrom('to alpha: run the tests'))
  assert.equal(h.agent.sent.length, 1)
  assert.equal(h.agent.sent[0].key, '4001:start-4001')
  assert.equal(h.agent.sent[0].content, 'run the tests')
  assert.deepEqual(h.chat.reactions, [{ messageId: tgMsg(10), emoji: '👀' }])
})

test('spoken and Russian forms reach the same session', async () => {
  const h = await two()
  await h.chat.inbound(textFrom('Send to alpha - hi there', { messageId: tgMsg(11) }))
  await h.chat.inbound(textFrom('отправь в alpha: привет', { messageId: tgMsg(12) }))
  assert.deepEqual(h.agent.sent.map((s) => [s.key, s.content]), [
    ['4001:start-4001', 'hi there'],
    ['4001:start-4001', 'привет'],
  ])
})

test('"to" with no text after the name is a reminder, not a send', async () => {
  const h = await two()
  await h.chat.inbound(textFrom('to alpha:'))
  assert.equal(h.agent.sent.length, 0)
  assert.deepEqual(h.chat.texts(), ['Nothing to send after "to alpha:".'])
})

test('"to" with no name is a usage line', async () => {
  const h = await two()
  await h.chat.inbound(textFrom('to: hello'))
  assert.equal(h.agent.sent.length, 0)
  assert.match(h.chat.texts()[0], /^Usage: to <name>: <text>/)
})

test('"to" with a name no session matches says so and lists the live sessions', async () => {
  const h = await two()
  await h.chat.inbound(textFrom('to zeta: hi'))
  assert.equal(h.agent.sent.length, 0)
  assert.deepEqual(h.chat.texts(), ['no session named "zeta". Live: alpha, alphabet.'])
})

test('"to" with an ambiguous name shows the choice as buttons, and sends nothing yet', async () => {
  const h = await two()
  await h.chat.inbound(textFrom('to alph: hi'))
  assert.equal(h.agent.sent.length, 0)
  const ask = h.chat.sent.find((s) => s.text === 'Which one?')
  assert.ok(ask, 'the choice is sent')
  // The sessions, then New, then the first mode button.
  assert.deepEqual((ask.opts?.rows ?? []).map((r) => r[0]!.text), ['alpha', 'alphabet', '🆕 New', 'quick'])
})

test('"note:" saves to the notes inbox and not to a session', async () => {
  const h = await two()
  await h.chat.inbound(textFrom('note: buy milk'))
  assert.equal(h.agent.sent.length, 0)
  assert.equal(h.store.notes.length, 1)
  assert.match(h.store.notes[0], /buy milk/)
  assert.deepEqual(h.chat.texts(), ['📝 saved'])
})

test('quick, read and web with no modes addon say "not installed"; new with no trusted folder says so; none goes to a session', async () => {
  const h = await two()
  for (const [i, word] of ['new: thing', 'quick: why', 'read: docs', 'web search: lint'].entries()) {
    await h.chat.inbound(textFrom(word, { messageId: tgMsg(20 + i) }))
  }
  assert.equal(h.agent.sent.length, 0)
  assert.deepEqual(h.chat.texts(), [
    'No trusted folder to start in. Run claude there once at the desk to trust it.',
    '"quick" is not installed.',
    '"read" is not installed.',
    '"web" is not installed.',
  ])
})

test('a note-looking message with no separator is an ordinary message', async () => {
  const h = await two()
  await h.chat.inbound(textFrom('note that the build failed'))
  assert.equal(h.store.notes.length, 0)
  assert.equal(h.chat.texts().some((t) => t.includes('not available')), false)
})

test('the chat log gets one line per incoming message, with its target, and one per reply', async () => {
  const chat = new RecordingLog()
  const h = await two(chat)
  await h.chat.inbound(textFrom('to alpha: run it', { messageId: tgMsg(30) }))
  await h.chat.inbound(textFrom('note: milk', { messageId: tgMsg(31) }))
  const incoming = chat.lines.filter((l) => l.dir === 'in')
  assert.deepEqual(
    incoming.map((l) => [l.tg_message_id, l.text, l.target]),
    [
      [tgMsg(30), 'to alpha: run it', { type: 'session', name: 'alpha' }],
      [tgMsg(31), 'note: milk', { type: 'note', name: 'inbox' }],
    ],
  )
  assert.equal(incoming[0].kind, 'text')
  assert.equal(incoming[0].attachments.length, 0)
})

test('the chat log records a router reply, with its message id, as an outgoing line', async () => {
  const chat = new RecordingLog()
  const h = await two(chat)
  await h.chat.inbound(textFrom('to zeta: hi', { messageId: tgMsg(40) }))
  const out = chat.lines.find((l) => l.dir === 'out')
  assert.ok(out)
  assert.equal(out.text, 'no session named "zeta". Live: alpha, alphabet.')
  assert.equal(out.tg_message_id, h.chat.sent[0].id)
})

test('a photo sent with "to <name>:" is saved to the chat-log attachments folder and logged with its path', async () => {
  const root = mkdtempSync(join(import.meta.dirname, '.tmp-chatlog-routing-'))
  try {
    const chat = new FilesChatLog(root)
    const h = await two(chat)
    // The fake Telegram does not model downloads: write the file the router asks for.
    Object.assign(h.chat, {
      download: async (_fileId: string, dest: string) => writeFileSync(dest, 'png'),
    })
    const photo = textFrom('to alpha: look at this', { kind: 'photo', messageId: tgMsg(50), fileRef: 'f1' })
    await h.chat.inbound(photo)

    assert.equal(h.agent.sent.length, 1)
    assert.equal(h.agent.sent[0].content, 'look at this')
    const imagePath = h.agent.sent[0].meta.image_path
    assert.ok(imagePath.startsWith(join(root, 'attachments')), `saved under the log root: ${imagePath}`)
    assert.equal(readFileSync(imagePath, 'utf8'), 'png')

    const monthFile = join(root, 'log', `${localMonth(h.clock.now())}.jsonl`)
    const line = JSON.parse(readFileSync(monthFile, 'utf8').trim().split('\n').pop()!)
    assert.equal(line.dir, 'in')
    assert.equal(line.kind, 'photo')
    assert.equal(line.target.name, 'alpha')
    assert.equal(line.attachments.length, 1)
    assert.match(line.attachments[0], /^attachments\/\d{4}-\d{2}-\d{2}\/\d{6}-photo\.jpg$/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
