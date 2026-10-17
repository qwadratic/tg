import type { Command } from 'commander'
import { renderReactions, showReactions } from '../../messages/reactions.js'
import { parsePeerRef } from '../../peers/ref.js'
import { parseLimit, parseMessageIds } from '../args.js'
import { runCommand } from '../errors.js'
import { notFound, printResult, resolveReadPeer, withAuthenticatedClient } from './shared.js'

/**
 * `tg reactions show <peer> <id>` - how many of each reaction a message has, and
 * with `--users` who. Read-only. Reacting, and marking reactions read, are writes
 * (D13a: a read receipt tells the other side a human is awake) and are not here.
 */
export function registerReactionsCommand(program: Command): void {
  const reactions = program
    .command('reactions')
    .description('Read the reactions on a message (read-only)')
    .action(() => reactions.help())

  reactions
    .command('show <peer> <id>')
    .description('Show the reactions on one message, with counts')
    .option('--users', 'Also list who reacted (not available in broadcast channels)')
    .option('--limit <n>', 'How many reactors to list with --users (default 100, at most 1000)')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, id: string, options: { users?: boolean; limit?: string; json?: boolean }) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        const [messageId] = parseMessageIds([id], 1)
        const limit = parseLimit(options.limit, 100, 1000)

        const row = await withAuthenticatedClient(async (tg) => {
          const target = await resolveReadPeer(tg, peer, 'reading')
          return showReactions(tg, target.id, messageId as number, { users: options.users, limit })
        })

        if (!row) throw notFound(`Message ${messageId} does not exist in that chat (or this account cannot see it).`)
        printResult(options.json, row, () => renderReactions(row))
      })
    })
}
