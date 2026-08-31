import chalk from 'chalk'
import type { Command } from 'commander'
import { syncChats } from '../../sync/index.js'
import { sleep } from '../../utils/sleep.js'
import { runCommand } from '../errors.js'
import { logSummary } from '../log.js'
import { OperatorError } from '../../errors.js'
import { EXIT } from '../../exit-codes.js'
import { formatDuration, resolveExportConfig, withAuthenticatedClient } from './shared.js'

/**
 * `tg sync chats` - keep the tracked chats archived, repeatedly.
 *
 * This is polling, exactly like `tg watch`: the client runs with
 * `disableUpdates: true`, so there is no live push stream to listen to, and a
 * timer is the only thing that can tell us to look again.
 *
 * The whole loop lives inside ONE `withAuthenticatedClient` call, so the
 * single-instance lock is held for the entire run and the session is opened
 * once. Reconnecting per pass would be slower and would race any other command
 * that grabbed the lock in the gap. Ctrl+C needs no handler here:
 * `src/session/lock.ts` already releases the lock on SIGINT/SIGTERM/SIGHUP.
 */
export function registerSyncChatsCommand(syncCommand: Command): void {
  syncCommand
    .command('chats')
    .description('Archive tracked chats into per-chat files, repeating until stopped (Ctrl+C)')
    .option('--once', 'Sync once and exit')
    .option('--interval <seconds>', 'Seconds to wait between passes in the default running mode', '300')
    .option(
      '--private-only',
      'Skip groups and channels; export only 1:1 chats. A 50k-message group costs hours and holds no private thread.'
    )
    .option(
      '--chats <ids>',
      'Comma-separated chat ids to sync instead of the tracked folders. Everything else is left untouched.'
    )
    .option('--json', 'Machine-readable output: one JSON summary line per pass, to stdout')
    .option('-v, --verbose', 'Also report new chats and skipped chats')
    .action(async (opts: {
      once?: boolean | undefined
      interval: string
      privateOnly?: boolean | undefined
      chats?: string | undefined
      json?: boolean | undefined
      verbose?: boolean | undefined
    }) => {
      await runCommand(async () => {
        const interval = Number.parseInt(opts.interval, 10)
        if (!Number.isFinite(interval) || interval < 30) {
          throw new OperatorError(
            '--interval must be at least 30 seconds; a full chat sync is heavier than a single-chat poll',
            EXIT.usage
          )
        }

        // Parsed before the session is opened, so a bad --chats costs no
        // connection and no lock. Pinned by eval-61.
        let chatIds: number[] | undefined
        if (opts.chats) {
          chatIds = opts.chats
            .split(',')
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isSafeInteger(n) && n !== 0)
          if (chatIds.length === 0) {
            throw new OperatorError(`--chats had no usable ids: ${opts.chats}`, EXIT.usage)
          }
        }

        await withAuthenticatedClient(async (tg) => {

          if (!opts.once) {
            // stderr, so a --json stdout stays one clean summary line per pass.
            console.error(chalk.cyan(`syncing every ${interval}s until stopped (Ctrl+C)`))
          }

          while (true) {
            // Resolved per pass, not once: a chat added to a tracked folder
            // between passes is picked up without restarting the command.
            const resolved = await resolveExportConfig(tg)
            const config = chatIds ? { ...resolved, trackedChatIds: chatIds } : resolved

            const result = await syncChats(tg, config, { privateOnly: opts.privateOnly })

            // The membership counters are opt-in on BOTH surfaces: a repeating
            // command should not grow a paragraph every 5 minutes, and a --json
            // consumer should get the same fields either way.
            const { newChatsAdded, chatsSkipped, ...core } = result

            if (opts.json) {
              process.stdout.write(`${JSON.stringify(opts.verbose ? result : core)}\n`)
            } else {
              const parts = [
                `${result.chatsProcessed} chats synced`,
                `${result.messagesAppended} messages`,
                `${result.filesUpdated} files updated`
              ]
              if (opts.verbose) {
                // Only what actually happened: a nightly log line of zeroes is noise.
                if (newChatsAdded > 0) parts.push(`${newChatsAdded} new chats added`)
                if (chatsSkipped > 0) parts.push(`${chatsSkipped} empty chats skipped`)
              }
              logSummary(`${parts.join(', ')} in ${formatDuration(result.durationMs)}`)
            }

            if (opts.once) break
            await sleep(interval * 1000)
          }
        })
      })
    })
}
