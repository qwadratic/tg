import type { Command } from 'commander'
import {
  PRIVACY_KEYS,
  isPrivacyKey,
  listSessions,
  readNotify,
  readPrivacy,
  renderNotify,
  renderPrivacy,
  renderSessions,
  unknownPrivacyKey,
  type NotifyScope,
  type PrivacyKeyName
} from '../../account/index.js'
import { parsePeerRef } from '../../peers/ref.js'
import { runCommand } from '../errors.js'
import { printResult, resolveReadPeer, withAuthenticatedClient } from './shared.js'

/**
 * `tg account` - the account's own settings, read: sessions, privacy, notifications.
 *
 * Read-only. Nothing here changes a setting, and nothing ends a session: each
 * workspace owns its own auth key (D3), so ending the wrong row signs a sibling
 * workspace out. That is a different tier with its own decision record (TASK-43,
 * phase 0.12).
 */
export function registerAccountCommand(program: Command): void {
  const account = program
    .command('account')
    .description('Read the account\'s own sessions, privacy and notification settings (read-only)')
    .action(() => account.help())

  account
    .command('sessions')
    .description('List every session of the account, the current one first (Settings > Devices)')
    .option('--json', 'Machine-readable output')
    .action(async (options: { json?: boolean }) => {
      await runCommand(async () => {
        const result = await withAuthenticatedClient((tg) => listSessions(tg))
        printResult(options.json, result, () => renderSessions(result))
      })
    })

  account
    .command('privacy [key]')
    .description(`Show who may see or do each thing; one setting (${Object.keys(PRIVACY_KEYS).join(', ')}) or all`)
    .option('--json', 'Machine-readable output')
    .action(async (key: string | undefined, options: { json?: boolean }) => {
      await runCommand(async () => {
        if (key !== undefined && !isPrivacyKey(key)) throw unknownPrivacyKey(key)
        const keys = (key === undefined ? Object.keys(PRIVACY_KEYS) : [key]) as PrivacyKeyName[]

        const rows = await withAuthenticatedClient((tg) => readPrivacy(tg, keys))
        printResult(options.json, rows, () => renderPrivacy(rows))
      })
    })

  account
    .command('notify [peer]')
    .description('Show notification settings: the three defaults, or one chat (id, @username, t.me link)')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string | undefined, options: { json?: boolean }) => {
      await runCommand(async () => {
        if (peer !== undefined) parsePeerRef(peer)

        const rows = await withAuthenticatedClient(async (tg) => {
          const scopes: NotifyScope[] = [{ kind: 'users' }, { kind: 'chats' }, { kind: 'channels' }]
          if (peer !== undefined) {
            const target = await resolveReadPeer(tg, peer, 'reading the notification settings of')
            scopes.splice(0, scopes.length, { kind: 'peer', peerId: target.id })
          }
          return readNotify(tg, scopes)
        })

        printResult(options.json, rows, () => renderNotify(rows))
      })
    })
}
