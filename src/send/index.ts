import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { tl, type TelegramClient } from '@mtcute/node'
import { OperatorError } from '../errors.js'
import { EXIT } from '../exit-codes.js'
import { assertPeerId } from '../peers/id.js'
import {
  ADMIN_RIGHTS,
  RESTRICTIONS,
  type AdminRightName,
  type AdminRights,
  type RestrictionName,
  type Restrictions
} from '../groups/rights.js'
import { assertConfirmed, guardedSend, type SentRecord } from './gate.js'
import { probeVideo, type VideoMeta } from '../media/probe.js'

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
 * `tg note` and the read-only `tg send log`, plus the `tg group` administration
 * verbs (D13c; membership and owner-only delete, D13d; ban, unban, restrict,
 * promote and demote, D13e). Widening it again means a decision file, per
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
  options: SendTextOptions & TopicOption = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)
  if (options.topicId !== undefined) assertTopicId(options.topicId)

  if (!text.trim()) throw new OperatorError('Refusing to send an empty message.')

  const peer = await tg.resolvePeer(peerId)
  return guardedSend(peerId, 'text', text.length, async () => {
    try {
      return await tg.sendText(peer, text, topicParams(options))
    } catch (error) {
      throw friendlyTelegramError(error)
    }
  }, topicExtra(options))
}

/**
 * Post into a forum topic. In a forum a topic IS its top message, so mtcute
 * spells "into topic N" as a reply to message N.
 */
export interface TopicOption {
  topicId?: number | undefined
}

function topicParams(options: TopicOption): { replyTo?: number } {
  return options.topicId === undefined ? {} : { replyTo: options.topicId }
}

function topicExtra(options: TopicOption): { topicId?: number } {
  return options.topicId === undefined ? {} : { topicId: options.topicId }
}

export interface SendMediaOptions extends SendTextOptions, TopicOption {
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

/**
 * The sendMedia input for one file. Pure, so what reaches Telegram is testable
 * without a client.
 *
 * A video carries its display width, height and duration when ffprobe could
 * read them (src/media/probe.ts). Without them Telegram gets a 0x0 video
 * attribute and clients draw a square player, stretching a 16:10 recording
 * into it. `meta` null (no ffprobe, unreadable file) sends as before.
 */
export function mediaInput(
  kind: 'photo' | 'video' | 'document',
  file: Uint8Array,
  fileName: string,
  options: SendMediaOptions,
  meta: VideoMeta | null
) {
  return {
    type: kind,
    file,
    fileName,
    ...(kind === 'video' ? { supportsStreaming: true } : {}),
    ...(kind === 'video' && meta ? { width: meta.width, height: meta.height, ...(meta.duration ? { duration: meta.duration } : {}) } : {}),
    ...(options.mime ? { fileMime: options.mime } : {}),
    ...(options.caption ? { caption: options.caption } : {})
  }
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
  if (options.topicId !== undefined) assertTopicId(options.topicId)

  if (!existsSync(filePath)) throw new OperatorError(`No such file: ${filePath}`)

  const file = await readFile(filePath)
  const kind = mediaKindFor(filePath)
  const peer = await tg.resolvePeer(peerId)

  // ponytail: no thumbnail yet — Telegram shows the first frame. Width, height
  // and duration come from ffprobe when it is installed (optional, never a
  // dependency of sending); see mediaInput.
  const meta = kind === 'video' ? probeVideo(filePath) : null

  return guardedSend(peerId, kind, file.length, async () => {
    try {
      return await tg.sendMedia(peer, mediaInput(kind, file, basename(filePath), options, meta), topicParams(options))
    } catch (error) {
      throw friendlyTelegramError(error)
    }
  }, topicExtra(options))
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
  }, { units: 0 })
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
  }, { units: 0 })
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
  }, { units: 0 })
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
  }, { units: 0 })
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
  }, { units: 0 })
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
  }, { units: 0 })
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
  }, { units: 0 })
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

/**
 * Group and channel administration (D13c).
 *
 * A second widening of the fence, and a different risk shape from the D13b
 * chat-state seven: those were private to the account owner, these are visible
 * to every member of the chat, and a few are effectively irreversible - a
 * regenerated primary invite link revokes the old one for everyone holding it,
 * and a released public username can be claimed by a stranger seconds later.
 *
 * They cost ZERO cap units: the caps bound DELIVERED messages, and none of
 * these delivers one. They still take the confirmation gate and the audit log,
 * which is the part that matters for an action nobody can take back.
 *
 * Every one uses a high-level mtcute method, so the fence catches them through
 * WRITE_RPCS rather than the raw TL literal list.
 */

/** Chat creation has no target peer yet, so the log records 0. */
const NO_PEER = 0

/** Options every administration verb takes, plus its own arguments. */
export type AdminOptions = SendTextOptions

/** Create a legacy group with an initial member list. */
export async function createGroup(
  tg: TelegramClient,
  title: string,
  userIds: number[],
  options: AdminOptions = {}
): Promise<SentRecord> {
  assertConfirmed(options)
  if (!title.trim()) throw new OperatorError('Give the group a title.')
  // Telegram's own rule: a legacy group cannot be created with just yourself.
  if (userIds.length === 0) {
    throw new OperatorError('A legacy group needs at least one other member. Give a peer id.')
  }
  const users = userIds.map((id) => assertPeerId(id))

  return guardedSend(NO_PEER, 'create-group', 0, async () => {
    const { chat } = await tg.createGroup({ title, users })
    return { id: chat.id }
  }, { units: 0 })
}

/** Create a broadcast channel. */
export async function createChannel(
  tg: TelegramClient,
  title: string,
  options: AdminOptions & { description?: string | undefined } = {}
): Promise<SentRecord> {
  assertConfirmed(options)
  if (!title.trim()) throw new OperatorError('Give the channel a title.')

  return guardedSend(NO_PEER, 'create-channel', 0, async () => {
    const chat = await tg.createChannel({
      title,
      ...(options.description ? { description: options.description } : {})
    })
    return { id: chat.id }
  }, { units: 0 })
}

/** Create a supergroup, optionally as a forum. */
export async function createSupergroup(
  tg: TelegramClient,
  title: string,
  options: AdminOptions & { description?: string | undefined; forum?: boolean | undefined } = {}
): Promise<SentRecord> {
  assertConfirmed(options)
  if (!title.trim()) throw new OperatorError('Give the supergroup a title.')

  return guardedSend(NO_PEER, 'create-supergroup', 0, async () => {
    const chat = await tg.createSupergroup({
      title,
      ...(options.description ? { description: options.description } : {}),
      ...(options.forum ? { forum: true } : {})
    })
    return { id: chat.id }
  }, { units: 0 })
}

/** Rename a chat. Everyone in it sees a service message. */
export async function setChatTitle(
  tg: TelegramClient,
  rawPeer: string | number,
  title: string,
  options: AdminOptions = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)
  if (!title.trim()) throw new OperatorError('Refusing to set an empty title.')

  return guardedSend(peerId, 'chat-title', 0, async () => {
    await tg.setChatTitle(peerId, title)
    return { id: 0 }
  }, { units: 0 })
}

/** Change a chat's description. An empty string clears it, which is allowed. */
export async function setChatDescription(
  tg: TelegramClient,
  rawPeer: string | number,
  description: string,
  options: AdminOptions = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)

  return guardedSend(peerId, 'chat-description', 0, async () => {
    await tg.setChatDescription(peerId, description)
    return { id: 0 }
  }, { units: 0 })
}

/** Set a chat's photo from a local file. */
export async function setChatPhoto(
  tg: TelegramClient,
  rawPeer: string | number,
  filePath: string,
  options: AdminOptions = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)
  if (!existsSync(filePath)) throw new OperatorError(`No such file: ${filePath}`)

  // A chat photo is a photo or a video avatar; the same extension rule the
  // send path already uses decides which, and a document is neither.
  const kind = mediaKindFor(filePath)
  if (kind === 'document') {
    throw new OperatorError(`Not an image or video: ${filePath}. A chat photo must be one.`)
  }
  const file = await readFile(filePath)

  return guardedSend(peerId, 'chat-photo', 0, async () => {
    await tg.setChatPhoto({ chatId: peerId, type: kind, media: file })
    return { id: 0 }
  }, { units: 0 })
}

/**
 * Set a chat's accent colour.
 *
 * `color` is Telegram's own palette INDEX, not an RGB value: 0-6 are the
 * built-in red, orange, purple, green, sea, blue, pink, and anything higher
 * comes from `help.getAppConfig`. Passed through faithfully rather than wrapped
 * in a palette of our own, which would go stale the moment Telegram adds one.
 */
export async function setChatColor(
  tg: TelegramClient,
  rawPeer: string | number,
  color: number,
  options: AdminOptions & { forProfile?: boolean | undefined } = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)
  if (!Number.isInteger(color) || color < 0) {
    throw new OperatorError(`Not a colour id: ${color}. Ids are non-negative integers (0-6 are built in).`)
  }

  return guardedSend(peerId, 'chat-color', 0, async () => {
    await tg.setChatColor({
      peer: peerId,
      color,
      ...(options.forProfile ? { forProfile: true } : {})
    })
    return { id: 0 }
  }, { units: 0 })
}

/** Set the sticker set a supergroup uses. `set` is a short name or set id. */
export async function setChatStickerSet(
  tg: TelegramClient,
  rawPeer: string | number,
  set: string,
  options: AdminOptions = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)
  if (!set.trim()) throw new OperatorError('Give a sticker set short name.')

  return guardedSend(peerId, 'chat-sticker-set', 0, async () => {
    await tg.setChatStickerSet(peerId, set)
    return { id: 0 }
  }, { units: 0 })
}

/**
 * Claim or release a public username.
 *
 * `null` makes the chat private, and is the irreversible half: the handle goes
 * back into the global pool immediately, where anyone can take it. mtcute
 * spells "remove" as an explicit null, so this does too rather than inventing
 * a second function.
 */
export async function setChatUsername(
  tg: TelegramClient,
  rawPeer: string | number,
  username: string | null,
  options: AdminOptions = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)
  // 5-32 characters, and the first must be a letter: 4 + 1 = 5, so the tail is
  // {4,31}. The looser {3,31} let 'abcd' through here for Telegram to reject.
  if (username !== null && !/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(username)) {
    throw new OperatorError(
      `Not a Telegram username: ${username}. 5-32 characters, letters, digits and _.`
    )
  }

  return guardedSend(peerId, 'chat-username', 0, async () => {
    await tg.setChatUsername(peerId, username)
    return { id: 0 }
  }, { units: 0 })
}

/** A write that produces a link, so the caller gets the link alongside the record. */
export interface InviteLinkResult {
  record: SentRecord
  link: string
}

/**
 * Regenerate the primary invite link.
 *
 * Destructive in a way the name hides: the OLD primary link is revoked, so
 * every copy of it already pasted into a message stops working.
 */
export async function exportInviteLink(
  tg: TelegramClient,
  rawPeer: string | number,
  options: AdminOptions = {}
): Promise<InviteLinkResult> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)

  const out: { link: string } = { link: '' }
  const record = await guardedSend(peerId, 'invite-link', 0, async () => {
    out.link = (await tg.exportInviteLink(peerId)).link
    return { id: 0 }
  }, { units: 0 })
  return { record, link: out.link }
}

export interface InviteLinkOptions extends AdminOptions {
  /** UNIX ms or a Date; when the link stops working. */
  expires?: number | undefined
  usageLimit?: number | undefined
  withApproval?: boolean | undefined
}

/** Create an additional invite link, leaving the primary one alone. */
export async function createInviteLink(
  tg: TelegramClient,
  rawPeer: string | number,
  options: InviteLinkOptions = {}
): Promise<InviteLinkResult> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)

  const out: { link: string } = { link: '' }
  const record = await guardedSend(peerId, 'invite-link', 0, async () => {
    out.link = (await tg.createInviteLink(peerId, {
      ...(options.expires === undefined ? {} : { expires: options.expires }),
      ...(options.usageLimit === undefined ? {} : { usageLimit: options.usageLimit }),
      ...(options.withApproval === undefined ? {} : { withApproval: options.withApproval })
    })).link
    return { id: 0 }
  }, { units: 0 })
  return { record, link: out.link }
}

/** Edit a non-primary invite link. Only the fields passed are changed. */
export async function editInviteLink(
  tg: TelegramClient,
  rawPeer: string | number,
  link: string,
  options: InviteLinkOptions = {}
): Promise<InviteLinkResult> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)
  if (!link.trim()) throw new OperatorError('Give the invite link to edit.')

  const out: { link: string } = { link: '' }
  const record = await guardedSend(peerId, 'invite-link', 0, async () => {
    out.link = (await tg.editInviteLink({
      chatId: peerId,
      link,
      ...(options.expires === undefined ? {} : { expires: options.expires }),
      ...(options.usageLimit === undefined ? {} : { usageLimit: options.usageLimit }),
      ...(options.withApproval === undefined ? {} : { withApproval: options.withApproval })
    })).link
    return { id: 0 }
  }, { units: 0 })
  return { record, link: out.link }
}

/** Create a forum topic. The record's messageId is the topic's top message id. */
export async function createForumTopic(
  tg: TelegramClient,
  rawPeer: string | number,
  title: string,
  options: AdminOptions & { icon?: number | undefined } = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)
  if (!title.trim()) throw new OperatorError('Give the topic a title.')

  return guardedSend(peerId, 'forum-topic', 0, async () => {
    const message = await tg.createForumTopic({
      chatId: peerId,
      title,
      ...(options.icon === undefined ? {} : { icon: options.icon })
    })
    return { id: message.id }
  }, { units: 0 })
}

/** Rename a forum topic. */
export async function editForumTopic(
  tg: TelegramClient,
  rawPeer: string | number,
  topicId: number,
  title: string,
  options: AdminOptions = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)
  assertTopicId(topicId)
  if (!title.trim()) throw new OperatorError('Refusing to set an empty topic title.')

  return guardedSend(peerId, 'forum-topic', 0, async () => {
    const message = await tg.editForumTopic({ chatId: peerId, topicId, title })
    return { id: message.id }
  }, { units: 0 })
}

/** A topic id is the id of its top message, so the same rule applies. */
function assertTopicId(topicId: number): void {
  if (!Number.isInteger(topicId) || topicId <= 0) {
    throw new OperatorError(`Not a topic id: ${topicId}. Ids are positive integers.`)
  }
}

/** Close or reopen a forum topic. */
export async function setForumTopicClosed(
  tg: TelegramClient,
  rawPeer: string | number,
  topicId: number,
  closed: boolean,
  options: AdminOptions = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)
  assertTopicId(topicId)

  return guardedSend(peerId, 'forum-topic', 0, async () => {
    const message = await tg.toggleForumTopicClosed({ chatId: peerId, topicId, closed })
    return { id: message.id }
  }, { units: 0 })
}

/** Pin or unpin a forum topic. */
export async function setForumTopicPinned(
  tg: TelegramClient,
  rawPeer: string | number,
  topicId: number,
  pinned: boolean,
  options: AdminOptions = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)
  assertTopicId(topicId)

  return guardedSend(peerId, 'forum-topic', 0, async () => {
    await tg.toggleForumTopicPinned({ chatId: peerId, topicId, pinned })
    return { id: 0 }
  }, { units: 0 })
}

/** Set the slow-mode interval in seconds; 0 turns it off. */
export async function setSlowMode(
  tg: TelegramClient,
  rawPeer: string | number,
  seconds: number,
  options: AdminOptions = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)
  if (!Number.isInteger(seconds) || seconds < 0) {
    throw new OperatorError(`Not a slow-mode interval: ${seconds}. Give seconds, or 0 to disable.`)
  }

  return guardedSend(peerId, 'slow-mode', 0, async () => {
    await tg.setSlowMode(peerId, seconds)
    return { id: 0 }
  }, { units: 0 })
}

/** Turn "restrict saving content" on or off. */
export async function setContentProtection(
  tg: TelegramClient,
  rawPeer: string | number,
  enabled: boolean,
  options: AdminOptions = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)

  return guardedSend(peerId, 'content-protection', 0, async () => {
    await tg.toggleContentProtection(peerId, enabled)
    return { id: 0 }
  }, { units: 0 })
}

/** Require an admin to approve people joining by link. */
export async function setJoinRequests(
  tg: TelegramClient,
  rawPeer: string | number,
  enabled: boolean,
  options: AdminOptions = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)

  return guardedSend(peerId, 'join-requests', 0, async () => {
    await tg.toggleJoinRequests(peerId, enabled)
    return { id: 0 }
  }, { units: 0 })
}

/** Require joining a discussion group before being able to post in it. */
export async function setJoinToSend(
  tg: TelegramClient,
  rawPeer: string | number,
  enabled: boolean,
  options: AdminOptions = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)

  return guardedSend(peerId, 'join-to-send', 0, async () => {
    await tg.toggleJoinToSend(peerId, enabled)
    return { id: 0 }
  }, { units: 0 })
}

/**
 * Membership and destruction (D13d).
 *
 * Unlike every verb above these act on a PERSON, or destroy a chat outright.
 * Still zero cap units (they deliver no message), still behind the confirmation
 * gate and the audit log; the real backstops are the 20-user batch cap, the
 * stop-on-flood rule and, for deletion, the ownership check.
 */

/** Telegram errors this CLI has learned by name, as an OperatorError with the right exit code. Anything else passes through. */
export function friendlyTelegramError(error: unknown): unknown {
  if (!(error instanceof Error)) return error
  if (tl.RpcError.is(error, 'FLOOD_WAIT_%d')) {
    return new OperatorError(
      `Telegram asked us to wait ${error.seconds}s before trying again. Not a bug: retry after that.`,
      EXIT.upstream
    )
  }
  if (tl.RpcError.is(error, 'PEER_FLOOD')) {
    return new OperatorError(
      'Telegram is throttling this account for too many requests. Wait a while before retrying.',
      EXIT.upstream
    )
  }
  if (tl.RpcError.is(error, 'CHAT_ADMIN_REQUIRED')) {
    return new OperatorError(
      'This account is not an admin in that chat, so Telegram refused. A human must grant admin rights first.',
      EXIT.needsHuman
    )
  }
  if (tl.RpcError.is(error, 'CHANNEL_FORUM_MISSING')) {
    return new OperatorError(
      'That chat is not a forum, so it has no topics. Create it with --forum, or drop --topic.',
      EXIT.usage
    )
  }
  if (tl.RpcError.is(error, 'TOPIC_CLOSED')) {
    return new OperatorError(
      'That topic is closed. Reopen it first: tg group topic-closed <chat> <topicId> off',
      EXIT.usage
    )
  }
  return error
}

/** The most users one `add-members` call will touch. */
export const MAX_MEMBERS_PER_CALL = 20

export type AddMemberFailureReason =
  | 'privacy' | 'not_mutual' | 'flood' | 'too_many_channels' | 'already_member' | 'other'

export interface AddMemberFailure {
  user: number
  reason: AddMemberFailureReason
  message: string
}

export interface AddMembersResult {
  added: number[]
  failed: AddMemberFailure[]
}

const INVITE_HINT = 'Share an invite link instead: tg group invite-new <chat>'

/** Map one thrown error to a stable reason code. `stop` means: do not keep hammering Telegram. */
function classifyAddFailure(error: unknown): { reason: AddMemberFailureReason; message: string; stop: boolean } {
  if (tl.RpcError.is(error, 'FLOOD_WAIT_%d')) {
    return { reason: 'flood', message: `Telegram asked us to wait ${error.seconds}s.`, stop: true }
  }
  if (tl.RpcError.is(error, 'PEER_FLOOD')) {
    return { reason: 'flood', message: 'Telegram is throttling this account for too many requests.', stop: true }
  }
  if (tl.RpcError.is(error, 'USER_PRIVACY_RESTRICTED')) {
    return { reason: 'privacy', message: `The user's privacy settings forbid being added. ${INVITE_HINT}`, stop: false }
  }
  if (tl.RpcError.is(error, 'USER_NOT_MUTUAL_CONTACT')) {
    return { reason: 'not_mutual', message: `Not a mutual contact. ${INVITE_HINT}`, stop: false }
  }
  if (tl.RpcError.is(error, 'USER_CHANNELS_TOO_MUCH')) {
    return { reason: 'too_many_channels', message: 'This user is already in too many groups and channels.', stop: false }
  }
  if (tl.RpcError.is(error, 'USER_ALREADY_PARTICIPANT')) {
    return { reason: 'already_member', message: 'Already a member.', stop: false }
  }
  if (tl.RpcError.is(error, 'CHAT_ADMIN_REQUIRED')) {
    return { reason: 'other', message: 'This account is not an admin in that chat.', stop: false }
  }
  return { reason: 'other', message: error instanceof Error ? error.message : String(error), stop: false }
}

/**
 * Add people to a chat, one at a time.
 *
 * One RPC per user so that one refusal cannot hide the others' outcome; each is
 * its own audit line. Never throws for a per-user refusal: the result lists who
 * was added and who was not, with a stable reason. A flood signal stops the
 * batch, and the users not yet tried are reported as `flood`, not retried.
 */
export async function addChatMembers(
  tg: TelegramClient,
  rawPeer: string | number,
  userIds: number[],
  options: AdminOptions = {}
): Promise<AddMembersResult> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)
  if (userIds.length === 0) throw new OperatorError('Give at least one user id to add.', EXIT.usage)
  if (userIds.length > MAX_MEMBERS_PER_CALL) {
    throw new OperatorError(
      `Too many users (${userIds.length}). Add at most ${MAX_MEMBERS_PER_CALL} per call.`,
      EXIT.usage
    )
  }
  const users = userIds.map((id) => assertPeerId(id))

  const added: number[] = []
  const failed: AddMemberFailure[] = []
  let stopped = false

  for (const user of users) {
    if (stopped) {
      failed.push({ user, reason: 'flood', message: 'Skipped: an earlier attempt in this batch hit a flood limit.' })
      continue
    }
    let missing = false
    try {
      await guardedSend(peerId, 'add-member', 0, async () => {
        const result = await tg.addChatMembers(peerId, [user], {})
        missing = result.length > 0
        return { id: user }
      }, { units: 0, targetUserId: user })
      if (missing) {
        failed.push({ user, reason: 'privacy', message: `The user's privacy settings forbid being added. ${INVITE_HINT}` })
      } else {
        added.push(user)
      }
    } catch (error) {
      const { reason, message, stop } = classifyAddFailure(error)
      failed.push({ user, reason, message })
      if (stop) stopped = true
    }
  }

  return { added, failed }
}

/** Remove one person from a chat (they may rejoin). */
export async function kickChatMember(
  tg: TelegramClient,
  rawPeer: string | number,
  rawUser: string | number,
  options: AdminOptions = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)
  const userId = assertPeerId(rawUser)

  return guardedSend(peerId, 'kick-member', 0, async () => {
    try {
      const message = await tg.kickChatMember({ chatId: peerId, userId })
      return { id: message?.id ?? 0 }
    } catch (error) {
      throw friendlyTelegramError(error)
    }
  }, { units: 0, targetUserId: userId })
}

/**
 * Delete a supergroup or channel for everyone. Irreversible.
 *
 * Only a chat this account created: checked first, refused otherwise. The check
 * is a read, so a refusal is not logged as a write attempt.
 */
export async function deleteChat(
  tg: TelegramClient,
  rawPeer: string | number,
  options: AdminOptions = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)

  const chat = await tg.getChat(peerId)
  if (!chat.isCreator) {
    throw new OperatorError(
      `Refusing to delete ${peerId}: this account did not create it. Only a chat you own can be deleted here.`,
      EXIT.usage
    )
  }

  return guardedSend(peerId, 'delete-chat', 0, async () => {
    try {
      await tg.deleteChannel(peerId)
    } catch (error) {
      throw friendlyTelegramError(error)
    }
    return { id: 0 }
  }, { units: 0 })
}

/**
 * Moderation and admin rights (D13e).
 *
 * `ban`, `unban`, `restrict`, `promote` and `demote`: still one PERSON per RPC
 * and one audit line each, still zero cap units (none delivers a message), still
 * behind the confirmation gate. What is new is the weight of two of them: a ban
 * is not undone by an unban in the eyes of everybody who watched it, and
 * `promote` hands another human power over the chat.
 *
 * Every one needs a supergroup or channel. A legacy group has no ban, no
 * restriction and no admin rights in Telegram's model (mtcute's ban there is a
 * plain removal, its unban a no-op), so reporting "banned" for it would be a
 * lie; the verbs refuse such a chat up front, from the id alone, with no round
 * trip. The one thing deliberately NOT reachable from here is ownership: there
 * is no transfer, and `promote` refuses anything that reads as "all rights".
 */

/** Telegram's marked ids: a supergroup or channel is below this, a legacy group is between it and zero. */
const FIRST_CHANNEL_MARK = -1_000_000_000_000

function assertSupergroupId(peerId: number, verb: string, hint: string): void {
  if (peerId < FIRST_CHANNEL_MARK) return
  throw new OperatorError(
    `${verb} needs a supergroup or channel, and ${peerId} is not one (it is a legacy group, a private chat or a user). ${hint}`,
    EXIT.usage
  )
}

/** A person is a positive user id: a chat or channel id is never somebody to ban or promote. */
function assertUserId(raw: string | number): number {
  const id = assertPeerId(raw)
  if (id < 0) {
    throw new OperatorError(
      `${id} is a chat or channel id, not a person. Give a user's numeric id: tg peers find <name> --id-only`,
      EXIT.usage
    )
  }
  return id
}

/** One call touches at most this many people, de-duplicated, at least one. */
function assertPeople(raw: readonly (string | number)[], what: string): number[] {
  if (raw.length === 0) throw new OperatorError(`Give at least one user id to ${what}.`, EXIT.usage)
  if (raw.length > MAX_MEMBERS_PER_CALL) {
    throw new OperatorError(
      `Too many users (${raw.length}). ${what[0]!.toUpperCase()}${what.slice(1)} at most ${MAX_MEMBERS_PER_CALL} per call.`,
      EXIT.usage
    )
  }
  return [...new Set(raw.map((id) => assertUserId(id)))]
}

const UNTIL_MIN_MS = 30_000
const UNTIL_MAX_MS = 366 * 24 * 60 * 60 * 1000

/**
 * `until` as UNIX ms, refused unless Telegram will honour it.
 *
 * Telegram reads an end date under ~30 seconds ahead or over 366 days out as
 * FOREVER, and mtcute's seconds field wraps past 2038, which also means
 * forever. A caller who asked for a short ban and silently got a permanent one
 * cannot tell, so anything outside the window is refused instead of passed on.
 */
export function assertUntil(until: number | undefined, now = Date.now()): number | undefined {
  if (until === undefined) return undefined
  if (!Number.isFinite(until)) throw new OperatorError(`Not a usable end date: ${until}.`, EXIT.usage)
  if (until < now + UNTIL_MIN_MS) {
    throw new OperatorError(
      `The end date ${new Date(until).toISOString()} is not at least 30 seconds away, which Telegram reads as FOREVER. Omit it if you mean forever.`,
      EXIT.usage
    )
  }
  if (until > now + UNTIL_MAX_MS) {
    throw new OperatorError(
      `The end date ${new Date(until).toISOString()} is more than 366 days away, which Telegram also reads as FOREVER. Omit it if you mean forever.`,
      EXIT.usage
    )
  }
  return until
}

const untilDetail = (until: number | undefined): string =>
  until === undefined ? 'until=forever' : `until=${new Date(until).toISOString()}`

export type MemberFailureReason =
  | 'flood' | 'not_admin' | 'target_is_admin' | 'target_is_creator' | 'not_member'
  | 'invalid_user' | 'invalid_chat' | 'too_many_admins' | 'invalid_rank' | 'skipped' | 'other'

export interface MemberFailure {
  user: number
  reason: MemberFailureReason
  message: string
  /** The repo exit code this refusal maps to (see AGENTS.md). */
  exit: number
}

export interface MemberBatchResult {
  /** People the action was applied to, in the order given. */
  done: number[]
  failed: MemberFailure[]
}

/** The exit code of a batch: 0 when it all worked, else the code of the first refusal. */
export function memberBatchExit(result: MemberBatchResult): number {
  return result.failed[0]?.exit ?? EXIT.ok
}

/**
 * Telegram's refusals to act on a person, as a stable reason and a repo exit code.
 *
 * `stop` means the next person would meet the same wall (no rights, a flood, an
 * unknown chat), so a batch halts rather than hammering Telegram. Anything not
 * listed is `other` with exit 1: an unknown failure stays a bug with its stack,
 * like everywhere else in this CLI.
 */
export function classifyMemberFailure(
  error: unknown
): { reason: MemberFailureReason; message: string; exit: number; stop: boolean } {
  if (tl.RpcError.is(error, 'FLOOD_WAIT_%d')) {
    return { reason: 'flood', message: `Telegram asked us to wait ${error.seconds}s. Not retried: retry after that.`, exit: EXIT.upstream, stop: true }
  }
  if (tl.RpcError.is(error, 'PEER_FLOOD')) {
    return { reason: 'flood', message: 'Telegram is throttling this account for too many requests. Wait a while before retrying.', exit: EXIT.upstream, stop: true }
  }
  if (tl.RpcError.is(error, 'CHAT_ADMIN_REQUIRED') || tl.RpcError.is(error, 'RIGHT_FORBIDDEN')) {
    return {
      reason: 'not_admin',
      message: 'This account is not an admin in that chat, or lacks the right for this. A human must grant it first.',
      exit: EXIT.needsHuman,
      stop: true
    }
  }
  if (tl.RpcError.is(error, 'USER_ADMIN_INVALID')) {
    return {
      reason: 'target_is_admin',
      message: 'That person is an admin this account may not change (it did not appoint them, or lacks the right). A human must deal with it.',
      exit: EXIT.needsHuman,
      stop: false
    }
  }
  if (tl.RpcError.is(error, 'USER_CREATOR')) {
    return { reason: 'target_is_creator', message: 'That person created the chat; nothing can be done to them here.', exit: EXIT.usage, stop: false }
  }
  if (tl.RpcError.is(error, 'USER_NOT_PARTICIPANT')) {
    return { reason: 'not_member', message: 'That person is not a member of the chat.', exit: EXIT.usage, stop: false }
  }
  if (
    tl.RpcError.is(error, 'USER_ID_INVALID') ||
    tl.RpcError.is(error, 'PARTICIPANT_ID_INVALID') ||
    tl.RpcError.is(error, 'PEER_ID_INVALID')
  ) {
    return { reason: 'invalid_user', message: 'Telegram does not know that user id.', exit: EXIT.usage, stop: false }
  }
  if (
    tl.RpcError.is(error, 'CHANNEL_INVALID') ||
    tl.RpcError.is(error, 'CHANNEL_PRIVATE') ||
    tl.RpcError.is(error, 'CHAT_ID_INVALID')
  ) {
    return { reason: 'invalid_chat', message: 'Telegram does not know that chat, or this account is not in it.', exit: EXIT.usage, stop: true }
  }
  if (tl.RpcError.is(error, 'ADMINS_TOO_MUCH')) {
    return { reason: 'too_many_admins', message: 'The chat already has the most admins Telegram allows. A human must demote one first.', exit: EXIT.needsHuman, stop: true }
  }
  if (tl.RpcError.is(error, 'ADMIN_RANK_INVALID') || tl.RpcError.is(error, 'ADMIN_RANK_EMOJI_NOT_ALLOWED')) {
    return { reason: 'invalid_rank', message: 'Telegram refused the custom title: at most 16 characters, and no emoji.', exit: EXIT.usage, stop: false }
  }
  return {
    reason: 'other',
    message: error instanceof Error ? error.message : String(error),
    exit: EXIT.bug,
    stop: false
  }
}

/** The error a single-person verb throws: mapped when Telegram's answer is known, untouched (a bug) when not. */
function memberRefusal(error: unknown): unknown {
  const known = classifyMemberFailure(error)
  return known.reason === 'other' ? error : new OperatorError(known.message, known.exit)
}

/**
 * Apply one RPC per person, one audit line each, stopping at a wall.
 *
 * Nothing is retried and nothing sleeps: a flood limit, a missing right or an
 * unknown chat halts the batch and the people not yet reached come back as
 * `skipped` with the same exit code. A refusal about one person (they are an
 * admin, they are not a member) is that person's alone and the batch goes on.
 */
async function eachPerson(
  peerId: number,
  kind: SentRecord['kind'],
  users: number[],
  detail: string,
  run: (user: number) => Promise<number>
): Promise<MemberBatchResult> {
  const done: number[] = []
  const failed: MemberFailure[] = []
  let stopper: MemberFailure | null = null

  for (const user of users) {
    if (stopper) {
      failed.push({
        user,
        reason: 'skipped',
        message: `Not attempted: an earlier refusal (${stopper.reason}) stopped the batch.`,
        exit: stopper.exit
      })
      continue
    }
    try {
      await guardedSend(peerId, kind, 0, async () => ({ id: await run(user) }), {
        units: 0,
        targetUserId: user,
        detail
      })
      done.push(user)
    } catch (error) {
      const known = classifyMemberFailure(error)
      const failure: MemberFailure = { user, reason: known.reason, message: known.message, exit: known.exit }
      failed.push(failure)
      if (known.stop) stopper = failure
    }
  }

  return { done, failed }
}

/**
 * Ban people from a supergroup or channel: out, and unable to come back by themselves.
 *
 * `until` is UNIX ms; omitted means forever.
 */
export async function banMembers(
  tg: TelegramClient,
  rawPeer: string | number,
  rawUsers: readonly (string | number)[],
  options: AdminOptions & { until?: number | undefined } = {}
): Promise<MemberBatchResult> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)
  assertSupergroupId(peerId, 'ban', 'A legacy group has no ban: remove someone there with tg group kick-member.')
  const users = assertPeople(rawUsers, 'ban')
  const until = assertUntil(options.until)

  return eachPerson(peerId, 'ban-member', users, untilDetail(until), async (userId) => {
    const message = await tg.banChatMember({
      chatId: peerId,
      participantId: userId,
      ...(until === undefined ? {} : { untilDate: until })
    })
    return message?.id ?? 0
  })
}

/**
 * Lift a ban or any restrictions, so the person MAY join again.
 *
 * It does not add anyone back. Telegram answers an unban of somebody who was
 * never banned with success, so an unban line in the log means "the door is
 * open", not "this person was banned".
 */
export async function unbanMembers(
  tg: TelegramClient,
  rawPeer: string | number,
  rawUsers: readonly (string | number)[],
  options: AdminOptions = {}
): Promise<MemberBatchResult> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)
  assertSupergroupId(peerId, 'unban', 'A legacy group has no ban to lift.')
  const users = assertPeople(rawUsers, 'unban')

  return eachPerson(peerId, 'unban-member', users, 'bans and restrictions lifted', async (userId) => {
    await tg.unbanChatMember({ chatId: peerId, participantId: userId })
    return 0
  })
}

/** The names in a comma-separated list, trimmed, de-duplicated, order kept. */
function nameList(raw: string): string[] {
  return [...new Set(raw.split(',').map((part) => part.trim()).filter(Boolean))]
}

/**
 * Check restriction names, from the CLI (`--deny a,b`) or a caller.
 *
 * `hasOwn`, not a plain lookup: `__proto__` and `constructor` would otherwise
 * resolve to inherited Object members and walk past this check.
 */
export function parseRestrictionNames(names: string | readonly string[]): RestrictionName[] {
  const list = typeof names === 'string' ? nameList(names) : [...new Set(names)]
  if (list.length === 0) {
    throw new OperatorError(
      'Name at least one restriction to apply. To lift restrictions, use: tg group unban <peer> <user>',
      EXIT.usage
    )
  }
  for (const name of list) {
    if (name === 'view-messages') {
      throw new OperatorError('Not a restriction: view-messages is a ban. Use: tg group ban <peer> <user>', EXIT.usage)
    }
    if (!Object.hasOwn(RESTRICTIONS, name)) {
      throw new OperatorError(
        `Not a restriction: ${name}. One of: ${Object.keys(RESTRICTIONS).join(', ')}`,
        EXIT.usage
      )
    }
  }
  return list as RestrictionName[]
}

/** The TL restriction object for a list of names: every named right set to true, which DISALLOWS it. */
export function restrictionsFor(names: readonly RestrictionName[]): Restrictions {
  const out: Restrictions = {}
  for (const name of names) out[RESTRICTIONS[name]] = true
  return out
}

/**
 * Take specific abilities away from one member of a supergroup.
 *
 * Each named restriction is set to true, which means DISALLOWED: that is
 * Telegram's own sense and it is passed through untranslated. At least one must
 * be named; an empty object would lift every restriction, and that has its own
 * verb (`unban`).
 */
export async function restrictMember(
  tg: TelegramClient,
  rawPeer: string | number,
  rawUser: string | number,
  deny: string | readonly string[],
  options: AdminOptions & { until?: number | undefined } = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)
  assertSupergroupId(peerId, 'restrict', 'A legacy group cannot restrict one member.')
  const userId = assertUserId(rawUser)
  const names = parseRestrictionNames(deny)
  const until = assertUntil(options.until)

  try {
    return await guardedSend(peerId, 'restrict-member', 0, async () => {
      await tg.restrictChatMember({
        chatId: peerId,
        userId,
        restrictions: restrictionsFor(names),
        ...(until === undefined ? {} : { until })
      })
      return { id: 0 }
    }, { units: 0, targetUserId: userId, detail: `deny=${names.join(',')} ${untilDetail(until)}` })
  } catch (error) {
    throw memberRefusal(error)
  }
}

/** Words that mean "everything" or "the chat itself", never accepted as a right. */
const SWEEPING_RIGHT = /^(all|\*|everything|full|owner|creator|founder|transfer)$/i

/**
 * Check admin right names, from the CLI (`--rights a,b`) or a caller.
 *
 * Rights are granted by NAME, one at a time. There is no `all`, no wildcard and
 * no ownership: those words are refused, and so is a list that names every
 * right, which is the same grant spelled out. The guard is against the
 * shortcut, not against an operator who wants a near-full admin and says so by
 * leaving one out.
 */
export function parseAdminRightNames(names: string | readonly string[]): AdminRightName[] {
  const list = typeof names === 'string' ? nameList(names) : [...new Set(names)]
  if (list.length === 0) {
    throw new OperatorError(
      'Name at least one right to grant. To take admin rights away, use: tg group demote <peer> <user>',
      EXIT.usage
    )
  }
  for (const name of list) {
    if (SWEEPING_RIGHT.test(name)) {
      throw new OperatorError(
        `Refusing "${name}": rights are named one by one, there is no "all", and ownership cannot be handed over here. ` +
        `One of: ${Object.keys(ADMIN_RIGHTS).join(', ')}`,
        EXIT.usage
      )
    }
    if (!Object.hasOwn(ADMIN_RIGHTS, name)) {
      throw new OperatorError(
        `Not an admin right: ${name}. One of: ${Object.keys(ADMIN_RIGHTS).join(', ')}`,
        EXIT.usage
      )
    }
  }
  if (list.length === Object.keys(ADMIN_RIGHTS).length) {
    throw new OperatorError(
      'Refusing to grant every right at once: that is an all-rights grant spelled out. Leave out the ones this person does not need.',
      EXIT.usage
    )
  }
  return list as AdminRightName[]
}

/** The TL admin-rights object for a list of names. */
export function adminRightsFor(names: readonly AdminRightName[]): AdminRights {
  const out: AdminRights = {}
  for (const name of names) out[ADMIN_RIGHTS[name]] = true
  return out
}

/** Telegram's limit on a custom admin title. */
export const MAX_RANK_LENGTH = 16

/** A custom admin title: 1-16 visible characters, or absent. */
export function parseRank(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const rank = raw.trim()
  const control = [...rank].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  if (rank.length === 0 || [...rank].length > MAX_RANK_LENGTH || control) {
    throw new OperatorError(
      `Not an admin title: ${JSON.stringify(raw)}. Give 1-${MAX_RANK_LENGTH} characters, no emoji, or omit --rank.`,
      EXIT.usage
    )
  }
  return rank
}

/**
 * Make somebody an admin with exactly the rights named, replacing any they had.
 *
 * Re-running with fewer rights narrows them. `add-admins` lets that person
 * appoint further admins and is a privilege escalation in its own right, so
 * the command layer says so in the prompt.
 */
export async function promoteAdmin(
  tg: TelegramClient,
  rawPeer: string | number,
  rawUser: string | number,
  rights: string | readonly string[],
  options: AdminOptions & { rank?: string | undefined } = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)
  assertSupergroupId(peerId, 'promote', 'Admin rights exist only in supergroups and channels.')
  const userId = assertUserId(rawUser)
  const names = parseAdminRightNames(rights)
  const rank = parseRank(options.rank)

  try {
    return await guardedSend(peerId, 'promote-admin', 0, async () => {
      await tg.editAdminRights({
        chatId: peerId,
        userId,
        rights: adminRightsFor(names),
        ...(rank === undefined ? {} : { rank })
      })
      return { id: 0 }
    }, {
      units: 0,
      targetUserId: userId,
      detail: `rights=${names.join(',')}${rank === undefined ? '' : ` rank=${JSON.stringify(rank)}`}`
    })
  } catch (error) {
    throw memberRefusal(error)
  }
}

/** Take every admin right away from somebody: they stay in the chat as a member. */
export async function demoteAdmin(
  tg: TelegramClient,
  rawPeer: string | number,
  rawUser: string | number,
  options: AdminOptions = {}
): Promise<SentRecord> {
  const peerId = assertPeerId(rawPeer)
  assertConfirmed(options)
  assertSupergroupId(peerId, 'demote', 'Admin rights exist only in supergroups and channels.')
  const userId = assertUserId(rawUser)

  try {
    return await guardedSend(peerId, 'demote-admin', 0, async () => {
      // Empty rights is how Telegram spells "no longer an admin".
      await tg.editAdminRights({ chatId: peerId, userId, rights: {} })
      return { id: 0 }
    }, { units: 0, targetUserId: userId, detail: 'rights=none' })
  } catch (error) {
    throw memberRefusal(error)
  }
}
