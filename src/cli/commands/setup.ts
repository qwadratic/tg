import { intro } from '@clack/prompts'
import chalk from 'chalk'
import type { Command } from 'commander'
import { syncFolderConfig } from '../../folders/index.js'
import { runCommand } from '../errors.js'
import { withAuthenticatedClient } from './shared.js'

export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('Select Telegram folders to export')
    .option('--select', 'Force folder re-selection')
    .action(async (options: { select?: boolean }) => {
      await runCommand(async () => {
        intro(chalk.cyan('Export Setup'))
        await withAuthenticatedClient(async (tg) => {
          // Sync setup config (first run: select, subsequent: refresh)
          await syncFolderConfig(tg, options.select)
        })
      })
    })
}
