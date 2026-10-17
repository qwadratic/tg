import type { Command } from 'commander'
import chalk from 'chalk'
import { dumpThread, renderDump } from '../../dump/index.js'
import { runCommand, handlePlainError } from '../errors.js'
import { OperatorError } from '../../errors.js'
import { EXIT } from '../../exit-codes.js'
import { withAuthenticatedClient } from './shared.js'
import { parseMessageIds, parseSince } from '../args.js'
import { describePeer, parsePeerRef, resolvePeerRef } from '../../peers/ref.js'

/**
 * `tg dump <peer>` - one chat as a flat transcript on stdout.
 *
 * Errors go to stderr in plain text and the payload goes to stdout, so this
 * pipes: `tg dump @durov --since last-7-days > thread.txt`.
 */
export function registerDumpCommand(program: Command): void {
  program
    .command('dump <peer>')
    .description('Print one chat as a flat chronological transcript (id, @username, t.me link or me)')
    .option('--since <date>', 'Stop at messages older than this')
    .option('--limit <n>', 'Maximum messages to read', '600')
    .option('--topic <id>', "Read one forum topic only; its id is the topic's first message id (see: tg group topic-list)")
    .option('--thread <id>', 'Read only the replies under one message: a reply thread, or the comments of a post in its discussion chat')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, options: { since?: string; limit: string; topic?: string; thread?: string; json?: boolean }) => {
      await runCommand(async () => {
        // Validate every argument BEFORE opening a session. Otherwise a typo in
        // --since costs a connection and the single-instance lock, and reports
        // the wrong problem first.
        //
        // Shape-checked offline first, so a malformed reference costs no
        // connection. The identity behind it is resolved after connecting.
        parsePeerRef(peer)
        const since = options.since ? parseSince(options.since) : undefined
        const limit = Number.parseInt(options.limit, 10)
        if (!Number.isFinite(limit) || limit <= 0) {
          throw new OperatorError(`--limit must be a positive number, got ${options.limit}`)
        }
        if (options.topic !== undefined && options.thread !== undefined) {
          throw new OperatorError('Give --topic or --thread, not both: a topic IS a thread, named by its first message.', EXIT.usage)
        }
        const threadFlag = options.topic !== undefined ? '--topic' : '--thread'
        const threadRaw = options.topic ?? options.thread
        const [threadId] = threadRaw === undefined ? [undefined] : parseMessageIds([threadRaw], 1, threadFlag)

        const lines = await withAuthenticatedClient(async (tg) => {
          const target = await resolvePeerRef(tg, peer)
          // stderr, so the payload on stdout stays pipeable. The operator sees
          // WHICH chat this actually was, which is the check that a username or
          // a bare id cannot give them by itself.
          console.error(chalk.dim(`reading ${describePeer(target)}${threadId === undefined ? '' : `, ${threadFlag.slice(2)} ${threadId}`}`))
          return dumpThread(tg, target.id, { limit, since, threadId })
        })

        process.stdout.write(
          options.json ? `${JSON.stringify(lines, null, 2)}\n` : renderDump(lines)
        )
      }, handlePlainError)
    })
}
