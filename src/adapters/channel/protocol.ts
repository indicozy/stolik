import type { NotifyLevel } from '../../brain/notify-level.ts'

export type Kind = 'response' | 'requested' | 'proactive'
// channel server -> router (persistent connection)
// spawnToken: the STOLIK_SPAWN_TOKEN the router put in this session's tmux environment (router-started sessions only).
// agent / agentPid: an opencode session registers with agent 'opencode' and the pid of its opencode process (no claudePid).
export type ChRegister = { t: 'register'; claudePid: number | null; cwd: string; spawnToken?: string; agent?: 'opencode'; agentPid?: number }
// level: how loud the message is (src/brain/notify-level.ts); absent means 'default'. `kind` is separate.
export type ChReply = { t: 'reply'; reqId: string; text: string; files?: string[]; kind: Kind; level?: NotifyLevel }
// close_session: the session ends on request (the router answers close_result, then closes it a moment later).
export type ChClose = { t: 'close'; reqId: string }
export type ChPermReq = { t: 'permission_request'; request_id: string; tool_name: string; description: string; input_preview: string }
// router -> channel server
export type RtRegistered = { t: 'registered'; name: string }
export type RtReplyResult = { t: 'reply_result'; reqId: string; ok: boolean; delivered: boolean; error?: string }
export type RtCloseResult = { t: 'close_result'; reqId: string; ok: boolean; error?: string }
export type RtInbound = { t: 'inbound'; content: string; meta: Record<string, string> }
export type RtPermission = { t: 'permission'; request_id: string; behavior: 'allow' | 'deny' }
// one-shot clients -> router (router answers { t: 'ok', delivered?: boolean } then closes)
// PermResolved (sent by the mod's tool.call hook, see mod/hooks/register.ts): a permission the mod saw asked was resolved.
// verdict 'allowed' when the tool ran, 'denied' when the call was refused. The key fields are those of PostToolUse.
export type PermResolvedPayload = { tool_name?: string; input_hash?: string; input_head?: string; verdict: 'allowed' | 'denied' }
export type HookMsg = { t: 'hook'; event: 'UserPromptSubmit' | 'Stop' | 'Notification' | 'PostToolUse' | 'PermResolved'; claudePid: number | null; cwd: string; payload: any }
export type NotifyMsg = { t: 'notify'; claudePid: number | null; cwd: string; text: string; files?: string[]; kind: Kind; plain?: boolean; level?: NotifyLevel }
// hook -> router: a PermissionRequest for AskUserQuestion or ExitPlanMode. The router answers with ask_result
// (decision omitted when it gives none, so the terminal dialog shows) and closes the connection.
// race: the mod races the terminal dialog against this ask (`--race`). The router then forwards it on the askDelay timer.
// raceId: the id the mod gives the raced dialog (`--race-id`), so a later ask_resolved can find this ask.
export type AskMsg = { t: 'ask'; claudePid: number | null; cwd: string; tool_name: string; tool_input: unknown; race?: boolean; raceId?: string }
// hook -> router, fire-and-forget (the AskResolved event): the terminal answered a raced dialog first, so its Telegram
// message loses its buttons. verdict: the answer labels joined by ', ', 'denied', or 'dismissed'.
export type AskResolvedMsg = { t: 'ask_resolved'; raceId: string; verdict: string }
export type AskDecision = { behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string }
export type AskResult = { t: 'ask_result'; decision?: AskDecision }
