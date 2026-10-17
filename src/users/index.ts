import type { Chat, FullUser, TelegramClient, User } from '@mtcute/node'
import { foldAccents } from '../peers/index.js'
import { reading } from '../reads/errors.js'

/**
 * People: `tg user info` and `tg contacts list`.
 *
 * Reads only. One thing is left out on purpose and stays out: PHONE NUMBERS. A
 * contact's number is another person's data, `tg session phones` already masks
 * the operator's own, and TASK-43 section 6 keeps phone-book enumeration to what
 * `check-phones` does with its own pacing. No row here has a `phone` field, so
 * `--json` cannot be used to export the address book.
 */

const minute = (date: Date | null | undefined): string => (date ? date.toISOString().slice(0, 16) : '')

/** A person, flattened. Fields after `language` come from the full profile. */
export interface UserInfoRow {
  id: number
  name: string
  username: string | null
  usernames: string[]
  self: boolean
  bot: boolean
  verified: boolean
  premium: boolean
  scam: boolean
  fake: boolean
  restricted: boolean
  deleted: boolean
  contact: boolean
  mutualContact: boolean
  closeFriend: boolean
  /** online | offline | recently | within_week | within_month | long_time_ago | bot. Coarse, as Telegram gives it. */
  status: string
  /** ISO to the minute, only when Telegram reports an exact time. */
  lastOnline: string
  language: string | null
  bio?: string
  /** Whether this account has blocked them. */
  blocked?: boolean
  commonChatsCount?: number
  pinnedMessageId?: number | null
  /** Chats this account shares with them, only with `common: true`. */
  commonChats?: { id: number; title: string; kind: string }[]
}

function basicRow(user: User): UserInfoRow {
  const usernames = (user.usernames ?? []).filter((u) => u.active !== false).map((u) => u.username)
  if (user.username && !usernames.includes(user.username)) usernames.unshift(user.username)

  return {
    id: user.id,
    name: user.displayName,
    username: user.username ?? null,
    usernames,
    self: user.isSelf,
    bot: user.isBot,
    verified: user.isVerified,
    premium: user.isPremium,
    scam: user.isScam,
    fake: user.isFake,
    restricted: user.isRestricted,
    deleted: user.isDeleted,
    contact: user.isContact,
    mutualContact: user.isMutualContact,
    closeFriend: user.isCloseFriend,
    status: user.status,
    lastOnline: minute(user.lastOnline),
    language: user.language ?? null
  }
}

function fullRow(user: FullUser): UserInfoRow {
  return {
    ...basicRow(user),
    bio: user.bio,
    blocked: user.isBlocked,
    commonChatsCount: user.commonChatsCount,
    pinnedMessageId: user.pinnedMsgId ?? null
  }
}

const chatRow = (chat: Chat): { id: number; title: string; kind: string } => ({
  id: chat.id,
  title: chat.title,
  kind: chat.chatType
})

/**
 * One person: basic (one request) or full, optionally with the chats you share.
 *
 * Takes a positive numeric id; a chat's id is refused by the command before this
 * is reached, with a pointer to `tg chat info`.
 */
export async function userInfo(
  tg: TelegramClient,
  userId: number,
  options: { basic?: boolean | undefined; common?: boolean | undefined } = {}
): Promise<UserInfoRow> {
  const row = await reading(async () => (options.basic ? basicRow(await tg.getUser(userId)) : fullRow(await tg.getFullUser(userId))))
  if (options.common) {
    row.commonChats = (await reading(() => tg.getCommonChats(userId))).map(chatRow)
  }
  return row
}

export function renderUserInfo(row: UserInfoRow): string {
  const handle = row.username ? ` @${row.username}` : ''
  const lines = [`${row.name}${handle} [id ${row.id}]`]

  const marks = [
    [row.self, 'you'],
    [row.bot, 'bot'],
    [row.verified, 'verified'],
    [row.premium, 'premium'],
    [row.scam, 'SCAM'],
    [row.fake, 'FAKE'],
    [row.restricted, 'restricted'],
    [row.deleted, 'deleted account'],
    [row.blocked === true, 'blocked by you']
  ] as const
  const set = marks.filter(([on]) => on).map(([, label]) => label)
  if (set.length > 0) lines.push(`  ${set.join(', ')}`)

  const relation = row.mutualContact ? 'mutual contact' : row.contact ? 'contact' : 'not a contact'
  lines.push(`  ${relation}${row.closeFriend ? ', close friend' : ''}`)

  const seen = row.lastOnline ? `${row.status}, ${row.lastOnline}` : row.status
  lines.push(`  last seen: ${seen}${row.language ? `  language ${row.language}` : ''}`)

  if (row.usernames.length > 1) lines.push(`  usernames: ${row.usernames.map((u) => `@${u}`).join(' ')}`)
  if (row.commonChatsCount) lines.push(`  ${row.commonChatsCount} chats in common`)
  if (row.pinnedMessageId) lines.push(`  pinned message #${row.pinnedMessageId}`)
  if (row.bio) lines.push(`  bio: ${row.bio.replace(/\s+/g, ' ').trim()}`)
  if (row.commonChats && row.commonChats.length > 0) {
    lines.push('  chats in common:')
    for (const chat of row.commonChats) lines.push(`    ${chat.title} (${chat.kind}) [id ${chat.id}]`)
  }
  return `${lines.join('\n')}\n`
}

/* --------------------------------------------------------------- contacts */

export interface ContactRow {
  id: number
  name: string
  username: string | null
  mutual: boolean
  closeFriend: boolean
  bot: boolean
  premium: boolean
}

/**
 * The address book, by name, optionally filtered and cut.
 *
 * `getContacts` is one request that returns the whole list, so `query` and `limit`
 * are applied here, after it. No phone numbers and no last-seen: see the note at
 * the top of this file.
 */
export async function contactsList(
  tg: TelegramClient,
  options: { query?: string | undefined; limit?: number | undefined } = {}
): Promise<ContactRow[]> {
  const people = await reading(() => tg.getContacts())
  const needle = options.query ? foldAccents(options.query) : null

  const rows = people
    .map((user): ContactRow => ({
      id: user.id,
      name: user.displayName,
      username: user.username ?? null,
      mutual: user.isMutualContact,
      closeFriend: user.isCloseFriend,
      bot: user.isBot,
      premium: user.isPremium
    }))
    .filter((row) => !needle || foldAccents(`${row.name} ${row.username ?? ''}`).includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id)

  return options.limit === undefined ? rows : rows.slice(0, options.limit)
}

export function renderContacts(rows: ContactRow[]): string {
  if (rows.length === 0) return 'no contacts\n'

  return `${rows
    .map((row) => {
      const marks = [row.mutual ? 'mutual' : null, row.closeFriend ? 'close friend' : null, row.bot ? 'bot' : null, row.premium ? 'premium' : null]
        .filter((mark): mark is string => mark !== null)
      return `${String(row.id).padStart(12)}  ${row.name}${row.username ? ` (@${row.username})` : ''}${marks.length > 0 ? `  ${marks.join(' ')}` : ''}`
    })
    .join('\n')}\n`
}
