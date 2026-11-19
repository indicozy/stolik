// The StorePort contract: one suite run against every store (JsonStore and SqliteStore), so both behave alike.
// Each store gets a fresh folder under test/ (removed afterwards); `reopen` opens the same folders again.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseTopics, serializeTopics, type TopicRec } from '../../src/brain/topics.ts'
import type { StorePort } from '../../src/ports.ts'
import type { StorePaths } from '../../src/adapters/store-files.ts'
import { tgChat, tgThread } from '../../src/adapters/chat/tg-ids.ts'

export type ContractHarness = {
  store: StorePort
  // A new store instance over the same files or database.
  reopen: () => StorePort
  paths: StorePaths
  cleanup: () => void
}

export function sandboxPaths(prefix: string): { root: string; paths: StorePaths; cleanup: () => void } {
  const root = mkdtempSync(join(import.meta.dirname, '..', `.tmp-${prefix}-`))
  const paths = { stateDir: join(root, 'state'), inboxDir: join(root, 'inbox'), notesDir: join(root, 'notes') }
  return { root, paths, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const TOPIC_A: TopicRec = { threadId: tgThread(101), name: 'stolik', project: 'stolik', cwd: '/p/stolik', sessionKey: null, backendSessionId: null, state: 'open', endedAt: null, deleteAt: null }
const TOPIC_B: TopicRec = {
  threadId: tgThread(7), name: 'old', project: 'proga', cwd: null, sessionKey: 'cwd:/p/proga', backendSessionId: '6d727728-f50d-46d9-83b5-b3e4f9e5a0a8',
  state: 'closed', endedAt: 1_700_000_000_000, deleteAt: 1_700_086_400_000,
}

export function storeContract(name: string, make: () => ContractHarness): void {
  test(`${name}: msgmap round-trips through a new instance; nothing saved reads as ''`, () => {
    const h = make()
    try {
      assert.equal(h.store.readMsgMap(), '')
      const json = JSON.stringify([[7, { key: 42, name: 'proj', cwd: '/c' }]])
      h.store.writeMsgMap(json)
      assert.equal(h.reopen().readMsgMap(), json)
    } finally {
      h.cleanup()
    }
  })

  test(`${name}: the lock flag survives a new instance; unlocking twice is fine`, () => {
    const h = make()
    try {
      assert.equal(h.store.isLocked(), false)
      h.store.setLocked(true)
      assert.equal(h.store.isLocked(), true)
      assert.equal(h.reopen().isLocked(), true)
      h.store.setLocked(false)
      h.store.setLocked(false)
      assert.equal(h.store.isLocked(), false)
      assert.equal(h.reopen().isLocked(), false)
    } finally {
      h.cleanup()
    }
  })

  test(`${name}: the default model survives a new instance; clearing it gives null`, () => {
    const h = make()
    try {
      assert.equal(h.store.defaultModel(), null)
      h.store.setDefaultModel('sonnet')
      assert.equal(h.store.defaultModel(), 'sonnet')
      assert.equal(h.reopen().defaultModel(), 'sonnet')
      h.store.setDefaultModel(null)
      h.store.setDefaultModel(null)
      assert.equal(h.store.defaultModel(), null)
      assert.equal(h.reopen().defaultModel(), null)
    } finally {
      h.cleanup()
    }
  })

  test(`${name}: the boot id is read trimmed; nothing saved means null`, () => {
    const h = make()
    try {
      assert.equal(h.store.readLastBootId(), null)
      h.store.writeBootId('0b1e2f3a-boot')
      assert.equal(h.reopen().readLastBootId(), '0b1e2f3a-boot')
    } finally {
      h.cleanup()
    }
  })

  test(`${name}: the group id round-trips; nothing saved is null`, () => {
    const h = make()
    try {
      assert.equal(h.store.readGroupId(), null)
      h.store.writeGroupId(tgChat(-1001234567890))
      assert.equal(h.reopen().readGroupId(), tgChat(-1001234567890))
    } finally {
      h.cleanup()
    }
  })

  test(`${name}: topic records round-trip in order; a second write replaces the first; nothing saved reads as ''`, () => {
    const h = make()
    try {
      assert.equal(h.store.readTopics(), '')
      h.store.writeTopics(serializeTopics([TOPIC_A, TOPIC_B]))
      assert.deepEqual(parseTopics(h.reopen().readTopics()), [TOPIC_A, TOPIC_B])
      h.store.writeTopics(serializeTopics([TOPIC_B]))
      assert.deepEqual(parseTopics(h.store.readTopics()), [TOPIC_B])
    } finally {
      h.cleanup()
    }
  })

  test(`${name}: notes are appended to inbox.md with a blank line between entries`, () => {
    const h = make()
    try {
      h.store.appendNote('## first\n')
      h.store.appendNote('## second\n')
      assert.equal(readFileSync(join(h.paths.notesDir, 'inbox.md'), 'utf8'), '## first\n\n## second\n')
    } finally {
      h.cleanup()
    }
  })

  test(`${name}: attachments are copied into notes/attachments and a taken name gets _2, _3`, async () => {
    const h = make()
    try {
      const src = join(h.paths.inboxDir, 'src.txt')
      writeFileSync(src, 'hello')
      const first = await h.store.saveAttachment(src, 'a.txt')
      assert.equal(first, join(h.paths.notesDir, 'attachments', 'a.txt'))
      assert.equal(readFileSync(first, 'utf8'), 'hello')
      assert.equal(h.store.attachmentExists('a.txt'), true)
      assert.equal(h.store.attachmentExists('b.txt'), false)
      assert.equal(await h.store.saveAttachment(src, 'a.txt'), join(h.paths.notesDir, 'attachments', 'a_2.txt'))
      assert.equal(await h.store.saveAttachment(src, 'a.txt'), join(h.paths.notesDir, 'attachments', 'a_3.txt'))
    } finally {
      h.cleanup()
    }
  })

  test(`${name}: attachmentPath creates the attachments folder; inboxPath is inside the inbox folder`, () => {
    const h = make()
    try {
      assert.equal(h.store.attachmentPath('photo.jpg'), join(h.paths.notesDir, 'attachments', 'photo.jpg'))
      assert.ok(existsSync(join(h.paths.notesDir, 'attachments')))
      assert.equal(h.store.inboxPath('123/123_voice.oga'), join(h.paths.inboxDir, '123/123_voice.oga'))
    } finally {
      h.cleanup()
    }
  })

  test(`${name}: a missing source makes saveAttachment reject and leaves no attachment behind`, async () => {
    const h = make()
    try {
      await assert.rejects(() => h.store.saveAttachment(join(h.paths.inboxDir, 'nope.txt'), 'x.txt'))
      assert.equal(h.store.attachmentExists('x.txt'), false)
    } finally {
      h.cleanup()
    }
  })
}
