// The optional ML worker step of `stolik setup` (plan 3.1, docs/install.md): build environment, venv planning,
// detection with fake lookups, and the step inside runSetup with fake prompts and a fake runner. Nothing is installed.
import './helpers/isolate.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  detectBuildTools,
  findInPath,
  formatMlPlan,
  llamaBuildPlan,
  mlInstallPlan,
  mlPaths,
  shellQuote,
  venvState,
  type BuildTools,
  type MlSetupDeps,
  type MlStep,
} from '../src/cli/ml-setup.ts'
import { runSetup, type SetupDeps } from '../src/cli/setup.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CUDA = '/usr/local/cuda'
const GCC = { gcc15: '/usr/bin/gcc-15', gxx15: '/usr/bin/g++-15' }

test('CUDA build with gcc-15: CMAKE_ARGS, host compiler and nvcc env are set', () => {
  const plan = llamaBuildPlan({ cudaRoot: CUDA, ...GCC })
  assert.equal(plan.mode, 'cuda')
  assert.equal(plan.env.CMAKE_ARGS, '-DGGML_CUDA=on -DCMAKE_CUDA_HOST_COMPILER=/usr/bin/g++-15')
  assert.equal(plan.env.CUDACXX, '/usr/local/cuda/bin/nvcc')
  assert.equal(plan.env.CUDA_HOME, CUDA)
  assert.equal(plan.env.CUDAHOSTCXX, '/usr/bin/g++-15')
  assert.equal(plan.env.NVCC_CCBIN, '/usr/bin/g++-15')
  assert.equal(plan.env.CC, '/usr/bin/gcc-15')
  assert.equal(plan.env.CXX, '/usr/bin/g++-15')
  assert.deepEqual(plan.notes, ['CUDA build with nvcc at /usr/local/cuda/bin/nvcc.'])
})

test('CUDA build without gcc-15 warns and keeps the default host compiler', () => {
  const plan = llamaBuildPlan({ cudaRoot: CUDA, gcc15: null, gxx15: null })
  assert.equal(plan.mode, 'cuda')
  assert.equal(plan.env.CMAKE_ARGS, '-DGGML_CUDA=on')
  assert.equal('CUDAHOSTCXX' in plan.env, false)
  assert.equal('NVCC_CCBIN' in plan.env, false)
  assert.ok(plan.notes.some((n) => /gcc-15 not found/.test(n)))
})

test('no nvcc: CPU build with an empty environment and a note', () => {
  const plan = llamaBuildPlan({ cudaRoot: null, ...GCC })
  assert.equal(plan.mode, 'cpu')
  assert.deepEqual(plan.env, {})
  assert.ok(plan.notes.some((n) => /CPU only/.test(n)))
})

test('detectBuildTools: $CUDA_HOME first, then /usr/local/cuda, then nvcc on PATH; gcc-15 looked up by name', () => {
  const present = new Set(['/opt/cuda/bin/nvcc', '/usr/local/cuda/bin/nvcc', '/usr/bin/gcc-15', '/usr/bin/g++-15'])
  const exists = (p: string) => present.has(p)
  const findInPathFake = (name: string) => (name === 'gcc-15' ? '/usr/bin/gcc-15' : name === 'g++-15' ? '/usr/bin/g++-15' : null)

  const withEnv = detectBuildTools({ env: { CUDA_HOME: '/opt/cuda' }, exists, findInPath: findInPathFake })
  assert.equal(withEnv.cudaRoot, '/opt/cuda')
  assert.equal(withEnv.gcc15, '/usr/bin/gcc-15')
  assert.equal(withEnv.gxx15, '/usr/bin/g++-15')

  const fallback = detectBuildTools({ env: {}, exists, findInPath: findInPathFake })
  assert.equal(fallback.cudaRoot, '/usr/local/cuda')

  const onPath = detectBuildTools({
    env: {},
    exists: (p) => p === '/usr/share/cuda/bin/nvcc',
    findInPath: (n) => (n === 'nvcc' ? '/usr/share/cuda/bin/nvcc' : null),
  })
  assert.equal(onPath.cudaRoot, '/usr/share/cuda')
  assert.equal(onPath.gcc15, null)

  const none = detectBuildTools({ env: {}, exists: () => false, findInPath: () => null })
  assert.deepEqual(none, { cudaRoot: null, gcc15: null, gxx15: null })
})

test('findInPath returns the first existing candidate and skips empty PATH entries', () => {
  const exists = (p: string) => p === '/b/uv'
  assert.equal(findInPath('uv', '/a::/b', exists), '/b/uv')
  assert.equal(findInPath('uv', '/a', exists), null)
  assert.equal(findInPath('uv', undefined, exists), null)
})

test('venvState: missing, ready (has bin/python), broken (folder without one)', () => {
  const dirs = new Set(['/r/ml/.venv', '/r/ml/.venv/bin/python', '/r/broken', '/r/broken/x'])
  const exists = (p: string) => dirs.has(p)
  assert.equal(venvState('/r/none', exists), 'missing')
  assert.equal(venvState('/r/ml/.venv', exists), 'ready')
  assert.equal(venvState('/r/broken', exists), 'broken')
})

const root = '/repo'
const cudaBuild = llamaBuildPlan({ cudaRoot: CUDA, ...GCC })

test('plan for a missing venv: create then install with the build environment', () => {
  const plan = mlInstallPlan({ root, venv: 'missing', uv: '/bin/uv', build: cudaBuild, requirementsExists: true })
  assert.equal(plan.ok, true)
  if (!plan.ok) return
  assert.equal(plan.steps.length, 2)
  assert.deepEqual(plan.steps[0].argv, ['/bin/uv', 'venv', '--python', '3.12', '/repo/ml/.venv'])
  assert.deepEqual(plan.steps[1].argv, [
    '/bin/uv',
    'pip',
    'install',
    '--python',
    '/repo/ml/.venv/bin/python',
    '-r',
    '/repo/ml/requirements.txt',
    '--no-binary',
    'llama-cpp-python',
  ])
  assert.equal(plan.steps[1].env.CMAKE_ARGS, cudaBuild.env.CMAKE_ARGS)
  assert.deepEqual(plan.steps[0].env, {})
})

test('plan for an existing venv: no create step, so the venv is reused', () => {
  const plan = mlInstallPlan({ root, venv: 'ready', uv: '/bin/uv', build: llamaBuildPlan({ cudaRoot: null, gcc15: null, gxx15: null }), requirementsExists: true })
  assert.equal(plan.ok, true)
  if (!plan.ok) return
  assert.equal(plan.steps.length, 1)
  assert.equal(plan.steps[0].argv[1], 'pip')
  assert.deepEqual(plan.steps[0].env, {}, 'CPU build: no build environment')
})

test('plan never removes or rebuilds a venv: no step uses --clear, --reinstall, rm or remove', () => {
  for (const venv of ['missing', 'ready'] as const) {
    const plan = mlInstallPlan({ root, venv, uv: '/bin/uv', build: cudaBuild, requirementsExists: true })
    assert.equal(plan.ok, true)
    if (!plan.ok) continue
    for (const step of plan.steps) {
      for (const bad of ['--clear', '--reinstall', 'rm', 'remove', '-rf']) assert.equal(step.argv.includes(bad), false, `${bad} in ${step.argv}`)
    }
  }
})

test('plan refuses a broken venv folder, a missing requirements file and a missing uv, without steps', () => {
  const broken = mlInstallPlan({ root, venv: 'broken', uv: '/bin/uv', build: cudaBuild, requirementsExists: true })
  assert.equal(broken.ok, false)
  if (!broken.ok) assert.match(broken.reason, /Move it aside \(nothing is deleted here\)/)

  const noReq = mlInstallPlan({ root, venv: 'missing', uv: '/bin/uv', build: cudaBuild, requirementsExists: false })
  assert.equal(noReq.ok, false)
  if (!noReq.ok) assert.match(noReq.reason, /requirements\.txt is missing/)

  const noUv = mlInstallPlan({ root, venv: 'missing', uv: null, build: cudaBuild, requirementsExists: true })
  assert.equal(noUv.ok, false)
  if (!noUv.ok) assert.match(noUv.reason, /uv is needed/)
})

test('formatMlPlan prints the environment and the exact commands before anything runs', () => {
  const plan = mlInstallPlan({ root, venv: 'missing', uv: '/bin/uv', build: cudaBuild, requirementsExists: true })
  assert.equal(plan.ok, true)
  if (!plan.ok) return
  const text = formatMlPlan(plan, cudaBuild).join('\n')
  assert.match(text, /CMAKE_ARGS='-DGGML_CUDA=on -DCMAKE_CUDA_HOST_COMPILER=\/usr\/bin\/g\+\+-15'/)
  assert.match(text, /CUDACXX=\/usr\/local\/cuda\/bin\/nvcc/)
  assert.match(text, /\/bin\/uv venv --python 3\.12 \/repo\/ml\/\.venv/)
  assert.match(text, /--no-binary llama-cpp-python/)
})

test('shellQuote leaves safe words alone and quotes the rest', () => {
  assert.equal(shellQuote('/usr/bin/uv'), '/usr/bin/uv')
  assert.equal(shellQuote('a b'), "'a b'")
  assert.equal(shellQuote("it's"), "'it'\\''s'")
})

test('mlPaths points inside ml/', () => {
  assert.deepEqual(mlPaths('/r'), { venv: '/r/ml/.venv', python: '/r/ml/.venv/bin/python', requirements: '/r/ml/requirements.txt' })
})

// ---- the step inside runSetup ----

const TOKEN = '123456789:AAHfakeTokenForTestsOnly_abcdefgh'

function withSetupPaths(fn: (paths: SetupDeps['paths'], root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(HERE, '.tmp-ml-setup-'))
  const paths = {
    envFile: join(root, 'home', '.config', 'stolik.env'),
    configFile: join(root, 'home', '.config', 'stolik', 'config.json'),
    pluginDir: '/opt/stolik/plugin',
    nodePath: '/usr/bin/node',
  }
  return fn(paths, root).finally(() => rmSync(root, { recursive: true, force: true }))
}

function fakeMl(over: Partial<MlSetupDeps> = {}): { ml: MlSetupDeps; ran: MlStep[] } {
  const ran: MlStep[] = []
  const ml: MlSetupDeps = {
    root: '/repo',
    tools: () => ({ cudaRoot: CUDA, ...GCC }) as BuildTools,
    venvState: () => 'missing',
    uv: '/bin/uv',
    requirementsExists: () => true,
    run: async (step) => {
      ran.push(step)
      return 0
    },
    ...over,
  }
  return { ml, ran }
}

function setupDeps(paths: SetupDeps['paths'], answers: string[], ml?: MlSetupDeps) {
  const out: string[] = []
  const asked: string[] = []
  const next = (q: string) => {
    asked.push(q)
    return Promise.resolve(answers.shift() ?? '')
  }
  const deps: SetupDeps = { ask: next, askSecret: next, out: (l) => out.push(l), paths, ml }
  return { deps, out, asked }
}

test('setup: the ML step is skipped by default (no answer) and runs nothing', async () => {
  await withSetupPaths(async (paths) => {
    const { ml, ran } = fakeMl()
    const { deps, out, asked } = setupDeps(paths, [TOKEN, '42', ''], ml)
    assert.equal(await runSetup(deps), 0)
    assert.equal(ran.length, 0)
    assert.match(asked.find((q) => /ml\/\.venv/.test(q)) ?? '', /\[y\/N\]/)
    assert.ok(out.some((l) => /skipped/.test(l)))
  })
})

test('setup: declining the run prompt after seeing the plan runs nothing', async () => {
  await withSetupPaths(async (paths) => {
    const { ml, ran } = fakeMl()
    const { deps, out } = setupDeps(paths, [TOKEN, '42', 'y', 'n'], ml)
    assert.equal(await runSetup(deps), 0)
    assert.equal(ran.length, 0)
    assert.ok(out.some((l) => /CMAKE_ARGS=/.test(l)), 'the environment is printed before the question')
    assert.ok(out.some((l) => /not run/.test(l)))
  })
})

test('setup: yes runs create and install in order; a failed step stops with exit 1 and keeps the venv', async () => {
  await withSetupPaths(async (paths) => {
    const ok = fakeMl()
    const first = setupDeps(paths, [TOKEN, '42', 'yes', 'yes'], ok.ml)
    assert.equal(await runSetup(first.deps), 0)
    assert.deepEqual(
      ok.ran.map((s) => s.argv[1]),
      ['venv', 'pip'],
    )

    const bad = fakeMl({ run: async () => 2 })
    const second = setupDeps(paths, [TOKEN, 'y', 'y'], bad.ml) // the owner is saved now: not asked again
    assert.equal(await runSetup(second.deps), 1)
    assert.ok(second.out.some((l) => /ml\/\.venv is kept as it is/.test(l)))
  })
})

test('setup: a broken ml/.venv is reported and nothing runs', async () => {
  await withSetupPaths(async (paths, root) => {
    mkdirSync(join(root, 'keep'), { recursive: true })
    const { ml, ran } = fakeMl({ venvState: () => 'broken' })
    const { deps, out } = setupDeps(paths, [TOKEN, '42', 'y'], ml)
    assert.equal(await runSetup(deps), 1)
    assert.equal(ran.length, 0)
    assert.ok(out.some((l) => /exists but has no bin\/python/.test(l)))
  })
})

test('setup: the rest of setup is saved even when the ML step fails', async () => {
  await withSetupPaths(async (paths) => {
    const { ml } = fakeMl({ run: async () => 1 })
    const { deps, out } = setupDeps(paths, [TOKEN, '42', 'y', 'y'], ml)
    assert.equal(await runSetup(deps), 1)
    assert.equal(readFileSync(paths.configFile, 'utf8').includes('"ownerUserId": "42"'), true)
    assert.ok(out.some((l) => /6\. Service/.test(l)), 'the service step is still printed')
    assert.equal(existsSync(paths.envFile), true)
  })
})

test('the repo requirements pin the working venv versions and keep llama-cpp-python pinned', () => {
  const text = readFileSync(join(HERE, '..', 'ml', 'requirements.txt'), 'utf8')
  assert.match(text, /^faster-whisper==1\.2\.1$/m)
  assert.match(text, /^llama-cpp-python==0\.3\.36$/m)
  assert.match(text, /^av==15\.1\.0$/m)
})
