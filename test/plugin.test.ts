import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The Claude Code plugin in plugin/ (manifest, marketplace, channel MCP entry, hooks) and the tg-claude launcher mode.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = join(REPO, 'plugin')
const readJson = (path: string): any => JSON.parse(readFileSync(path, 'utf8'))
const installSh = readFileSync(join(REPO, 'install.sh'), 'utf8')

test('plugin manifest: name tg-bridge, version and description present, no reserved name', () => {
  const m = readJson(join(PLUGIN, '.claude-plugin', 'plugin.json'))
  assert.equal(m.name, 'tg-bridge')
  assert.match(m.version, /^\d+\.\d+\.\d+$/)
  assert.ok(m.description)
  // Anthropic's reserved prefixes (plugins-reference, "name").
  assert.doesNotMatch(m.name, /^(claude-|anthropic-|anthropics-|cc-plugin-)/)
})

test('local marketplace indicozy lists tg-bridge at the marketplace root', () => {
  const mk = readJson(join(PLUGIN, '.claude-plugin', 'marketplace.json'))
  assert.equal(mk.name, 'indicozy')
  assert.ok(mk.owner?.name)
  assert.equal(mk.plugins.length, 1)
  assert.equal(mk.plugins[0].name, 'tg-bridge')
  assert.equal(mk.plugins[0].source, './')
})

test('.mcp.json: the channel server runs dist/channel.js through the node launcher (never a bare node)', () => {
  const mcp = readJson(join(PLUGIN, '.mcp.json'))
  const s = mcp.mcpServers['tg-bridge']
  assert.equal(s.command, '${CLAUDE_PLUGIN_ROOT}/../bin/tg-plugin-node')
  assert.deepEqual(s.args, ['${CLAUDE_PLUGIN_ROOT}/../dist/channel.js'])
  // The plugin's MCP entry carries the legacy protocol negotiation env that the server needs.
  assert.equal(s.env.MCP_PROTOCOL_NEGOTIATION, 'legacy')
})

// The plugin's own hook contract: event, matcher (none: PermissionRequest covers every tool), timeout in seconds, and the script
// each command runs after the plugin root prefix is removed. PostToolUse runs the posttool guard, which wraps the node
// launcher around dist/hook.js.
const PLUGIN_HOOKS: Array<{ event: string; matcher?: string; timeout: number; script: string }> = [
  { event: 'UserPromptSubmit', timeout: 5, script: 'bin/tg-plugin-node dist/hook.js UserPromptSubmit' },
  { event: 'Stop', timeout: 5, script: 'bin/tg-plugin-node dist/hook.js Stop' },
  { event: 'Notification', timeout: 5, script: 'bin/tg-plugin-node dist/hook.js Notification' },
  {
    event: 'PermissionRequest',
    timeout: 3600,
    script: 'bin/tg-plugin-node dist/hook.js PermissionRequest',
  },
  {
    event: 'PostToolUse',
    timeout: 5,
    script: 'bin/tg-posttool-hook bin/tg-plugin-node dist/hook.js',
  },
]

test('hooks/hooks.json: the plugin registers the five events with their matchers, timeouts and commands', () => {
  const plugin = readJson(join(PLUGIN, 'hooks', 'hooks.json')).hooks as Record<string, any[]>
  assert.deepEqual(Object.keys(plugin).sort(), PLUGIN_HOOKS.map((w) => w.event).sort())
  for (const w of PLUGIN_HOOKS) {
    const groups = plugin[w.event]
    assert.equal(groups.length, 1, `${w.event}: one matcher group`)
    assert.equal(groups[0].matcher, w.matcher, `${w.event}: matcher`)
    assert.equal(groups[0].hooks.length, 1)
    const h = groups[0].hooks[0]
    assert.equal(h.type, 'command')
    assert.equal(h.timeout, w.timeout, `${w.event}: timeout`)
    assert.ok(h.command.includes('${CLAUDE_PLUGIN_ROOT}'), `${w.event}: command uses CLAUDE_PLUGIN_ROOT`)
    // Compare the command with quotes and the plugin-root prefix removed.
    const normalized = h.command.replaceAll('"', '').replaceAll('${CLAUDE_PLUGIN_ROOT}/../', '')
    assert.equal(normalized.endsWith(w.script), true, `${w.event}: command ends with ${w.script}, got ${normalized}`)
  }
})

test('install.sh is a thin wrapper: it changes no Claude Code state (no `claude mcp`, no settings.json)', () => {
  assert.doesNotMatch(installSh, /claude mcp/)
  assert.doesNotMatch(installSh, /settings\.json/)
})

test('hook and server paths resolve to real files after build (dist/*.js, bin/tg-posttool-hook)', (t) => {
  const expand = (s: string) => s.replaceAll('${CLAUDE_PLUGIN_ROOT}', PLUGIN).replaceAll('"', '')
  const hooks = readJson(join(PLUGIN, 'hooks', 'hooks.json')).hooks as Record<string, any[]>
  const commands = Object.values(hooks).flatMap((g) => g.map((x: any) => expand(x.hooks[0].command)))
  const mcpArg = expand(readJson(join(PLUGIN, '.mcp.json')).mcpServers['tg-bridge'].args[0])
  // Every token that climbs out of plugin/ (../dist/..., ../bin/...) is a repo file the plugin depends on.
  const targets = [mcpArg, ...commands.flatMap((c) => c.split(/\s+/).filter((tok) => tok.includes('/../')))]
  if (!existsSync(join(REPO, 'dist', 'channel.js'))) {
    t.skip('dist/ not built; run npm run build')
    return
  }
  for (const target of new Set(targets.map((x) => resolve(x)))) {
    assert.ok(existsSync(target), `missing after build: ${target}`)
  }
  // install.sh makes the posttool guard executable (chmod 755); the plugin relies on the same file.
  assert.ok((statSync(join(REPO, 'bin', 'tg-posttool-hook')).mode & 0o111) !== 0, 'bin/tg-posttool-hook not executable')
  assert.ok((statSync(join(REPO, 'bin', 'tg-plugin-node')).mode & 0o111) !== 0, 'bin/tg-plugin-node not executable')
})

test('tg-claude: default loads server:tg-bridge; TG_BRIDGE_PLUGIN=1 loads plugin:tg-bridge@indicozy', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '.tmp-plugin')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  try {
    // A stub `claude` on PATH prints its argv, so the launcher's choice is observable without starting Claude Code.
    writeFileSync(join(dir, 'claude'), '#!/bin/sh\nprintf "%s\\n" "$@"\n')
    chmodSync(join(dir, 'claude'), 0o755)
    const run = (env: Record<string, string>) =>
      execFileSync(join(REPO, 'bin', 'tg-claude'), ['--model', 'haiku'], {
        env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, ...env },
        encoding: 'utf8',
      })
    const plain = run({})
    assert.match(plain, /^--dangerously-load-development-channels\nserver:tg-bridge\n--model\nhaiku\n$/)
    const plugin = run({ TG_BRIDGE_PLUGIN: '1' })
    assert.match(plugin, /^--dangerously-load-development-channels\nplugin:tg-bridge@indicozy\n--model\nhaiku\n$/)
    // Plain management subcommands still pass through unchanged.
    assert.equal(run({ TG_BRIDGE_PLUGIN: '1' }).includes('server:'), false)
    const mcp = execFileSync(join(REPO, 'bin', 'tg-claude'), ['mcp', 'list'], {
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, TG_BRIDGE_PLUGIN: '1' },
      encoding: 'utf8',
    })
    assert.equal(mcp, 'mcp\nlist\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
