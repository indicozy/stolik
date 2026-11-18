// Moved to adapters/platform/linux-proc.ts (plan S10). Re-exported here so channel.ts, hook.ts and notify.ts keep
// their imports until the channel and hooks adapter move (plan S6).
export { findClaudePid, isInteractiveClaude, readCmdline } from './adapters/platform/process.ts'
