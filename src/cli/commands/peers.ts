import type { Command } from 'commander'
import { listPeers, matchPeers, renderPeers } from '../../peers/index.js'
import { runCommand } from '../errors.js'
import { OperatorError } from '../../errors.js'
import { EXIT } from '../../exit-codes.js'
import { withAuthenticatedClient } from './shared.js'
import { parseSince } from '../args.js'

/**
 * Peer discovery. Read-only.
 *
 * This is the lookup step that keeps names off the send path: `peers find`
 * prints ids for a human to read, and `send` takes only ids.
 */
export function registerPeersCommand(program: Command): void {
  const peers = program
    .command('peers')
    .description('Find chats and their numeric ids')
    .action(() => peers.help())

  peers
    .command('list')
    .description('List chats, most recent activity first')
    .option('--type <type>', 'Only this peer type: user, chat, channel')
    .option('--since <date>', 'Only chats active since this date (YYYY-MM-DD or a cutoff shortcut)')
    .option('--no-bots', 'Exclude bot chats')
    .option('--limit <n>', 'Dialogs to walk', '500')
    .option('--json', 'Machine-readable output')
    .action(async (options: { type?: string; since?: string; bots: boolean; limit: string; json?: boolean }) => {
      await runCommand(async () => {
        // Parsed before the session is opened, so a bad --since costs no
        // connection and no lock. Pinned by eval-61.
        const since = options.since ? parseSince(options.since) : undefined
        const limit = Number.parseInt(options.limit, 10)
        if (!Number.isFinite(limit) || limit <= 0) {
          throw new OperatorError(`--limit must be a positive number, got ${options.limit}`, EXIT.usage)
        }

        const found = await withAuthenticatedClient((tg) =>
          listPeers(tg, {
            type: options.type,
            since,
            excludeBots: options.bots === false,
            limit
          })
        )

        // stdout carries only the payload, so `... --json | jq` works.
        process.stdout.write(options.json ? `${JSON.stringify(found, null, 2)}\n` : renderPeers(found))
      })
    })

  peers
    .command('find <needle>')
    .description('Find chats whose name or username contains <needle>')
    .option('--limit <n>', 'Dialogs to walk', '500')
    .option('--json', 'Machine-readable output')
    .option(
      '--id-only',
      'Print just the id of the single best match, for shell composition. Fails if the needle is ambiguous.'
    )
    .action(async (needle: string, options: { limit: string; json?: boolean; idOnly?: boolean }) => {
      await runCommand(async () => {
        if (!needle.trim()) throw new OperatorError('Give a name to search for.')

        const limit = Number.parseInt(options.limit, 10)
        if (!Number.isFinite(limit) || limit <= 0) {
          throw new OperatorError(`--limit must be a positive number, got ${options.limit}`, EXIT.usage)
        }

        const found = await withAuthenticatedClient(async (tg) =>
          matchPeers(await listPeers(tg, { limit }), needle)
        )

        // --id-only exists so name-to-id composes without jq:
        //   tg dump "$(tg peers find zoe --id-only)"
        // It REFUSES on ambiguity rather than guessing, because silently picking
        // the first of several people is how the wrong chat gets read or texted.
        if (options.idOnly) {
          if (found.length === 0) {
            // Not "not configured": the needle simply matched nothing. An agent
            // must be able to tell a bad search term from a broken workspace.
            throw new OperatorError(`No chat matches ${JSON.stringify(needle)}.`, EXIT.usage)
          }
          if (found.length > 1) {
            throw new OperatorError(
              `${found.length} chats match ${JSON.stringify(needle)}, so there is no single id:\n` +
              found.map((p) => `    ${p.id}  ${p.name}${p.username ? ` (@${p.username})` : ''}`).join('\n') +
              '\n  Narrow the search, or pass one of these ids directly.',
              EXIT.usage
            )
          }
          const [only] = found
          if (!only) throw new OperatorError(`No chat matches ${JSON.stringify(needle)}.`, EXIT.usage)
          process.stdout.write(`${only.id}\n`)
          return
        }

        process.stdout.write(options.json ? `${JSON.stringify(found, null, 2)}\n` : renderPeers(found))
      })
    })
}
