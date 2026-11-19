// The chat adapter contract (chat connector 0d batch 3; inventory section E of research/0d-sites.md). One suite runs
// against every adapter through a rig: FakeChat (test/chat-contract.fake.test.ts) and the Telegram adapter driven
// through its seam (test/chat-contract.telegram.test.ts). Nothing here touches the network. A case a rig cannot provoke
// is skipped with its reason (t.skip, or the `skip` option). A real mismatch is a `todo` with its reason: it shows in
// the output and does not fail the run. Case ids are the inventory's numbers (E1..E17); a case with parts is split
// into E15:cap and the like.
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ChatError, type ButtonPress, type ChatErrorKind, type ChatEvent, type ChatId, type ChatPort, type Inbound, type MessageId, type ThreadId, type UserId } from '../../src/brain/chat-types.ts'
import { ChunkSendError } from '../../src/brain/outbound-queue.ts'
import { ISOLATED_ROOT } from './isolate.ts'

// Where the platform put something: the owner's private chat, the bound home, or anywhere else.
export type Where = 'dm' | 'home' | 'other'

// What the platform was asked to do, in its own terms. Cases filter by op; the order within one op is the call order.
export type Out =
  | { op: 'send'; chat: Where; thread?: ThreadId; text: string; replyTo: boolean; buttons: string[]; id: MessageId }
  | { op: 'edit'; chat: Where; id: MessageId; text: string; buttons: string[] }
  | { op: 'clear'; chat: Where; id: MessageId }
  | { op: 'react'; chat: Where; id: MessageId; emoji: string }
  | { op: 'typing'; chat: Where; thread?: ThreadId }
  | { op: 'file'; chat: Where; path: string; asPhoto: boolean; id: MessageId }
  | { op: 'topic'; action: 'create' | 'rename' | 'close' | 'reopen'; thread?: ThreadId; name?: string }
  | { op: 'ack'; id: string; text?: string }

// Platform refusals a rig can provoke. Each one reaches the adapter as the platform would send it.
export type Failure = 'rate-limited' | 'access-lost' | 'thread-closed' | 'not-modified' | 'too-long' | 'network' | 'server' | 'client'

// Service events in the platform's terms, as the rig injects them (the rig builds the platform's own update).
export type InjectEvent =
  | { type: 'home-moved' } // the bound home moves to rig.otherHome
  | { type: 'member-joined'; who: 'stranger' | 'owner' | 'bot'; label: string }
  | { type: 'rights'; access: 'ok' | 'lost' } // the bot's own rights in the home
  | { type: 'anonymous-post' } // a message in the home with no attributable sender

export type Rig = {
  chat: ChatPort
  // The owner's private chat, the bound home, a second home (for home-moved), the owner's id, and an id no message has.
  dm: ChatId
  home: ChatId
  otherHome: ChatId
  owner: UserId
  ghost: MessageId
  // False when the owner filter and the member classification are adapter code the rig does not run (FakeChat). The
  // cases that test them then skip.
  adapterFilters: boolean
  out(): Out[]
  // The next platform call is refused with this failure, after `skip` calls went through.
  fail(kind: Failure, skip?: number): void
  // Sends into this thread are refused: the platform no longer has it.
  goneThread(thread: ThreadId): void
  inject: {
    message(o: { text?: string; kind?: 'text' | 'sticker' | 'photo'; from?: 'owner' | 'stranger'; chat?: 'dm' | 'home'; thread?: ThreadId; replyTo?: MessageId }): Promise<void>
    press(o: { data: string; from?: 'owner' | 'stranger'; chat?: 'dm' | 'home'; message?: MessageId }): Promise<void>
    event(e: InjectEvent): Promise<void>
  }
  close(): Promise<void> | void
}

export type ContractOpts = { skip?: Record<string, string>; todo?: Record<string, string> }

const settle = () => new Promise<void>((r) => setTimeout(r, 10))

// Records what the chat hands the router, in order.
function listen(chat: ChatPort) {
  const inbound: Inbound[] = []
  const presses: ButtonPress[] = []
  const events: ChatEvent[] = []
  chat.onInbound(async (m) => { inbound.push(m) })
  chat.onButton(async (p) => { presses.push(p) })
  chat.onChatEvent(async (e) => { events.push(e) })
  return { inbound, presses, events }
}

type Of<K extends Out['op']> = Extract<Out, { op: K }>
const of = <K extends Out['op']>(rig: Rig, op: K): Of<K>[] => rig.out().filter((o): o is Of<K> => o.op === op)

// Expected ChatError for each refusal: the kind, and the transient flag and status where the rig sets them.
const FAILURES: Array<{ kind: Failure; expect: ChatErrorKind; transient?: boolean; status?: number }> = [
  { kind: 'rate-limited', expect: 'rate-limited' },
  { kind: 'access-lost', expect: 'access-lost' },
  { kind: 'thread-closed', expect: 'thread-closed' },
  { kind: 'not-modified', expect: 'not-modified' },
  { kind: 'too-long', expect: 'too-long' },
  { kind: 'network', expect: 'other', transient: true },
  { kind: 'server', expect: 'other', transient: true, status: 500 },
  { kind: 'client', expect: 'other', transient: false, status: 400 },
]

export function chatContract(name: string, make: () => Promise<Rig>, opts: ContractOpts = {}): void {
  const run = (id: string, title: string, body: (rig: Rig, t: TestContext) => Promise<void>) => {
    test(`${name} ${id}: ${title}`, { skip: opts.skip?.[id], todo: opts.todo?.[id] }, async (t) => {
      const rig = await make()
      try {
        await body(rig, t)
      } finally {
        await rig.close()
      }
    })
  }

  run('E1', 'capabilities are sane', async (rig) => {
    const c = rig.chat.capabilities
    assert.ok(rig.dm.startsWith(`${c.platform}:`), 'the DM id carries the platform prefix')
    assert.ok(rig.home.startsWith(`${c.platform}:`), 'the home id carries the platform prefix')
    assert.ok(c.text.maxChars > 0, 'a text limit')
    assert.ok(c.names.home && c.names.lobby && c.names.thread, 'the platform words for home, lobby and thread')
    for (const m of ['createThread', 'renameThread', 'closeThread', 'reopenThread'] as const) {
      assert.equal(typeof rig.chat[m], 'function', `${m} is part of the port`)
    }
    if (c.threads.kind !== 'none') assert.ok(c.threads.maxNameChars > 0, 'a thread name limit')
    if (c.buttons.kind === 'inline') {
      assert.ok(c.buttons.payloadBytes > 0 && c.buttons.maxRows > 0 && c.buttons.maxPerRow > 0 && c.buttons.labelChars > 0)
    }
    if (c.files.outbound) assert.ok(c.files.maxUploadBytes > 0, 'an upload limit')
    assert.ok(c.rate.perChatPerMin > 0 && c.rate.burst > 0, 'a rate')
  })

  run('E2', 'ids carry the platform prefix and compare in send order', async (rig) => {
    const { chat } = rig
    const p = `${chat.capabilities.platform}:`
    chat.setHome(rig.home)
    const a = await chat.sendText('one')
    const b = await chat.sendText('two')
    const dm = await chat.sendText('dm', { dm: true })
    const [d, e] = await chat.sendChunks(['four', 'five'])
    const f = await chat.sendText('six')
    const thread = await chat.createThread('topic')
    for (const id of [a, b, dm, d, e, f]) assert.ok(id.startsWith(p), `${id} carries ${p}`)
    assert.ok(thread.startsWith(p), `${thread} carries ${p}`)
    const seq = [a, b, d, e, f]
    for (let i = 0; i < seq.length; i++) {
      assert.equal(chat.compareMessages(seq[i], seq[i]), 0, 'a message equals itself')
      for (let j = i + 1; j < seq.length; j++) {
        assert.ok(chat.compareMessages(seq[i], seq[j]) < 0, `${seq[i]} is older than ${seq[j]}`)
        assert.ok(chat.compareMessages(seq[j], seq[i]) > 0, 'the order is antisymmetric')
      }
    }
    assert.deepEqual([...seq].reverse().sort((x, y) => chat.compareMessages(x, y)), seq, 'the order is transitive')
  })

  run('E3', 'sendText returns an id; sendChunks returns ids in order, replyTo on the first chunk, buttons on the last', async (rig) => {
    const { chat } = rig
    chat.setHome(rig.home)
    const anchor = await chat.sendText('anchor')
    assert.equal(typeof (await chat.sendText('single', { replyTo: anchor })), 'string')
    const from = rig.out().length
    const ids = await chat.sendChunks(['a', 'b', 'c'], { replyTo: anchor, rows: [[{ text: 'Go', data: 'go' }]] })
    assert.equal(ids.length, 3)
    const sends = rig.out().slice(from).filter((o): o is Of<'send'> => o.op === 'send')
    assert.deepEqual(sends.map((s) => s.text), ['a', 'b', 'c'], 'in order')
    assert.deepEqual(sends.map((s) => s.id), ids, 'the ids returned are the ids sent')
    assert.deepEqual(sends.map((s) => s.replyTo), [true, false, false], 'the reply goes on the first chunk only')
    assert.deepEqual(sends.map((s) => s.buttons.length > 0), [false, false, true], 'the buttons go on the last chunk only')

  })

  run('E3:failure', 'a failed chunk stops the group and reports the chunks that went out', async (rig) => {
    const { chat } = rig
    chat.setHome(rig.home)
    rig.fail('network', 1) // the first chunk goes out, the second is refused
    const err = await chat.sendChunks(['x', 'y', 'z']).then(() => null, (e: unknown) => e)
    assert.ok(err instanceof ChunkSendError, `a ChunkSendError, not ${String(err)}`)
    assert.equal(err.sentIds.length, 1, 'one chunk went out')
    assert.equal(of(rig, 'send').filter((s) => s.text === 'x').length, 1)
    assert.equal(of(rig, 'send').filter((s) => s.text === 'y' || s.text === 'z').length, 0, 'nothing after the failure')
  })

  run('E4', 'a text of exactly maxChars goes; one more character is refused as too-long', async (rig) => {
    const max = rig.chat.capabilities.text.maxChars
    assert.equal(typeof (await rig.chat.sendText('x'.repeat(max))), 'string')
    const err = await rig.chat.sendText('x'.repeat(max + 1)).then(() => null, (e: unknown) => e)
    assert.ok(err instanceof ChatError && err.kind === 'too-long', `too-long, not ${String(err)}`)
  })

  run('E5', 'buttons keep their data, a tap comes back with it, a second ack does not throw', async (rig, t) => {
    const { chat } = rig
    const b = chat.capabilities.buttons
    if (b.kind !== 'inline') {
      t.skip('no inline buttons on this platform')
      return
    }
    const data = 'd'.repeat(b.payloadBytes)
    const l = listen(chat)
    const id = await chat.sendText('pick', { rows: [[{ text: 'L'.repeat(b.labelChars), data }]] })
    assert.ok(of(rig, 'send').find((s) => s.id === id)?.buttons.includes(data), 'the button data reaches the platform intact')
    await rig.inject.press({ data, message: id })
    await settle()
    assert.equal(l.presses.length, 1, 'the tap reaches onButton')
    assert.equal(l.presses[0].data, data)
    assert.equal(l.presses[0].message, id, 'the tap names the message that carried the button')
    await chat.ackButton(l.presses[0].pressId, 'done')
    await chat.ackButton(l.presses[0].pressId)
  })

  run('E6', 'inbound messages carry the chat, the sender, the thread, the reply and the kind', async (rig) => {
    const { chat } = rig
    const l = listen(chat)
    chat.setHome(rig.home) // topics live in the bound home
    const thread = await chat.createThread('topic')
    const first = await chat.sendText('question')
    await rig.inject.message({ text: 'hello' })
    await rig.inject.message({ text: 'in topic', chat: 'home', thread })
    await rig.inject.message({ text: 'answer', replyTo: first })
    await rig.inject.message({ kind: 'sticker' })
    await rig.inject.message({ kind: 'photo', text: 'look' })
    await settle()
    assert.equal(l.inbound.length, 5)
    const [dm, topic, reply, sticker, photo] = l.inbound
    for (const m of l.inbound) {
      assert.ok(m.messageId.startsWith(`${chat.capabilities.platform}:`), 'the message id carries the platform prefix')
      assert.equal(m.fromId, rig.owner, 'the sender is the owner')
      assert.equal(m.forwarded, false)
    }
    assert.equal(dm.kind, 'text')
    assert.equal(dm.text, 'hello')
    assert.equal(dm.chat.kind, 'dm')
    assert.equal(dm.chat.id, rig.dm)
    assert.equal(dm.chat.thread, null, 'no thread in the DM')
    assert.equal(dm.replyToId, null)
    assert.equal(topic.chat.kind, 'home')
    assert.equal(topic.chat.id, rig.home)
    assert.equal(topic.chat.thread, thread, 'the thread of a topic message')
    assert.equal(reply.replyToId, first, 'a reply names the message it answers')
    assert.equal(sticker.kind, 'unsupported')
    assert.ok(sticker.label && sticker.label.length > 0, 'an unsupported kind is named')
    assert.equal(photo.kind, 'photo')
    assert.ok(photo.fileRef, 'a photo carries a file reference')
    assert.equal(photo.text, 'look', 'a caption is the text')
  })

  run('E7', 'a stranger cannot message or tap the bot', async (rig, t) => {
    if (!rig.adapterFilters) {
      t.skip('the owner filter is adapter code; this rig receives what the adapter let through')
      return
    }
    const { chat } = rig
    const l = listen(chat)
    await rig.inject.message({ text: 'intruder', from: 'stranger' })
    await rig.inject.press({ data: 'x', from: 'stranger' })
    await settle()
    assert.equal(l.inbound.length, 0, 'a stranger message does not reach onInbound')
    assert.equal(l.presses.length, 0, 'a stranger tap does not reach onButton')
    await rig.inject.message({ text: 'owner' })
    await settle()
    assert.equal(l.inbound.length, 1, 'the owner still gets through')
  })

  run('E8', 'platform service events become the neutral ChatEvents', async (rig) => {
    const { chat } = rig
    chat.setHome(rig.home)
    const l = listen(chat)
    await rig.inject.event({ type: 'home-moved' })
    await rig.inject.event({ type: 'member-joined', who: 'stranger', label: 'Ada' })
    await rig.inject.event({ type: 'rights', access: 'lost' })
    await rig.inject.event({ type: 'rights', access: 'ok' })
    await rig.inject.event({ type: 'anonymous-post' })
    await settle()
    assert.equal(l.events.length, 5, JSON.stringify(l.events))
    const [moved, joined, lost, ok, anon] = l.events
    assert.deepEqual(moved, { type: 'home-moved', from: rig.home, to: rig.otherHome })
    assert.deepEqual(joined, { type: 'stranger-joined', chat: rig.home, label: 'Ada' })
    assert.ok(lost.type === 'access' && lost.access === 'lost' && lost.chat === rig.home && lost.reason.length > 0, 'the bot lost its rights')
    assert.ok(ok.type === 'access' && ok.access === 'ok' && ok.chat === rig.home, 'the bot has its rights again')
    assert.deepEqual(anon, { type: 'unattributable-post', chat: rig.home })
  })

  run('E8b', 'the owner and a bot joining raise no stranger-joined', async (rig, t) => {
    if (!rig.adapterFilters) {
      t.skip('the member classification is adapter code; this rig receives what the adapter let through')
      return
    }
    const l = listen(rig.chat)
    await rig.inject.event({ type: 'member-joined', who: 'owner', label: 'owner' })
    await rig.inject.event({ type: 'member-joined', who: 'bot', label: 'bot' })
    await settle()
    assert.deepEqual(l.events, [], 'no event for the owner or a bot')
  })

  for (const f of FAILURES) {
    run(`E9:${f.kind}`, 'a platform refusal reaches the router as a ChatError of the right kind', async (rig) => {
      const { chat } = rig
      let thread: ThreadId | null = null
      if (f.kind === 'not-modified') {
        chat.setHome(rig.home)
        thread = await chat.createThread('topic')
      }
      rig.fail(f.kind)
      const err = await (thread ? chat.reopenThread(thread) : chat.sendText('x')).then(() => null, (e: unknown) => e)
      assert.ok(err instanceof ChatError, `a ChatError, not ${String(err)}`)
      assert.equal(err.kind, f.expect)
      if (f.kind === 'rate-limited') assert.ok(typeof err.retryAfterMs === 'number' && err.retryAfterMs > 0, 'the wait is given')
      if (f.transient !== undefined) assert.equal(err.transient, f.transient, 'transient')
      if (f.status !== undefined) assert.equal(err.status, f.status, 'the platform status')
    })
  }

  run('E10', 'each reaction kind reaches the platform once, with its own emoji', async (rig) => {
    const { chat } = rig
    const id = await chat.sendText('react to me')
    const from = rig.out().length
    await chat.react(id, 'seen')
    await chat.react(id, 'queued')
    await chat.react(id, 'held')
    const reacts = rig.out().slice(from).filter((o): o is Of<'react'> => o.op === 'react')
    assert.equal(reacts.length, 3)
    assert.ok(reacts.every((r) => r.id === id && r.emoji.length > 0))
    assert.equal(new Set(reacts.map((r) => r.emoji)).size, 3, 'three different emoji')
  })

  run('E11', 'thread operations hit the platform with the thread, and the name is cut to the limit', async (rig, t) => {
    const { chat } = rig
    const c = chat.capabilities
    if (c.threads.kind === 'none') {
      t.skip('no threads on this platform')
      return
    }
    chat.setHome(rig.home)
    const thread = await chat.createThread('n'.repeat(c.threads.maxNameChars + 50))
    assert.ok(thread.startsWith(`${c.platform}:`))
    const created = of(rig, 'topic').find((o) => o.action === 'create')
    assert.ok((created?.name ?? '').length <= c.threads.maxNameChars, 'the name is cut to the limit')
    await chat.renameThread(thread, 'renamed')
    if (c.threads.close) await chat.closeThread(thread)
    await chat.reopenThread(thread)
    const acts = of(rig, 'topic').filter((o) => o.thread === thread).map((o) => o.action)
    assert.deepEqual(acts, ['create', 'rename', ...(c.threads.close ? ['close'] : []), 'reopen'])
    rig.goneThread(thread)
    const err = await chat.sendText('into a gone thread', { thread }).then(() => null, (e: unknown) => e)
    assert.ok(err instanceof ChatError && err.kind === 'thread-closed', `thread-closed, not ${String(err)}`)
  })

  run('E12', 'sends go to the chat named, and an edit or reaction stays in the chat its message is in', async (rig) => {
    const { chat } = rig
    const from = rig.out().length
    chat.setHome(rig.home)
    const h = await chat.sendText('to home')
    const d = await chat.sendText('to dm', { dm: true })
    await chat.editText(h, 'edited home', null)
    await chat.editText(d, 'edited dm', null)
    await chat.react(h, 'seen')
    chat.setHome(null)
    await chat.sendText('no home now')
    const out = rig.out().slice(from)
    const sendChat = (text: string) => out.find((o): o is Of<'send'> => o.op === 'send' && o.text === text)?.chat
    const editChat = (text: string) => out.find((o): o is Of<'edit'> => o.op === 'edit' && o.text === text)?.chat
    assert.equal(sendChat('to home'), 'home')
    assert.equal(sendChat('to dm'), 'dm')
    assert.equal(sendChat('no home now'), 'dm', 'with no home bound, sends go to the DM')
    assert.equal(editChat('edited home'), 'home', 'the edit of a home message stays in the home')
    assert.equal(editChat('edited dm'), 'dm', 'the edit of a DM message stays in the DM')
    assert.equal(of(rig, 'react').find((r) => r.id === h)?.chat, 'home', 'the reaction stays in the home')
  })

  run('E13', 'editRows and editText replace text and keyboards; clearButtons takes a target; isDm answers for known messages', async (rig) => {
    const { chat } = rig
    chat.setHome(rig.home)
    const h = await chat.sendText('a', { rows: [[{ text: 'x', data: 'x' }]] })
    const d = await chat.sendText('b', { dm: true })
    const from = rig.out().length
    await chat.editRows(h, 'a2', [[{ text: 'y', data: 'y' }]])
    await chat.editRows(h, 'a3', [])
    await chat.editText(d, 'b2', { requestId: 'r1', withMore: false, redacted: false })
    await chat.editText(d, 'b3', null)
    await chat.clearButtons?.(rig.ghost, { dm: true })
    const out = rig.out().slice(from)
    const edit = (text: string) => out.find((o): o is Of<'edit'> => o.op === 'edit' && o.text === text)
    assert.equal(edit('a2')?.buttons.length, 1, 'editRows sets the new buttons')
    assert.equal(edit('a2')?.id, h)
    assert.equal(edit('a3')?.buttons.length, 0, 'an empty row list removes the keyboard')
    assert.ok((edit('b2')?.buttons.length ?? 0) > 0, 'editText with a permission keyboard sets buttons')
    assert.equal(edit('b3')?.buttons.length, 0, 'editText with null removes the keyboard')
    assert.deepEqual(out.filter((o): o is Of<'clear'> => o.op === 'clear').map((o) => [o.id, o.chat]), [[rig.ghost, 'dm']], 'clearButtons uses the target for an unknown message')
    assert.equal(chat.isDm?.(d), true)
    assert.equal(chat.isDm?.(h), false)
    assert.equal(chat.isDm?.(rig.ghost), undefined, 'an unknown message is undefined')
  })

  run('E14', 'live buttons list the messages that carry them and drop them when cleared', async (rig, t) => {
    const { chat } = rig
    if (!chat.onLiveButtons) {
      t.skip('the platform does not track live buttons')
      return
    }
    const lists: Array<Array<{ messageId: MessageId; dm: boolean }>> = []
    chat.onLiveButtons((list) => { lists.push(list) })
    const id = await chat.sendText('k', { rows: [[{ text: 'a', data: 'a' }]] })
    assert.ok((lists.at(-1) ?? []).some((x) => x.messageId === id), 'the message with buttons is listed')
    await chat.clearButtons?.(id)
    assert.ok(!(lists.at(-1) ?? []).some((x) => x.messageId === id), 'a cleared message is no longer listed')
  })

  run('E15', 'sendFile sends a photo when asked, a document otherwise', async (rig) => {
    const dir = join(ISOLATED_ROOT, 'chat-contract')
    mkdirSync(dir, { recursive: true })
    const png = join(dir, 'pic.png')
    writeFileSync(png, 'png')
    const from = rig.out().length
    await rig.chat.sendFile(png, true)
    await rig.chat.sendFile(png, false)
    const files = rig.out().slice(from).filter((o): o is Of<'file'> => o.op === 'file')
    assert.deepEqual(files.map((f) => f.asPhoto), [true, false])
    assert.ok(files.every((f) => f.path === png), 'the file path is sent')
  })

  run('E15:cap', 'sendFile refuses a file over the upload cap as too-long', async (rig) => {
    const dir = join(ISOLATED_ROOT, 'chat-contract')
    mkdirSync(dir, { recursive: true })
    const big = join(dir, 'big.bin')
    writeFileSync(big, '')
    truncateSync(big, rig.chat.capabilities.files.maxUploadBytes + 1)
    try {
      const err = await rig.chat.sendFile(big, false).then(() => null, (e: unknown) => e)
      assert.ok(err instanceof ChatError && err.kind === 'too-long', `too-long, not ${String(err)}`)
    } finally {
      rmSync(big, { force: true })
    }
  })

  run('E15:download', 'download writes a file under the limit and refuses one over it', async (rig) => {
    const { chat } = rig
    const l = listen(chat)
    await rig.inject.message({ kind: 'photo' })
    await settle()
    const ref = l.inbound[0]?.fileRef
    assert.ok(ref, 'the photo carries a file reference')
    const dir = join(ISOLATED_ROOT, 'chat-contract', 'got')
    const dest = join(dir, 'photo.jpg')
    await chat.download(ref, dest, 100)
    assert.equal(readFileSync(dest, 'utf8'), 'hello', 'the file is written')
    const tooBig = join(dir, 'too-big.jpg')
    await assert.rejects(chat.download(ref, tooBig, 2))
    assert.equal(existsSync(tooBig), false, 'nothing is written past the limit')
  })

  run('E16', 'stop resolves with nothing running; onStarted takes a callback; drain, when present, meets its budget', async (rig) => {
    rig.chat.onStarted(() => {})
    await rig.chat.stop()
    if (rig.chat.drain) {
      const t0 = Date.now()
      await rig.chat.drain(200)
      assert.ok(Date.now() - t0 < 1000, 'drain returns within its budget')
    }
  })

  run('E16:start', 'onStarted fires once polling starts, and stop ends it', async (rig) => {
    let started = 0
    rig.chat.onStarted(() => { started++ })
    rig.chat.start()
    for (let i = 0; i < 50 && started === 0; i++) await settle()
    assert.equal(started, 1, 'onStarted fired')
    await rig.chat.stop()
  })

  run('E17', 'typing shows in the chat, or does nothing where the platform has none; setCommands takes a list', async (rig) => {
    await rig.chat.typing({ dm: true })
    const typings = of(rig, 'typing')
    assert.equal(typings.length, rig.chat.capabilities.typing ? 1 : 0, 'typing is sent only where the platform has it')
    rig.chat.setCommands?.([{ command: 'help', description: 'Help' }])
  })
}
