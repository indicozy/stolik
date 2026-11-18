import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { JsonlFile } from '../src/router/log.ts'
import { pruneInbox } from '../src/router/deliver.ts'

const DAY = 24 * 60 * 60_000

function tempDir(): string {
  return mkdtempSync(join(import.meta.dirname, '.tmp-growth-'))
}

test('audit log: writing past the size limit rotates, and the rotated files are capped', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'audit.log')
    const line = JSON.stringify({ ts: 'x', event: 'inbound', pad: 'y'.repeat(40) }) + '\n'
    const max = 300
    for (let i = 0; i < 60; i++) new JsonlFile(path, max, 3).append(line)
    const names = readdirSync(dir).sort()
    assert.deepEqual(names, ['audit.log', 'audit.log.1', 'audit.log.2', 'audit.log.3'])
    for (const n of names) assert.ok(statSync(join(dir, n)).size <= max, `${n} stays within the limit`)
    // The live file holds the newest lines, each one whole.
    const live = readFileSync(path, 'utf8').trim().split('\n')
    assert.ok(live.length > 0)
    for (const l of live) assert.equal(l, line.trimEnd())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('audit log: a rotation moves the previous file to .1 and keeps the order of the rotated files', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'audit.log')
    new JsonlFile(path, 10, 2).append('first\n')
    new JsonlFile(path, 10, 2).append('second\n') // 'first\n' + 'second\n' would pass 10 bytes: rotate
    assert.equal(readFileSync(join(dir, 'audit.log.1'), 'utf8'), 'first\n')
    assert.equal(readFileSync(path, 'utf8'), 'second\n')
    new JsonlFile(path, 10, 2).append('third\n')
    new JsonlFile(path, 10, 2).append('fourth\n')
    assert.equal(readFileSync(join(dir, 'audit.log.2'), 'utf8'), 'second\n')
    assert.equal(readFileSync(join(dir, 'audit.log.1'), 'utf8'), 'third\n')
    assert.equal(existsSync(join(dir, 'audit.log.3')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('inbox prune: old files and the directories left empty go, new files and their folders stay', () => {
  const dir = tempDir()
  try {
    const now = Date.UTC(2026, 10, 14)
    const old = new Date(now - 10 * DAY)
    const fresh = new Date(now - DAY)
    const put = (rel: string, when: Date) => {
      const p = join(dir, rel)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, 'x')
      utimesSync(p, when, when)
      return p
    }
    const oldFile = put('100_voice.oga', old)
    const freshFile = put('200_photo.jpg', fresh)
    const nestedOld = put('300/doc.pdf', old)
    utimesSync(join(dir, '300'), old, old)
    mkdirSync(join(dir, 'emptyOld'))
    utimesSync(join(dir, 'emptyOld'), old, old)
    mkdirSync(join(dir, 'emptyNew'))
    utimesSync(join(dir, 'emptyNew'), fresh, fresh)
    // An old folder that is not empty after its old file goes is removed with it; a fresh file keeps its folder.
    put('400/keep.txt', fresh)
    utimesSync(join(dir, '400'), old, old)

    const removed = pruneInbox(dir, now, 7 * DAY)

    assert.equal(existsSync(oldFile), false)
    assert.equal(existsSync(nestedOld), false)
    assert.equal(existsSync(join(dir, '300')), false, 'the emptied folder goes')
    assert.equal(existsSync(join(dir, 'emptyOld')), false, 'an old empty folder goes')
    assert.equal(existsSync(freshFile), true)
    assert.equal(existsSync(join(dir, 'emptyNew')), true, 'a fresh empty folder stays')
    assert.equal(existsSync(join(dir, '400', 'keep.txt')), true)
    assert.equal(existsSync(join(dir, '400')), true, 'a folder with a fresh file stays')
    assert.equal(removed, 4)
    assert.equal(existsSync(dir), true, 'the root stays')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('inbox prune: a missing folder is a no-op', () => {
  assert.equal(pruneInbox(join(import.meta.dirname, 'no-such-inbox-folder'), Date.now(), DAY), 0)
})
