import type { Command } from 'commander'
import { runCommand } from '../errors.js'
import { ship } from '../../ship/index.js'

/**
 * `tg ship` - the only thing in this repo that ever talks to gbrain.
 *
 * It is a subcommand for the human's convenience and a separate PROCESS for
 * the security boundary: it must run only after the ingester has exited, and
 * its import graph deliberately contains no session, client or mtcute module.
 */
export function registerShipCommand(program: Command): void {
  program
    .command('ship')
    .description('OPTIONAL: push new archive files into gbrain, an external knowledge base. Skip unless you use gbrain.')
    .option('--dry-run', 'Print what would be captured; exec nothing, move no watermark')
    .option('--all', 'Ignore the .last-ship watermark and re-ship everything (idempotent by slug)')
    .option(
      '--skip-unroutable',
      'Ship what can be routed and report the rest, instead of failing the whole run'
    )
    .action(async (options: { dryRun?: boolean; all?: boolean; skipUnroutable?: boolean }) => {
      await runCommand(async () => {
        const { shipped, captures, skipped } = ship({
          dryRun: options.dryRun,
          all: options.all,
          skipUnroutable: options.skipUnroutable
        })
        const tail = skipped > 0 ? `, ${skipped} skipped as unroutable` : ''
        console.log(
          options.dryRun
            ? `dry run: ${shipped} file(s), ${captures} capture(s)${tail}, watermark untouched`
            : `shipped ${shipped} file(s) in ${captures} capture(s)${tail}`
        )
      })
    })
}
