// Enable and disable state of each addon. The router and the `tg-bridge addon` CLI keep it in the SQLite store's
// addon_settings table (DbAddonSettings, DbStorePort). JsonAddonSettings is the file form, `<config dir>/addons.json`,
// kept for tests and for reading an old file.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DbStorePort } from '../ports.ts'

export interface AddonSettings {
  // True when the addon is enabled. An addon never seen before is disabled.
  isEnabled(name: string): boolean
  setEnabled(name: string, on: boolean): void
  // True when the owner has chosen the addon before (switched it on or off). Never true for an addon never touched.
  hasChoice(name: string): boolean
  // Named one-time flags (the built-ins offer). A flag is never cleared.
  getFlag(key: string): boolean
  setFlag(key: string): void
  // The hash of the manifest the owner last consented to (manifest.ts consentHash), or null when none was recorded.
  consentHash(name: string): string | null
  setConsentHash(name: string, hash: string): void
}

// `<config dir>/addons.json`, written atomically (temp file then rename), mode 0600. A missing or corrupt file reads as
// "nothing enabled"; the next write replaces it.
export class JsonAddonSettings implements AddonSettings {
  private readonly path: string

  constructor(path: string) {
    this.path = path
  }

  private read(): Record<string, boolean | string> {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
      const out: Record<string, boolean | string> = {}
      // Booleans are enable state and flags; strings are consent hashes, under a key with a leading '#'.
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'boolean') out[k] = v
        else if (typeof v === 'string' && k.startsWith(CONSENT_PREFIX)) out[k] = v
      }
      return out
    } catch {
      return {}
    }
  }

  isEnabled(name: string): boolean {
    return this.read()[name] === true
  }

  setEnabled(name: string, on: boolean): void {
    this.write(name, on)
  }

  hasChoice(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.read(), name)
  }

  getFlag(key: string): boolean {
    return this.read()[FLAG_PREFIX + key] === true
  }

  setFlag(key: string): void {
    this.write(FLAG_PREFIX + key, true)
  }

  consentHash(name: string): string | null {
    const v = this.read()[CONSENT_PREFIX + name]
    return typeof v === 'string' ? v : null
  }

  setConsentHash(name: string, hash: string): void {
    this.write(CONSENT_PREFIX + name, hash)
  }

  // Flags are stored under a key with a leading '@', which no addon name can have. Consent hashes use '#'.
  private write(key: string, value: boolean | string): void {
    const all = this.read()
    all[key] = value
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const tmp = this.path + '.tmp'
    writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.path)
  }
}

const FLAG_PREFIX = '@'
const CONSENT_PREFIX = '#'
// The addon-settings scope of the flags in the SQLite store (no addon has this name).
const FLAG_SCOPE = '_host'

// The same state over the SQLite store's addon_settings table (key `enabled`, value '1' or '0').
export class DbAddonSettings implements AddonSettings {
  private readonly db: Pick<DbStorePort, 'getAddonSetting' | 'setAddonSetting'>

  constructor(db: Pick<DbStorePort, 'getAddonSetting' | 'setAddonSetting'>) {
    this.db = db
  }

  isEnabled(name: string): boolean {
    return this.db.getAddonSetting(name, 'enabled') === '1'
  }

  setEnabled(name: string, on: boolean): void {
    this.db.setAddonSetting(name, 'enabled', on ? '1' : '0')
  }

  hasChoice(name: string): boolean {
    return this.db.getAddonSetting(name, 'enabled') !== null
  }

  getFlag(key: string): boolean {
    return this.db.getAddonSetting(FLAG_SCOPE, key) === '1'
  }

  setFlag(key: string): void {
    this.db.setAddonSetting(FLAG_SCOPE, key, '1')
  }

  // Scope = the addon's name, key `consent` (the hash of the manifest the owner allowed).
  consentHash(name: string): string | null {
    return this.db.getAddonSetting(name, CONSENT_KEY)
  }

  setConsentHash(name: string, hash: string): void {
    this.db.setAddonSetting(name, CONSENT_KEY, hash)
  }
}

const CONSENT_KEY = 'consent'

// `<config dir>/addons.json` for the default config dir (see tgConfigDir in src/config.ts).
export function addonsStatePath(configDir: string): string {
  return join(configDir, 'addons.json')
}
