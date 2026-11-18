// The optional ML worker step of `tg-bridge setup` (plan 3.1, docs/install.md). Pure planning: which venv steps run and
// the build environment for llama-cpp-python (CUDA when nvcc is found, CPU otherwise). Nothing here deletes a venv:
// an existing ml/.venv is reused, and a folder that is not a venv is refused, never removed.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

export const ML_PYTHON = '3.12'
export const ML_LLAMA_PACKAGE = 'llama-cpp-python'

// Tools the CUDA build needs, as paths. Null when not found.
export type BuildTools = {
  // The CUDA root (the folder with bin/nvcc), e.g. /usr/local/cuda.
  cudaRoot: string | null
  // gcc-15 and g++-15: nvcc 13.2 refuses a host compiler newer than gcc 15.
  gcc15: string | null
  gxx15: string | null
}

// The environment for building llama-cpp-python. `notes` are printed, so nothing is guessed silently.
export type BuildPlan = { mode: 'cuda' | 'cpu'; env: Record<string, string>; notes: string[] }

export function llamaBuildPlan(tools: BuildTools): BuildPlan {
  if (tools.cudaRoot === null) {
    return {
      mode: 'cpu',
      env: {},
      notes: ['No nvcc found: llama-cpp-python is built for CPU only (needs cmake and a C++ compiler).'],
    }
  }
  const nvcc = join(tools.cudaRoot, 'bin', 'nvcc')
  const env: Record<string, string> = {
    CUDA_HOME: tools.cudaRoot,
    CUDACXX: nvcc,
    CMAKE_BUILD_PARALLEL_LEVEL: '12',
  }
  const notes: string[] = []
  let cmake = '-DGGML_CUDA=on'
  if (tools.gcc15 !== null && tools.gxx15 !== null) {
    env.CC = tools.gcc15
    env.CXX = tools.gxx15
    env.CUDAHOSTCXX = tools.gxx15
    env.NVCC_CCBIN = tools.gxx15
    cmake += ` -DCMAKE_CUDA_HOST_COMPILER=${tools.gxx15}`
  } else {
    notes.push(
      'gcc-15 not found: nvcc uses the default host compiler. CUDA 13.2 refuses gcc 16 and newer; install gcc-15 if the build fails.',
    )
  }
  env.CMAKE_ARGS = cmake
  return { mode: 'cuda', env, notes: [`CUDA build with nvcc at ${nvcc}.`, ...notes] }
}

// The CUDA root candidates in order: $CUDA_HOME, /usr/local/cuda, then the folder above nvcc on PATH.
export function detectBuildTools(opts: {
  env: NodeJS.ProcessEnv
  exists: (path: string) => boolean
  findInPath: (name: string) => string | null
}): BuildTools {
  const cudaRoots = [opts.env.CUDA_HOME, '/usr/local/cuda']
  const onPath = opts.findInPath('nvcc')
  if (onPath) cudaRoots.push(dirname(dirname(onPath)))
  const cudaRoot =
    cudaRoots.find((root): root is string => typeof root === 'string' && root !== '' && opts.exists(join(root, 'bin', 'nvcc'))) ??
    null
  return {
    cudaRoot,
    gcc15: opts.findInPath('gcc-15'),
    gxx15: opts.findInPath('g++-15'),
  }
}

// The first executable named `name` on PATH, or null.
export function findInPath(name: string, pathValue: string | undefined, exists: (path: string) => boolean): string | null {
  for (const dir of (pathValue ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, name)
    if (exists(candidate)) return candidate
  }
  return null
}

export type VenvState = 'missing' | 'ready' | 'broken'

// `missing`: no ml/.venv. `ready`: it has bin/python. `broken`: the folder exists without one (refused, not removed).
export function venvState(venvDir: string, exists: (path: string) => boolean): VenvState {
  if (!exists(venvDir)) return 'missing'
  return exists(join(venvDir, 'bin', 'python')) ? 'ready' : 'broken'
}

export type MlStep = { label: string; argv: string[]; env: Record<string, string> }
export type MlPlan = { ok: true; venv: string; steps: MlStep[] } | { ok: false; reason: string }

export function mlPaths(root: string): { venv: string; python: string; requirements: string } {
  const venv = join(root, 'ml', '.venv')
  return { venv, python: join(venv, 'bin', 'python'), requirements: join(root, 'ml', 'requirements.txt') }
}

// The venv steps for this machine. `uv` is the uv binary (null when not installed). The install step always carries
// the build environment, so a re-run after a failed build uses the same settings.
export function mlInstallPlan(opts: {
  root: string
  venv: VenvState
  uv: string | null
  build: BuildPlan
  requirementsExists: boolean
}): MlPlan {
  const p = mlPaths(opts.root)
  if (opts.venv === 'broken') {
    return { ok: false, reason: `${p.venv} exists but has no bin/python. Move it aside (nothing is deleted here), then run setup again.` }
  }
  if (!opts.requirementsExists) return { ok: false, reason: `${p.requirements} is missing.` }
  if (opts.uv === null) {
    return { ok: false, reason: 'uv is needed to create ml/.venv (https://docs.astral.sh/uv/). Install it, then run setup again.' }
  }
  const steps: MlStep[] = []
  if (opts.venv === 'missing') {
    steps.push({ label: `create ${p.venv} (Python ${ML_PYTHON})`, argv: [opts.uv, 'venv', '--python', ML_PYTHON, p.venv], env: {} })
  }
  steps.push({
    label: 'install ML requirements (llama-cpp-python is built from source)',
    argv: [opts.uv, 'pip', 'install', '--python', p.python, '-r', p.requirements, '--no-binary', ML_LLAMA_PACKAGE],
    env: opts.build.env,
  })
  return { ok: true, venv: p.venv, steps }
}

// Shell-quotes one argument for display only.
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

// The lines shown before anything runs: the build mode, the environment, and the exact commands.
export function formatMlPlan(plan: Extract<MlPlan, { ok: true }>, build: BuildPlan): string[] {
  const envPrefix = (env: Record<string, string>): string =>
    Object.entries(env)
      .map(([k, v]) => `${k}=${shellQuote(v)} `)
      .join('')
  const lines = build.notes.map((n) => `   ${n}`)
  const buildEnv = envPrefix(build.env).trimEnd()
  if (buildEnv !== '') lines.push(`   environment for the build: ${buildEnv}`)
  lines.push('   commands:')
  for (const step of plan.steps) lines.push(`     ${envPrefix(step.env)}${step.argv.map(shellQuote).join(' ')}`)
  return lines
}

// What setup needs from the machine: where the repo is, the build tools, the venv state, uv, and a runner for a step.
export type MlSetupDeps = {
  root: string
  tools(): BuildTools
  venvState(): VenvState
  uv: string | null
  requirementsExists(): boolean
  run(step: MlStep): Promise<number>
}

// The real dependencies for a machine. `pin` wraps a command (CPU pinning from config, nice).
export function systemMlDeps(
  root: string,
  pathValue: string | undefined,
  pin: (file: string, args: string[]) => { file: string; args: string[] } = (file, args) => ({ file, args }),
): MlSetupDeps {
  const exists = (p: string) => existsSync(p)
  const { venv, requirements } = mlPaths(root)
  const uv = findInPath('uv', pathValue, exists)
  return {
    root,
    tools: () => detectBuildTools({ env: process.env, exists, findInPath: (n) => findInPath(n, pathValue, exists) }),
    venvState: () => venvState(venv, exists),
    uv,
    requirementsExists: () => exists(requirements),
    run: async (step) => {
      const [file, ...args] = step.argv
      const pinned = pin(file, args)
      const r = spawnSync(pinned.file, pinned.args, {
        cwd: root,
        env: { ...process.env, ...step.env },
        stdio: 'inherit',
      })
      return r.status ?? 1
    },
  }
}
