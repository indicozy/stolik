// The /addons menu (plan 2.10): the list of installed addons with one on/off button each. Pure text and button data;
// the router sends and edits the message. Nothing here installs anything.
import type { AddonInfo } from '../ports.ts'

export type MenuButton = { text: string; data: string }

export const ADDON_CALLBACK_RE = /^ad:([a-z][a-z0-9-]{1,39}):(on|off)$/

export type AddonCallback = { name: string; on: boolean }

export function parseAddonCallback(data: string): AddonCallback | null {
  const m = ADDON_CALLBACK_RE.exec(data)
  return m ? { name: m[1], on: m[2] === 'on' } : null
}

// "Open <addon> in /addons" on a notice about an addon that is off: the tap sends the /addons menu.
export const ADDON_SHOW_RE = /^ad:([a-z][a-z0-9-]{1,39}):show$/

export function parseAddonShow(data: string): string | null {
  const m = ADDON_SHOW_RE.exec(data)
  return m ? m[1] : null
}

export function addonsMenuText(list: AddonInfo[]): string {
  if (list.length === 0) {
    return 'No addons installed. Install one on the PC: tg-bridge addon add <git url | npm name | folder>'
  }
  const lines = list.map((a) => `${a.name} ${a.version}: ${a.enabled ? 'on' : 'off'}, ${a.status} (${a.provides.join(', ')})`)
  return ['Addons (install on the PC with tg-bridge addon add; the buttons turn them on or off):', ...lines].join('\n')
}

// One button row per addon: "Turn off x" when it is on, "Turn on x" when it is off. A shadowed folder gets no button
// (its name is the built-in's, and the button would switch the built-in).
export function addonsMenuRows(list: AddonInfo[]): MenuButton[][] {
  return list.filter((a) => !a.shadowed).map((a) => [
    { text: `${a.enabled ? 'Turn off' : 'Turn on'} ${a.name}`, data: `ad:${a.name}:${a.enabled ? 'off' : 'on'}` },
  ])
}
