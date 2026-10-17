import type { PeerReaction, TelegramClient } from '@mtcute/node'
import { reading, readingEach } from '../reads/errors.js'
import { PAGE_SIZE, paced } from './fetch.js'

/**
 * Reactions to one message: how many of each, and with `--users` who.
 *
 * Reads only. This is the COUNTS and the NAMES; reacting, and marking reactions
 * read, are writes (a read receipt tells the other side a human is awake, D13a)
 * and are not here.
 */

export interface ReactionUserRow {
  userId: number
  name: string
  emoji: string
  /** Whether this account has not yet seen the reaction. */
  unread: boolean
}

export interface ReactionsRow {
  chatId: number
  messageId: number
  total: number
  counts: { emoji: string; count: number; paid: boolean }[]
  /**
   * Whether Telegram tells who reacted. A broadcast channel does not: its
   * reactions are counts only, and asking for names is refused (exit 2).
   */
  usersVisible: boolean
  /** The few most recent reactors Telegram sends along with the counts. */
  recent: ReactionUserRow[]
  /** Everyone, paged, only with `users: true`. */
  users?: ReactionUserRow[]
}

/** A reaction as text: the emoji itself, or `custom:<id>` for a custom emoji, which has none. */
export function reactionLabel(emoji: string | { toString(): string }): string {
  return typeof emoji === 'string' ? emoji : `custom:${emoji.toString()}`
}

function reactor(reaction: PeerReaction): ReactionUserRow {
  let name = '?'
  try {
    name = reaction.user.displayName
  } catch {
    // The user was not in the batch Telegram sent; the id is still true.
  }
  return { userId: reaction.userId, name, emoji: reactionLabel(reaction.emoji), unread: reaction.unread }
}

/** Where the next page of reactors starts, as mtcute hands it back. */
type ReactorOffset = NonNullable<Awaited<ReturnType<TelegramClient['getReactionUsers']>>['next']>

/**
 * Pages of the people who reacted, as one stream.
 *
 * Not `iterReactionUsers`: in mtcute 0.27.8 that iterator never ends. When the
 * last page has no next offset it starts again from the first one and yields the
 * same people until `limit`, so a message with two reactors would be read fifty
 * times over. This stops when Telegram gives no next page. The paced walk still
 * sets the speed.
 */
async function* reactorPages(tg: TelegramClient, chatId: number, messageId: number, limit: number): AsyncGenerator<PeerReaction> {
  let offset: ReactorOffset | undefined
  let yielded = 0

  for (;;) {
    const page = await tg.getReactionUsers({
      chatId,
      message: messageId,
      limit: Math.min(PAGE_SIZE, limit - yielded),
      ...(offset ? { offset } : {})
    })
    for (const reaction of page) {
      yield reaction
      yielded++
    }
    if (!page.next || page.length === 0) return
    offset = page.next
  }
}

/**
 * The reactions of one message, or null when Telegram has no such message.
 *
 * `limit` bounds the names read with `users`; the counts are always whole.
 */
export async function showReactions(
  tg: TelegramClient,
  chatId: number,
  messageId: number,
  options: { users?: boolean | undefined; limit?: number | undefined } = {}
): Promise<ReactionsRow | null> {
  const [msg] = await reading(() => tg.getMessages(chatId, messageId))
  if (!msg) return null

  const [reactions] = await reading(() => tg.getMessageReactions([msg]))
  const counts = (reactions?.reactions ?? []).map((r) => ({ emoji: reactionLabel(r.emoji), count: r.count, paid: r.isPaid }))

  const row: ReactionsRow = {
    chatId,
    messageId,
    total: counts.reduce((sum, c) => sum + c.count, 0),
    counts,
    usersVisible: reactions?.usersVisible ?? false,
    recent: (reactions?.recentReactions ?? []).map(reactor)
  }

  if (options.users) {
    const limit = options.limit ?? 100
    const people: ReactionUserRow[] = []
    for await (const reaction of paced(readingEach(reactorPages(tg, chatId, messageId, limit)), { limit })) {
      people.push(reactor(reaction))
    }
    row.users = people
  }
  return row
}

export function renderReactions(row: ReactionsRow): string {
  if (row.counts.length === 0) return `no reactions on message #${row.messageId}\n`

  const lines = [`message #${row.messageId}: ${row.total} reactions`]
  lines.push(`  ${row.counts.map((c) => `${c.emoji} ${c.count}${c.paid ? ' (paid)' : ''}`).join(', ')}`)
  if (!row.usersVisible) lines.push('  who reacted: not shown by Telegram for this chat')

  const people = row.users ?? row.recent
  if (people.length > 0) {
    lines.push(row.users ? '  who:' : '  most recent:')
    for (const p of people) lines.push(`    ${p.emoji}  ${p.name} [id ${p.userId}]${p.unread ? '  unread' : ''}`)
  }
  return `${lines.join('\n')}\n`
}
