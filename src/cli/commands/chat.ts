import type { Command } from 'commander'
import { CHAT_EVENT_TYPES, chatInfo, chatLog, renderChatInfo, renderChatLog } from '../../chats/index.js'
import { parsePeerRef } from '../../peers/ref.js'
import { peerKindOf } from '../../peers/id.js'
import { OperatorError } from '../../errors.js'
import { EXIT } from '../../exit-codes.js'
import { parseChoices, parseLimit, parseUserIds } from '../args.js'
import { runCommand } from '../errors.js'
import { printResult, requireChat, resolveReadPeer, withAuthenticatedClient } from './shared.js'

/**
 * `tg chat` - what a group, supergroup or channel is, and what happened in it.
 *
 * Read-only: nothing here changes a chat, so it is not behind the send fence and
 * cannot import the send module. See backlog/decisions/2026-10-17-core-reads-and-fence-hardening.md.
 */
export function registerChatCommand(program: Command): void {
  const chat = program
    .command('chat')
    .description('Read what a group or channel is, and its admin log (read-only)')
    .action(() => chat.help())

  chat
    .command('info <peer>')
    .description('Show a group, supergroup or channel: kind, members, settings, description (id, @username, t.me link)')
    .option('--basic', 'One cheap request: skip the description, admin counts and settings')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, options: { basic?: boolean; json?: boolean }) => {
      await runCommand(async () => {
        parsePeerRef(peer)

        const row = await withAuthenticatedClient(async (tg) => {
          const target = await resolveReadPeer(tg, peer, 'reading')
          requireChat(target, 'tg chat info', `tg user info ${target.id}`)
          return chatInfo(tg, target.id, { basic: options.basic })
        })

        printResult(options.json, row, () => renderChatInfo(row))
      })
    })

  chat
    .command('log <peer>')
    .description("Read a supergroup or channel's admin log, newest first (needs admin rights; Telegram keeps it for 48 hours)")
    .option('--type <types>', `Only these actions, comma separated: ${CHAT_EVENT_TYPES.slice(0, 5).join(', ')}, ...`)
    .option('--user <ids>', 'Only actions by these admins (numeric ids, comma separated or repeated)', collect, [] as string[])
    .option('--query <text>', "Telegram's own text search over the log")
    .option('--limit <n>', 'How many events to read (default 100, at most 1000)')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, options: { type?: string; user: string[]; query?: string; limit?: string; json?: boolean }) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        const limit = parseLimit(options.limit, 100, 1000)
        const types = options.type === undefined ? undefined : parseChoices(options.type, '--type', CHAT_EVENT_TYPES)
        const users = options.user.length === 0 ? undefined : parseUserIds(options.user, '--user', 50)

        const rows = await withAuthenticatedClient(async (tg) => {
          const target = await resolveReadPeer(tg, peer, 'reading the admin log of')
          requireChat(target, 'tg chat log', `tg user info ${target.id}`)
          if (peerKindOf(target.id) !== 'channel') {
            throw new OperatorError(
              'The admin log exists for supergroups and channels. A legacy group has none: tg chat info shows what it is.',
              EXIT.usage
            )
          }
          return chatLog(tg, target.id, { limit, types, users, query: options.query })
        })

        printResult(options.json, rows, () => renderChatLog(rows))
      })
    })
}

/** commander option collector: `--user 1 --user 2` and `--user 1,2` both work. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value]
}
