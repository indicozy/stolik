// The read and web allowlist, and the PreToolUse decision the hook script makes (design §4.10, plan 2.11). Review
// findings 3, 4, 5 and 16 are pinned here (the /proc and egress bypasses, the root allowlist, the glob rules, git flags).
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkBash, decideTool, hookOutput, secretPath, type ToolPolicy } from '../src/brain/modes.ts'

const HOME = '/home/u'
const CWD = `${HOME}/Documents/projects/master`
const POLICY: ToolPolicy = { home: HOME, cwd: CWD, roots: [CWD, '/tmp', '/etc/os-release', '/etc/hostname', '/etc/hosts', '/var/log'] }
const allowed = (cmd: string) => checkBash(cmd, POLICY).allow
const denied = (cmd: string) => !checkBash(cmd, POLICY).allow
const read = (file_path: string) => decideTool('read', 'Read', { file_path }, POLICY).allow
const grep = (input: Record<string, unknown>) => decideTool('read', 'Grep', { pattern: 'x', ...input }, POLICY).allow
const glob = (pattern: string, path?: string) => decideTool('read', 'Glob', path === undefined ? { pattern } : { pattern, path }, POLICY).allow

test('allowed: the owner-accepted read commands, with paths inside the roots', () => {
  for (const cmd of [
    'git status', 'git status --short', 'git log --oneline -5', 'git diff', 'git diff --stat', 'git show HEAD',
    'git branch', 'git branch -a', 'git branch --show-current', 'git branch --merged main', 'git branch --list feat',
    'ls', 'ls -la /tmp', `ls -la ${CWD}`, 'df -h', `du -sh ${CWD}`, 'du -sh', 'free -m', 'uptime', 'ps aux',
    'systemctl --user status stolik', 'systemctl --user status foo.service', 'systemctl --user status stolik --no-pager -n 20 -l',
    'journalctl --user -u stolik --since today', 'journalctl --user -n 5', 'nvidia-smi',
    'nvidia-smi --query-gpu=name,memory.used --format=csv', `${HOME}/.claude/skills/quota-gate/scripts/quota-gate --weekly-min=0`,
  ]) assert.ok(allowed(cmd), `should allow: ${cmd}`)
})

test('denied: writes, installs, deletes, restarts and network (design §4.10)', () => {
  for (const cmd of [
    'touch /tmp/x', 'rm -rf /tmp/x', 'rm x', 'curl https://example.com', 'wget https://x', 'git push', 'git push origin main',
    'git commit -m x', 'git reset --hard', 'npm install', 'pip install x', 'mkdir d', 'mv a b', 'cp a b', 'chmod +x a',
    'systemctl --user restart stolik', 'systemctl --user stop stolik', 'journalctl --user --vacuum-time=1d',
    'git branch -D main', 'git branch newname', 'git branch -m a b', 'git diff --output=/tmp/x', 'git diff --ext-diff',
    'git -C /x status', 'git -c core.pager=sh log', 'nvidia-smi -r', 'nvidia-smi -pl 100',
    'python3 -c 1', 'sh -c ls', 'env', 'printenv',
  ]) assert.ok(denied(cmd), `should deny: ${cmd}`)
})

test('denied: shell operators, chaining, substitution, quoting and redirects', () => {
  for (const cmd of [
    'git status && rm -rf /', 'ls; rm x', 'ls | sh', 'ls > /tmp/x', 'ls < /etc/passwd', 'ls `id`', 'ls $(id)', 'ls $HOME',
    'ls "a b"', "ls 'a'", 'ls\nrm x', 'ls \\', 'ls {a,b}', 'ls (a)', '', '   ',
  ]) assert.ok(denied(cmd), `should deny: ${JSON.stringify(cmd)}`)
})

test('a git branch name is only a ref after --merged, --contains or --list', () => {
  assert.ok(allowed('git branch --contains main'))
  assert.ok(denied('git branch main'))
  assert.ok(denied('git branch --verbose new'))
})

test('a Bash command that names a secret path is refused, and so is a secret path among the words', () => {
  for (const cmd of ['ls /home/u/.ssh', 'ls ~/.ssh', 'ls ~/.config/telegram-notify.env', 'git log -- ~/.config/stolik.env', 'ls ~/.claude.json']) {
    assert.equal(checkBash(cmd, POLICY).allow, false, `refused: ${cmd}`)
  }
})

test('the secret list covers the env files, the Claude config, keys, pem files and the new families', () => {
  for (const p of [
    `${HOME}/.config/telegram-notify.env`, `${HOME}/.config/whatever.env.local`, `${HOME}/.claude.json`, `${HOME}/certs/server.pem`,
    `${HOME}/.ssh/id_rsa.pub`, `${HOME}/projects/app/id_dsa`, `${HOME}/projects/app/id_ed25519_backup`,
    `${CWD}/.npmrc`, `${HOME}/.netrc`, `${HOME}/.pgpass`, `${HOME}/.git-credentials`, `${CWD}/db/vault.kdbx`, `${CWD}/tls/server.key`,
    `${CWD}/tls/cert.p12`, `${HOME}/.kube/config`, `${HOME}/.docker/config.json`, `${HOME}/.bash_history`, `${HOME}/.zsh_history`,
    `${HOME}/.python_history`, `${HOME}/.psql_history`, `${HOME}/.node_repl_history`, `${HOME}/.mozilla/firefox/x/cookies.sqlite`,
    `${HOME}/.config/google-chrome/Default/Login Data`, `${HOME}/.local/share/TelegramDesktop/tdata/key_datas`,
    `${HOME}/.claude/settings.json`, `${HOME}/.claude/settings.local.json`, `${HOME}/.claude/projects/x/session.jsonl`,
    `${HOME}/.claude/.credentials.json`,
  ]) assert.ok(secretPath(p), `secret: ${p}`)
  for (const p of [`${HOME}/projects/app/README.md`, `${CWD}/src/config.ts`]) {
    assert.equal(secretPath(p), false, `not secret: ${p}`)
  }
})

test('the secret list matches /proc, /sys and /dev at the start of a word or after = or :, not as a folder named dev in a home path', () => {
  for (const p of ['/proc/1/environ', '--files0-from=/proc/1/environ', 'REV:/proc/1/environ', '/sys/kernel', '/dev/shm/x', 'x=/dev']) {
    assert.ok(secretPath(p), `secret: ${p}`)
  }
  for (const p of [`${HOME}/dev/myproject/README.md`, `${HOME}/dev`, `${HOME}/projects/proc/x.ts`]) {
    assert.equal(secretPath(p), false, `not secret: ${p}`)
  }
})

test('Grep and Glob are refused outside the roots (home, /, /home, the config folders); the project folder is fine', () => {
  for (const root of [HOME, `${HOME}/`, '/', '/home', `${HOME}/.config`, `${HOME}/.local/state`, `${HOME}/.claude`]) {
    assert.equal(grep({ path: root }), false, `grep refused at ${root}`)
    assert.equal(glob('*.ts', root), false, `glob refused at ${root}`)
  }
  assert.equal(grep({ path: CWD }), true)
  assert.equal(grep({}), true, 'no path: the project folder')
})

test('secret paths are refused for Read, Grep and Glob', () => {
  for (const p of [
    `${HOME}/.config/stolik.env`, `${HOME}/.config/stolik/config.json`, `${HOME}/.local/state/stolik/modes/threads.json`,
    `${HOME}/.ssh/id_ed25519`, `${HOME}/.claude/.credentials.json`, `${CWD}/.env`, `${CWD}/.env.local`,
    '/proc/1234/environ', `${HOME}/aws/credentials`,
  ]) assert.equal(read(p), false, `refused: ${p}`)
  assert.equal(glob('**/.env', CWD), false)
  assert.equal(read(`${CWD}/README.md`), true)
  assert.equal(grep({ pattern: 'credentials', path: CWD, glob: '*.ts' }), true)
})

test('tools by mode: quick has none, read has read tools and checked Bash, web has search only', () => {
  assert.equal(decideTool('quick', 'Read', { file_path: CWD }, POLICY).allow, false)
  assert.equal(grep({ path: CWD }), true)
  assert.equal(decideTool('read', 'Bash', { command: 'ls' }, POLICY).allow, true)
  assert.equal(decideTool('read', 'Bash', { command: 'touch /tmp/x' }, POLICY).allow, false)
  assert.equal(decideTool('read', 'WebSearch', { query: 'x' }, POLICY).allow, false)
  assert.equal(decideTool('read', 'Write', { file_path: CWD }, POLICY).allow, false)
  assert.equal(decideTool('web', 'WebSearch', { query: 'x' }, POLICY).allow, true)
  assert.equal(decideTool('web', 'WebFetch', { url: 'https://x' }, POLICY).allow, true)
  assert.equal(decideTool('web', 'Bash', { command: 'ls' }, POLICY).allow, false)
  assert.equal(decideTool('web', 'Read', { file_path: CWD }, POLICY).allow, false)
})

test('the hook denies in the PreToolUse JSON and never allows', () => {
  assert.equal(hookOutput({ allow: true, reason: 'allowed' }), '')
  const out = JSON.parse(hookOutput({ allow: false, reason: 'nope' })) as { hookSpecificOutput: Record<string, string> }
  assert.deepEqual(out.hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'nope' })
})

// The compiled-from-source hook, run as the CLI runs it: JSON on stdin, the mode as argv[2], the policy file as argv[3]
// (the arguments hookCommand builds).
const HERE = dirname(fileURLToPath(import.meta.url))
const HOOK = join(HERE, '..', 'src', 'addons', 'modes', 'hook.ts')
const policyDir = mkdtempSync(join(HERE, '.tmp-hookpolicy-'))
const POLICY_FILE = join(policyDir, 'read.json')
// The file hookCommand points at: the HookPolicy shape (src/brain/hook-policy.ts), with no web hosts and no log files.
writeFileSync(POLICY_FILE, JSON.stringify({ mode: 'read', ...POLICY, webHosts: [], webLog: null, auditFile: null, deniedLog: null }))
process.on('exit', () => rmSync(policyDir, { recursive: true, force: true }))
function runHook(mode: string, input: string): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', HOOK, mode, POLICY_FILE], { input, encoding: 'utf8', timeout: 20_000 })
  return { code: r.status, out: r.stdout }
}

// The PreToolUse event the CLI sends: hook_event_name, tool_name and tool_input.
const preEvent = (tool_name: string, tool_input: Record<string, unknown>) =>
  JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input })

test('hook script: denies a touch in read mode, allows an ls, fails closed on garbage', () => {
  const touch = runHook('read', preEvent('Bash', { command: 'touch /tmp/x' }))
  assert.equal(touch.code, 0)
  assert.equal((JSON.parse(touch.out) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(runHook('read', preEvent('Bash', { command: 'ls' })).out, '')
  // Failures of the hook itself (bad input, unknown mode, a mode that does not match the policy) are denies.
  const denies = (out: string) => (JSON.parse(out) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision === 'deny'
  assert.ok(denies(runHook('read', 'not json').out), 'garbage input is denied')
  assert.ok(denies(runHook('nope', '{}').out), 'an unknown mode is denied')
  assert.ok(denies(runHook('quick', preEvent('Bash', { command: 'ls' })).out), 'quick has no hook: a policy for read does not match')
  assert.ok(denies(runHook('read', preEvent('Bash', { command: `ls ${HOME}/.npmrc` })).out), 'a secret path is denied')
})

// Regression: a read run denied `ls /tmp` although `Bash(ls:*)` is allowed. /tmp is a root, so it is allowed here.
test('ls of any root path is read-only and allowed; the chaining, substitution and write forms are not', () => {
  for (const cmd of ['ls /tmp', 'ls /tmp/', 'ls -la /tmp', `ls ${CWD}`, 'git status']) {
    assert.deepEqual(checkBash(cmd, POLICY), { allow: true, reason: 'allowed' }, `allowed: ${cmd}`)
  }
  for (const cmd of ['ls /tmp; rm -rf x', 'ls /tmp && rm x', 'ls /tmp | sh', 'ls /tmp > /tmp/x', 'ls `id`', 'ls $(id)']) {
    assert.equal(checkBash(cmd, POLICY).allow, false, `denied: ${cmd}`)
  }
  for (const cmd of ['touch /tmp/x', 'rm -rf /tmp/x', 'curl https://example.com', 'git push']) {
    assert.equal(checkBash(cmd, POLICY).allow, false, `denied: ${cmd}`)
  }
  assert.equal(decideTool('read', 'Bash', { command: 'ls /tmp' }, POLICY).allow, true)
  assert.equal(read(`${HOME}/.ssh/id_ed25519`), false)
  assert.equal(read('/tmp/notes.txt'), true)
})

// Review finding 1: `ps` shows other processes' environments with an e flag (BSD `e`, `eww`, `-E`, `--env`), and
// an environ column. Only a fixed set of flags, pids, users, sort keys and columns is allowed.
test('ps: the process environment is never shown, in any flag spelling', () => {
  for (const cmd of [
    'ps eww', 'ps auxeww', 'ps e', 'ps ax e', 'ps -E', 'ps -e -E', 'ps --env', 'ps -o pid,environ', 'ps -o pid,command',
    'ps -eo pid,args', 'ps u -p 1 e', 'ps -ef e', 'ps aux -E', 'ps -o pid=x', 'ps --pid 1', 'ps -C bash', 'ps -p',
  ]) assert.equal(checkBash(cmd, POLICY).allow, false, `refused: ${cmd}`)
})

test('ps: the listing flags, a user, pids, a sort key and the fixed columns are allowed', () => {
  for (const cmd of [
    'ps', 'ps aux', 'ps -ef', 'ps -e -f', 'ps -u root', 'ps -u root aux', 'ps -p 1234', 'ps -p 1,2',
    'ps -o pid,ppid,user,%cpu,%mem,etime,stat,comm,args', 'ps aux --sort=-%cpu', 'ps -ef --sort -%mem',
  ]) assert.ok(allowed(cmd), `should allow: ${cmd}`)
})

// Review finding 3: the bypasses found in review. Each one must be refused.
test('finding 3: /proc reads, egress flags and the abbreviated forms are refused', () => {
  for (const cmd of [
    'du --files0-from=/proc/1/environ', 'du --exclude-from=/x', 'du -X /x', 'du -H .', 'du --exclude=x', 'du --files0-from=/tmp/list',
    'systemctl --user status -H host', 'systemctl --user status --host=host foo', 'systemctl --user status -M x@y',
    'systemctl --user status --machine=x foo', 'systemctl --user status foo -H host',
    'ps eww', 'ps e', 'ps -E', 'ls /proc/self', 'ls -la /proc/1/', 'ls /proc', 'df -H', 'ls --help',
    'ls /dev/shm', 'du -sh /sys/kernel', 'ls -I/proc',
  ]) assert.equal(checkBash(cmd, POLICY).allow, false, `refused: ${cmd}`)
})

// Review finding 3 and 4: a path argument is checked, lexically and through symlinks, against the roots and the secrets.
test('finding 3 and 4: ls of a secret path is refused, in or out of a root', () => {
  for (const cmd of [`ls ${HOME}/.npmrc`, 'ls /home/x/.npmrc', `ls ${CWD}/.npmrc`, `ls ~/.npmrc`, `ls ${HOME}/.ssh`, `du -sh ${HOME}`, 'ls ~', `ls ~/Documents/projects`]) {
    assert.equal(checkBash(cmd, POLICY).allow, false, `refused: ${cmd}`)
  }
})

// Review finding 3: `journalctl --user` stays as it is, and the secret list still applies to its arguments.
test('journalctl: the reading options are allowed', () => {
  for (const cmd of [
    'journalctl --user -n 50', 'journalctl --user --lines=100 --no-pager', 'journalctl --user -u stolik.service -o cat -q',
    'journalctl --user -b -r -p err', 'journalctl --user -p 3..4 --until 2026-11-14', 'journalctl --user -e --no-pager',
    'journalctl --user --user-unit stolik', 'journalctl --user -o json -n 5', 'journalctl --user --unit=stolik --output=short-iso',
    'journalctl --user --since yesterday -u stolik',
  ]) assert.ok(allowed(cmd), `should allow: ${cmd}`)
})

test('journalctl: cursor files, directories, journal files, roots, images, follow and other options are refused', () => {
  for (const cmd of [
    'journalctl --user --cursor-file=/tmp/c', 'journalctl --user --cursor-file /tmp/c', 'journalctl --user -D /x',
    'journalctl --user --directory=/x', 'journalctl --user --file=/x', 'journalctl --user --root=/x', 'journalctl --user --image=/x',
    'journalctl --user -f', 'journalctl --user --follow', 'journalctl --user -o export', 'journalctl --user -n abc',
    'journalctl --user -p nope', 'journalctl --user --vacuum-time=1d', 'journalctl --user -m', 'journalctl --user -S 10',
    'journalctl --user --output-fields=_CMDLINE', 'journalctl --user -u',
  ]) assert.equal(checkBash(cmd, POLICY).allow, false, `refused: ${cmd}`)
})

// Review finding 2: a path is normalised before the secret check (./, ../, ~), and a word with a glob or expansion
// character is refused. `ls ~` (the home folder) is not a root, so it is refused too.
test('Bash: ~ and ~/ expand to the home folder; other tilde forms and glob characters are refused', () => {
  for (const cmd of [`ls ~/Documents/projects/master`, `du -sh ~/Documents/projects/master`]) assert.ok(allowed(cmd), `should allow: ${cmd}`)
  for (const cmd of ['ls ~user', 'ls ~root/x', 'ls ~/*', 'ls /home/u/*', 'ls ?', 'ls [ab]', 'ls ~/.s?h', 'ls ~/{a}', 'ls a~b']) {
    assert.equal(checkBash(cmd, POLICY).allow, false, `refused: ${cmd}`)
  }
})

test('Bash: a secret path is refused after ./, ../ and ~ are resolved', () => {
  for (const cmd of [
    `ls ${HOME}/.config/./stolik.env`, `ls ~/.config/./stolik.env`, `ls ${HOME}/.config/x/../stolik.env`,
    `ls ${HOME}/projects/../.ssh`, `ls ~/./.ssh`, `ls ${HOME}/.ssh/.`, `ls ~/.claude/./.credentials.json`,
  ]) assert.equal(checkBash(cmd, POLICY).allow, false, `refused: ${cmd}`)
})

test('Read, Grep and Glob: the path is resolved first, so ./ and ../ do not hide a secret', () => {
  assert.equal(read(`${HOME}/.config/./stolik.env`), false)
  assert.equal(read('~/.config/./stolik.env'), false)
  assert.equal(read(`${HOME}/projects/../.ssh/config`), false)
  assert.equal(read(`${HOME}/.claude/./.credentials.json`), false)
  assert.equal(glob('../../.ssh/*', CWD), false)
  assert.equal(grep({ path: CWD, glob: '../../.ssh/*' }), false)
  assert.equal(grep({ path: `${CWD}/..` }), false, 'resolves to the projects folder, which is not a root')
  assert.equal(read(`${CWD}/README.md`), true)
})

// Review finding 1: /proc is refused for Read, Grep and Glob, whatever the path, glob or pattern spelling.
test('Read, Grep and Glob refuse /proc entirely, including through a glob or a relative path', () => {
  assert.equal(grep({ path: '/proc' }), false)
  assert.equal(grep({ path: '/proc/self' }), false)
  assert.equal(grep({ pattern: 'environ', path: CWD, glob: '../../../../proc/*/environ' }), false)
  assert.equal(glob('/proc/*/environ', HOME), false)
  assert.equal(read('/proc/self/status'), false)
  assert.equal(read('/proc/self/cwd/.env'), false)
  assert.equal(read('/proc/self/../self/status'), false)
})

// Review finding 16 and 3: git flags are explicit per subcommand, `..` is refused, and paths stay inside the roots.
test('git: --no-index and paths outside the roots are refused; project paths are fine', () => {
  for (const cmd of ['git diff --no-index a b', 'git diff --no-ind a b', 'git diff /etc/shadow /tmp/x', 'git diff ../../x', 'git log /etc/passwd']) {
    assert.equal(checkBash(cmd, POLICY).allow, false, `refused: ${cmd}`)
  }
  for (const cmd of ['git diff src/x.ts', 'git show HEAD:src/a.ts', 'git log --oneline -5 -- src']) {
    assert.ok(allowed(cmd), `should allow: ${cmd}`)
  }
})

test('git: config, output and abbreviated flags, and .. anywhere, are refused', () => {
  for (const cmd of [
    'git -c core.pager=x log', 'git -C /tmp status', 'git --git-dir=/x log', 'git --work-tree=/x status', 'git log --outp=/tmp/x',
    'git log --output=/tmp/x', 'git show HEAD:../../x', 'git log HEAD..main', 'git diff --textconv', 'git diff --ext-diff',
    'git log --exec=sh', 'git status --ignored-x', 'git show --no-index a b', 'git diff --no-ind', 'git log --no-walk=x',
    'git log -c', 'git diff --output-indicator-new=x',
  ]) assert.equal(checkBash(cmd, POLICY).allow, false, `refused: ${cmd}`)
})

// Review finding 5: Glob and the Grep glob field. A literal safe extension, no dot files, no ..; a recursive glob may not
// name secrets.
test('Glob and Grep globs: the safe extensions pass; secret names, dot files and extensionless or unsafe globs do not', () => {
  assert.equal(glob('*.env', CWD), false)
  assert.equal(glob('**/.env', CWD), false)
  assert.equal(glob('*', CWD), false)
  assert.equal(glob('**/*', CWD), false)
  assert.equal(glob('*.key', CWD), false)
  assert.equal(glob('../*.ts', CWD), false)
  assert.equal(glob('/etc/*.ts', CWD), false)
  assert.equal(glob('~/*.ts', CWD), false)
  assert.equal(glob('**/*secret*.ts', CWD), false, 'a recursive glob naming a secret')
  assert.equal(glob('**/*token*.md', CWD), false, 'a recursive glob naming a token')
  assert.equal(glob('*.{ts,.env}', CWD), false, 'a brace alternative that is a dot file')
  assert.equal(glob('[.]env.ts', CWD), false, 'a dot in a character class')
  assert.equal(glob('*.ts', CWD), true)
  assert.equal(glob('**/*.ts', CWD), true)
  assert.equal(glob('src/**/*.{ts,tsx}', CWD), true)
  assert.equal(glob('*.md', CWD), true)
  assert.equal(grep({ path: CWD, glob: '.*' }), false)
  assert.equal(grep({ path: CWD, glob: '.*/**' }), false)
  assert.equal(grep({ path: CWD, glob: '*.env' }), false)
  assert.equal(grep({ path: CWD, glob: '*' }), false)
  assert.equal(grep({ path: CWD, glob: '*.ts' }), true)
  assert.equal(grep({ path: CWD, glob: 'src/**/*.ts' }), true)
  assert.equal(grep({ path: '/tmp', glob: '*.txt' }), true)
})

// Symlinks: a path inside the project that is a symlink to a secret folder is refused, as the folder it points at.
// The temp folder is inside the worktree (test/.tmp-*) and removed afterwards.
test('Read, Grep and Glob follow symlinks: a link to a secret folder is refused, a link to a normal folder is fine', () => {
  const tmp = mkdtempSync(join(HERE, '.tmp-symlink-'))
  const policy: ToolPolicy = { home: HOME, cwd: CWD, roots: [CWD, tmp] }
  const rd = (file_path: string) => decideTool('read', 'Read', { file_path }, policy).allow
  try {
    mkdirSync(join(tmp, 'vault', '.ssh'), { recursive: true })
    mkdirSync(join(tmp, 'notes'), { recursive: true })
    symlinkSync(join(tmp, 'vault', '.ssh'), join(tmp, 'link-ssh'))
    symlinkSync(join(tmp, 'notes'), join(tmp, 'link-notes'))
    symlinkSync(join(tmp, 'vault', '.ssh', 'missing'), join(tmp, 'link-dangling'))
    assert.equal(rd(join(tmp, 'link-ssh', 'config')), false, 'through a symlink to .ssh')
    assert.equal(decideTool('read', 'Grep', { pattern: 'x', path: join(tmp, 'link-ssh') }, policy).allow, false, 'a grep root that is the link')
    assert.equal(decideTool('read', 'Glob', { pattern: '*.ts', path: join(tmp, 'link-ssh') }, policy).allow, false, 'a glob root that is the link')
    assert.equal(rd(join(tmp, 'link-dangling')), false, 'a dangling link into .ssh')
    assert.equal(rd(join(tmp, 'link-notes', 'a.md')), true, 'a link to a normal folder')
    assert.equal(rd(join(tmp, 'notes', 'a.md')), true)
    assert.equal(decideTool('read', 'Bash', { command: `ls ${join(tmp, 'link-ssh')}` }, policy).allow, false, 'ls through the link')
    assert.ok(secretPath(join(tmp, 'vault', '.ssh', 'config')), 'the pattern matches the real .ssh path')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
