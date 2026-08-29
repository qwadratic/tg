import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { TelegramClient } from '@mtcute/node'
import { OperatorError } from '../errors.js'
import { assertPeerId } from '../peers/id.js'
import { assertConfirmed, guardedSend, type SentRecord } from './gate.js'

/**
 * The ONLY module in `src/` that calls a Telegram write RPC.
 *
 * Everything else in this codebase reads. That was once an absolute:
 *
 *   backlog/decisions/2026-08-05-consolidate-on-telegram-utils.md, line 193:
 *   "No write-back to Telegram: disableUpdates: true means the client never even
 *    receives updates, and there are ZERO sendText/sendMedia/forwardMessages/
 *    deleteMessages/editMessage/readHistory call sites in src/."
 *
 * The fenced verb set is: `tg send text`, `tg send media`, `tg send rm`,
 * `tg send forward`, `tg send edit`, `tg send read`, the seven chat-state verbs
 * (`archive`, `unarchive`, `pin`, `unpin`, `mute`, `unmute`, `unread`),
 * `tg note` and the read-only `tg send log`. Widening it again means a decision
 * file, per
 * backlog/decisions/2026-08-17-narrow-the-no-write-back-rule-and-build-the-missing-gates.md
 * and its 2026-08-19 amendment.
 *
 * That invariant is now deliberately NARROWED, not abandoned. The operator sent
 * an APK, images, notes and outreach messages this month from four throwaway
 * scripts that held the same credential with none of the guards below, so the
 * capability already existed - it was simply unguarded, uncapped and unlogged.
 * Moving it in here is what makes it checkable.
 *
 * The narrowed rule, each clause pinned by an eval in `test/trust.test.ts`:
 *   1. Write RPCs appear in this file and nowhere else under `src/`.
 *      (`src/contacts/import.ts` keeps its older, separately fenced exception.)
 *   2. No unattended entry point can reach this module: the import graphs of
 *      `export`, `folders`, `ship` and every read verb are checked and must not
 *      contain it, so a cron job or timer provably cannot send.
 *   3. A send needs a numeric peer id. Never a name, never a username.
 *   4. A send needs a human, or an explicit `--yes` standing in for one.
 *   5. Sends are capped per run and per day, and every attempt is logged.
 */

export type { SentRecord } from './gate.js'

export interface SendTextOptions {
  yes?: boolean | undefined
}

/** Send a plain text message to a numeric peer id. */
export async function sendText(
  tg: TelegramClient,
  rawPeer: string | number,
  text: string,
  options: SendTextOptions = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)

  if (!text.trim()) throw new OperatorError('Refusing to send an empty message.')

  const peer = await tg.resolvePeer(peerId)
  return guardedSend(peerId, 'text', text.length, () => tg.sendText(peer, text))
}

export interface SendMediaOptions extends SendTextOptions {
  caption?: string | undefined
  /** Override the detected mime type. */
  mime?: string | undefined
}

/**
 * Photo or video when the extension says so, document otherwise.
 *
 * The distinction is not cosmetic: a document arrives as a file to download,
 * while a video gets an inline player. Sending an .mp4 as a document was simply
 * wrong - nobody wants to download a screen recording to watch it.
 *
 * .gif stays a photo: Telegram renders it animated already, and routing it
 * through the video path would make it a silent looping clip instead.
 */
export function mediaKindFor(path: string): 'photo' | 'video' | 'document' {
  if (/\.(jpe?g|png|gif|webp)$/i.test(path)) return 'photo'
  if (/\.(mp4|mov|m4v|webm)$/i.test(path)) return 'video'
  return 'document'
}

/** Send a file to a numeric peer id. */
export async function sendMedia(
  tg: TelegramClient,
  rawPeer: string | number,
  filePath: string,
  options: SendMediaOptions = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)

  if (!existsSync(filePath)) throw new OperatorError(`No such file: ${filePath}`)

  const file = await readFile(filePath)
  const kind = mediaKindFor(filePath)
  const peer = await tg.resolvePeer(peerId)

  return guardedSend(peerId, kind, file.length, () =>
    tg.sendMedia(peer, {
      type: kind,
      file,
      fileName: basename(filePath),
      // ponytail: no width/height/duration, so the client reads them from the
      // file itself. Telegram still renders a player; the only cost is that the
      // bubble may size itself once the header is parsed. Upgrade path if a
      // thumbnail or exact aspect ratio ever matters: probe with ffprobe and
      // pass width/height/duration/thumb - which would make ffmpeg a dependency
      // of sending, so it is not worth it until something needs it.
      ...(kind === 'video' ? { supportsStreaming: true } : {}),
      ...(options.mime ? { fileMime: options.mime } : {}),
      ...(options.caption ? { caption: options.caption } : {})
    })
  )
}

/**
 * Delete messages you sent, for everyone.
 *
 * The one write here that destroys rather than creates, so it is the one worth
 * being most careful with: ids are per-chat, and a wrong peer silently deletes
 * a DIFFERENT conversation's messages rather than erroring. Hence the numeric
 * peer id requirement shared with every other write, and the same confirmation
 * gate - `--yes` is the caller stating they mean it.
 *
 * Telegram reports no per-id result, so a stale or already-deleted id succeeds
 * quietly. The log records what was asked for, not what existed.
 */
export async function deleteMessages(
  tg: TelegramClient,
  rawPeer: string | number,
  messageIds: number[],
  options: SendTextOptions = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)

  const [firstId] = messageIds
  if (firstId === undefined) throw new OperatorError('Give at least one message id to delete.')
  for (const id of messageIds) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new OperatorError(`Not a message id: ${id}. Ids are positive integers.`)
    }
  }

  const peer = await tg.resolvePeer(peerId)
  return guardedSend(peerId, 'delete', messageIds.length, async () => {
    await tg.deleteMessagesById(peer, messageIds, { revoke: true })
    return { id: firstId }
  })
}

/**
 * Forward messages from one chat into another.
 *
 * Two peers, so two chances to aim it wrong: ids are per-chat, and a wrong
 * source silently forwards a DIFFERENT conversation's messages. Both ends go
 * through {@link assertPeerId} for that reason.
 *
 * The record is logged against the DESTINATION - the peer whose screen changes
 * - with the SOURCE alongside it in `fromPeerId`, because the risk of this verb
 * is the pair: a private thread copied out to a third party.
 *
 * A forward delivers one message per id, so it costs one cap unit per id. The
 * caps bound delivered messages, not RPC calls; charging a hundred-message
 * forward a single unit would empty the point of them.
 */
export async function forwardMessage(
  tg: TelegramClient,
  fromPeer: string | number,
  toPeer: string | number,
  messageIds: number[],
  options: SendTextOptions = {}
): Promise<SentRecord> {
  const fromId = assertPeerId(fromPeer)
  const toId = assertPeerId(toPeer)
  assertConfirmed(options)

  if (messageIds.length === 0) throw new OperatorError('Give at least one message id to forward.')
  // Telegram's own ceiling (mtcute: "You can forward no more than 100 messages
  // at once"). Caught here so an oversized list never reaches the network,
  // where it would fail server-side after burning cap budget.
  if (messageIds.length > 100) {
    throw new OperatorError(
      `Too many messages to forward (${messageIds.length}). Telegram allows at most 100 at once.`
    )
  }
  for (const id of messageIds) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new OperatorError(`Not a message id: ${id}. Ids are positive integers.`)
    }
  }

  const from = await tg.resolvePeer(fromId)
  const to = await tg.resolvePeer(toId)
  return guardedSend(toId, 'forward', messageIds.length, async () => {
    const messages = await tg.forwardMessagesById({ fromChatId: from, toChatId: to, messages: messageIds })
    return { id: messages[0]?.id ?? 0 }
  }, { units: messageIds.length, fromPeerId: fromId })
}

/**
 * Edit the text of a message you sent.
 *
 * An edit is a write on someone else's screen just as much as {@link sendText}
 * is - the bubble changes under them, and Telegram shows it as edited - so it
 * takes the same numeric peer id and the same confirmation gate.
 */
export async function editMessageText(
  tg: TelegramClient,
  rawPeer: string | number,
  messageId: number,
  text: string,
  options: SendTextOptions = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)

  if (!Number.isInteger(messageId) || messageId <= 0) {
    throw new OperatorError(`Not a message id: ${messageId}. Ids are positive integers.`)
  }
  if (!text.trim()) throw new OperatorError('Refusing to edit a message to be empty.')

  const peer = await tg.resolvePeer(peerId)
  return guardedSend(peerId, 'edit', text.length, async () => {
    const message = await tg.editMessage({ chatId: peer, message: messageId, text })
    return { id: message.id }
  })
}

/**
 * Mark a chat as read, up to its latest message.
 *
 * Sends no content, and is gated exactly like one that does. A read receipt is
 * visible to the other party: it tells them a human is awake and reading right
 * now. An unattended run quietly clearing unreads is therefore a real signal
 * leak about the operator, not a free action, so it costs the same budget and
 * needs the same yes as {@link sendText}.
 */
export async function markRead(
  tg: TelegramClient,
  rawPeer: string | number,
  options: SendTextOptions = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)

  const peer = await tg.resolvePeer(peerId)
  return guardedSend(peerId, 'read', 0, async () => {
    await tg.readHistory(peer)
    return { id: 0 }
  })
}

/**
 * Chat-state verbs: private to the account owner, gated anyway.
 *
 * Unlike every write above, none of the seven below is visible to a
 * counterparty. Archiving, pinning, muting and marking unread change only the
 * owner's own chat list; nothing crosses to the other side of the chat, and
 * there is no receipt like the one {@link markRead} produces. They are fenced
 * regardless, because the property that makes this module reviewable is "every
 * write RPC is here", not "every dangerous one is".
 *
 * They log `messageId: 0` and `size: 0` - the same sentinel {@link markRead}
 * already uses, for the same reason: no message is involved.
 *
 * `pin`/`unpin` and `mute`/`unmute` go through the raw `tg.call()` API because
 * mtcute ships no high-level wrapper for dialog pinning or notify settings.
 * That is why the trust fence also scans for the TL method-name string
 * literals; a regex looking for a JS call name would fence nothing.
 */

/** Move a chat into the archive. */
export async function archiveChat(
  tg: TelegramClient,
  rawPeer: string | number,
  options: SendTextOptions = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)

  return guardedSend(peerId, 'archive', 0, async () => {
    await tg.archiveChats(peerId)
    return { id: 0 }
  })
}

/** Move a chat back out of the archive. */
export async function unarchiveChat(
  tg: TelegramClient,
  rawPeer: string | number,
  options: SendTextOptions = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)

  return guardedSend(peerId, 'unarchive', 0, async () => {
    await tg.unarchiveChats(peerId)
    return { id: 0 }
  })
}

/** Mark a chat unread, so it reappears as needing attention. */
export async function markUnread(
  tg: TelegramClient,
  rawPeer: string | number,
  options: SendTextOptions = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)

  return guardedSend(peerId, 'unread', 0, async () => {
    await tg.markChatUnread(peerId)
    return { id: 0 }
  })
}

/** Pin or unpin a chat to the top of the dialog list. Raw RPC: no wrapper. */
async function toggleDialogPin(
  tg: TelegramClient,
  peerId: number,
  pinned: boolean
): Promise<void> {
  const peer = await tg.resolvePeer(peerId)
  await tg.call({
    _: 'messages.toggleDialogPin',
    pinned,
    peer: { _: 'inputDialogPeer', peer }
  })
}

/** Pin a chat to the top of the dialog list. */
export async function pinChat(
  tg: TelegramClient,
  rawPeer: string | number,
  options: SendTextOptions = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)

  return guardedSend(peerId, 'pin', 0, async () => {
    await toggleDialogPin(tg, peerId, true)
    return { id: 0 }
  })
}

/** Unpin a chat. */
export async function unpinChat(
  tg: TelegramClient,
  rawPeer: string | number,
  options: SendTextOptions = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)

  return guardedSend(peerId, 'unpin', 0, async () => {
    await toggleDialogPin(tg, peerId, false)
    return { id: 0 }
  })
}

/**
 * Telegram's own "mute indefinitely" convention: the largest int32 unix
 * timestamp. Not a sentinel we invented - the apps write exactly this.
 */
const MUTE_FOREVER = 2147483647

/** Set a chat's mute-until watermark. Raw RPC: no wrapper. */
async function setMuteUntil(
  tg: TelegramClient,
  peerId: number,
  muteUntil: number
): Promise<void> {
  const peer = await tg.resolvePeer(peerId)
  await tg.call({
    _: 'account.updateNotifySettings',
    peer: { _: 'inputNotifyPeer', peer },
    settings: { _: 'inputPeerNotifySettings', muteUntil }
  })
}

/** Mute a chat indefinitely. */
export async function muteChat(
  tg: TelegramClient,
  rawPeer: string | number,
  options: SendTextOptions = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)

  return guardedSend(peerId, 'mute', 0, async () => {
    await setMuteUntil(tg, peerId, MUTE_FOREVER)
    return { id: 0 }
  })
}

/** Unmute a chat. */
export async function unmuteChat(
  tg: TelegramClient,
  rawPeer: string | number,
  options: SendTextOptions = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)

  return guardedSend(peerId, 'unmute', 0, async () => {
    await setMuteUntil(tg, peerId, 0)
    return { id: 0 }
  })
}

/**
 * Send to Saved Messages, the chat with yourself.
 *
 * Kept separate from {@link sendText} so the everyday case - leaving yourself a
 * note - needs no peer id and therefore cannot be aimed at another person by
 * mistake. Saved Messages is your own user id, which is why this resolves
 * `getMe` rather than accepting a target at all.
 */
export async function sendNote(
  tg: TelegramClient,
  text: string,
  options: SendTextOptions = {}
): Promise<SentRecord> {
  assertConfirmed(options)

  if (!text.trim()) throw new OperatorError('Refusing to send an empty note.')

  const me = await tg.getMe()
  const peer = await tg.resolvePeer(me.id)
  return guardedSend(me.id, 'text', text.length, () => tg.sendText(peer, text))
}
