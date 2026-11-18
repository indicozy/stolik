// The Discord adapter loads lazily (plan 23 decision 1): a Telegram start never loads @discordjs/*, the Discord mapping or
// the Discord adapter, and a Discord start does (the positive control, so the probe really sees the loads). Each case is a
// child process that builds the router through app.ts, with a module hook that logs every resolved module. No network.
import './helpers/isolate.ts'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ISOLATED_ROOT } from './helpers/isolate.ts'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const DISCORD_MODULE = /@discordjs|discord-map|adapters\/chat\/discord\.ts|discord-api-types|discord-perms/

function probe(mode: 'telegram' | 'discord'): { status: number | null; stdout: string; stderr: string; loads: string[] } {
  const log = join(ISOLATED_ROOT, `loads-${mode}.log`)
  rmSync(log, { force: true })
  const run = spawnSync(
    process.execPath,
    ['--import', join(REPO, 'test/helpers/load-register.mjs'), '--experimental-strip-types', join(REPO, 'test/helpers/start-probe.ts'), mode],
    { cwd: REPO, env: { ...process.env, LOAD_LOG: log }, encoding: 'utf8', timeout: 120_000 },
  )
  const loads = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, loads }
}

test('lazy load: a Telegram router build never loads the Discord adapter, its mapping, or @discordjs/*', () => {
  const run = probe('telegram')
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /built/)
  assert.ok(run.loads.length > 0, 'the module hook saw the loads')
  assert.deepEqual(run.loads.filter((u) => DISCORD_MODULE.test(u)), [])
})

test('lazy load: a Discord router build loads the adapter and @discordjs/* (the probe sees them)', () => {
  const run = probe('discord')
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /built/)
  assert.ok(run.loads.some((u) => u.includes('/adapters/chat/discord.ts')))
  assert.ok(run.loads.some((u) => u.includes('@discordjs/rest')))
})
