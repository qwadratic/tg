import type { Dialog, TelegramClient } from '@mtcute/node'
import { paced, pageSizeFor } from '../messages/fetch.js'
import { reading, readingEach } from '../reads/errors.js'

/**
 * The state of chats in the chat list: `tg dialogs show` and `tg draft list`.
 *
 * Reads only. A draft is an unsent message the operator (or, from 0.9, an agent
 * on their behalf) left in a chat; reading it sends nothing and tells nobody.
 */

const minute = (date: Date | null | undefined): string => (date ? date.toISOString().slice(0, 16) : '')
const flat = (text: string, width: number): string => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > width ? `${one.slice(0, width - 1)}…` : one
}

/** One chat's place in the list: unread, pinned, muted, archived, what was said last, any draft. */
export interface DialogRow {
  id: number
  /** user | chat, as mtcute names the peer kind. */
  type: string
  name: string
  username: string | null
  unread: number
  unreadMentions: number
  unreadReactions: number
  pinned: boolean
  /** null when Telegram does not say (the chat uses the default). */
  muted: boolean | null
  archived: boolean
  markedUnread: boolean
  /** ISO to the minute of the last message, or null for an empty chat. */
  lastMessageAt: string | null
  /** The last message, one line, clipped. */
  lastMessage: string
  hasDraft: boolean
  autoDeleteSeconds: number | null
}

function dialogRow(dialog: Dialog): DialogRow {
  const peer = dialog.peer
  const last = dialog.lastMessage

  return {
    id: peer.id,
    type: peer.type,
    name: peer.displayName,
    username: peer.username ?? null,
    unread: dialog.unreadCount,
    unreadMentions: dialog.unreadMentionsCount,
    unreadReactions: dialog.unreadReactionsCount,
    pinned: dialog.isPinned,
    muted: dialog.isMuted,
    archived: dialog.isArchived,
    markedUnread: dialog.isManuallyUnread,
    lastMessageAt: last ? minute(last.date) : null,
    lastMessage: flat(last?.text ?? '', 80),
    hasDraft: dialog.draftMessage !== null && dialog.draftMessage !== undefined,
    autoDeleteSeconds: dialog.ttlPeriod ?? null
  }
}

/**
 * The dialogs of the chats asked for, in the order asked. A chat Telegram has no
 * dialog for (never opened, or left) comes back in `missing`.
 */
export async function showDialogs(
  tg: TelegramClient,
  chatIds: readonly number[]
): Promise<{ rows: DialogRow[]; missing: number[] }> {
  const found = await reading(() => tg.getPeerDialogs([...chatIds]))

  const rows: DialogRow[] = []
  const missing: number[] = []
  chatIds.forEach((id, index) => {
    const dialog = found[index]
    if (dialog) rows.push(dialogRow(dialog))
    else missing.push(id)
  })
  return { rows, missing }
}

export function renderDialogs(rows: DialogRow[]): string {
  if (rows.length === 0) return 'no dialogs\n'

  return `${rows
    .map((row) => {
      const marks = [
        row.pinned ? 'pinned' : null,
        row.muted ? 'muted' : null,
        row.archived ? 'archived' : null,
        row.markedUnread ? 'marked unread' : null,
        row.unread ? `${row.unread} unread` : null,
        row.unreadMentions ? `mentions ${row.unreadMentions}` : null,
        row.unreadReactions ? `reactions ${row.unreadReactions}` : null,
        row.hasDraft ? 'draft' : null,
        row.autoDeleteSeconds ? `auto-delete ${row.autoDeleteSeconds}s` : null
      ].filter((mark): mark is string => mark !== null)

      const head = `${row.name}${row.username ? ` (@${row.username})` : ''} [id ${row.id}] ${row.type}${marks.length > 0 ? `  ${marks.join(', ')}` : ''}`
      const last = row.lastMessageAt ? `    last ${row.lastMessageAt}: ${row.lastMessage || '(no text)'}` : '    no messages'
      return `${head}\n${last}`
    })
    .join('\n')}\n`
}

/* ---------------------------------------------------------------- drafts */

export interface DraftRow {
  chatId: number
  chat: string
  /** ISO to the minute the draft was last saved. */
  at: string
  /** The whole draft text. */
  text: string
  /** The message the draft answers, when it is a reply. */
  replyTo: number | null
  noPreview: boolean
}

/** How many dialogs `draft list` looks through when it is not told. */
export const DEFAULT_DRAFT_SCAN = 200

/**
 * The drafts waiting in the chat list.
 *
 * Telegram attaches a draft to its dialog, so finding them means walking dialogs,
 * newest activity first, up to `scan` of them, through the one paced walk. A draft
 * in a chat older than that is not found: raise the scan, do not expect magic.
 */
export async function listDrafts(tg: TelegramClient, options: { scan?: number | undefined } = {}): Promise<DraftRow[]> {
  const scan = options.scan ?? DEFAULT_DRAFT_SCAN
  const rows: DraftRow[] = []

  // `keep`: mtcute leaves archived chats out of a dialog walk unless told otherwise,
  // and a draft in an archived chat is exactly the kind that gets forgotten.
  for await (const dialog of paced(
    readingEach(tg.iterDialogs({ limit: scan, chunkSize: pageSizeFor(scan), archived: 'keep' })),
    { limit: scan }
  )) {
    const draft = dialog.draftMessage
    if (!draft) continue
    rows.push({
      chatId: dialog.peer.id,
      chat: dialog.peer.displayName,
      at: minute(draft.date),
      text: draft.text,
      replyTo: draft.replyToMessage?.replyToMsgId ?? null,
      noPreview: draft.disableWebPreview
    })
  }

  return rows.sort((a, b) => b.at.localeCompare(a.at))
}

export function renderDrafts(rows: DraftRow[]): string {
  if (rows.length === 0) return 'no drafts\n'

  return `${rows
    .map((row) => {
      const marks = [row.replyTo ? `reply to #${row.replyTo}` : null, row.noPreview ? 'no link preview' : null].filter(
        (mark): mark is string => mark !== null
      )
      return `${row.chat} [id ${row.chatId}]  ${row.at}${marks.length > 0 ? `  ${marks.join(', ')}` : ''}\n    ${row.text.replace(/\n/g, '\n    ')}`
    })
    .join('\n')}\n`
}
