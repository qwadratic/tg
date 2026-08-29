import chalk from 'chalk'
import type { Command } from 'commander'
import { openSession } from '../../session/index.js'
import { SECRETS } from '../../session/psst.js'
import { runCommand } from '../errors.js'
import { OperatorError } from '../../errors.js'
import { EXIT } from '../../exit-codes.js'

/** Parsed before openSession, so a typo costs no lock and no connection (eval-61). */
export function parseTtlDays(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined

  const days = Number.parseInt(raw, 10)
  if (!Number.isFinite(days) || days < 0) {
    throw new OperatorError(
      `--ttl-days must be a non-negative integer, got "${raw}". Use 0 to disable expiry.`,
      EXIT.usage
    )
  }
  return days
}

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
    .option('--ttl-days <n>', "Days before this workspace's session auto-expires (default 3; 0 disables)")
    .action(async (options: { force?: boolean; qr?: boolean; ttlDays?: string }) => {
      await runCommand(async () => {
        const ttlDays = parseTtlDays(options.ttlDays)

        const handle = await openSession({
          interactive: true,
          forceImport: options.force,
          qr: options.qr,
          ttlDays
        })
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
