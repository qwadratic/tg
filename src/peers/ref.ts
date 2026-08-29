import type { TelegramClient } from '@mtcute/node'
import { OperatorError } from '../errors.js'
import { EXIT } from '../exit-codes.js'

/**
 * How a human names a chat on the command line.
 *
 * Accepts a numeric id, an @username, a t.me link, or `me` for Saved Messages,
 * because those are the four ways a Telegram chat is actually written down and
 * pasted around. Requiring an id for everything meant looking one up by eye and
 * retyping nine digits before every single command.
 *
 * The safety property that replaces "ids only" is RESOLVE THEN SHOW: whatever
 * you typed is turned into a concrete identity, and the identity - not the thing
 * you typed - is what gets echoed, confirmed for sends, and written to the audit
 * log. See D17 in backlog/decisions/.
 */

export type PeerRefKind = 'id' | 'username' | 'self'

export interface PeerRef {
  /** Ready to hand to mtcute, whose InputPeerLike accepts ids and usernames. */
  value: string | number
  /** Exactly what the operator typed, for error messages. */
  raw: string
  kind: PeerRefKind
}

/**
 * Telegram usernames are ASCII only: letters, digits and underscore, 5-32 chars,
 * starting with a letter.
 *
 * This is why the parser rejects rather than resolves anything with a non-ASCII
 * character in a username position. A Cyrillic "о" inside "@durоv" is not a
 * lookalike of a valid username, it is not a valid username at all, so the
 * homoglyph never reaches the network. That is a fact about Telegram's format,
 * not a policy this tool invented.
 */
const USERNAME = /^[a-zA-Z][a-zA-Z0-9_]{3,31}$/

/** t.me/name, https://t.me/name, telegram.me/name, with or without a trailing slash. */
const LINK = /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/([^/?#]+)\/?$/i

function invalid(raw: string, why: string): OperatorError {
  return new OperatorError(
    `Cannot use ${JSON.stringify(raw)} as a chat: ${why}\n` +
    '  Accepted forms:\n' +
    '    108844221            a numeric id (from `tg peers find <name>`)\n' +
    '    @durov               a username\n' +
    '    https://t.me/durov   a public link\n' +
    '    me                   your own Saved Messages',
    EXIT.usage
  )
}

/**
 * Turn what the operator typed into something mtcute can resolve.
 *
 * Pure and offline: this decides the SHAPE of the reference only. Whether the
 * peer exists is the network's answer, not this function's.
 */
export function parsePeerRef(raw: string): PeerRef {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) throw invalid(raw, 'it is empty')

  if (trimmed === 'me' || trimmed === 'self') {
    return { value: 'me', raw: trimmed, kind: 'self' }
  }

  // A numeric id. Negative ids are groups and channels, so the sign matters.
  if (/^-?\d+$/.test(trimmed)) {
    const id = Number(trimmed)
    if (!Number.isSafeInteger(id) || id === 0) {
      throw invalid(raw, 'that is not a usable Telegram id')
    }
    return { value: id, raw: trimmed, kind: 'id' }
  }

  // A link. Invite links point at a join flow, not a peer that can be resolved.
  const link = LINK.exec(trimmed)
  if (link) {
    const handle = link[1] ?? ''
    if (handle.startsWith('+') || handle.toLowerCase() === 'joinchat') {
      throw invalid(
        raw,
        'that is a private invite link. Join the chat in Telegram first, then find it with `tg peers find`'
      )
    }
    if (!USERNAME.test(handle)) throw invalid(raw, `"${handle}" is not a valid username`)
    return { value: handle, raw: trimmed, kind: 'username' }
  }

  const handle = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed

  if (!USERNAME.test(handle)) {
    // Being specific here is what makes a homoglyph legible instead of baffling.
    if (/[^\x20-\x7e]/.test(handle)) {
      throw invalid(
        raw,
        'it contains a non-ASCII character, and Telegram usernames are ASCII only. ' +
        'If you copied this from a message it may be a lookalike'
      )
    }
    throw invalid(raw, 'it is not a numeric id and not a valid username')
  }

  return { value: handle, raw: trimmed, kind: 'username' }
}

/** A chat, after the network has told us who it actually is. */
export interface ResolvedPeer {
  id: number
  name: string
  username: string | null
  /** How it was written on the command line. */
  ref: PeerRef
}

/**
 * Resolve a reference to a concrete identity.
 *
 * Always goes through `getPeer` even for a numeric id, because the whole point
 * is to hand the caller a NAME to show. A number the operator cannot read is
 * not something they can check.
 */
export async function resolvePeerRef(tg: TelegramClient, raw: string): Promise<ResolvedPeer> {
  const ref = parsePeerRef(raw)

  let peer: { id: number; displayName?: string; username?: string | null }
  try {
    peer = (await tg.getPeer(ref.value))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new OperatorError(
      `No chat found for ${JSON.stringify(ref.raw)} (${detail}).\n` +
      (ref.kind === 'username'
        ? '  Usernames only resolve for public chats and people you can reach.\n' +
          '  For a private chat, find it with:  tg peers find <name>'
        : '  Check the id with:  tg peers find <name>')
    )
  }

  return {
    id: Number(peer.id),
    name: String(peer.displayName ?? peer.id),
    username: peer.username ?? null,
    ref
  }
}

/** One line naming a resolved chat unambiguously: name, @handle and id. */
export function describePeer(peer: ResolvedPeer): string {
  const handle = peer.username ? ` (@${peer.username})` : ''
  return `${peer.name}${handle} [id ${peer.id}]`
}
