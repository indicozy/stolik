// Router /resume: the list of transcripts as buttons, and the tap that resumes one.
import type { ButtonPress } from '../../brain/chat-types.ts'
import type { MessageId } from '../../brain/chat-types.ts'
import { channelSessionFor, listResumable, RESUME_PENDING_CAP, RESUME_PENDING_TTL_MS, resumeCallbackData, resumeLabel, type ResumeItem } from '../../brain/resume.ts'
import { errMsg } from '../log.ts'
import { logOutgoing, say } from '../send.ts'
import { newRouteId } from '../shared.ts'
import { resumeEnded } from '../spawn.ts'
import { sendTarget } from '../topics.ts'
import { openTopicOfDir } from '../../brain/topics.ts'
import type { Router } from '../core.ts'

// The sessions whose channel is connected now. A registry entry whose channel has gone (its session ended) is not live,
// so its transcript is listed as ended and /resume can start it again.
function channelSessions(router: Router) {
  return router.registry.list().filter((s) => s.hasChannel && router.agent.isConnected(s.key))
}

// /resume: the ended and live agent sessions as buttons, newest first. Reads at most TRANSCRIPT_SCAN_MAX files.
export async function sendResumeList(router: Router, replyTo: MessageId): Promise<void> {
  const now = router.clock.now()
  const live = router.agent.liveSessionIds()
  const sessions = channelSessions(router)
  const entries = await router.agent.listTranscripts()
  const channelIds = new Set(entries.map((e) => e.id).filter((id) => channelSessionFor(id, sessions, live) !== undefined))
  const items = listResumable(entries, new Set(live.keys()), channelIds, now)
  if (items.length === 0) return say(router, 'No agent sessions to resume.', replyTo)
  const id = newRouteId()
  putResume(router, id, items, now)
  const rows = items.map((it, i) => [{ text: resumeLabel(it, now), data: resumeCallbackData(id, i) }])
  // The picker is a General message (design §4.2); resuming it reopens the topic, not the picker.
  const to = sendTarget(router, 'resume-picker')
  const text = 'Pick a session. Ended ones resume here in tmux.'
  await router.chat
    .sendText(text, { rows, replyTo, ...to })
    .then((msgId) => logOutgoing(router, { kind: 'resume', text, topic_id: to.thread ?? null, tg_message_id: msgId }))
    .catch((e) => router.logger.log(`send failed: ${errMsg(e)}`))
}

export function putResume(router: Router, id: string, items: ResumeItem[], now: number): void {
  if (router.resumes.size >= RESUME_PENDING_CAP) {
    const oldest = router.resumes.keys().next().value
    if (oldest !== undefined) router.resumes.delete(oldest)
  }
  router.resumes.set(id, { items, createdAt: now })
}

export async function onResumeCallback(router: Router, cb: ButtonPress, r: { pendingId: string; idx: number }): Promise<void> {
  const answer = (t?: string) => router.chat.ackButton(cb.pressId, t).catch(() => {})
  const p = router.resumes.get(r.pendingId)
  const item = p?.items[r.idx]
  if (!p || !item || router.clock.now() - p.createdAt > RESUME_PENDING_TTL_MS) {
    router.resumes.delete(r.pendingId)
    return answer('expired, send /resume again')
  }
  await answer()
  // Checked again on tap: the session may have started or stopped since the list was sent.
  const live = router.agent.liveSessionIds()
  const channel = channelSessionFor(item.id, channelSessions(router), live)
  if (channel) {
    // In group mode the session's folder has a topic: point there. Without one (DM mode), point to /to.
    const topic = openTopicOfDir(router.topics, channel.cwd)
    const where = topic
      ? `in its topic "${topic.name}". Write there.`
      : `as ${channel.name}. Send to it with /to ${channel.name} <text>, or see /list.`
    return say(router, `${item.title} is already live ${where}`)
  }
  if (live.has(item.id)) {
    return say(router, 'This session is running without Telegram. Use Remote Control: run /rc in that terminal, or open it in the Claude app.')
  }
  return resumeEnded(router, item)
}
