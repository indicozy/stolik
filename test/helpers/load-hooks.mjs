// Module hook for the lazy-load test: every module the process resolves is appended to LOAD_LOG (one URL per line).
import { appendFileSync } from 'node:fs'

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context)
  if (process.env.LOAD_LOG) appendFileSync(process.env.LOAD_LOG, `${result.url}\n`)
  return result
}
