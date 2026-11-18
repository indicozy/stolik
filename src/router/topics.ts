// Router wiring for group mode (plan 2.2, 2.3, ticket 22): the Telegram calls for topic changes, and the send targets.
// One topic per folder: every session in a folder shares its topic. The rules are pure (src/brain/topics.ts,
// src/brain/destinations.ts); this file applies them to the router's state. In DM mode (no group bound) every function
// here does nothing and every send keeps today's target.
import { basename } from 'node:path'
import type { Inbound } from '../brain/chat-types.ts'
import type { MessageId, SendTarget, ThreadId } from '../brain/chat-types.ts'
import {
  connectPlan, deleteRetryDelay, dueDeletes, DELETE_MAX_FAILURES, folderTopicName, isThreadGone, isTopicNotModified, newTopic,
  openTopicOfDir, serializeTopics, step, type TopicRec,
} from '../brain/topics.ts'
import { destinationFor, type Destination, type OutKind } from '../brain/destinations.ts'
import { errMsg } from './log.ts'
import { say } from './send.ts'
import type { OutboundSource } from './outbound.ts'
import type { Kind } from '../adapters/channel/protocol.ts'
import type { Session } from './state.ts'
import type { Router } from './core.ts'
import { MINUTE } from '../brain/common.ts'
import { resolveMsgRef } from '../brain/msgmap.ts'

// After a router start, a session that has not reconnected within this grace is taken as ended: its open topic is closed.
export const TOPIC_RECONNECT_GRACE_MS = 2 * MINUTE

// Group mode: a group is bound and the bot can still run it (see Router.groupAccess). Otherwise output goes to the DM.
export function groupMode(router: Router): boolean {
  return router.groupId !== null && router.groupAccess
}

// Creation order of two topics: a Telegram thread id is the id of the topic's first message, so the chat's message order
// gives it. Thread ids are ordered only through this, never with < or -.
function threadOrder(router: Router, a: ThreadId, b: ThreadId): number {
  return router.chat.compareMessages(a as string as MessageId, b as string as MessageId)
}

function toTarget(d: Destination): SendTarget {
  const t: SendTarget = {}
  if (d.threadId !== undefined) t.thread = d.threadId
  if (d.chat === 'dm') t.dm = true
  return t
}

// The send target of an outbound message of `kind` about session `s` (session-scoped kinds use its topic).
export function sendTarget(router: Router, kind: OutKind, s?: Session | null): SendTarget {
  const topicThread = s ? (openTopicOfDir(router.topics, s.cwd)?.threadId ?? null) : null
  return toTarget(destinationFor(kind, { groupMode: groupMode(router), topicThread }))
}

// The send target of a reply to inbound message `m`: the thread the message came from (General for DM and General).
export function inboundTarget(router: Router, m: Inbound): SendTarget {
  return threadTarget(router, m.chat.kind === 'home' ? m.chat.thread : null)
}

// The send target for a reply in forum topic `thread` (null: General, or the owner's DM).
export function threadTarget(router: Router, thread: ThreadId | null): SendTarget {
  return toTarget(destinationFor('reply-in-place', { groupMode: groupMode(router), topicThread: thread }))
}

// Tells the user, once, that a session ended while a message of theirs was still unanswered: a reply to that message in
// the message's own topic. Clears the pending mark, so a later check does not say it again.
export function announceTerminated(router: Router, s: Session): void {
  const pending = s.pendingTg
  if (!pending) return
  s.pendingTg = null
  void say(router, `⚠️ [${s.name}] was terminated before it finished answering this message.`, pending.messageId, threadTarget(router, pending.thread))
}

// Session output kinds: a Stop-hook text ends the turn; a proactive reply is a proactive ping; the rest are answers.
export function outKindFor(kind: Kind, source: OutboundSource): OutKind {
  if (source === 'hook') return 'end-of-turn'
  return kind === 'proactive' ? 'proactive' : 'answer'
}

export function topicForThread(router: Router, threadId: ThreadId): TopicRec | undefined {
  return router.topics.find((r) => r.threadId === threadId && r.state !== 'deleted')
}

function replaceTopic(router: Router, rec: TopicRec): void {
  const i = router.topics.findIndex((r) => r.threadId === rec.threadId)
  if (i >= 0) router.topics[i] = rec
}

export function persistTopics(router: Router): void {
  try {
    router.store.writeTopics(serializeTopics(router.topics))
  } catch (e) {
    router.logger.log(`topics save failed: ${errMsg(e)}`)
  }
}

// Topic work of one folder runs one job at a time: a second session that registers in the folder while the first is
// making its topic waits for it, then plans again and finds the topic open (no second topic). A job that fails does not
// hold the next one back. The queue is kept per folder (router.topicsCreating).
function inFolderLane<T>(router: Router, cwd: string, job: () => Promise<T>): Promise<T> {
  const prev = router.topicsCreating.get(cwd) ?? Promise.resolve()
  const run = prev.then(job)
  const tail = run.then(() => undefined, () => undefined)
  router.topicsCreating.set(cwd, tail)
  void tail.then(() => {
    if (router.topicsCreating.get(cwd) === tail) router.topicsCreating.delete(cwd)
  })
  return run
}

// A session registered over its channel: its folder gets a topic, unless the folder's topic is open (then nothing). A
// closed topic of the folder is reopened.
export async function onSessionRegistered(router: Router, s: Session): Promise<void> {
  if (!groupMode(router)) return
  await inFolderLane(router, s.cwd, async () => {
    const plan = connectPlan(router.topics, { cwd: s.cwd })
    if (plan.effect === 'none') return
    await openTopicFor(router, s, plan)
  })
}

async function openTopicFor(router: Router, s: Session, plan: { effect: 'reopen'; threadId: ThreadId } | { effect: 'create'; name: string }): Promise<void> {
  if (plan.effect === 'reopen') {
    const old = router.topics.find((r) => r.threadId === plan.threadId)
    if (old) {
      let reopened = true
      try {
        await router.chat.reopenThread(old.threadId)
      } catch (e) {
        // Already open in Telegram: the record catches up, nothing failed.
        if (!isTopicNotModified(e)) {
          reopened = false
          router.logger.log(`topic reopen failed, making a new one: ${errMsg(e)}`)
          // Deleted by hand: the record is gone for good, so the folder gets a fresh topic.
          if (isThreadGone(e)) replaceTopic(router, { ...old, state: 'deleted', sessionKey: null, deleteAt: null })
        }
      }
      if (reopened) {
        replaceTopic(router, step(old, { type: 'reopen', now: router.clock.now() }).rec)
        persistTopics(router)
        router.audit.event({ event: 'topic', action: 'reopen', session: s.name })
        return
      }
    }
  }
  try {
    const name = folderTopicName(s.cwd, router.topics)
    const threadId = await router.chat.createThread(name)
    const rec = newTopic(threadId, name, s.project, s.cwd)
    if (!router.registry.list().some((x) => x.cwd === s.cwd)) {
      // Every session in the folder ended while the topic was being made: the new topic is closed at once, not left open.
      const { rec: closed } = step(rec, { type: 'end', now: router.clock.now() })
      router.topics.push(closed)
      persistTopics(router)
      await router.chat.closeThread(threadId).catch((e: unknown) => {
        if (!isTopicNotModified(e)) router.logger.log(`topic close failed for ${s.name}: ${errMsg(e)}`)
      })
      router.audit.event({ event: 'topic', action: 'create', session: s.name })
      return
    }
    router.topics.push(rec)
    persistTopics(router)
    router.audit.event({ event: 'topic', action: 'create', session: s.name })
  } catch (e) {
    router.logger.log(`topic for ${s.name} not created: ${errMsg(e)}`)
  }
}

// A session ended (its process is gone). Its folder's topic closes only when no other live session is in the folder. A
// folder topic is never deleted: the next session there reopens it.
export async function onSessionEnded(router: Router, s: Session): Promise<void> {
  await inFolderLane(router, s.cwd, async () => {
    if (router.registry.list().some((x) => x.key !== s.key && x.cwd === s.cwd)) return
    const rec = openTopicOfDir(router.topics, s.cwd)
    if (rec) await endTopic(router, rec, s.name)
  })
}

// The end of a topic: the record closes, then Telegram closes the thread.
async function endTopic(router: Router, rec: TopicRec, label: string): Promise<void> {
  const { rec: next, effect } = step(rec, { type: 'end', now: router.clock.now() })
  replaceTopic(router, next)
  persistTopics(router)
  if (effect !== 'close') return
  try {
    await router.chat.closeThread(rec.threadId)
    router.audit.event({ event: 'topic', action: 'close', session: label })
  } catch (e) {
    if (isTopicNotModified(e)) return
    router.logger.log(`topic close failed for ${label}: ${errMsg(e)}`)
  }
}

// Run once after the reconnect grace (see Router.start), and on each sweep after it. An open folder topic whose folder has
// no live session is closed (a router restart can leave it open).
export async function closeOrphanTopics(router: Router): Promise<void> {
  // From here on the periodic sweep checks for orphans too (see sweep): the reconnect grace is over.
  router.orphanChecksOn = true
  const live = router.registry.list()
  for (const rec of [...router.topics]) {
    if (rec.state !== 'open' || rec.cwd === null || live.some((s) => s.cwd === rec.cwd)) continue
    await endTopic(router, rec, rec.name)
  }
  await tidyTopicNames(router)
}

// A folder topic named while a legacy topic still held its basename got parent/basename. Once the legacy records are gone,
// each folder topic is renamed to what the naming rule gives it now, but only when that is the plain basename (or shorter).
// Records go in threadId order, and each rename updates its record before the next one is worked out, so two topics never
// swap names. Each rename runs in the folder's lane, so a create in flight for that folder finishes first.
export async function tidyTopicNames(router: Router): Promise<void> {
  let changed = false
  const targets = router.topics
    .filter((r) => r.state !== 'deleted' && r.cwd !== null)
    .map((r) => ({ threadId: r.threadId, cwd: r.cwd as string }))
    .sort((a, b) => threadOrder(router, a.threadId, b.threadId))
  for (const { threadId, cwd } of targets) {
    await inFolderLane(router, cwd, async () => {
      const cur = router.topics.find((r) => r.threadId === threadId && r.state !== 'deleted')
      if (!cur || cur.cwd === null) return
      const want = folderTopicName(cur.cwd, router.topics.filter((r) => r.threadId !== threadId))
      const base = basename(cur.cwd) || cur.cwd
      if (want === cur.name || want.length > base.length) return
      try {
        await router.chat.renameThread(threadId, want)
      } catch (e) {
        if (!isTopicNotModified(e)) {
          router.logger.log(`topic ${cur.name} not renamed to ${want}: ${errMsg(e)}`)
          return
        }
      }
      replaceTopic(router, { ...cur, name: want })
      changed = true
    })
  }
  if (changed) persistTopics(router)
}

// Rollout of one topic per folder: the per-session topics of earlier runs are deleted in Telegram once, at start, and their
// records are dropped. A delete that fails (other than "thread gone") is logged and the record is dropped anyway, so it is
// not retried forever. Group mode only. The Logs topic and the mode threads are not in router.topics (they are stored
// elsewhere), so they are not touched.
export async function deleteLegacyTopics(router: Router): Promise<void> {
  if (!groupMode(router)) return
  const legacy = router.topics.filter((r) => r.cwd === null)
  if (legacy.length === 0) return
  for (const rec of legacy) {
    if (rec.state !== 'deleted') {
      try {
        await router.chat.deleteThread(rec.threadId)
      } catch (e) {
        if (!isThreadGone(e)) router.logger.log(`old topic ${rec.name} not deleted: ${errMsg(e)}`)
      }
    }
    router.topics = router.topics.filter((r) => r !== rec)
  }
  persistTopics(router)
  router.logger.log(`removed ${legacy.length} topic record(s) from before one topic per folder`)
  await tidyTopicNames(router)
}

// The session a plain message in a folder topic goes to (ticket 22), among the live sessions of the folder `live`:
// (a) a reply to a session message that is live here; (b) else the session that wrote the last message in the topic
// before this one (by Telegram message id, so a message the session posts while the user types does not count); (c) else
// the most recently active live session. Null when the folder has no live session.
export function topicSessionFor(router: Router, rec: TopicRec, m: Inbound, live: Session[]): Session | null {
  if (live.length === 0) return null
  if (m.replyToId !== null) {
    const ref = resolveMsgRef(router.msgMap.get(m.replyToId), live)
    if (ref?.status === 'live') return ref.session
  }
  const ref = resolveMsgRef(router.msgMap.lastInThread(rec.threadId, m.messageId, (a, b) => router.chat.compareMessages(a, b)), live)
  if (ref?.status === 'live') return ref.session
  return live.reduce((a, b) => (b.lastActive > a.lastActive ? b : a))
}

// Runs a send into a session's topic. When Telegram says the topic is gone (deleted by hand), the record is marked
// deleted, a new topic is made for the session (General when that fails too), and the send is tried once more there.
// Returns the value and the target the send landed on.
export async function inTopic<T>(
  router: Router,
  s: Session,
  to: SendTarget,
  fn: (t: SendTarget) => Promise<T>,
): Promise<{ value: T; to: SendTarget }> {
  try {
    return { value: await fn(to), to }
  } catch (e) {
    if (to.thread === undefined || !isThreadGone(e)) throw e
    const threadId = await recoverTopic(router, s, to.thread)
    const next: SendTarget = { ...to }
    if (threadId === null) delete next.thread
    else next.thread = threadId
    return { value: await fn(next), to: next }
  }
}

// Marks the stale topic deleted and makes a new one for the session's folder. Returns the new thread id, or null when no
// topic can be made (the message then goes to General). It runs in the folder's lane, so a folder gets one new topic even
// when several sends find the same topic gone.
export function recoverTopic(router: Router, s: Session, staleThread: ThreadId): Promise<ThreadId | null> {
  return inFolderLane(router, s.cwd, async () => {
    const stale = router.topics.find((r) => r.threadId === staleThread && r.state !== 'deleted')
    if (stale) replaceTopic(router, { ...stale, state: 'deleted', sessionKey: null, endedAt: stale.endedAt ?? router.clock.now(), deleteAt: null })
    persistTopics(router)
    router.logger.log(`topic of ${s.name} is gone in Telegram; making a new one`)
    if (!router.registry.list().some((x) => x.cwd === s.cwd)) return null
    // Another send or a register made the folder's new topic meanwhile: that one is used.
    const open = openTopicOfDir(router.topics, s.cwd)
    if (open) return open.threadId
    try {
      const name = folderTopicName(s.cwd, router.topics)
      const threadId = await router.chat.createThread(name)
      router.topics.push(newTopic(threadId, name, s.project, s.cwd))
      persistTopics(router)
      router.audit.event({ event: 'topic', action: 'recreate', session: s.name })
      return threadId
    } catch (e) {
      router.logger.log(`topic for ${s.name} could not be recreated, using General: ${errMsg(e)}`)
      return null
    }
  })
}

// Deletes the legacy closed topics whose 7-day deadline has passed (folder topics have no deadline). A record is marked
// deleted only when Telegram deletes the topic, or says it is already gone. Any other failure leaves it closed, and the
// next sweep tries again. A sweep that is still running is not started again (a slow delete would otherwise be sent twice).
export async function sweepTopics(router: Router, now: number): Promise<void> {
  if (router.topicSweepRunning) return
  // A topic whose delete failed waits for its backoff; one given up is not tried again (the owner was told).
  const due = dueDeletes(router.topics, now).filter((r) => {
    const f = router.deleteFailures.get(r.threadId)
    return !f || (!f.gaveUp && now >= f.nextAt)
  })
  if (due.length === 0) return
  router.topicSweepRunning = true
  try {
    for (const rec of due) {
      try {
        await router.chat.deleteThread(rec.threadId)
      } catch (e) {
        if (!isThreadGone(e)) {
          const f = router.deleteFailures.get(rec.threadId) ?? { failures: 0, nextAt: 0, gaveUp: false }
          f.failures++
          if (f.failures >= DELETE_MAX_FAILURES) {
            f.gaveUp = true
            router.logger.log(`topic ${rec.name} not deleted after ${f.failures} tries: ${errMsg(e)}`)
            await say(router, `Could not delete the closed topic "${rec.name}" after ${f.failures} tries. Delete it by hand in the group.`)
          } else {
            f.nextAt = now + deleteRetryDelay(f.failures)
            router.logger.log(`topic delete failed, retry in ${Math.round(deleteRetryDelay(f.failures) / 60_000)} min: ${errMsg(e)}`)
          }
          router.deleteFailures.set(rec.threadId, f)
          continue
        }
      }
      router.deleteFailures.delete(rec.threadId)
      const cur = router.topics.find((r) => r.threadId === rec.threadId)
      if (!cur || cur.state !== 'closed') continue
      replaceTopic(router, step(cur, { type: 'sweep', now }).rec)
      router.audit.event({ event: 'topic', action: 'delete', project: rec.project })
    }
  } finally {
    router.topicSweepRunning = false
    persistTopics(router)
  }
}
