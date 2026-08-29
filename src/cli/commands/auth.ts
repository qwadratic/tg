import chalk from 'chalk'
import type { Command } from 'commander'
import { openSession } from '../../session/index.js'
import { SECRETS } from '../../session/psst.js'
import { runCommand } from '../errors.js'

/**
 * Kept as the short spelling of `session login`, since it is the verb people
 * reach for first and it was the command this tool shipped with.
 */
export function registerAuthCommand(program: Command): void {
  program
    .command('auth')
    .description('Authenticate with Telegram (alias for "session login")')
    .option('--force', 'Discard the local cache and log in again')
    .option('--qr', 'Log in by scanning a QR code instead of typing a phone number, like linking a desktop device')
    .action(async (options) => {
      await runCommand(async () => {
        const handle = await openSession({ interactive: true, forceImport: options.force, qr: options.qr })
        try {
          const label = `${handle.user.firstName} ${handle.user.lastName ?? ''}`.trim()
          console.log(chalk.green(`\nLogged in as: ${label} (@${handle.user.username ?? 'no username'})`))
          console.log(chalk.dim(`Session source: ${handle.source}; stored in psst as ${SECRETS.session}`))
        } finally {
          await handle.close()
        }
      })
    })
}
