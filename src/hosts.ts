import { existsSync, readFileSync } from 'node:fs'
import { hostname as osHostname } from 'node:os'
import { join } from 'node:path'
import { stateDir } from './paths.js'

/**
 * Personal hostname aliases for the session device label.
 *
 * "MacBookPro.home" means nothing in a phone screen full of Active Sessions
 * rows. This file - hand-edited, per-user (stateDir(), never DATA_DIR), never
 * committed because it isn't under any workspace this tool controls - lets an
 * operator say what a raw hostname means to them:
 *
 *   { "MacBookPro.home": "qwadratic-laptop" }
 *
 * No CLI writes it. It's one line typed once, not a feature surface.
 *
 * Missing or malformed reads as "no aliases" and returns the raw hostname
 * unchanged - a typo in this file must not break every command, only leave the
 * label less friendly.
 */
export function hostsPath(): string {
  return join(stateDir(), 'hosts.json')
}

export function friendlyHostname(raw: string = osHostname(), path: string = hostsPath()): string {
  if (!existsSync(path)) return raw

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (parsed && typeof parsed === 'object') {
      const alias = (parsed as Record<string, unknown>)[raw]
      if (typeof alias === 'string' && alias.trim()) return alias.trim()
    }
  } catch {
    // Malformed file: fall through to the raw hostname rather than throw.
  }

  return raw
}
