// Router flows on the Discord-shaped id profile of the fake (batch D2, research/d1-brief.md): media download into the
// inbox, a reply to a Discord message, a folder topic created with a dc: thread id, a topic recovered when Discord says
// it is gone, and the home, topics and message map read back after a restart.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { basename } from 'node:path'
import type { MessageId, ThreadId } from '../src/brain/chat-types.ts'
import { saveNow } from '../src/router/send.ts'
import { DISCORD_GUILD, DISCORD_OWNER, FakeConn, HOME, flush, harness, textFrom } from './helpers/fakes.ts'

const PROJ = `${HOME}/proj`
const LOBBY_CHANNEL = '100000000000000002'
// Discord snowflakes: 19 digits, never parsed as numbers.
const SNOW = /^\d{19}$/

// A message id in the lobby or in a topic post (the post is a channel: its id is the channel part).
function dcMsg(channel: string, n: number): MessageId {
  return `dc:${channel}:${1_000_000_000_000_000_500n + BigInt(n)}` as MessageId
}

// A group-mode Discord router with one channel session in PROJ (pid 4242), its topic created.
async function discordWithSession(pid = 4242, opts: { quotaRefusal?: () => Promise<string | null> } = {}) {
  const h = harness({ discord: true, groupId: DISCORD_GUILD, ownerUserId: DISCORD_OWNER, ...opts })
  await h.router.start()
  h.platform.dirs.add(PROJ)
  const conn = new FakeConn()
  h.agent.receive(conn, { t: 'register', claudePid: pid, cwd: PROJ })
  await flush()
  return { ...h, conn }
}

function topicOf(chat: { topicOps: Array<{ op: string; threadId?: ThreadId }> }): ThreadId {
  const op = chat.topicOps.find((o) => o.op === 'create')
  assert.ok(op?.threadId, 'a topic was created')
  return op.threadId
}

test('media: an owner photo and a document reach the session with a file path, and the inbox name has no colon', async () => {
  const { chat, agent } = await discordWithSession()
  const topic = topicOf(chat)
  const topicChannel = topic.slice('dc:'.length)
  const fetched: string[] = []
  chat.download = async (_fileRef: string, dest: string) => {
    fetched.push(dest)
  }
  const chatRef = { kind: 'home' as const, id: DISCORD_GUILD, thread: topic }

  await chat.inbound(textFrom('', { kind: 'photo', messageId: dcMsg(topicChannel, 1), fromId: DISCORD_OWNER, chat: chatRef, fileRef: 'att-1' }))
  await flush()
  await chat.inbound(
    textFrom('the spec', {
      kind: 'document',
      messageId: dcMsg(topicChannel, 2),
      fromId: DISCORD_OWNER,
      chat: chatRef,
      fileRef: 'att-2',
      fileName: 'spec v2.pdf',
    }),
  )
  await flush()

  assert.equal(fetched.length, 2, 'both files were downloaded through the chat port')
  assert.ok(fetched.every((p) => !basename(p).includes(':')), 'no colon in the inbox file names')
  assert.match(basename(fetched[0]), /^dc-\d+-\d+_photo\.jpg$/)
  assert.equal(agent.sent.length, 2, 'each file is delivered once')
  assert.equal(agent.sent[0].meta.image_path, fetched[0])
  assert.equal(agent.sent[0].meta.message_id, dcMsg(topicChannel, 1), 'the channel meta carries the opaque id')
  assert.equal(agent.sent[1].meta.file_path, fetched[1])
  assert.equal(agent.sent[1].meta.file_name, 'spec v2.pdf')
  assert.ok(!basename(agent.sent[1].meta.file_path).includes(':'))
  assert.match(agent.sent[1].content, /the spec/)
})

test('reply: an owner reply to a session message goes to that session, with the opaque dc: ids in its meta', async () => {
  const { chat, agent, conn } = await discordWithSession()
  const topic = topicOf(chat)
  const topicChannel = topic.slice('dc:'.length)
  // The session answers into its topic: the router records the Discord message id the answer got.
  agent.receive(conn, { t: 'reply', reqId: 'r1', text: 'Which file do you mean?', kind: 'response' })
  await flush()
  const answer = chat.sent.find((s) => s.text.includes('Which file'))
  assert.ok(answer, 'the answer was sent')
  assert.match(answer.id, /^dc:\d{19}:\d{19}$/)
  assert.equal(answer.opts?.thread, topic)

  await chat.inbound(
    textFrom('the one in the docs folder', {
      messageId: dcMsg(topicChannel, 3),
      fromId: DISCORD_OWNER,
      replyToId: answer.id,
      replyToText: 'Which file do you mean?',
      chat: { kind: 'home', id: DISCORD_GUILD, thread: topic },
    }),
  )
  await flush()
  const got = agent.sent[agent.sent.length - 1]
  assert.ok(got, 'the reply reached the session')
  assert.equal(got.content, 'the one in the docs folder', 'a live session gets the text as it is, as on Telegram')
  assert.equal(got.meta.message_id, dcMsg(topicChannel, 3), 'message_id is the opaque Discord id, not a number')
  assert.equal(got.meta.user_id, DISCORD_OWNER)
})

test('reply: a reply in a topic with no live session starts a session whose first prompt quotes the replied-to text', async () => {
  const { chat, agent, router, clock } = await discordWithSession(4242, { quotaRefusal: async () => null })
  const topic = topicOf(chat)
  const topicChannel = topic.slice('dc:'.length)
  agent.trusted.add(PROJ)
  for (const s of router.registry.list()) router.registry.remove(s.key)
  await chat.inbound(
    textFrom('start the parser plan', {
      messageId: dcMsg(topicChannel, 4),
      fromId: DISCORD_OWNER,
      replyToId: dcMsg(LOBBY_CHANNEL, 9),
      replyToText: 'Use zod here',
      chat: { kind: 'home', id: DISCORD_GUILD, thread: topic },
    }),
  )
  await flush()
  assert.deepEqual(agent.startedSessions, [{ project: 'proj', dir: PROJ, extra: [] }])
  agent.receive(new FakeConn(), { t: 'register', claudePid: 5151, cwd: PROJ, spawnToken: agent.spawnTokens[0] })
  clock.advance(1000)
  await flush()
  assert.equal(
    agent.sent.at(-1)?.content,
    'The user is replying to this earlier message:\n"""\nUse zod here\n"""\n\nstart the parser plan',
  )
})

test('folder topic: a new folder session makes a thread whose dc: id is stored in the topics', async () => {
  const { chat, store, router } = await discordWithSession()
  const creates = chat.topicOps.filter((o) => o.op === 'create')
  assert.equal(creates.length, 1)
  const threadId = creates[0].threadId
  assert.ok(threadId?.startsWith('dc:'))
  assert.match(threadId.slice('dc:'.length), SNOW, 'the thread id is a 19-digit snowflake after dc:')
  assert.equal(creates[0].name, 'proj')
  const saved = JSON.parse(store.topicsJson) as Array<{ threadId: string; state: string; cwd: string }>
  assert.deepEqual(saved.map((t) => [t.threadId, t.state, t.cwd]), [[threadId, 'open', PROJ]])
  assert.deepEqual(router.topics.map((t) => t.threadId), [threadId])
})

test('topic recover: a topic Discord says is gone is recreated, and the reply goes into the new topic', async () => {
  const { chat, agent, conn, router } = await discordWithSession()
  const gone = topicOf(chat)
  chat.goneThreads.add(gone)
  agent.receive(conn, { t: 'reply', reqId: 'r1', text: 'Back again.', kind: 'response' })
  await flush()
  const creates = chat.topicOps.filter((o) => o.op === 'create')
  assert.equal(creates.length, 2, 'the original topic, then its replacement')
  const fresh = creates[1].threadId
  assert.ok(fresh?.startsWith('dc:') && fresh !== gone)
  const sent = chat.sent.filter((s) => s.text.includes('Back again.'))
  assert.equal(sent.length, 1, 'sent once')
  assert.equal(sent[0].opts?.thread, fresh)
  assert.equal(router.topics.find((r) => r.threadId === gone)?.state, 'deleted')
  assert.equal(router.topics.find((r) => r.threadId === fresh)?.state, 'open')

  // And the router keeps working: a second reply goes to the same new topic, no third topic.
  agent.receive(conn, { t: 'reply', reqId: 'r2', text: 'Still working.', kind: 'response' })
  await flush()
  assert.equal(chat.topicOps.filter((o) => o.op === 'create').length, 2)
  assert.equal(chat.sent.find((s) => s.text.includes('Still working.'))?.opts?.thread, fresh)
})

test('restart: the home, the topics and the message map come back with their dc: ids', async () => {
  const first = await discordWithSession()
  const topic = topicOf(first.chat)
  first.agent.receive(first.conn, { t: 'reply', reqId: 'r1', text: 'Saved answer.', kind: 'response' })
  await flush()
  // The map is saved on a short timer; save it now, as the timer would.
  saveNow(first.router)
  const answer = first.chat.sent.find((s) => s.text.includes('Saved answer.'))
  assert.ok(answer)

  // A new router on the same store: the bound home and the saved records are read at start.
  const second = harness({ discord: true, ownerUserId: DISCORD_OWNER })
  second.store.groupId = DISCORD_GUILD
  second.store.topicsJson = first.store.topicsJson
  second.store.msgMap = first.store.msgMap
  await second.router.start()

  assert.equal(second.router.groupId, DISCORD_GUILD)
  assert.equal(second.chat.group, DISCORD_GUILD)
  assert.deepEqual(second.router.topics.map((t) => [t.threadId, t.name]), [[topic, 'proj']])
  assert.match(String(second.router.topics[0].threadId), /^dc:\d{19}$/)
  const entry = second.router.msgMap.get(answer.id)
  assert.ok(entry, 'the message map keeps the dc: message id')
  assert.equal(entry.cwd, PROJ)
  assert.ok(first.store.msgMap.includes(answer.id), 'the saved map text holds the id as written')
})
