import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SESSION_META_PATH } from '../paths.js'
import { setting } from '../env.js'

/**
 * How long a workspace's Telegram session is allowed to live.
 *
 * A session string is a full account credential, and a workspace that was used
 * once and abandoned leaves a live one behind forever. Expiring it turns "I
 * must remember to terminate that" into something that happens on its own.
 *
 * No client, no network and no prompt in this file: the whole policy is pure
 * functions over one JSON file, so every branch is testable without logging in.
 */

/** Days a session lives when nobody says otherwise. */
export const DEFAULT_SESSION_TTL_DAYS = 3

const MS_PER_DAY = 86_400_000

export interface SessionMeta {
  /** ISO 8601. When THIS workspace's session was established. */
  createdAt: string
  ttlDays: number
}

/** Missing, unreadable or malformed reads as null. Never throws. */
export function readSessionMeta(path: string = SESSION_META_PATH): SessionMeta | null {
  if (!existsSync(path)) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    // A truncated file must not brick a workspace. Absent meta is backfilled by
    // the caller, which restarts the clock rather than expiring anything.
    return null
  }

  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Partial<SessionMeta>

  if (typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))) return null
  if (typeof record.ttlDays !== 'number' || !Number.isFinite(record.ttlDays)) return null

  return { createdAt: record.createdAt, ttlDays: record.ttlDays }
}

/** Write the meta, 0600. It sits beside an auth key; treat it the same way. */
export function writeSessionMeta(meta: SessionMeta, path: string = SESSION_META_PATH): void {
  // DATA_DIR already exists whenever a session is open; this is defence in
  // depth for a caller that got here another way.
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
  // writeFileSync's mode applies only on create, so an existing file keeps its
  // old mode. Set it every time.
  chmodSync(path, 0o600)
}

/**
 * The TTL that actually applies.
 *
 * TG_SESSION_TTL_DAYS wins when set, including `0` or a negative value, which
 * switch auto-expiry OFF - the same explicit escape hatch TG_NO_PHONE_HISTORY
 * gives the phone list. Otherwise the value recorded at login, otherwise 3.
 */
export function effectiveTtlDays(
  meta: SessionMeta | null,
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = setting('SESSION_TTL_DAYS', env)
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw.trim(), 10)
    if (Number.isFinite(parsed)) return parsed
  }

  if (meta && Number.isFinite(meta.ttlDays)) return meta.ttlDays
  return DEFAULT_SESSION_TTL_DAYS
}

/**
 * What to write when a session is REUSED, or null to write nothing.
 *
 * Pure, so the two branches that matter - backfilling a pre-feature workspace
 * and re-lengthening a live one - are testable without a client.
 */
export function metaForReuse(
  meta: SessionMeta | null,
  ttlDays: number | undefined,
  now: Date
): SessionMeta | null {
  // Nothing to record and nothing asked: leave the file alone.
  if (meta && ttlDays === undefined) return null

  // The clock is the operator's, not the upgrade's: a workspace that predates
  // this feature starts counting now, and `--ttl-days` on a live session
  // changes the LENGTH only, never restarts it.
  return {
    createdAt: meta?.createdAt ?? now.toISOString(),
    ttlDays: ttlDays ?? meta?.ttlDays ?? DEFAULT_SESSION_TTL_DAYS
  }
}

/**
 * Is this session past its TTL?
 *
 * `now` is required rather than defaulted to a live clock: a policy that reads
 * the wall clock inside itself cannot be tested at a boundary.
 *
 * Null meta is NOT infinitely old. A workspace that predates this feature has
 * no recorded creation time, and logging it out on the first run after an
 * upgrade would be a surprise; the caller backfills instead.
 */
export function isExpired(meta: SessionMeta | null, now: Date): boolean {
  if (!meta) return false

  const ttlDays = effectiveTtlDays(meta)
  if (ttlDays <= 0) return false

  const createdAt = Date.parse(meta.createdAt)
  if (Number.isNaN(createdAt)) return false

  return now.getTime() - createdAt > ttlDays * MS_PER_DAY
}
