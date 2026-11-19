// ML worker addon (plan 3.1). A service addon: it provides nothing to users, and the voice, voice-cleanup and digest
// addons call its ops through the host. The Python worker (ml/worker.py) speaks the addon protocol on this process's
// stdin and stdout, so this wrapper only starts it with the ML venv's Python and hands the pipes over. The host's
// payload.deadline (epoch ms) therefore reaches the worker unchanged, with no forwarding code here.
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The repo's ml folder, three levels up from this file (src/addons/ml-worker or dist/addons/ml-worker). An installed copy
// needs STOLIK_ML_PYTHON and STOLIK_ML_WORKER instead (packaging, plan P).
const ML_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'ml')
const python = process.env.STOLIK_ML_PYTHON ?? join(ML_DIR, '.venv', 'bin', 'python')
const worker = process.env.STOLIK_ML_WORKER ?? join(ML_DIR, 'worker.py')

const child = spawn(python, ['-I', worker], {
  stdio: 'inherit',
  env: { ...process.env, HF_HOME: process.env.HF_HOME ?? '/mnt/ai_models/hf' },
})

// The host stops an addon with SIGTERM. Pass it on, so the worker and its GPU memory go with it.
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => child.kill(sig))
child.on('error', (e) => {
  process.stderr.write(`ml-worker: cannot start ${python}: ${e.message}\n`)
  process.exit(1)
})
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
