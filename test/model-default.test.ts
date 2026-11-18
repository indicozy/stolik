// The default model of bot-started sessions: the `--model` flag on a new start (not on a resume, not twice), the
// effective model (the /model setting, else config claudeModel, else Claude Code's default), the /model command, and the
// start announcements (one new message per start, naming the instance). Fakes only: no tmux, no Telegram.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Router } from '../src/router/core.ts'
import { spawnFor, resumeEnded } from '../src/router/spawn.ts'
import { parseTgConfig } from '../src/config.ts'
import { tgMsg } from '../src/adapters/chat/tg-ids.ts'
import {
  FakeAgent, FakeAudit, FakeClock, FakeLogger, FakePlatform, FakeStore, FakeChat, HOME, OWNER, flush, harness, textFrom,
} from './helpers/fakes.ts'

const PROJ = `${HOME}/proj`
const IMG = `${HOME}/imgtune`
const RESUME_ID = '11111111-2222-4333-8444-555555555555'

// A harness with the folder trusted and existing, and a start of `proj` by `/to proj <text>`.
async function started(opts: { claudeModel?: string | null; model?: string | null } = {}) {
  const h = harness({ claudeModel: opts.claudeModel ?? null })
  h.store.setDefaultModel(opts.model ?? null)
  await h.router.start()
  h.agent.trusted.add(PROJ)
  h.platform.dirs.add(PROJ)
  return h
}

test('a new start gets --model from the /model setting, and the queue keeps the final arguments', async () => {
  const h = await started({ model: 'sonnet' })
  await h.chat.inbound(textFrom('/to proj first', { messageId: tgMsg(10) }))
  await flush()
  assert.deepEqual(h.agent.startedSessions, [{ project: 'proj', dir: PROJ, extra: ['--model', 'sonnet'] }])
  assert.deepEqual(h.router.spawns.get(PROJ)?.extraArgs, ['--model', 'sonnet'], 'startCommand shows what ran')
})

test('config claudeModel is used when no /model setting is saved, and the /model setting wins over it', async () => {
  const fromConfig = await started({ claudeModel: 'opus' })
  await fromConfig.chat.inbound(textFrom('/to proj first', { messageId: tgMsg(10) }))
  await flush()
  assert.deepEqual(fromConfig.agent.startedSessions[0].extra, ['--model', 'opus'])

  const overridden = await started({ claudeModel: 'opus', model: 'haiku' })
  await overridden.chat.inbound(textFrom('/to proj first', { messageId: tgMsg(10) }))
  await flush()
  assert.deepEqual(overridden.agent.startedSessions[0].extra, ['--model', 'haiku'])
})

test('with no model set anywhere, a new start passes no --model flag (Claude Code default)', async () => {
  const h = await started()
  await h.chat.inbound(textFrom('/to proj first', { messageId: tgMsg(10) }))
  await flush()
  assert.deepEqual(h.agent.startedSessions[0].extra, [])
})

test('a model already in the extra arguments is kept, and no second --model is added', async () => {
  const h = await started({ model: 'sonnet' })
  await spawnFor(h.router, 'proj', PROJ, textFrom('hi', { messageId: tgMsg(10) }), 'hi', undefined, ['--model', 'haiku'])
  assert.deepEqual(h.agent.startedSessions[0].extra, ['--model', 'haiku'])
  assert.deepEqual(h.router.spawns.get(PROJ)?.extraArgs, ['--model', 'haiku'])

  const eq = await started({ model: 'sonnet' })
  await spawnFor(eq.router, 'proj', PROJ, textFrom('hi', { messageId: tgMsg(11) }), 'hi', undefined, ['--model=haiku'])
  assert.deepEqual(eq.agent.startedSessions[0].extra, ['--model=haiku'])
})

test('a resumed session keeps its own model: resume adds no --model flag', async () => {
  const h = await started({ model: 'sonnet', claudeModel: 'opus' })
  h.platform.files.set('/fake/a.jsonl', { isFile: true, size: 10 })
  await resumeEnded(h.router, { id: RESUME_ID, path: '/fake/a.jsonl', cwd: PROJ, title: 'Fix the parser', lastActive: 0, state: 'ended' })
  await flush()
  assert.deepEqual(h.agent.startedSessions[0].extra, ['--resume', RESUME_ID])
})

test('the start announcement is a new reply naming the instance, with the model when one is set', async () => {
  const plain = await started()
  await plain.chat.inbound(textFrom('/to proj first', { messageId: tgMsg(10) }))
  await flush()
  const said = plain.chat.sent.find((s) => s.text.startsWith('🆕'))
  assert.equal(said?.text, '🆕 Starting new instance tg-proj (proj)…')
  assert.equal(said?.opts?.replyTo, tgMsg(10), 'a reply to the message that asked for the start')

  const withModel = await started({ model: 'sonnet' })
  await withModel.chat.inbound(textFrom('/to proj first', { messageId: tgMsg(10) }))
  await flush()
  assert.ok(withModel.chat.sent.some((s) => s.text === '🆕 Starting new instance tg-proj (proj, model sonnet)…'))
})

test('a resumed start is announced as resuming the title as its tmux session', async () => {
  const h = await started()
  h.platform.files.set('/fake/a.jsonl', { isFile: true, size: 10 })
  await resumeEnded(h.router, { id: RESUME_ID, path: '/fake/a.jsonl', cwd: PROJ, title: 'Fix the parser', lastActive: 0, state: 'ended' })
  await flush()
  assert.ok(h.chat.sent.some((s) => s.text === '🔁 Resuming Fix the parser as tg-proj (proj)…'))
})

test('/model alone says where the default comes from: the bot setting, the config, or Claude Code', async () => {
  const none = await started()
  await none.chat.inbound(textFrom('/model', { messageId: tgMsg(5) }))
  await flush()
  assert.equal(none.chat.sent.at(-1)?.text, "New sessions use Claude Code's default model (no --model). Set one with /model <name>.")

  const config = await started({ claudeModel: 'opus' })
  await config.chat.inbound(textFrom('/model', { messageId: tgMsg(5) }))
  await flush()
  assert.equal(config.chat.sent.at(-1)?.text, 'New sessions start with --model opus (from config claudeModel).')

  const bot = await started({ claudeModel: 'opus', model: 'sonnet' })
  await bot.chat.inbound(textFrom('/model', { messageId: tgMsg(5) }))
  await flush()
  assert.equal(bot.chat.sent.at(-1)?.text, 'New sessions start with --model sonnet (set with /model).')
})

test('/model <name> saves the default for new sessions and says the running ones keep theirs', async () => {
  const h = await started()
  await h.chat.inbound(textFrom('/model sonnet', { messageId: tgMsg(5) }))
  await flush()
  assert.equal(h.store.defaultModel(), 'sonnet')
  assert.equal(h.chat.sent.at(-1)?.text, 'New sessions will start with --model sonnet. Running sessions keep their model.')
})

test('/model default clears the bot setting; the config value applies again', async () => {
  const h = await started({ claudeModel: 'opus', model: 'sonnet' })
  await h.chat.inbound(textFrom('/model default', { messageId: tgMsg(5) }))
  await flush()
  assert.equal(h.store.defaultModel(), null)
  assert.equal(h.chat.sent.at(-1)?.text, 'Cleared the /model setting. New sessions start with --model opus (from config claudeModel).')

  const plain = await started({ model: 'sonnet' })
  await plain.chat.inbound(textFrom('/model DEFAULT', { messageId: tgMsg(5) }))
  await flush()
  assert.equal(plain.store.defaultModel(), null)
  assert.equal(plain.chat.sent.at(-1)?.text, "Cleared the /model setting. New sessions use Claude Code's default model (no --model).")
})

test('/model with an invalid name is refused and the setting stays as it was', async () => {
  const h = await started({ model: 'sonnet' })
  for (const bad of ['-x', 'two words', '--model', 'a;rm']) {
    await h.chat.inbound(textFrom(`/model ${bad}`, { messageId: tgMsg(5) }))
    await flush()
    assert.match(String(h.chat.sent.at(-1)?.text), /^Not a model name: /)
  }
  assert.equal(h.store.defaultModel(), 'sonnet')
})

test('config claudeModel accepts model names and refuses one that starts with a dash', () => {
  assert.equal(parseTgConfig({}).claudeModel, null)
  assert.equal(parseTgConfig({ claudeModel: 'claude-opus-4-1' }).claudeModel, 'claude-opus-4-1')
  assert.equal(parseTgConfig({ claudeModel: 'sonnet[1m]' }).claudeModel, 'sonnet[1m]')
  assert.throws(() => parseTgConfig({ claudeModel: '-x' }), /claudeModel/)
})

// A router with routerAutoStart "auto", so a name that leads the message starts its folder by itself (startRouted).
function autoRouter() {
  const chat = new FakeChat()
  const agent = new FakeAgent()
  const platform = new FakePlatform()
  const router = new Router({
    ownerId: OWNER,
    groupId: null,
    secrets: ['SECRET-TOKEN'],
    home: HOME,
    socketPath: '/fake/router.sock',
    chat,
    store: new FakeStore(),
    platform,
    agent,
    ml: { transcribe: async () => '', close: () => {} },
    clock: new FakeClock(),
    audit: new FakeAudit(),
    logger: new FakeLogger(),
    routerAutoStart: 'auto',
    quotaRefusal: async () => null,
  })
  return { router, chat, agent, platform }
}

test('an auto-started folder sends exactly one start message, with wrong one? and the new text', async () => {
  const h = autoRouter()
  h.agent.trusted.add(IMG)
  h.platform.dirs.add(IMG)
  await h.router.start()
  await h.chat.inbound(textFrom('imgtune: resize the hero', { messageId: tgMsg(20) }))
  await flush()
  const starts = h.chat.sent.filter((s) => /Starting/.test(s.text))
  assert.equal(starts.length, 1, 'one start message, not two')
  assert.equal(starts[0].text, '🆕 Starting new instance tg-imgtune (imgtune)…')
  assert.deepEqual(starts[0].opts?.rows?.[0].map((b) => b.text), ['↩ wrong one?'])
  assert.deepEqual(h.agent.startedSessions, [{ project: 'imgtune', dir: IMG, extra: [] }])
})

test('a start whose tmux name was taken edits its start message to the name that runs, keeping the wrong-one button', async () => {
  const h = autoRouter()
  h.agent.trusted.add(IMG)
  h.platform.dirs.add(IMG)
  // The plain name is taken, so the session runs as the -2 instance.
  h.agent.startSession = async (project: string) => `tg-${project}-2`
  await h.router.start()
  await h.chat.inbound(textFrom('imgtune: resize the hero', { messageId: tgMsg(20) }))
  await flush()
  const start = h.chat.sent.find((s) => /Starting/.test(s.text))
  assert.equal(start?.text, '🆕 Starting new instance tg-imgtune (imgtune)…', 'the message first names the plain name')
  const edit = h.chat.rowEdits.find((e) => e.messageId === start?.id)
  assert.equal(edit?.text, '🆕 Starting new instance tg-imgtune-2 (imgtune)…')
  assert.deepEqual(edit?.rows[0].map((b) => b.text), ['↩ wrong one?'])
  assert.deepEqual(edit?.rows[0].map((b) => b.data), start?.opts?.rows?.[0].map((b: { data: string }) => b.data))
})
