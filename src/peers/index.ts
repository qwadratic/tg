import type { TelegramClient } from '@mtcute/node'

/**
 * Peer discovery: which chats exist, and which one is the person I mean.
 *
 * WHY this is its own verb rather than a flag on export: every write operation
 * takes a NUMERIC peer id, never a name (see `src/send/index.ts`). Discovery is
 * therefore a separate, read-only step whose whole job is to turn "Zoe" into
 * an id a human has looked at. Merging the two would put fuzzy name matching on
 * the path that sends messages to real people, which is the mistake this
 * separation exists to make impossible.
 */

/** A chat, flattened to the fields worth deciding on. */
export interface PeerSummary {
  id: number
  /** 'user' | 'chat' | 'channel', as mtcute reports it. */
  type: string
  name: string
  username: string | null
  bot: boolean
  /** ISO minute of the last message, or null for an empty chat. */
  lastMessageAt: string | null
  /** First line of the last message, clipped. Context for picking the right chat. */
  lastMessage: string
}

/**
 * mtcute's dialog peer is untyped at this boundary, so read it defensively:
 * only a primitive becomes text, anything else is treated as absent rather
 * than stringified into "[object Object]".
 */
function asText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return null
}

/** Name fields differ by peer type; a user has firstName, a group has title. */
function peerName(peer: Record<string, unknown>): string {
  const parts = [peer.firstName, peer.lastName].filter(Boolean).join(' ')
  return String(peer.displayName ?? peer.title ?? (parts || peer.id))
}

/**
 * Strip diacritics so an ASCII needle matches an accented name.
 *
 * "zoe" has to find "Zoë". Without this the operator types the name they
 * can type and gets nothing back, then reaches for a raw script.
 */
export function foldAccents(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

export interface ListPeersOptions {
  /** Cap on dialogs walked. Telegram pages these, so this bounds the request count. */
  limit?: number | undefined
  /** Keep only this peer type. 'user' gives 1:1 chats and excludes groups. */
  type?: string | undefined
  /** Keep only chats whose last message is at or after this instant. */
  since?: Date | undefined
  /** Drop bot chats. Bots dominate a dialog list and are rarely the target. */
  excludeBots?: boolean | undefined
}

/**
 * Enumerate dialogs, newest activity first.
 *
 * Read-only: walks the dialog list and resolves nothing beyond what Telegram
 * already returned, so it costs one paged request sequence and no per-peer
 * lookups.
 */
export async function listPeers(
  tg: TelegramClient,
  options: ListPeersOptions = {}
): Promise<PeerSummary[]> {
  const found: PeerSummary[] = []

  for await (const dialog of tg.iterDialogs({ limit: options.limit ?? 500 })) {
    const peer = dialog.peer as unknown as Record<string, unknown>
    const type = asText(peer.type) ?? 'unknown'

    if (options.type && type !== options.type) continue
    if (options.excludeBots && peer.isBot) continue

    const date = dialog.lastMessage?.date ?? null
    if (options.since && (!date || date < options.since)) continue

    found.push({
      id: Number(peer.id),
      type,
      name: peerName(peer),
      username: asText(peer.username),
      bot: Boolean(peer.isBot),
      lastMessageAt: date ? date.toISOString().slice(0, 16) : null,
      lastMessage: (dialog.lastMessage?.text ?? '').replace(/\s+/g, ' ').slice(0, 80)
    })
  }

  // Newest first. Chats with no messages sort last rather than crashing the
  // comparator, which is what a null date would otherwise do.
  found.sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''))
  return found
}

/**
 * Find chats whose name or username contains `needle`, accent-insensitively.
 *
 * Returns every match rather than guessing one. Picking for the operator is the
 * behaviour that sends a message to the wrong person.
 */
export function matchPeers(peers: PeerSummary[], needle: string): PeerSummary[] {
  const folded = foldAccents(needle)
  return peers.filter((p) =>
    foldAccents(`${p.name} ${p.username ?? ''}`).includes(folded)
  )
}

/** Right-pad to width, accounting for nothing clever: these are terminal columns. */
function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text.padEnd(width)
}

/** Render a peer table. Pure, so a golden can pin the layout. */
export function renderPeers(peers: PeerSummary[]): string {
  if (peers.length === 0) return 'no matching chats\n'

  const nameWidth = Math.max(4, ...peers.map((p) => p.name.length))
  const idWidth = Math.max(2, ...peers.map((p) => String(p.id).length))

  const lines = [
    `${pad('id', idWidth)}  ${pad('name', nameWidth)}  type     last`,
    ...peers.map(
      (p) =>
        `${String(p.id).padStart(idWidth)}  ${pad(p.name, nameWidth)}  ` +
        `${pad(p.bot ? 'bot' : p.type, 7)}  ${p.lastMessageAt ?? '-'}`
    )
  ]
  return `${lines.join('\n')}\n`
}
