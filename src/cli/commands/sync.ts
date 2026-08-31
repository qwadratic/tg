import type { Command } from 'commander'
import { registerSyncChatsCommand } from './sync-chats.js'
import { registerSyncRecentCommand } from './sync-recent.js'
import { registerSyncHistoricalCommand } from './sync-historical.js'

/**
 * `tg sync` - the archiving group: `chats`, `recent`, `historical`.
 *
 * Bare `tg sync` prints help rather than quietly meaning `sync chats`. The
 * three subcommands write different files and cost very different amounts of
 * time; a default action would make the expensive one the one you get by typo.
 */
export function registerSyncCommand(program: Command): void {
  const sync = program
    .command('sync')
    .description('Archive tracked chats: per-chat files, or a recent/historical digest')
    .action(() => sync.help())

  registerSyncChatsCommand(sync)
  registerSyncRecentCommand(sync)
  registerSyncHistoricalCommand(sync)
}
