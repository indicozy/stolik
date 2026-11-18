// Router side of /addons (plan 2.10): lists the installed addons with on and off buttons. It never installs anything.
import type { ButtonPress } from '../../brain/chat-types.ts'
import type { MessageId } from '../../brain/chat-types.ts'
import { addonsMenuRows, addonsMenuText, type AddonCallback } from '../../addons-host/menu.ts'
import { errMsg } from '../log.ts'
import { say } from '../send.ts'
import type { Router } from '../core.ts'

export async function sendAddonMenu(router: Router, replyTo: MessageId | null): Promise<void> {
  if (!router.addons) return say(router, 'Addons are not set up.', replyTo ?? undefined)
  const list = router.addons.list()
  await router.chat
    .sendText(addonsMenuText(list), { ...(replyTo !== null ? { replyTo } : {}), rows: addonsMenuRows(list) })
    .catch((e) => router.logger.log(`addon menu failed: ${errMsg(e)}`))
}

export async function onAddonCallback(router: Router, cb: ButtonPress, c: AddonCallback): Promise<void> {
  const answer = (t: string) => router.chat.ackButton(cb.pressId, t).catch(() => {})
  if (!router.addons) return answer('Addons are not set up.')
  const refusal = await router.addons.setEnabled(c.name, c.on)
  router.audit.event({ event: 'addon_toggle', addon: c.name, on: c.on, refused: refusal !== null })
  if (cb.message !== null) {
    const list = router.addons.list()
    await router.chat.editRows(cb.message, addonsMenuText(list), addonsMenuRows(list)).catch(() => {})
  }
  return answer(refusal ?? (c.on ? 'Turned on.' : 'Turned off.'))
}

// The "Open <addon> in /addons" button of a notice: the /addons menu, as a new message replying to the notice.
export async function onAddonShow(router: Router, cb: ButtonPress): Promise<void> {
  const answer = (t: string) => router.chat.ackButton(cb.pressId, t).catch(() => {})
  if (!router.addons) return answer('Addons are not set up.')
  await sendAddonMenu(router, cb.message)
  return answer('Addons.')
}
