import type { Command } from 'commander'
import { DEFAULT_DRAFT_SCAN, listDrafts, renderDrafts } from '../../dialogs/index.js'
import { parseLimit } from '../args.js'
import { runCommand } from '../errors.js'
import { printResult, withAuthenticatedClient } from './shared.js'

/**
 * `tg draft list` - unsent drafts waiting in your chats. Read-only.
 *
 * Reading a draft sends nothing and tells nobody. Writing one is a different verb
 * (planned for 0.9) with its own gate.
 */
export function registerDraftCommand(program: Command): void {
  const draft = program
    .command('draft')
    .description('Read the drafts waiting in your chats (read-only)')
    .action(() => draft.help())

  draft
    .command('list')
    .description('List the unsent drafts, newest first, with their text')
    .option('--scan <n>', `How many of your most recent chats to look through (default ${DEFAULT_DRAFT_SCAN}, at most 2000)`)
    .option('--limit <n>', 'How many drafts to show, newest first (default 100, at most 1000)')
    .option('--json', 'Machine-readable output')
    .action(async (options: { scan?: string; limit?: string; json?: boolean }) => {
      await runCommand(async () => {
        const scan = parseLimit(options.scan, DEFAULT_DRAFT_SCAN, 2000)
        const limit = parseLimit(options.limit, 100, 1000)

        const rows = (await withAuthenticatedClient((tg) => listDrafts(tg, { scan }))).slice(0, limit)
        printResult(options.json, rows, () => renderDrafts(rows))
      })
    })
}
