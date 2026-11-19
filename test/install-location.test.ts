// The npx guard: a copy that runs from npm's _npx cache must not get a service unit (the cache can be cleaned), while
// setup still runs. Nothing here touches systemd or launchd: runService gets a fake `run`.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isNpxInstall, NPX_SERVICE_MESSAGE } from '../src/cli/install-location.ts'
import { runService, type ServiceDeps } from '../src/cli/service.ts'

test('isNpxInstall: true for a copy under the npx cache, on both separators', () => {
  assert.equal(isNpxInstall('/home/u/.npm/_npx/3f9a1c/node_modules/stolik/dist/router/main.js'), true)
  assert.equal(isNpxInstall('C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\stolik\\dist'), true)
})

test('isNpxInstall: false for a global install, a checkout and names that only look alike', () => {
  assert.equal(isNpxInstall('/usr/lib/node_modules/stolik/dist/router/main.js'), false)
  assert.equal(isNpxInstall('/home/u/.nvm/versions/node/v22/lib/node_modules/stolik/dist/router/main.js'), false)
  assert.equal(isNpxInstall('/home/u/Documents/projects/stolik/dist/router/main.js'), false)
  assert.equal(isNpxInstall('/home/u/projects/my_npx_tools/stolik/dist'), false)
  assert.equal(isNpxInstall('/home/u/projects/_npxfoo/stolik/dist'), false)
})

test('runService install refuses an npx path: no unit written, one message, exit 1', () => {
  const written: string[] = []
  const errs: string[] = []
  const runs: string[] = []
  const deps = {
    platform: 'linux',
    home: '/home/u',
    xdgConfigHome: undefined,
    uid: 1000,
    nodePath: '/usr/bin/node',
    scriptPath: '/home/u/.npm/_npx/3f9a1c/node_modules/stolik/dist/router/main.js',
    presence: 'logind',
    cpuAffinity: null,
    nice: null,
    exists: () => true,
    out: (line: string) => written.push(line),
    err: (line: string) => errs.push(line),
    run: (file: string, args: string[]) => {
      runs.push([file, ...args].join(' '))
      return { status: 0, stdout: '', stderr: '' }
    },
  } as unknown as ServiceDeps
  const code = runService({ action: 'install', name: null, start: true, stop: false }, deps)
  assert.equal(code, 1)
  assert.deepEqual(errs, [NPX_SERVICE_MESSAGE])
  assert.deepEqual(written, [])
  assert.deepEqual(runs, [])
})
