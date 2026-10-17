import type { Command } from 'commander'
import { MAX_MESSAGE_IDS, listScheduled, renderMessages } from '../../messages/read.js'
import { parsePeerRef } from '../../peers/ref.js'
import { parseMessageIds } from '../args.js'
import { runCommand } from '../errors.js'
import { notFound, printResult, resolveReadPeer, withAuthenticatedClient } from './shared.js'

/**
 * `tg scheduled list <peer> [ids...]` - messages waiting to be sent in a chat.
 * Read-only: scheduling, rescheduling and deleting are writes and are not here.
 */
export function registerScheduledCommand(program: Command): void {
  const scheduled = program
    .command('scheduled')
    .description('Read the messages scheduled to be sent in a chat (read-only)')
    .action(() => scheduled.help())

  scheduled
    .command('list <peer> [ids...]')
    .description('List what is scheduled in a chat, soonest first; or only the scheduled message ids given')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, ids: string[], options: { json?: boolean }) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        const wanted = ids.length === 0 ? [] : parseMessageIds(ids, MAX_MESSAGE_IDS)

        const { target, result } = await withAuthenticatedClient(async (tg) => {
          const target = await resolveReadPeer(tg, peer, 'reading the scheduled messages of')
          return { target, result: await listScheduled(tg, target.id, wanted) }
        })

        if (wanted.length > 0 && result.rows.length === 0) {
          throw notFound(`None of scheduled message ${wanted.join(', ')} exists in chat ${target.id}.`)
        }
        printResult(options.json, { chatId: target.id, messages: result.rows, missing: result.missing }, () =>
          (result.rows.length === 0 ? 'nothing scheduled\n' : renderMessages(result.rows)) +
          (result.missing.length > 0 ? `not found: ${result.missing.join(', ')}\n` : '')
        )
      })
    })
}
