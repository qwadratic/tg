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
