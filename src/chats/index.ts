import type { ChatAction, ChatEvent, FullChat, Chat, TelegramClient } from '@mtcute/node'
import { adminRightNames } from '../groups/rights.js'
import { paced, pageSizeFor } from '../messages/fetch.js'
import { reading, readingEach } from '../reads/errors.js'

/**
 * What a chat is, and what happened in it: `tg chat info` and `tg chat log`.
 *
 * Reads only, so none of it is behind the send fence and none of it can reach
 * `src/send/` (eval-31 derives that from the import graph). Rendering is pure, like
 * `renderPeers` and `renderDump`, so a golden can pin it.
 */

const minute = (date: Date | null | undefined): string => (date ? date.toISOString().slice(0, 16) : '')

/** One line's worth of a name, with the id that makes it unambiguous. */
const named = (id: number, name: string): string => `${name} [id ${id}]`

/* ------------------------------------------------------------- chat info */

/**
 * A chat, flattened. The fields after `joined` come from the full profile and are
 * absent from a `--basic` read, which is one request cheaper.
 */
export interface ChatInfoRow {
  id: number
  /** group | supergroup | channel | gigagroup | monoforum. */
  kind: string
  title: string
  username: string | null
  /** Every active username, the primary one first. */
  usernames: string[]
  verified: boolean
  scam: boolean
  fake: boolean
  restricted: boolean
  forum: boolean
  /** This account's own standing in the chat. */
  creator: boolean
  admin: boolean
  member: boolean
  protectedContent: boolean
  joinRequests: boolean
  joinToSend: boolean
  members: number | null
  /** ISO to the minute, or '' when Telegram does not say. */
  created: string
  joined: string
  description?: string
  admins?: number
  banned?: number | null
  online?: number
  slowModeSeconds?: number | null
  autoDeleteSeconds?: number | null
  linkedChatId?: number | null
  pinnedMessageId?: number | null
  pendingJoinRequests?: number
  unread?: number
  archived?: boolean
}

/**
 * How many members, as far as Telegram says.
 *
 * `FullChat.membersCount` is the channel's own figure and reads 0 for a basic
 * group, so when it is empty the count on the chat object it extends is used
 * instead. Telegram gives no count at all for some chats: null, not zero.
 */
function membersOf(chat: Chat): number | null {
  const raw = (chat as { raw?: object }).raw
  const fromChat = raw !== undefined && 'participantsCount' in raw ? ((raw as { participantsCount?: number | null }).participantsCount ?? null) : null
  const count = chat.membersCount
  return count ? count : (fromChat ?? count ?? null)
}

/** The chat a channel is linked to, tolerating one Telegram did not send along. */
function linkedChatOf(chat: FullChat): number | null {
  try {
    return chat.linkedChat?.id ?? null
  } catch {
    return null
  }
}

function basicRow(chat: Chat): ChatInfoRow {
  const usernames = (chat.usernames ?? []).filter((u) => u.active !== false).map((u) => u.username)
  if (chat.username && !usernames.includes(chat.username)) usernames.unshift(chat.username)

  return {
    id: chat.id,
    kind: chat.chatType,
    title: chat.title,
    username: chat.username ?? null,
    usernames,
    verified: chat.isVerified,
    scam: chat.isScam,
    fake: chat.isFake,
    restricted: chat.isRestricted,
    forum: chat.isForum,
    creator: chat.isCreator,
    admin: chat.isAdmin,
    member: chat.isMember,
    protectedContent: chat.hasContentProtection,
    joinRequests: chat.hasJoinRequests,
    joinToSend: chat.hasJoinToSend,
    members: membersOf(chat),
    created: minute(chat.creationDate),
    joined: minute(chat.joinDate)
  }
}

function fullRow(chat: FullChat): ChatInfoRow {
  return {
    ...basicRow(chat),
    description: chat.bio,
    admins: chat.adminsCount,
    banned: chat.bannedCount ?? chat.kickedCount ?? null,
    online: chat.onlineCount,
    slowModeSeconds: chat.slowmodeSeconds ?? null,
    autoDeleteSeconds: chat.ttlPeriod ?? null,
    linkedChatId: linkedChatOf(chat),
    pinnedMessageId: chat.pinnedMsgId ?? null,
    pendingJoinRequests: chat.pendingJoinRequests,
    unread: chat.unreadCount,
    archived: chat.isArchived
  }
}

/**
 * Basic or full information about one group, supergroup or channel.
 *
 * The invite link a full profile carries is deliberately not reported: it is the
 * chat's primary link, which `tg group invite-list` shows to an admin who asked
 * for it, and an agent that read the profile of every chat it was asked about
 * should not end up holding them all.
 */
export async function chatInfo(tg: TelegramClient, chatId: number, options: { basic?: boolean | undefined } = {}): Promise<ChatInfoRow> {
  return reading(async () => (options.basic ? basicRow(await tg.getChat(chatId)) : fullRow(await tg.getFullChat(chatId))))
}

const count = (value: number): string => value.toLocaleString('en-US')

export function renderChatInfo(row: ChatInfoRow): string {
  const handle = row.username ? ` @${row.username}` : ''
  const lines = [`${row.title} (${row.kind})${handle} [id ${row.id}]`]

  const marks = [
    [row.verified, 'verified'],
    [row.forum, 'forum'],
    [row.scam, 'SCAM'],
    [row.fake, 'FAKE'],
    [row.restricted, 'restricted'],
    [row.protectedContent, 'content protected'],
    [row.joinRequests, 'join requests'],
    [row.joinToSend, 'join to send']
  ] as const
  const set = marks.filter(([on]) => on).map(([, label]) => label)
  if (set.length > 0) lines.push(`  ${set.join(', ')}`)

  const people = [
    row.members === null ? null : `${count(row.members)} members`,
    row.admins === undefined ? null : `${count(row.admins)} admins`,
    row.online ? `${count(row.online)} online` : null,
    row.banned ? `${count(row.banned)} banned` : null
  ].filter((part): part is string => part !== null)
  if (people.length > 0) lines.push(`  ${people.join(', ')}`)

  if (row.usernames.length > 1) lines.push(`  usernames: ${row.usernames.map((u) => `@${u}`).join(' ')}`)

  const settings = [
    row.slowModeSeconds ? `slow mode ${row.slowModeSeconds}s` : null,
    row.autoDeleteSeconds ? `auto-delete ${row.autoDeleteSeconds}s` : null,
    row.linkedChatId ? `linked chat ${row.linkedChatId}` : null,
    row.pinnedMessageId ? `pinned message #${row.pinnedMessageId}` : null,
    row.pendingJoinRequests ? `${row.pendingJoinRequests} join requests waiting` : null
  ].filter((part): part is string => part !== null)
  if (settings.length > 0) lines.push(`  ${settings.join(', ')}`)

  const you = [
    row.creator ? 'creator' : row.admin ? 'admin' : row.member ? 'member' : 'not a member',
    row.archived ? 'archived' : null,
    row.unread ? `${row.unread} unread` : null
  ].filter((part): part is string => part !== null)
  lines.push(`  you: ${you.join(', ')}`)

  const dates = [row.created ? `created ${row.created}` : null, row.joined ? `joined ${row.joined}` : null].filter(
    (part): part is string => part !== null
  )
  if (dates.length > 0) lines.push(`  ${dates.join(', ')}`)

  if (row.description) lines.push(`  description: ${row.description.replace(/\s+/g, ' ').trim()}`)
  return `${lines.join('\n')}\n`
}

/* -------------------------------------------------------------- chat log */

/** The action types Telegram's admin log knows, as mtcute names them. */
export const CHAT_EVENT_TYPES = [
  'user_joined', 'user_joined_invite', 'user_joined_approved', 'user_left', 'user_invited',
  'title_changed', 'description_changed', 'username_changed', 'usernames_changed', 'photo_changed',
  'invites_toggled', 'signatures_toggled', 'msg_pinned', 'msg_edited', 'msg_deleted', 'msg_sent',
  'user_perms_changed', 'user_admin_perms_changed', 'stickerset_changed', 'history_toggled',
  'def_perms_changed', 'poll_stopped', 'linked_chat_changed', 'location_changed', 'slow_mode_changed',
  'call_started', 'call_ended', 'call_setting_changed', 'invite_deleted', 'invite_edited', 'invite_revoked',
  'ttl_changed', 'no_forwards_toggled', 'forum_toggled', 'topic_created', 'topic_edited', 'topic_deleted',
  'signature_profiles_toggled', 'sub_extend', 'available_reactions_changed', 'emoji_status_changed',
  'emoji_stickerset_changed', 'peer_color_changed', 'profile_peer_color_changed', 'wallpaper_changed',
  'toggle_anti_spam', 'toggle_autotranslation'
] as const satisfies readonly Exclude<ChatAction, null>['type'][]

export type ChatEventType = (typeof CHAT_EVENT_TYPES)[number]

/** One entry of the admin log ("Recent actions" in Telegram's clients). */
export interface ChatEventRow {
  /** Telegram's event id, as text: it is a 64-bit number. Bigger is newer. */
  id: string
  at: string
  actor: { id: number; name: string }
  /** The action type, as mtcute names it (`title_changed`), or `unknown`. */
  action: string
  /** What changed, in a line. Never a link: invite links are credentials. */
  detail: string
}

const clip = (text: string, width = 80): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat
}
const onOff = (value: boolean): string => (value ? 'on' : 'off')

/** The name of a user an event mentions, tolerating one Telegram did not send. */
function personOf(read: () => { id: number; displayName: string }): string {
  try {
    const user = read()
    return named(user.id, user.displayName)
  } catch {
    return 'someone Telegram did not name'
  }
}

/**
 * One action, in a line.
 *
 * Unknown action types fall through to an empty detail rather than failing: an
 * mtcute that learns a new kind of event must not turn a log read into a crash,
 * and the type is still reported.
 */
export function describeChatAction(action: ChatAction): string {
  if (action === null) return ''
  switch (action.type) {
    case 'user_joined_invite':
      return 'through an invite link'
    case 'user_joined_approved':
      return `approved by ${personOf(() => action.approvedBy)}`
    case 'user_invited':
      return `invited ${personOf(() => action.member.user)}`
    case 'title_changed':
    case 'description_changed':
    case 'username_changed':
      return `${clip(action.old) || '(empty)'} -> ${clip(action.new) || '(empty)'}`
    case 'usernames_changed':
      return `${action.old.join(',') || '(none)'} -> ${action.new.join(',') || '(none)'}`
    case 'invites_toggled':
    case 'signatures_toggled':
    case 'history_toggled':
      return `${onOff(action.old)} -> ${onOff(action.new)}`
    case 'msg_pinned':
    case 'msg_deleted':
    case 'poll_stopped':
    case 'msg_sent':
      return `message #${action.message.id}${action.message.text ? `: ${clip(action.message.text)}` : ''}`
    case 'msg_edited':
      return `message #${action.new.id}: ${clip(action.old.text) || '(no text)'} -> ${clip(action.new.text) || '(no text)'}`
    case 'user_perms_changed':
      return `${personOf(() => action.new.user)}: ${action.old.status} -> ${action.new.status}`
    case 'user_admin_perms_changed': {
      const before = adminRightNames(action.old.permissions)
      const after = adminRightNames(action.new.permissions)
      const gained = after.filter((right) => !before.includes(right)).map((right) => `+${right}`)
      const lost = before.filter((right) => !after.includes(right)).map((right) => `-${right}`)
      const rights = [...gained, ...lost].join(' ')
      return `${personOf(() => action.new.user)}: ${action.old.status} -> ${action.new.status}${rights ? ` (${rights})` : ''}`
    }
    case 'linked_chat_changed':
      return `${action.old || 'none'} -> ${action.new || 'none'}`
    case 'slow_mode_changed':
    case 'ttl_changed':
      return `${action.old}s -> ${action.new}s`
    case 'call_setting_changed':
      return `members join muted: ${onOff(action.joinMuted)}`
    case 'invite_deleted':
    case 'invite_edited':
    case 'invite_revoked':
      return 'an invite link'
    case 'no_forwards_toggled':
    case 'forum_toggled':
    case 'toggle_anti_spam':
    case 'toggle_autotranslation':
      return onOff(action.enabled)
    case 'signature_profiles_toggled':
      return onOff(action.new)
    case 'topic_created':
    case 'topic_deleted':
      return `topic "${clip(action.topic.title, 60)}"`
    case 'topic_edited':
      return `topic "${clip(action.old.title, 60)}" -> "${clip(action.new.title, 60)}"`
    default:
      return ''
  }
}

function eventRow(event: ChatEvent): ChatEventRow {
  const action = event.action
  let name = 'someone Telegram did not name'
  try {
    name = event.actor.displayName
  } catch {
    // The actor was not in the batch Telegram sent; the id below is still true.
  }
  return {
    id: String(event.id),
    at: minute(event.date),
    actor: { id: event.raw.userId, name },
    action: action?.type ?? 'unknown',
    detail: describeChatAction(action)
  }
}

export interface ChatLogOptions {
  /** Newest this many events. */
  limit: number
  /** Only these action types. */
  types?: readonly ChatEventType[] | undefined
  /** Only actions by these admins (numeric ids). */
  users?: readonly number[] | undefined
  /** Telegram's own text search over the log. */
  query?: string | undefined
}

/**
 * The admin log of a supergroup or channel, newest first.
 *
 * Telegram answers only an admin: `CHAT_ADMIN_REQUIRED` comes back as exit 3, a
 * human must grant the right. Paged through the one paced walk, `limit` events at
 * most; when a type filter is given Telegram filters some types on its side and
 * mtcute the rest, so a page can be short without the log being over.
 */
export async function chatLog(tg: TelegramClient, chatId: number, options: ChatLogOptions): Promise<ChatEventRow[]> {
  const rows: ChatEventRow[] = []
  const events = paced(
    readingEach(
      tg.iterChatEventLog(chatId, {
        chunkSize: pageSizeFor(options.limit),
        ...(options.types && options.types.length > 0 ? { filters: [...options.types] } : {}),
        ...(options.users && options.users.length > 0 ? { users: [...options.users] } : {}),
        ...(options.query ? { query: options.query } : {})
      })
    ),
    { limit: options.limit }
  )

  for await (const event of events) rows.push(eventRow(event))
  return rows
}

export function renderChatLog(rows: ChatEventRow[]): string {
  if (rows.length === 0) return 'no events\n'

  return `${rows
    .map((row) => `${row.at}  ${named(row.actor.id, row.actor.name)}  ${row.action}${row.detail ? `  ${row.detail}` : ''}`)
    .join('\n')}\n`
}
