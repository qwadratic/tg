import type { Command } from 'commander'
import {
  DEFAULT_THREAD_DEPTH,
  MAX_MESSAGE_IDS,
  MAX_THREAD_DEPTH,
  assertMessageLink,
  getMessageRows,
  messageFromLink,
  messageThread,
  renderMessages,
  renderThread
} from '../../messages/read.js'
import {
  SEARCH_FILTERS,
  isSearchFilter,
  normalizeHashtag,
  searchLive,
  type SearchFilterName,
  type SearchScope
} from '../../messages/search.js'
import { parsePeerRef } from '../../peers/ref.js'
import { OperatorError } from '../../errors.js'
import { EXIT } from '../../exit-codes.js'
import { parseLimit, parseMessageIds, parseSince, parseUserIds } from '../args.js'
import { runCommand } from '../errors.js'
import { notFound, printResult, requirePerson, resolveReadPeer, withAuthenticatedClient } from './shared.js'

/**
 * `tg msg` - read messages from Telegram: by id, by link, in context, and by
 * searching.
 *
 * Read-only. `msg search` is the LIVE search (it asks Telegram); the offline
 * search over the archive is TASK-26's `tg search`, a different verb on purpose.
 */
export function registerMsgCommand(program: Command): void {
  const msg = program
    .command('msg')
    .description('Read messages from Telegram: by id, by link, in context, or by search (read-only)')
    .action(() => msg.help())

  msg
    .command('get <peer> <ids...>')
    .description(`Read messages by id, in full (at most ${MAX_MESSAGE_IDS} per call)`)
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, ids: string[], options: { json?: boolean }) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        const wanted = parseMessageIds(ids, MAX_MESSAGE_IDS)

        const { target, result } = await withAuthenticatedClient(async (tg) => {
          const target = await resolveReadPeer(tg, peer, 'reading')
          return { target, result: await getMessageRows(tg, target.id, wanted) }
        })

        if (result.rows.length === 0) {
          throw notFound(`None of message ${wanted.join(', ')} exists in chat ${target.id} (or this account cannot see it).`)
        }
        printResult(options.json, { chatId: target.id, messages: result.rows, missing: result.missing }, () =>
          renderMessages(result.rows) + (result.missing.length > 0 ? `not found: ${result.missing.join(', ')}\n` : '')
        )
      })
    })

  msg
    .command('link <url>')
    .description('Read the message a t.me link points at (https://t.me/name/123 or https://t.me/c/<chat>/123)')
    .option('--json', 'Machine-readable output')
    .action(async (url: string, options: { json?: boolean }) => {
      await runCommand(async () => {
        // Checked before a session is opened: a mistyped or invite link costs nothing.
        assertMessageLink(url)

        const row = await withAuthenticatedClient((tg) => messageFromLink(tg, url))
        if (!row) throw notFound(`Telegram has no message at ${url} (deleted, or this account cannot see it).`)
        printResult(options.json, row, () => renderMessages([row]))
      })
    })

  msg
    .command('thread <peer> <id>')
    .description('Read one message in context: what it replies to, its album, and where a channel post\'s comments live')
    .option('--depth <n>', `How many replied-to messages to climb (default ${DEFAULT_THREAD_DEPTH}, at most ${MAX_THREAD_DEPTH})`)
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, id: string, options: { depth?: string; json?: boolean }) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        const [messageId] = parseMessageIds([id], 1)
        const depth = options.depth === undefined ? undefined : parseLimit(options.depth, DEFAULT_THREAD_DEPTH, MAX_THREAD_DEPTH)

        const view = await withAuthenticatedClient(async (tg) => {
          const target = await resolveReadPeer(tg, peer, 'reading')
          return messageThread(tg, target.id, messageId as number, { depth })
        })

        if (!view) throw notFound(`Message ${messageId} does not exist in that chat (or this account cannot see it).`)
        printResult(options.json, view, () => renderThread(view))
      })
    })

  msg
    .command('search <query>')
    .description('Search Telegram live, newest first. Pick one scope: --chat <peer>, --global, --hashtag or --posts')
    .option('--chat <peer>', 'Search inside one chat')
    .option('--global', 'Search across all of your chats')
    .option('--hashtag', 'The query is a hashtag, searched across all of Telegram')
    .option('--posts', 'Search public channel posts across Telegram (free up to Telegram\'s daily allowance; tg never pays)')
    .option('--filter <kind>', `Only messages of this kind, with --chat or --global: ${Object.keys(SEARCH_FILTERS).join(', ')}`)
    .option('--from <id>', 'Only messages by this user (numeric id), with --chat')
    .option('--since <date>', 'Only messages from this date on, with --chat or --global')
    .option('--until <date>', 'Only messages up to the end of this date, with --chat or --global')
    .option('--limit <n>', 'How many results (default 50, at most 500)')
    .option('--json', 'Machine-readable output')
    .action(async (query: string, options: {
      chat?: string; global?: boolean; hashtag?: boolean; posts?: boolean
      filter?: string; from?: string; since?: string; until?: string; limit?: string; json?: boolean
    }) => {
      await runCommand(async () => {
        const scopes = [options.chat !== undefined, options.global, options.hashtag, options.posts].filter(Boolean).length
        if (scopes !== 1) {
          throw new OperatorError(
            'Pick exactly one scope: --chat <peer>, --global, --hashtag or --posts. ' +
            'A search with no scope would silently cover only private chats and small groups.',
            EXIT.usage
          )
        }
        if (!query.trim()) throw new OperatorError('Give something to search for.', EXIT.usage)

        const wide = options.chat !== undefined || options.global
        for (const [flag, value] of [['--filter', options.filter], ['--since', options.since], ['--until', options.until]] as const) {
          if (value !== undefined && !wide) {
            throw new OperatorError(`${flag} works with --chat and --global; Telegram does not filter ${options.hashtag ? 'hashtag' : 'public-post'} searches.`, EXIT.usage)
          }
        }
        if (options.from !== undefined && options.chat === undefined) {
          throw new OperatorError('--from works with --chat only.', EXIT.usage)
        }

        if (options.chat !== undefined) parsePeerRef(options.chat)
        if (options.hashtag) normalizeHashtag(query)
        const limit = parseLimit(options.limit, 50, 500)
        const filter = options.filter === undefined ? undefined : checkFilter(options.filter)
        const from = options.from === undefined ? undefined : parseUserIds([options.from], '--from', 1)[0]
        const since = options.since === undefined ? undefined : parseSince(options.since)
        const until = options.until === undefined ? undefined : endOfDay(parseSince(options.until))

        const result = await withAuthenticatedClient(async (tg) => {
          let scope: SearchScope
          if (options.chat !== undefined) {
            const target = await resolveReadPeer(tg, options.chat, 'searching')
            scope = { kind: 'chat', chatId: target.id }
          } else if (options.global) scope = { kind: 'global' }
          else if (options.hashtag) scope = { kind: 'hashtag' }
          else scope = { kind: 'posts' }

          if (from !== undefined) {
            // Resolve then show, like every peer (D17): the operator sees WHO the filter is aimed at.
            requirePerson(await resolveReadPeer(tg, String(from), 'only messages from'), 'tg msg search --from', 'a user id')
          }

          return searchLive(tg, scope, query, { limit, filter, from, since, until })
        })

        if (result.rows.length === 0) throw notFound(`Nothing matches ${JSON.stringify(query)}.`)
        const scope = options.chat !== undefined ? 'chat' : options.global ? 'global' : options.hashtag ? 'hashtag' : 'posts'
        printResult(options.json, { scope, query, messages: result.rows, ...(result.quota ? { quota: result.quota } : {}) }, () =>
          renderMessages(result.rows, { withChat: options.chat === undefined })
        )
      })
    })
}

/** `--until 2026-10-17` means that whole day, so the bound is the start of the next one. */
function endOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1)
}

function checkFilter(name: string): SearchFilterName {
  if (!isSearchFilter(name)) {
    throw new OperatorError(`--filter must be one of: ${Object.keys(SEARCH_FILTERS).join(', ')}. Got ${JSON.stringify(name)}.`, EXIT.usage)
  }
  return name
}
