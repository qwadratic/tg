import type { ChatMember, TelegramClient } from '@mtcute/node'
import { reading } from '../reads/errors.js'
import { adminRightNames, restrictionNames } from './rights.js'

/**
 * The READ half of group/channel administration.
 *
 * Deliberately separate from `src/send/index.ts`: listing invite links, the
 * people who used one, a chat's members and a forum's topics calls no write RPC, so none of it
 * belongs behind the send fence. Keeping it here means a future read verb can
 * use it without importing the module that can write.
 *
 * Rendering is pure, like `renderPeers`/`renderDump`, so a golden can pin it.
 */

/** One invite link, flattened. */
export interface InviteLinkRow {
  link: string
  primary: boolean
  revoked: boolean
  /** People who have joined through it. */
  usage: number
  /** 0 means unlimited. */
  usageLimit: number
  approvalNeeded: boolean
  /** ISO to the minute, or '' when the link never expires. */
  expires: string
}

/** One person who joined through an invite link. */
export interface InviteMemberRow {
  userId: number
  name: string
  at: string
  pending: boolean
}

/** One member of a chat. */
export interface ChatMemberRow {
  userId: number
  name: string
  username: string | null
  /** creator | admin | member | restricted | banned | left. */
  status: string
  /** An admin's custom title, or '' when there is none. */
  rank: string
  /** Kebab-case admin rights an admin holds (see `tg group promote`); empty for everyone else. */
  rights: string[]
  /** ISO to the minute, or '' when Telegram does not report it. */
  joined: string
}

export type ChatMemberType = 'all' | 'banned' | 'restricted' | 'bots' | 'recent' | 'admins' | 'contacts' | 'mention'

/** One forum topic. */
export interface ForumTopicRow {
  id: number
  title: string
  closed: boolean
  pinned: boolean
  unread: number
}

const minute = (date: Date | null | undefined): string =>
  date ? date.toISOString().slice(0, 16) : ''

/** Invite links created by the current account (or another admin). */
export async function listInviteLinks(
  tg: TelegramClient,
  chatId: number,
  options: { revoked?: boolean | undefined; limit?: number | undefined } = {}
): Promise<InviteLinkRow[]> {
  const links = await reading(() => tg.getInviteLinks(chatId, {
    ...(options.revoked ? { revoked: true } : {}),
    ...(options.limit === undefined ? {} : { limit: options.limit })
  }))

  return [...links].map((link) => ({
    link: link.link,
    primary: link.isPrimary,
    revoked: link.isRevoked,
    usage: link.usage,
    usageLimit: link.usageLimit,
    approvalNeeded: link.approvalNeeded,
    expires: minute(link.endDate)
  }))
}

/** People who joined through one invite link. */
export async function listInviteLinkMembers(
  tg: TelegramClient,
  chatId: number,
  options: { link?: string | undefined; limit?: number | undefined } = {}
): Promise<InviteMemberRow[]> {
  const members = await reading(() => tg.getInviteLinkMembers(chatId, {
    ...(options.link ? { link: options.link } : {}),
    ...(options.limit === undefined ? {} : { limit: options.limit })
  }))

  return [...members].map((member) => ({
    userId: member.user.id,
    name: member.user.displayName,
    at: minute(member.date),
    pending: member.isPendingRequest
  }))
}

/**
 * Members of a chat: who is in it, and in what role.
 *
 * A READ, so it lives here and not in `src/send/`: it needs no gate and no
 * budget, and the import graph keeps it that way (eval-31 walks this file).
 * Telegram returns at most 200 members whatever offset or limit is asked for;
 * that is the server's rule, not one invented here. `type` filters only apply to
 * supergroups and channels.
 */
export async function listChatMembers(
  tg: TelegramClient,
  chatId: number,
  options: {
    limit?: number | undefined
    type?: ChatMemberType | undefined
    query?: string | undefined
  } = {}
): Promise<ChatMemberRow[]> {
  const members = await reading(() => tg.getChatMembers(chatId, {
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.type === undefined ? {} : { type: options.type }),
    ...(options.query === undefined ? {} : { query: options.query })
  }))

  return [...members].map(memberRow)
}

/** One member, flattened the same way for a list and for a single lookup. */
function memberRow(member: ChatMember): ChatMemberRow {
  return {
    userId: member.user.id,
    name: member.user.displayName,
    username: member.user.username ?? null,
    status: member.status,
    rank: member.title ?? '',
    rights: member.status === 'admin' || member.status === 'creator' ? adminRightNames(member.permissions) : [],
    joined: minute(member.joinedDate)
  }
}

/** One member in full: the row, plus who put them there and what they may not do. */
export interface ChatMemberDetail extends ChatMemberRow {
  invitedBy: string | null
  promotedBy: string | null
  restrictedBy: string | null
  /** Kebab-case abilities taken away, for a restricted member; empty otherwise. */
  restrictions: string[]
  /** ISO to the minute when a restriction or ban ends; '' when it does not, or when there is none. */
  until: string
}

const by = (user: { id: number; displayName: string } | null): string | null =>
  user ? `${user.displayName} [id ${user.id}]` : null

/**
 * One person's standing in one chat, or null when they are not in it.
 *
 * `group members` lists up to 200 of them; this answers "is that person here, and
 * what are they", which the list cannot do for a large chat. A READ: it lives here
 * and not in `src/send/` for the reason `listChatMembers` does.
 */
export async function getChatMemberDetail(
  tg: TelegramClient,
  chatId: number,
  userId: number
): Promise<ChatMemberDetail | null> {
  const member = await reading(() => tg.getChatMember({ chatId, userId }))
  if (!member) return null

  return {
    ...memberRow(member),
    invitedBy: by(member.invitedBy),
    promotedBy: by(member.promotedBy),
    restrictedBy: by(member.restrictedBy),
    restrictions: restrictionNames(member.restrictions?.raw),
    until: minute(member.restrictions?.untilDate)
  }
}

/** Topics in a forum supergroup. */
export async function listForumTopics(
  tg: TelegramClient,
  chatId: number,
  options: { limit?: number | undefined } = {}
): Promise<ForumTopicRow[]> {
  const topics = await reading(() => tg.getForumTopics(chatId, {
    ...(options.limit === undefined ? {} : { limit: options.limit })
  }))

  return [...topics].map((topic) => ({
    id: topic.id,
    title: topic.title,
    closed: topic.isClosed,
    pinned: topic.isPinned,
    unread: topic.unreadCount
  }))
}

/** Flags as a compact suffix, or '' when none apply. */
function flags(pairs: [boolean, string][]): string {
  const on = pairs.filter(([set]) => set).map(([, label]) => label)
  return on.length > 0 ? `  ${on.join(' ')}` : ''
}

export function renderInviteLinks(rows: InviteLinkRow[]): string {
  if (rows.length === 0) return 'no invite links\n'

  return `${rows
    .map((row) => {
      const limit = row.usageLimit > 0 ? `/${row.usageLimit}` : ''
      return (
        `${row.link}  ${row.usage}${limit} joined` +
        flags([
          [row.primary, 'primary'],
          [row.revoked, 'revoked'],
          [row.approvalNeeded, 'approval'],
          [Boolean(row.expires), `expires ${row.expires}`]
        ])
      )
    })
    .join('\n')}\n`
}

export function renderInviteMembers(rows: InviteMemberRow[]): string {
  if (rows.length === 0) return 'no members joined via this link\n'

  return `${rows
    .map((row) => `${row.at}  ${row.userId}  ${row.name}${flags([[row.pending, 'pending']])}`)
    .join('\n')}\n`
}

export function renderChatMembers(rows: ChatMemberRow[]): string {
  if (rows.length === 0) return 'no members\n'

  return `${rows
    .map((row) => {
      const handle = row.username ? ` (@${row.username})` : ''
      return (
        `${String(row.userId).padStart(12)}  ${row.name}${handle}  ${row.status}` +
        flags([
          [Boolean(row.rank), `"${row.rank}"`],
          [row.rights.length > 0, `rights ${row.rights.join(',')}`],
          [Boolean(row.joined), `joined ${row.joined}`]
        ])
      )
    })
    .join('\n')}\n`
}

export function renderForumTopics(rows: ForumTopicRow[]): string {
  if (rows.length === 0) return 'no forum topics\n'

  return `${rows
    .map((row) =>
      `${String(row.id).padStart(6)}  ${row.title}` +
      flags([
        [row.closed, 'closed'],
        [row.pinned, 'pinned'],
        [row.unread > 0, `${row.unread} unread`]
      ])
    )
    .join('\n')}\n`
}

/** One member in full, as lines. Pure, so a golden can pin it. */
export function renderChatMember(row: ChatMemberDetail): string {
  const handle = row.username ? ` (@${row.username})` : ''
  const lines = [`${row.name}${handle} [id ${row.userId}]  ${row.status}${row.rank ? `  "${row.rank}"` : ''}`]
  if (row.rights.length > 0) lines.push(`  rights: ${row.rights.join(',')}`)
  if (row.restrictions.length > 0) {
    lines.push(`  may not: ${row.restrictions.join(',')}${row.until ? ` until ${row.until}` : ''}`)
  }
  if (row.joined) lines.push(`  joined ${row.joined}`)
  if (row.invitedBy) lines.push(`  invited by ${row.invitedBy}`)
  if (row.promotedBy) lines.push(`  promoted by ${row.promotedBy}`)
  if (row.restrictedBy) lines.push(`  restricted by ${row.restrictedBy}`)
  return `${lines.join('\n')}\n`
}
