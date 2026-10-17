import type { Command } from 'commander'
import { renderUserInfo, userInfo } from '../../users/index.js'
import { parsePeerRef } from '../../peers/ref.js'
import { runCommand } from '../errors.js'
import { printResult, requirePerson, resolveReadPeer, withAuthenticatedClient } from './shared.js'

/**
 * `tg user info <peer>` - who a person is, from Telegram's side. Read-only.
 *
 * No phone numbers and no last-seen beyond Telegram's own coarse bucket: see the
 * note at the top of `src/users/index.ts`.
 */
export function registerUserCommand(program: Command): void {
  const user = program
    .command('user')
    .description('Read who a person is (read-only)')
    .action(() => user.help())

  user
    .command('info <peer>')
    .description('Show a person: name, handles, contact state, last seen, bio (id, @username, t.me link or me)')
    .option('--basic', 'One cheap request: skip the bio and the full profile')
    .option('--common', 'Also list the groups and channels you share with them')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, options: { basic?: boolean; common?: boolean; json?: boolean }) => {
      await runCommand(async () => {
        parsePeerRef(peer)

        const row = await withAuthenticatedClient(async (tg) => {
          const target = await resolveReadPeer(tg, peer, 'reading')
          requirePerson(target, 'tg user info', `tg chat info ${target.id}`)
          return userInfo(tg, target.id, { basic: options.basic, common: options.common })
        })

        printResult(options.json, row, () => renderUserInfo(row))
      })
    })
}
