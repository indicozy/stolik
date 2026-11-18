// JsonStore: the StorePort contract (shared suite), plus the file-level details only the JSON store has.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { JsonStore } from '../src/adapters/store-json.ts'
import { loadMsgMap } from '../src/brain/msgmap.ts'
import { sandboxPaths, storeContract } from './helpers/store-contract.ts'
import { tgMsg } from '../src/adapters/chat/tg-ids.ts'

storeContract('JsonStore', () => {
  const box = sandboxPaths('store-json')
  const store = new JsonStore(box.paths)
  return { store, reopen: () => new JsonStore(box.paths), paths: box.paths, cleanup: box.cleanup }
})

test('JsonStore: constructor creates the state and inbox folders', () => {
  const box = sandboxPaths('store-json-dirs')
  try {
    new JsonStore(box.paths)
    assert.ok(existsSync(box.paths.stateDir))
    assert.ok(existsSync(box.paths.inboxDir))
  } finally {
    box.cleanup()
  }
})

test('JsonStore: msgmap is written atomically (no temp file left) and a corrupt file reads as an empty map', () => {
  const box = sandboxPaths('store-json-msgmap')
  try {
    const store = new JsonStore(box.paths)
    const json = JSON.stringify([[7, { key: '42:start-42', name: 'proj', cwd: '/c' }]])
    store.writeMsgMap(json)
    assert.equal(loadMsgMap(store.readMsgMap()).get(tgMsg(7))?.name, 'proj')
    assert.equal(existsSync(join(box.paths.stateDir, 'msgmap.json.tmp')), false)
    writeFileSync(join(box.paths.stateDir, 'msgmap.json'), '{not json')
    assert.equal(loadMsgMap(store.readMsgMap()).size(), 0)
  } finally {
    box.cleanup()
  }
})

test('JsonStore: the state folder is private (0700) after open, including one created with 0755', () => {
  if (process.platform === 'win32') return
  const box = sandboxPaths('store-json-mode')
  try {
    mkdirSync(box.paths.stateDir, { recursive: true })
    chmodSync(box.paths.stateDir, 0o755)
    new JsonStore(box.paths)
    assert.equal(statSync(box.paths.stateDir).mode & 0o777, 0o700)
  } finally {
    box.cleanup()
  }
})

test('JsonStore: opening never raises a startup notice', () => {
  const box = sandboxPaths('store-json-notices')
  try {
    assert.deepEqual(new JsonStore(box.paths).startupNotices, [])
  } finally {
    box.cleanup()
  }
})
