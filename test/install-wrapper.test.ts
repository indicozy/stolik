// install.sh is a thin wrapper: npm ci, npm run build, then `stolik setup`. It must not register MCP, touch the
// Claude settings or build the old stt venv. Run with fake node and npm on PATH, so nothing real is built or set up.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const INSTALL = join(REPO, 'install.sh')

function withFakes(fn: (bin: string, log: string) => void): void {
  const dir = mkdtempSync(join(HERE, '.tmp-install-'))
  try {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const log = join(dir, 'log')
    writeFileSync(log, '')
    // node -p prints the answer to the version test (true or false); other calls are logged.
    const node = `#!/bin/sh\nif [ "$1" = -p ]; then echo "$FAKE_NODE_OK"; exit 0; fi\necho "node $*" >> "${log}"\n`
    const npm = `#!/bin/sh\necho "npm $*" >> "${log}"\n`
    writeFileSync(join(bin, 'node'), node)
    writeFileSync(join(bin, 'npm'), npm)
    chmodSync(join(bin, 'node'), 0o755)
    chmodSync(join(bin, 'npm'), 0o755)
    fn(bin, log)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function runInstall(bin: string, nodeOk: 'true' | 'false') {
  return spawnSync('bash', [INSTALL], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: bin, FAKE_NODE_OK: nodeOk },
  })
}

test('install.sh parses under bash -n', () => {
  const r = spawnSync('bash', ['-n', INSTALL], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
})

test('install.sh does not register MCP, touch Claude settings, or build the old stt venv', () => {
  const text = readFileSync(INSTALL, 'utf8')
  assert.equal(text.includes('claude mcp'), false)
  assert.equal(text.includes('settings.json'), false)
  assert.equal(text.includes('stt/'), false)
  assert.equal(text.includes('taskset'), false, 'machine CPU pinning is not the installer\'s job')
  assert.match(text, /^set -euo pipefail$/m)
})

test('install.sh: build, then setup; no MCP or settings writes', () => {
  withFakes((bin, log) => {
    const r = runInstall(bin, 'true')
    assert.equal(r.status, 0, r.stderr)
    const calls = readFileSync(log, 'utf8').trim().split('\n')
    assert.deepEqual(calls, ['npm ci', 'npm run build', `node ${join(REPO, 'dist', 'cli', 'stolik.js')} setup`])
    assert.match(r.stdout, /stolik service install --start/)
    assert.match(r.stdout, /\/plugin install stolik@indicozy/)
    assert.equal(existsSync(join(bin, '.claude')), false, 'no ~/.claude is created')
  })
})

test('install.sh: refuses a node older than 22.13 before building anything', () => {
  withFakes((bin, log) => {
    const r = runInstall(bin, 'false')
    assert.equal(r.status, 1)
    assert.match(r.stderr, /node 22\.13 or newer is required/)
    assert.equal(readFileSync(log, 'utf8'), '')
  })
})
