import type { Command } from 'commander'
import { renderDialogs, showDialogs } from '../../dialogs/index.js'
import { parsePeerRef } from '../../peers/ref.js'
import { OperatorError } from '../../errors.js'
import { EXIT } from '../../exit-codes.js'
import { runCommand } from '../errors.js'
import { notFound, printResult, resolveReadPeer, withAuthenticatedClient } from './shared.js'

/** Resolving each chat is a request of its own, so a call is bounded. */
const MAX_DIALOGS = 20

/**
 * `tg dialogs show <peers...>` - where chats stand in your chat list: unread,
 * pinned, muted, archived, what was said last. Read-only.
 */
export function registerDialogsCommand(program: Command): void {
  const dialogs = program
    .command('dialogs')
    .description('Read where chats stand in your chat list (read-only)')
    .action(() => dialogs.help())

  dialogs
    .command('show <peers...>')
    .description(`Show the dialog of each chat: unread counts, pinned, muted, archived, last message (at most ${MAX_DIALOGS})`)
    .option('--json', 'Machine-readable output')
    .action(async (peers: string[], options: { json?: boolean }) => {
      await runCommand(async () => {
        if (peers.length > MAX_DIALOGS) {
          throw new OperatorError(`At most ${MAX_DIALOGS} chats per call, got ${peers.length}.`, EXIT.usage)
        }
        for (const peer of peers) parsePeerRef(peer)

        const result = await withAuthenticatedClient(async (tg) => {
          const ids: number[] = []
          for (const peer of peers) ids.push((await resolveReadPeer(tg, peer, 'reading')).id)
          return showDialogs(tg, [...new Set(ids)])
        })

        if (result.rows.length === 0) throw notFound('None of those chats has a dialog in your chat list.')
        printResult(options.json, { dialogs: result.rows, missing: result.missing }, () =>
          renderDialogs(result.rows) + (result.missing.length > 0 ? `no dialog for: ${result.missing.join(', ')}\n` : '')
        )
      })
    })
}
