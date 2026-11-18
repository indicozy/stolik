// Folder-topic mutes in the router (spec 24 §4): the lookup per thread, the save, and the send wrapper that applies the
// mute. Every router send goes through withTopicMute (Router constructor), so no send path can skip it.
import type { ChatPort, ThreadId } from '../brain/chat-types.ts'
import { isSilentSend, type NotifyLevel } from '../brain/notify-level.ts'
import { activeMute, serializeMutes } from '../brain/mute.ts'
import type { Router } from './core.ts'
import { topicForThread } from './topics.ts'

// The mute of a folder, or null. An expired mute is dropped here (lazy cleaning) and the map is saved again.
export function muteOf(router: Router, cwd: string): { until: number | null } | null {
  const mute = activeMute(router.mutes, cwd, router.clock.now())
  if (mute === null && Object.hasOwn(router.mutes, cwd)) {
    delete router.mutes[cwd]
    saveMutes(router)
  }
  return mute
}

// Whether a thread is a folder topic whose folder is muted. General and DM (no thread) are never muted.
export function isThreadMuted(router: Router, threadId: ThreadId | undefined): boolean {
  if (threadId === undefined) return false
  const topic = topicForThread(router, threadId)
  if (!topic || topic.cwd === null) return false
  return muteOf(router, topic.cwd) !== null
}

// Sets the mute of a folder: `until` epoch ms, null for "until /silent off", undefined to clear it.
export function setMute(router: Router, cwd: string, until: number | null | undefined): void {
  if (until === undefined) delete router.mutes[cwd]
  else router.mutes[cwd] = until
  saveMutes(router)
}

export function saveMutes(router: Router): void {
  router.store.writeMutes(serializeMutes(router.mutes))
}

type Sendable = { silent?: boolean; level?: NotifyLevel; thread?: ThreadId }

// The options of one send after the mute: `level` is removed, and `silent: true` is set when the send must not ping.
// Absent options stay absent unless the send has to be silent.
function outbound<T extends Sendable>(opts: T | undefined, isMuted: (threadId: ThreadId | undefined) => boolean): T | undefined {
  const silent = isSilentSend({ silent: opts?.silent, level: opts?.level }, isMuted(opts?.thread))
  if (opts === undefined) return silent ? ({ silent: true } as T) : undefined
  const { level: _level, ...rest } = opts
  return (silent ? { ...rest, silent: true } : rest) as T
}

// The choke point (spec 24 §4): wraps the router's Telegram port so that a send to a muted folder topic goes out silent,
// unless its level pings anyway (critical). Every other member passes through unchanged. A send with no level is default.
export function withTopicMute(inner: ChatPort, isMuted: (threadId: ThreadId | undefined) => boolean): ChatPort {
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'sendText') {
        return (text: string, opts?: Parameters<ChatPort['sendText']>[1]) => target.sendText(text, outbound(opts, isMuted))
      }
      if (prop === 'sendChunks') {
        return (texts: readonly string[], opts?: Parameters<ChatPort['sendChunks']>[1]) =>
          target.sendChunks(texts, outbound(opts, isMuted))
      }
      if (prop === 'sendFile') {
        return (path: string, asPhoto: boolean, t?: Parameters<ChatPort['sendFile']>[2]) =>
          target.sendFile(path, asPhoto, outbound(t, isMuted) as Parameters<ChatPort['sendFile']>[2])
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
