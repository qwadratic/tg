import { basename } from 'node:path'
import { TelegramClient } from '@mtcute/node'
import { BaseSqliteStorage, networkMiddlewares } from '@mtcute/core'
import { EncryptedSqliteStorage } from './storage/encrypted.js'
import { SESSION_DB_PATH } from './session/cache.js'
import { readSecret, SECRETS } from './session/psst.js'
import { readSessionMeta } from './session/ttl.js'

/** Errors the session layer handles itself; logging them would be noise. */
const EXPECTED_RPC_ERRORS = new Set([
  'AUTH_KEY_UNREGISTERED',
  'AUTH_KEY_DUPLICATED',
  'SESSION_REVOKED',
  'SESSION_EXPIRED'
])

/**
 * What Telegram's own "Active Sessions" list calls this workspace.
 *
 * mtcute defaults every client to "mtcute on Node.js/vX (Darwin arm64)", so a
 * machine with several workspaces shows several identical rows and none of
 * them can be safely terminated. `<date>/<directory>` replaces that: no
 * "mtcute", no "Node.js", just when this workspace's session was created and
 * where it lives on disk - matching `tg session status`'s own fields, and
 * stable across every future connection because it reads the same
 * session-meta.json the TTL feature already writes.
 *
 * The date is the session's actual createdAt once one exists. Before that -
 * the first connection of a fresh login, before openSession() has written
 * session-meta.json - it falls back to today, which is what createdAt is
 * about to become moments later anyway.
 *
 * 48 chars is a GUESS, not a documented Telegram limit - no cap is published,
 * and both an over-long string and a truncated one are risks, so pick a length
 * that stays readable in the app's list.
 */
// Exported for test/device-label.test.ts - not used outside this file otherwise.
export function workspaceDeviceLabel(): string {
  const meta = readSessionMeta()
  const date = (meta?.createdAt ?? new Date().toISOString()).slice(0, 10)
  return `${date}/${basename(process.cwd())}`.slice(0, 48)
}

/**
 * @param cacheKey - encrypts data/session.db at rest. Supplied by the session
 *   layer from the psst vault; no longer typed in by a human on every run.
 */
export function createClient(cacheKey: string): TelegramClient {
  // readSecret checks process.env first, so a .env file keeps working unchanged.
  const apiId = readSecret(SECRETS.apiId)
  const apiHash = readSecret(SECRETS.apiHash)

  if (!apiId || !apiHash) {
    throw new Error(
      'API_ID and API_HASH are not set.\n' +
      '  Store them in the vault:  psst set API_ID && psst set API_HASH\n' +
      '  Or put them in a .env file (see .env.example).'
    )
  }

  // EncryptedSqliteStorage is a driver; wrap it with BaseSqliteStorage
  const driver = new EncryptedSqliteStorage(SESSION_DB_PATH, cacheKey)
  const storage = new BaseSqliteStorage(driver)

  return new TelegramClient({
    apiId: parseInt(apiId, 10),
    apiHash,
    storage,
    disableUpdates: true,
    // Spread last by mtcute's network manager, so this overrides its default
    // deviceModel. Only deviceModel: systemVersion/appVersion/langCode are the
    // library's to report.
    initConnectionOptions: { deviceModel: workspaceDeviceLabel() },
    network: {
      // Use built-in middlewares with flood wait handling up to 60 seconds
      middlewares: [
        ...networkMiddlewares.basic({
          floodWaiter: {
            maxWait: 60_000,
          },
        }),
        networkMiddlewares.onRpcError((ctx, error) => {
          // A dead auth key is how the session layer probes for "do we need to
          // log in?", so reporting it here would be alarming and wrong.
          if (EXPECTED_RPC_ERRORS.has(error.errorMessage)) return
          console.error(`RPC error in ${ctx.request._}: ${error.errorMessage}`)
        }),
      ],
    },
  })
}
