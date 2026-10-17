import type { Command } from 'commander'
import { contactsList, renderContacts } from '../../users/index.js'
import { parseLimit } from '../args.js'
import { runCommand } from '../errors.js'
import { printResult, withAuthenticatedClient } from './shared.js'

/**
 * `tg contacts list` - the address book, by name. Read-only.
 *
 * Phone numbers are never printed (see `src/users/index.ts`): `--json` cannot be
 * used to export the phone book. Adding, editing and removing contacts are writes
 * and are not here.
 */
export function registerContactsCommand(program: Command): void {
  const contacts = program
    .command('contacts')
    .description('Read the address book (read-only)')
    .action(() => contacts.help())

  contacts
    .command('list')
    .description('List your contacts by name: id, @username, mutual, close friend')
    .option('--query <text>', 'Only contacts whose name or @username matches, accents ignored')
    .option('--limit <n>', 'How many to show (default 200, at most 5000)')
    .option('--json', 'Machine-readable output')
    .action(async (options: { query?: string; limit?: string; json?: boolean }) => {
      await runCommand(async () => {
        const limit = parseLimit(options.limit, 200, 5000)

        const rows = await withAuthenticatedClient((tg) => contactsList(tg, { query: options.query, limit }))
        printResult(options.json, rows, () => renderContacts(rows))
      })
    })
}
