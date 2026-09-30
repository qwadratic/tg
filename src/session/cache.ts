import { existsSync, renameSync } from 'node:fs'
import Database from 'better-sqlite3-multiple-ciphers'
import { SESSION_DB_PATH } from '../paths.js'

/**
 * Local, encrypted cache: auth key plus the resolved peer table.
 *
 * The peer table is why this file exists at all. A string session carries
 * only { version, primaryDcs, self, authKey } - no peers - so without a
 * cache on disk every run would have to re-resolve every chat's access hash.
 *
 * The path itself lives in `src/paths.ts` so a workspace can relocate its whole
 * data root at once; re-exported here because that is where callers look for it.
 */
export { SESSION_DB_PATH }

export interface PeerCacheStats {
  /** Rows in the mtcute `peers` table. */
  count: number
  /** Newest `updated` column, as an ISO timestamp, or null when empty. */
  lastUpdated: string | null
}

/**
 * Count cached peers by reading the mtcute `peers` table directly.
 *
 * Done outside the client so it can be checked before connecting - which is
 * the whole point when verifying that peers survive across separate runs.
 */
export function peerCacheStats(dbKey: string, path = SESSION_DB_PATH): PeerCacheStats {
  if (!existsSync(path)) return { count: 0, lastUpdated: null }

  const db = new Database(path, { readonly: true })
  try {
    db.pragma(`key='${dbKey.replace(/'/g, "''")}'`)
    const table = db
      .prepare("select name from sqlite_master where type='table' and name='peers'")
      .get()
    if (!table) return { count: 0, lastUpdated: null }

    const row = db.prepare('select count(*) as count, max(updated) as updated from peers').get() as {
      count: number
      updated: number | null
    }
    return {
      count: row.count,
      // mtcute stores `updated` as unix *milliseconds*, not seconds. Scaling it
      // again put `session status` about 56000 years into the future.
      lastUpdated: row.updated ? new Date(row.updated).toISOString() : null
    }
  } finally {
    db.close()
  }
}

/**
 * Does the cache at `path` open with `dbKey`? False for a file encrypted with
 * another key (or not a database at all); true when there is no file.
 */
export function cacheOpensWith(dbKey: string, path = SESSION_DB_PATH): boolean {
  if (!existsSync(path)) return true
  let db: InstanceType<typeof Database> | null = null
  try {
    db = new Database(path, { readonly: true })
    db.pragma(`key='${dbKey.replace(/'/g, "''")}'`)
    db.prepare('SELECT count(*) FROM sqlite_master').get()
    return true
  } catch {
    return false
  } finally {
    db?.close()
  }
}

/**
 * Move an unreadable cache (and its -wal/-shm) aside as `<path>.orphaned-<stamp>`.
 * Not deleted: if the old key turns up, the peer table is still there. Returns
 * the new path of the main file.
 */
export function quarantineCache(path = SESSION_DB_PATH, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const target = `${path}.orphaned-${stamp}`
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(`${path}${suffix}`)) renameSync(`${path}${suffix}`, `${target}${suffix}`)
  }
  return target
}
