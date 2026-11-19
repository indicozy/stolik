// The chat adapter contract (chat connector 0d batch 3) run against FakeChat, the port the router tests use. FakeChat
// takes events already classified and does not run the owner filter, so E7 and E8b skip here (they are adapter code,
// run by the Telegram contract). It does not model downloads or polling, so E15:download and E16:start skip.
import './helpers/isolate.ts'
import { FakeChat } from './helpers/fakes.ts'
import { chatContract, type Out, type Rig, type Where } from './helpers/chat-contract.ts'
import { tgChat, tgMsg, tgUser } from '../src/adapters/chat/tg-ids.ts'
import type { ButtonPress, ChatRef, MessageId } from '../src/brain/chat-types.ts'

const DM = tgChat(111)
const HOME = tgChat(-1001)
const OTHER_HOME = tgChat(-1002)
const OWNER = tgUser(111)

const TOPIC_ACTION = { create: 'create', edit: 'rename', reopen: 'reopen' } as const

async function fakeRig(): Promise<Rig> {
  const chat = new FakeChat()
  let nextIn = 900
  const where = (c: 'group' | 'dm'): Where => (c === 'dm' ? 'dm' : 'home')
  const chatOfId = (id: MessageId): Where => {
    const s = chat.sent.find((x) => x.id === id)
    if (s) return where(s.chat)
    const f = chat.files.find((x) => x.id === id)
    return f ? where(f.chat) : 'other'
  }
  const buttonsOf = (opts: { perm?: unknown; rows?: Array<Array<{ data: string }>> } | undefined): string[] => [
    ...(opts?.perm ? ['perm'] : []),
    ...(opts?.rows ?? []).flat().map((b) => b.data),
  ]
  const refChat = (w: 'dm' | 'home' | undefined): ChatRef => (w === 'home' ? { kind: 'home', id: HOME, thread: null } : { kind: 'dm', id: DM, thread: null })

  const out = (): Out[] => [
    ...chat.sent.map((s): Out => ({ op: 'send', chat: where(s.chat), thread: s.opts?.thread, text: s.text, replyTo: s.opts?.replyTo !== undefined, buttons: buttonsOf(s.opts), id: s.id })),
    ...chat.files.map((f): Out => ({ op: 'file', chat: where(f.chat), path: f.path, asPhoto: f.asPhoto, id: f.id })),
    ...chat.rowEdits.map((e): Out => ({ op: 'edit', chat: chatOfId(e.messageId), id: e.messageId, text: e.text, buttons: e.rows.flat().map((b) => b.data) })),
    ...chat.permEdits.map((e): Out => ({ op: 'edit', chat: chatOfId(e.messageId), id: e.messageId, text: e.text, buttons: e.perm ? ['perm'] : [] })),
    ...chat.clearedKeyboards.map((c): Out => ({ op: 'clear', chat: chat.group === null || c.target?.dm ? 'dm' : 'home', id: c.messageId })),
    ...chat.reactions.map((r): Out => ({ op: 'react', chat: chatOfId(r.messageId), id: r.messageId, emoji: r.emoji })),
    ...chat.typings.map((t): Out => ({ op: 'typing', chat: where(t.chat), thread: t.thread })),
    ...chat.topicOps.map((t): Out => ({ op: 'topic', action: TOPIC_ACTION[t.op], thread: t.threadId, name: t.name })),
    ...chat.answers.map((a): Out => ({ op: 'ack', id: a.id, text: a.text })),
  ]

  return {
    chat,
    dm: DM,
    home: HOME,
    otherHome: OTHER_HOME,
    owner: OWNER,
    ghost: tgMsg(999999),
    adapterFilters: false,
    out,
    fail: (kind, skip) => chat.fail(kind, skip),
    goneThread: (t) => {
      chat.goneThreads.add(t)
    },
    inject: {
      async message(o) {
        const kind = o.kind ?? 'text'
        const base = {
          messageId: tgMsg(nextIn++),
          text: o.text ?? '',
          replyToId: o.replyTo ?? null,
          replyToText: o.replyTo !== undefined ? 'orig' : null,
          forwarded: false,
          from: 'owner',
          fromId: OWNER,
          chat: o.chat === 'home' && o.thread !== undefined
            ? { kind: 'home' as const, id: HOME, thread: o.thread }
            : refChat(o.chat),
        }
        if (kind === 'sticker') await chat.inbound({ ...base, kind: 'unsupported', label: 'a sticker' })
        else if (kind === 'photo') await chat.inbound({ ...base, kind: 'photo', fileRef: 'ph1' })
        else await chat.inbound({ ...base, kind: 'text' })
      },
      async press(o) {
        const press: Omit<ButtonPress, 'chat'> = { pressId: `cb${nextIn++}`, data: o.data, message: (o.message ?? null) as MessageId | null, from: OWNER }
        await chat.callback({ ...press, chat: refChat(o.chat) })
      },
      async event(e) {
        switch (e.type) {
          case 'home-moved':
            return chat.chatEvent({ type: 'home-moved', from: HOME, to: OTHER_HOME })
          case 'member-joined':
            // The adapter drops the owner's and the bots' joins; the fake takes only what the adapter let through.
            if (e.who === 'stranger') return chat.chatEvent({ type: 'stranger-joined', chat: HOME, label: e.label })
            return
          case 'rights':
            return chat.chatEvent({ type: 'access', chat: HOME, access: e.access, reason: e.access === 'ok' ? 'administrator' : 'left' })
          case 'anonymous-post':
            return chat.chatEvent({ type: 'unattributable-post', chat: HOME })
        }
      },
    },
    close: () => {},
  }
}

chatContract('FakeChat', fakeRig, {
  skip: {
    'E15:download': 'FakeChat does not model downloads (download throws)',
    'E16:start': 'FakeChat has no polling: onStarted is never called',
  },
})
