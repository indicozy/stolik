// bin/tg-plugin-node: the node the plugin runs with. Order: nodePath in config.json, then node on PATH (plan P3).
// Real shell runs with a temp HOME and fake node scripts that print what they were asked to run.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LAUNCHER = join(HERE, '..', 'bin', 'tg-plugin-node')

function fakeNode(path: string, tag: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `#!/bin/sh\necho "${tag} $*"\n`)
  chmodSync(path, 0o755)
}

// A folder holding only sed and head, so the PATH of a test can exclude every node but the fake ones.
function toolsDir(root: string): string {
  const dir = join(root, 'tools')
  mkdirSync(dir, { recursive: true })
  for (const tool of ['sed', 'head']) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim()
    symlinkSync(found, join(dir, tool))
  }
  return dir
}

function withFixture(fn: (root: string, home: string) => void): void {
  const root = mkdtempSync(join(HERE, '.tmp-launcher-'))
  try {
    toolsDir(root)
    fn(root, join(root, 'home'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function runLauncher(root: string, env: Record<string, string>) {
  return spawnSync(LAUNCHER, ['dist/hook.js', 'Stop'], {
    encoding: 'utf8',
    env: { PATH: `${root}/pathbin:${root}/tools`, ...env },
  })
}

test('tg-plugin-node: uses nodePath from config.json when that file is executable', () => {
  withFixture((root, home) => {
    fakeNode(join(root, 'cfgbin', 'node'), 'cfg-node')
    fakeNode(join(root, 'pathbin', 'node'), 'path-node')
    mkdirSync(join(home, '.config', 'tg-bridge'), { recursive: true })
    writeFileSync(
      join(home, '.config', 'tg-bridge', 'config.json'),
      JSON.stringify({ nodePath: join(root, 'cfgbin', 'node'), ownerUserId: '1' }, null, 2),
    )
    const r = runLauncher(root, { HOME: home })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, 'cfg-node dist/hook.js Stop\n')
  })
})

test('tg-plugin-node: a nodePath that is gone falls back to node on PATH', () => {
  withFixture((root, home) => {
    fakeNode(join(root, 'pathbin', 'node'), 'path-node')
    mkdirSync(join(home, '.config', 'tg-bridge'), { recursive: true })
    writeFileSync(join(home, '.config', 'tg-bridge', 'config.json'), JSON.stringify({ nodePath: `${root}/gone/node` }))
    const r = runLauncher(root, { HOME: home })
    assert.equal(r.stdout, 'path-node dist/hook.js Stop\n')
  })
})

test('tg-plugin-node: no config means node on PATH; an absolute XDG_CONFIG_HOME is read, a relative one is ignored', () => {
  withFixture((root, home) => {
    fakeNode(join(root, 'pathbin', 'node'), 'path-node')
    fakeNode(join(root, 'xdgbin', 'node'), 'xdg-node')
    assert.equal(runLauncher(root, { HOME: home }).stdout, 'path-node dist/hook.js Stop\n')
    mkdirSync(join(root, 'xdg', 'tg-bridge'), { recursive: true })
    writeFileSync(join(root, 'xdg', 'tg-bridge', 'config.json'), JSON.stringify({ nodePath: `${root}/xdgbin/node` }))
    assert.equal(runLauncher(root, { HOME: home, XDG_CONFIG_HOME: join(root, 'xdg') }).stdout, 'xdg-node dist/hook.js Stop\n')
    assert.equal(runLauncher(root, { HOME: home, XDG_CONFIG_HOME: 'xdg' }).stdout, 'path-node dist/hook.js Stop\n')
  })
})

test('tg-plugin-node: no node anywhere gives a clear error and exit 1', () => {
  withFixture((root, home) => {
    mkdirSync(join(root, 'pathbin'), { recursive: true })
    const r = runLauncher(root, { HOME: home })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /no node found \(set nodePath with: tg-bridge setup\)/)
  })
})
