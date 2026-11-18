// Workers addon entry point (plan 3.7). Answers `/workers` in General with what the Claude sessions, their subagents, the
// heavy jobs, the GPUs and the machine are doing (report.ts). Stdout is the protocol channel; logs go to stderr.
import { startAddon } from '../sdk.ts'
import { workersHandlers } from './command.ts'
import { buildWorkersReport, configSecrets } from './report.ts'

startAddon((peer) => workersHandlers(peer, () => buildWorkersReport({ secrets: configSecrets(), llm: true })))
