// Test isolation: HOME and the XDG folders point at a temp folder for this test file, so no test reads or writes the
// owner's real state, config, runtime or cache folders (the router's STATE_DIR, the pending markers, the config file).
// Each test file runs in its own process, and the folder is removed when it exits. Import this FIRST in a test file:
// src/config.ts reads these settings when it loads.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEST_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = mkdtempSync(join(TEST_DIR, '.tmp-isolate-'))
for (const d of ['home', 'state', 'config', 'cache', 'runtime']) mkdirSync(join(root, d), { recursive: true, mode: 0o700 })

process.env.HOME = join(root, 'home')
process.env.XDG_STATE_HOME = join(root, 'state')
process.env.XDG_CONFIG_HOME = join(root, 'config')
process.env.XDG_CACHE_HOME = join(root, 'cache')
process.env.XDG_RUNTIME_DIR = join(root, 'runtime')
// A developer's shell may point these at a trial instance; no test should inherit that.
delete process.env.TG_BRIDGE_SOCKET
delete process.env.TG_BRIDGE_ENV_FILE
delete process.env.TG_BRIDGE_CHANNEL

// The folder this file made, for tests that need its root (for example the migration test's default target).
export const ISOLATED_ROOT = root

process.on('exit', () => rmSync(root, { recursive: true, force: true }))
