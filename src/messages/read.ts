import type { Message, TelegramClient } from '@mtcute/node'
import { messageRefs, messageStats } from '../dump/index.js'
import { OperatorError } from '../errors.js'
import { EXIT } from '../exit-codes.js'
import { reading } from '../reads/errors.js'

/**
 * Messages by id, by link and by thread: the verbs that read ONE message and what
 * surrounds it (`tg msg get`, `link`, `thread`, `tg scheduled list`).
 *
 * Reads only. The shapes here are shared with live search and the reactions read,
 * so a message looks the same wherever it turns up.
 */

const minute = (date: Date | null | undefined): string => (date ? date.toISOString().slice(0, 16) : '')

/** One message, flattened. */
export interface MessageRow {
  id: number
  chatId: number
  chat: string
  /** ISO to the minute. For a scheduled message this is when it WILL be sent. */
  at: string
  from: string
  fromId: number | null
  /** The whole text, never clipped: reading one message is the point. */
  text: string
  /** mtcute's media type (`photo`, `video`, `document`, ...) or ''. */
  media: string
  /** URLs and file names the message carries (see `messageRefs`). */
  refs: string[]
  /** Views, forwards, reactions, replies, edited (see `messageStats`). */
  stats: string
  replyTo: number | null
  /** The message a reply thread or forum topic hangs from. */
  threadId: number | null
  forwardedFrom: string | null
  pinned: boolean
  outgoing: boolean
  edited: boolean
  scheduled: boolean
  /** A t.me link, for a supergroup or channel message; null for a private chat. */
  link: string | null
}

/** A peer's name, tolerating one the batch did not carry. */
function peerOf(read: () => { id?: number; displayName?: string } | null | undefined): { id: number | null; name: string } {
  try {
    const peer = read()
    return { id: typeof peer?.id === 'number' ? peer.id : null, name: peer?.displayName ?? '?' }
  } catch {
    return { id: null, name: '?' }
  }
}

/** The link mtcute can build for a message, or null where Telegram has no such link. */
function linkOf(msg: Message): string | null {
  try {
    return typeof msg.link === 'string' ? msg.link : null
  } catch {
    // A private chat or a legacy group has no permalink; that is not an error.
    return null
  }
}

export function messageRow(msg: Message): MessageRow {
  const sender = peerOf(() => msg.sender)
  const chat = peerOf(() => msg.chat)
  const forward = (() => {
    try {
      return msg.forward ? msg.forward.sender.displayName : null
    } catch {
      return null
    }
  })()

  return {
    id: msg.id,
    chatId: chat.id ?? 0,
    chat: chat.name,
    at: minute(msg.date),
    from: sender.name,
    fromId: sender.id,
    text: msg.text ?? '',
    media: (msg.media as unknown as { type?: string } | null | undefined)?.type ?? '',
    refs: messageRefs(msg),
    stats: messageStats(msg),
    replyTo: msg.replyToMessage?.id ?? null,
    threadId: msg.replyToMessage?.threadId ?? null,
    forwardedFrom: forward,
    pinned: Boolean(msg.isPinned),
    outgoing: Boolean(msg.isOutgoing),
    edited: Boolean(msg.editDate) && !msg.hideEditMark,
    scheduled: Boolean(msg.isScheduled),
    link: linkOf(msg)
  }
}

/** Indent every line after the first, so a multi-line message stays one block. */
const block = (text: string): string => text.replace(/\n/g, '\n    ')

/**
 * Messages as text: one block each, the same line `tg dump` prints plus the id, and
 * under it what the message is attached to. Pure, so a golden can pin it.
 *
 * `withChat` adds the chat's name, for a list that spans chats (global search).
 */
export function renderMessages(rows: MessageRow[], options: { withChat?: boolean } = {}): string {
  if (rows.length === 0) return 'no messages\n'

  return `${rows
    .map((row) => {
      const where = options.withChat ? `${row.chat} ` : ''
      const media = row.media ? ` <${row.media}>` : ''
      const refs = row.refs.length > 0 ? ` [${row.refs.join(' ')}]` : ''
      const stats = row.stats ? ` (${row.stats})` : ''
      const head = `#${row.id} [${row.at}] ${where}${row.from}: ${block(row.text)}${media}${refs}${stats}`

      const marks = [
        row.replyTo ? `reply to #${row.replyTo}` : null,
        row.threadId ? `thread #${row.threadId}` : null,
        row.forwardedFrom ? `forwarded from ${row.forwardedFrom}` : null,
        row.pinned ? 'pinned' : null,
        row.edited ? 'edited' : null,
        row.scheduled ? 'scheduled' : null
      ].filter((mark): mark is string => mark !== null)

      return [head, marks.length > 0 ? `    ${marks.join(' | ')}` : null, row.link ? `    ${row.link}` : null]
        .filter((line): line is string => line !== null)
        .join('\n')
    })
    .join('\n')}\n`
}

/* ------------------------------------------------------------------- get */

/** Telegram answers at most this many ids in one request. */
export const MAX_MESSAGE_IDS = 100

/**
 * Messages by id, in the order asked. An id Telegram has no message for comes back
 * in `missing`, not as an error: asking for ten and getting nine is a normal day.
 */
export async function getMessageRows(
  tg: TelegramClient,
  chatId: number,
  ids: readonly number[]
): Promise<{ rows: MessageRow[]; missing: number[] }> {
  const found = await reading(() => tg.getMessages(chatId, [...ids]))

  const rows: MessageRow[] = []
  const missing: number[] = []
  ids.forEach((id, index) => {
    const msg = found[index]
    if (msg) rows.push(messageRow(msg))
    else missing.push(id)
  })
  return { rows, missing }
}

/* ------------------------------------------------------------------ link */

/**
 * A message link, checked offline.
 *
 * `t.me/<name>/<id>`, `t.me/<name>/<topic>/<id>`, `t.me/c/<chat>/<id>` and the
 * same with a topic. An invite link (`t.me/+...`, `t.me/joinchat/...`) is refused
 * by name: it points at a join flow, and nothing here joins anything.
 */
export function assertMessageLink(raw: string): string {
  const link = String(raw ?? '').trim()
  const match = /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/([^/?#]+)((?:\/\d+){1,3})(?:[/?#].*)?$/i.exec(link)

  const refuse = (why: string): never => {
    throw new OperatorError(
      `Cannot use ${JSON.stringify(raw)} as a message link: ${why}\n` +
      '  Accepted forms:\n' +
      '    https://t.me/durov/123         a message in a public chat\n' +
      '    https://t.me/durov/45/123      a message in a topic or thread\n' +
      '    https://t.me/c/1234567890/123  a message in a private supergroup or channel you are in',
      EXIT.usage
    )
  }

  if (/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/(?:\+|joinchat\/)/i.test(link)) {
    return refuse('that is an invite link. Joining is not something this command does')
  }
  if (!match) return refuse('it is not a t.me message link')

  const name = match[1] ?? ''
  const numbers = (match[2] ?? '').split('/').filter(Boolean)
  if (name.toLowerCase() === 'c') {
    if (numbers.length < 2) return refuse('a t.me/c/ link needs a chat id and a message id')
  } else if (!/^[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(name)) {
    return refuse(`"${name}" is not a valid username`)
  }
  // mtcute reads the last path segment as the message id, so a trailing slash
  // would make it an empty one, which is the number 0: a message that never exists.
  return link.replace(/\/+(?=[?#]|$)/, '')
}

/** The message a t.me link points at, or null when Telegram has none there. */
export async function messageFromLink(tg: TelegramClient, link: string): Promise<MessageRow | null> {
  const msg = await reading(() => tg.getMessageByLink(assertMessageLink(link)))
  return msg ? messageRow(msg) : null
}

/* ---------------------------------------------------------------- thread */

/** How far up a reply chain `msg thread` will climb by default, and at most. */
export const DEFAULT_THREAD_DEPTH = 5
export const MAX_THREAD_DEPTH = 20

/** Where a message sits: what it answers, its album, and where a channel post's comments live. */
export interface ThreadView {
  message: MessageRow
  /** The messages it replies to, nearest first, as far up as `depth` allowed. */
  parents: MessageRow[]
  /** True when the chain went on past `depth`. */
  moreAbove: boolean
  /** The other messages of its album, when it is part of one. */
  album: MessageRow[]
  /** For a channel post with comments: the discussion group message that holds them. */
  discussion: { chatId: number; messageId: number } | null
}

/**
 * One message in context.
 *
 * Each step up the chain is one request, bounded by `depth`; the album and the
 * discussion message are one request each and only made when the message has
 * them. The replies BELOW the message are a transcript, not a lookup: `tg dump
 * <chat> --thread <id>` reads them through the paced walk.
 */
export async function messageThread(
  tg: TelegramClient,
  chatId: number,
  id: number,
  options: { depth?: number | undefined } = {}
): Promise<ThreadView | null> {
  const depth = options.depth ?? DEFAULT_THREAD_DEPTH
  const [first] = await reading(() => tg.getMessages(chatId, id))
  if (!first) return null

  const parents: MessageRow[] = []
  let current: Message = first
  let moreAbove = false
  while (current.replyToMessage?.id) {
    if (parents.length >= depth) {
      moreAbove = true
      break
    }
    const parent = await reading(() => tg.getReplyTo(current))
    // The message it answered may have been deleted: the chain ends there.
    if (!parent) break
    parents.push(messageRow(parent))
    current = parent
  }

  const album = first.groupedId
    ? (await reading(() => tg.getMessageGroup({ chatId, message: id }))).filter((m) => m.id !== id).map(messageRow)
    : []

  let discussion: ThreadView['discussion'] = null
  if (first.replies?.hasComments) {
    const post = await reading(() => tg.getDiscussionMessage({ chatId, message: id }))
    if (post) discussion = { chatId: post.chat.id, messageId: post.id }
  }

  return { message: messageRow(first), parents, moreAbove, album, discussion }
}

export function renderThread(view: ThreadView): string {
  const parts = [renderMessages([view.message])]

  if (view.parents.length > 0) {
    parts.push(`replies to (nearest first${view.moreAbove ? ', the chain goes on' : ''}):\n${renderMessages(view.parents)}`)
  }
  if (view.album.length > 0) parts.push(`the rest of its album:\n${renderMessages(view.album)}`)
  if (view.discussion) {
    parts.push(
      `comments: discussion chat ${view.discussion.chatId}, message #${view.discussion.messageId}\n` +
      `  read them with: tg dump ${view.discussion.chatId} --thread ${view.discussion.messageId}\n`
    )
  }
  return parts.join('\n')
}

/* ------------------------------------------------------------- scheduled */

/**
 * Messages waiting to be sent in a chat: all of them, or the ids asked for.
 *
 * A READ of what is already scheduled (Telegram's own list, which the operator
 * sees in the app). Scheduling, rescheduling and deleting are writes and are not
 * here.
 */
export async function listScheduled(
  tg: TelegramClient,
  chatId: number,
  ids: readonly number[] = []
): Promise<{ rows: MessageRow[]; missing: number[] }> {
  if (ids.length === 0) {
    const all = await reading(() => tg.getAllScheduledMessages(chatId))
    return { rows: [...all].map(messageRow).sort((a, b) => a.at.localeCompare(b.at)), missing: [] }
  }

  const found = await reading(() => tg.getScheduledMessages(chatId, [...ids]))
  const rows: MessageRow[] = []
  const missing: number[] = []
  ids.forEach((id, index) => {
    const msg = found[index]
    if (msg) rows.push(messageRow(msg))
    else missing.push(id)
  })
  return { rows, missing }
}
