// Router Telegram button taps: routes the callback to its handler and resolves permission prompts.
import type { ButtonPress } from '../../brain/chat-types.ts'
import { parseResumeCallback } from '../../brain/resume.ts'
import { parseAskCallback } from '../ask.ts'
import { onAskCallback } from './ask.ts'
import { onResumeCallback } from './resume.ts'
import { onAddonCallback, onAddonShow } from './addons.ts'
import { parseAddonCallback, parseAddonShow } from '../../addons-host/menu.ts'
import { onBuiltinsCallback, parseBuiltinsCallback } from './builtins.ts'
import { onRouteCallback } from './route.ts'
import { onBridgeCallback, parseBridgeCallback } from '../addon-bridge.ts'
import { textLimit, permissionExpired, expandedPermissionText, parseCallbackData, permissionRefusal, parseRouteCallback, isOwnerUser, verdictLabel, APPROVAL_EXPIRED_TEXT } from '../state.ts'
import type { Router } from '../core.ts'
import { decideInbound } from '../../brain/inbound.ts'
import { logSessionOut, syncPendingMarker } from '../approvals.ts'
import { sendTarget } from '../topics.ts'
import { parseVoiceCallback } from '../voice-echo.ts'
import { onVoiceCallback } from '../voice.ts'
import { onIdleKeepOpen, parseIdleKeepCallback } from '../close.ts'

export async function onCallback(router: Router, cb: ButtonPress): Promise<void> {
  if (router.locked) return router.chat.ackButton(cb.pressId, 'locked').catch(() => {})
  // Verdicts come from the owner only. The bot already ignores other users; this keeps the check explicit.
  if (!isOwnerUser(cb.from, router.ownerId)) return router.chat.ackButton(cb.pressId, 'Not allowed').catch(() => {})
  // Taps count only in the bound group or the DM (in DM mode); in group mode the DM says to use the group.
  const chat = cb.chat
  const decision = decideInbound({
    update: 'callback',
    chatKind: chat.kind,
    chatId: chat.id,
    fromId: cb.from,
    ownerUserId: router.ownerId,
    groupId: router.groupId,
  })
  if (decision.action === 'use-group') return router.chat.ackButton(cb.pressId, 'Use the group').catch(() => {})
  if (decision.action !== 'route') return router.chat.ackButton(cb.pressId).catch(() => {})
  const route = parseRouteCallback(cb.data)
  if (route) return onRouteCallback(router, cb, route)
  const resume = parseResumeCallback(cb.data)
  if (resume) return onResumeCallback(router, cb, resume)
  const ask = parseAskCallback(cb.data)
  if (ask) return onAskCallback(router, cb, ask)
  const addon = parseAddonCallback(cb.data)
  if (addon) return onAddonCallback(router, cb, addon)
  const shown = parseAddonShow(cb.data)
  if (shown) return onAddonShow(router, cb)
  const builtins = parseBuiltinsCallback(cb.data)
  if (builtins) return onBuiltinsCallback(router, cb, builtins)
  const bridged = parseBridgeCallback(cb.data)
  if (bridged) return onBridgeCallback(router, cb, bridged.token)
  const voice = parseVoiceCallback(cb.data)
  if (voice) return onVoiceCallback(router, cb, voice)
  // Before parseCallbackData: the idle warning's [Keep open] (close.ts).
  const idleKeep = parseIdleKeepCallback(cb.data)
  if (idleKeep !== null) return onIdleKeepOpen(router, cb, idleKeep)
  const parsed = parseCallbackData(cb.data)
  if (!parsed) return router.chat.ackButton(cb.pressId).catch(() => {})
  if (parsed.behavior === 'more') {
    const p = router.pending.get(parsed.requestId)
    // A prompt still in flight has no message to show the full text in: no buttons can have reached it yet.
    if (!p || p.messageId === null) return router.chat.ackButton(cb.pressId, 'Expired or already answered.').catch(() => {})
    // Answered first: the edit may wait in the queue.
    void router.chat.ackButton(cb.pressId).catch(() => {})
    await router.chat
      .editText(p.messageId, expandedPermissionText(p.details, router.secrets, p.redacted, textLimit(router.chat)), {
        requestId: parsed.requestId,
        withMore: false,
        redacted: p.redacted,
      }, 'urgent')
      .catch(() => {})
    return
  }
  const pending = router.pending.get(parsed.requestId)
  const refusal = pending ? permissionRefusal(parsed.behavior, pending.redacted) : null
  if (refusal) return router.chat.ackButton(cb.pressId, refusal).catch(() => {})
  await resolvePermission(router, parsed.requestId, parsed.behavior, cb.pressId)
}

// Answers the tap first, then edits the prompt (urgent: the edit is what the owner is waiting to see). The answer
// does not wait for the edit.
export async function resolvePermission(router: Router, requestId: string, behavior: 'allow' | 'deny', answerId?: string): Promise<void> {
  const answer = (t?: string) => {
    if (answerId) void router.chat.ackButton(answerId, t).catch(() => {})
  }
  const p = router.pending.get(requestId)
  if (!p) return answer('Expired or already answered.')
  router.pending.delete(requestId)
  syncPendingMarker(router, p.session.pid)
  const alive = router.registry.list().includes(p.session)
  const connected = router.agentFor(p.session.key).isConnected(p.session.key)
  // A prompt still in flight has no message to edit yet.
  if (permissionExpired(p, router.clock.now())) {
    answer('Expired.')
    if (p.messageId !== null) {
      await router.chat.editText(p.messageId, `${p.text}\n\n${APPROVAL_EXPIRED_TEXT}`, null, 'urgent').catch(() => {})
      logSessionOut(router, p.session, sendTarget(router, 'approval', p.session), 'expired', APPROVAL_EXPIRED_TEXT, p.messageId)
    }
    return
  }
  if (!alive || !connected) {
    answer('That session is no longer running.')
    if (p.messageId !== null) await router.chat.editText(p.messageId, `${p.text}\n\n⌛ session is gone`, null, 'urgent').catch(() => {})
    return
  }
  router.agentFor(p.session.key).answerPermission(p.session.key, requestId, behavior)
  router.audit.event({ event: 'permission_decision', session: p.session.name, behavior })
  const label = verdictLabel(behavior)
  answer(label)
  if (p.messageId !== null) await router.chat.editText(p.messageId, `${p.text}\n\n${label}`, null, 'urgent').catch(() => {})
}
