import { existsSync, rmSync } from 'node:fs'
import type { TelegramClient, User } from '@mtcute/node'
import { ensureAuthenticated, ensureAuthenticatedQr, checkSession } from '../auth.js'
import { createClient } from '../client.js'
import { acquireLock } from './lock.js'
import { OperatorError } from '../errors.js'
import { SESSION_DB_PATH } from './cache.js'
import { deleteSecret, getOrCreateDbKey, psstAvailable, readSecret, writeSecret, SECRETS } from './psst.js'
import {
  isExpired,
  metaForReuse,
  readSessionMeta,
  writeSessionMeta,
  DEFAULT_SESSION_TTL_DAYS
} from './ttl.js'
import { SESSION_META_PATH } from '../paths.js'
import { setting } from '../env.js'
import { EXIT } from '../exit-codes.js'

/** Where this run's authorisation came from. */
export type SessionSource =
  | 'cache' // local encrypted cache already held an auth key
  | 'vault' // imported the string session out of psst
  | 'login' // no usable session anywhere, so the user logged in by hand

/**
 * Would a login prompt actually reach a human?
 *
 * A TTY alone is not enough: an agent or CI job often runs with a pty attached
 * and would sit forever on "Enter your phone number". TG_NON_INTERACTIVE=1
 * is the explicit way such a caller says "fail instead of asking".
 */
export function canPrompt(): boolean {
  if (setting('NON_INTERACTIVE') === '1') return false
  return Boolean(process.stdin.isTTY)
}

export interface OpenSessionOptions {
  /**
   * May this run prompt for a phone number and code?
   * Defaults to {@link canPrompt}, so unattended runs fail loudly instead of
   * hanging on a prompt nobody is there to answer.
   */
  interactive?: boolean | undefined
  /**
   * Discard the local cache and re-import from the vault. Use when deploying a
   * session that was created on another machine, or after rotating one.
   */
  forceImport?: boolean | undefined
  /**
   * Log in by scanning a QR code instead of typing a phone number. Ignored
   * unless this run ends up needing an interactive login.
   */
  qr?: boolean | undefined
  /**
   * How many days before this workspace's session self-expires. Persisted once
   * set; omit to leave whatever this workspace already has (or the default).
   */
  ttlDays?: number | undefined
}

export interface SessionHandle {
  tg: TelegramClient
  user: User
  source: SessionSource
  /** Disconnect and drop the single-instance lock. */
  close: () => Promise<void>
}

function noSessionError(): OperatorError {
  // A globally installed tg cannot assume psst exists: it is a separate binary
  // that `npm i -g` does not bring along. Without this check the failure reads
  // "no session", which sends the operator to `session login` - where the vault
  // write fails for the same underlying reason. Name the real cause instead.
  if (!psstAvailable()) {
    return new OperatorError(
      'No usable Telegram session, and psst is not on PATH.\n' +
      '  tg keeps its secrets in a psst vault, which is a separate binary:\n' +
      '    https://github.com/vpetrigo/psst\n' +
      '  Or supply the secrets directly, with no vault:\n' +
      `    API_ID=... API_HASH=... ${SECRETS.session}=... tg ...`
    )
  }

  return new OperatorError(
    'No usable Telegram session.\n' +
    `  This workspace's vault has no valid ${SECRETS.session} and the local cache\n` +
    '  is empty or stale.\n' +
    '  Run this once, at a terminal:  tg session login\n' +
    '  Then unattended runs pick the session up automatically.\n' +
    '  Each workspace logs in for itself; never copy a session from another one.',
    EXIT.needsHuman
  )
}

/**
 * Delete the local cache. Safe: everything in it is either regenerable
 * (peers) or also held in the vault (the auth key).
 */
export function resetLocalCache(path = SESSION_DB_PATH): void {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${path}${suffix}`, { force: true })
  }
}

/** The local traces of a session, injectable so expiry is testable offline. */
export interface ExpiryEffects {
  resetCache: () => void
  forgetSecret: () => void
  removeMeta: () => void
}

const LOCAL_EXPIRY_EFFECTS: ExpiryEffects = {
  resetCache: () => resetLocalCache(),
  forgetSecret: () => deleteSecret(SECRETS.session),
  removeMeta: () => rmSync(SESSION_META_PATH, { force: true })
}

/**
 * End an expired session at Telegram, then locally - in that order.
 *
 * The order is the whole point, so it is a function rather than a comment: an
 * unconfirmed server-side logout must never be forgotten locally, because
 * dropping the session string here would leave a live authorisation at
 * Telegram that this tool can no longer name or terminate.
 */
export async function expireSession(
  logOut: () => Promise<void>,
  effects: ExpiryEffects = LOCAL_EXPIRY_EFFECTS
): Promise<void> {
  try {
    await logOut()
  } catch (error) {
    throw new OperatorError(
      'This workspace\'s Telegram session is past its TTL, but Telegram could not\n' +
      `  be reached to end it (${error instanceof Error ? error.message : String(error)}).\n` +
      '  Nothing was deleted locally, so the session stays terminable. Retry.\n' +
      '  Or end it by hand: Telegram > Settings > Devices.',
      EXIT.upstream
    )
  }

  effects.resetCache()
  effects.forgetSecret()
  effects.removeMeta()
}

/**
 * Get an authenticated client, without ever prompting for a password.
 *
 * Resolution order, cheapest first:
 *   1. the local encrypted cache, which also carries the peer table
 *   2. the string session in psst, imported into a fresh cache
 *   3. an interactive login, whose result is written back to psst
 *
 * Step 2 reads THIS workspace's vault, not another machine's. A session string
 * is an auth key, and one auth key used from two places desynchronises
 * Telegram's pts/qts/seq state and can earn AUTH_KEY_DUPLICATED - which revokes
 * it for everyone using it. So step 3 is per workspace, deliberately: each one
 * logs in once and owns its own key. Never copy a session between workspaces.
 */
export async function openSession(options: OpenSessionOptions = {}): Promise<SessionHandle> {
  const interactive = options.interactive ?? canPrompt()

  // Taken before touching the session so two runs can never share one auth key.
  const release = acquireLock()

  try {
    if (options.forceImport) resetLocalCache()

    const hadCache = existsSync(SESSION_DB_PATH)
    const vaultSession = readSecret(SECRETS.session)

    // Nothing to authenticate with and nobody to ask: say so now rather than
    // opening a socket, generating a cache key and failing a round trip later.
    if (!hadCache && !vaultSession && !interactive) throw noSessionError()

    const cacheKey = getOrCreateDbKey()
    const tg = createClient(cacheKey)

    try {
      if (vaultSession) {
        // A no-op when the cache already holds an auth key - that is precisely
        // what preserves the peer table from run to run.
        await tg.importSession(vaultSession)
      }

      await tg.connect()

      let user = await checkSession(tg)
      let source: SessionSource = hadCache ? 'cache' : 'vault'

      const now = new Date()
      let meta = user ? readSessionMeta() : null

      if (user && isExpired(meta, now)) {
        // auth.logOut ends THIS auth key and nothing else. Never
        // account.setAuthorizationTTL, which is an account-wide policy that
        // would reach the operator's phone.
        await expireSession(async () => {
          await tg.logOut()
        })
        meta = null
        user = null
      }

      if (!user) {
        if (!interactive) throw noSessionError()

        user = options.qr ? await ensureAuthenticatedQr(tg) : await ensureAuthenticated(tg)
        writeSecret(SECRETS.session, await tg.exportSession())
        writeSessionMeta({
          createdAt: now.toISOString(),
          ttlDays: options.ttlDays ?? DEFAULT_SESSION_TTL_DAYS
        })
        source = 'login'
      } else {
        // Reused session. Backfill a missing record rather than treating it as
        // infinitely old, and rewrite the length only when one was asked for.
        const next = metaForReuse(meta, options.ttlDays, now)
        if (next) writeSessionMeta(next)
      }

      if (user && source !== 'login' && !vaultSession) {
        // Authorised from a local cache that predates the vault: capture it now
        // so this session becomes deployable too.
        writeSecret(SECRETS.session, await tg.exportSession())
      }

      const close = async () => {
        await tg.destroy().catch(() => undefined)
        release()
      }

      return { tg, user, source, close }
    } catch (error) {
      await tg.destroy().catch(() => undefined)
      throw error
    }
  } catch (error) {
    release()
    throw error
  }
}

/** Run `fn` with an authenticated client, always releasing the lock afterwards. */
export async function withSession<T>(
  fn: (tg: TelegramClient, session: SessionHandle) => Promise<T>,
  options: OpenSessionOptions = {}
): Promise<T> {
  const session = await openSession(options)
  try {
    return await fn(session.tg, session)
  } finally {
    await session.close()
  }
}
