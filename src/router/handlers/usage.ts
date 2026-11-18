// `/usage` in General (plan 2.8): today and this week, per mode, and the weekly quota pace.
import type { MessageId } from '../../brain/chat-types.ts'
import { errMsg } from '../log.ts'
import { say } from '../send.ts'
import type { Router } from '../core.ts'

export async function sendUsage(router: Router, replyTo: MessageId): Promise<void> {
  if (!router.usage) return say(router, 'Usage is not set up.', replyTo)
  const text = await router.usage.report().catch((e: unknown) => `Usage could not be read: ${errMsg(e)}`)
  return say(router, text, replyTo)
}
