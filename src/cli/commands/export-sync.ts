import { intro } from '@clack/prompts'
import chalk from 'chalk'
import type { Command } from 'commander'
import { syncChats } from '../../sync/index.js'
import { runCommand } from '../errors.js'
import { logSummary } from '../log.js'
import { formatDuration, resolveExportConfig, withAuthenticatedClient } from './shared.js'

export function registerExportSyncCommand(exportCommand: Command): void {
  exportCommand
    .command('chats')
    .description('Export chats into per-chat archive files')
    .option(
      '--private-only',
      'Skip groups and channels; export only 1:1 chats. A 50k-message group costs hours and holds no private thread.'
    )
    .option(
      '--chats <ids>',
      'Comma-separated chat ids to export instead of the tracked folders. Everything else is left untouched.'
    )
    .action(async (opts: { privateOnly?: boolean | undefined; chats?: string | undefined }) => {
      await runCommand(async () => {
        intro(chalk.cyan('Export Chats'))
        await withAuthenticatedClient(
          async (tg) => {
            let config = await resolveExportConfig(tg)
            if (!config) {
              return
            }

            if (opts.chats) {
              const ids = opts.chats
                .split(',')
                .map((s) => Number(s.trim()))
                .filter((n) => Number.isSafeInteger(n) && n !== 0)
              if (ids.length === 0) {
                throw new Error(`--chats had no usable ids: ${opts.chats}`)
              }
              config = { ...config, trackedChatIds: ids }
            }

            // Run incremental sync
            const result = await syncChats(tg, config, { privateOnly: opts.privateOnly })

            // Display sync summary
            const duration = formatDuration(result.durationMs)
            const parts = [
              `${result.chatsProcessed} chats synced`,
              `${result.messagesAppended} messages`,
              `${result.filesUpdated} files updated`,
            ]
            if (result.newChatsAdded > 0) {
              parts.push(`${result.newChatsAdded} new chats added`)
            }
            if (result.newFoldersAdded > 0) {
              parts.push(`${result.newFoldersAdded} new folders tracked`)
            }
            if (result.chatsSkipped > 0) {
              parts.push(`${result.chatsSkipped} empty chats skipped`)
            }
            logSummary(`${parts.join(', ')} in ${duration}`, { leadingNewline: true })
          }
        )
      })
    })
}
