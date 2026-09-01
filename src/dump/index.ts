import type { Message, TelegramClient } from '@mtcute/node'
import { fetchMessages } from '../messages/fetch.js'

/**
 * Flat, chronological transcript of one chat.
 *
 * WHY this exists next to `export`: the archive writer produces one markdown
 * file per chat with YAML frontmatter, shaped for gbrain ingestion. That is the
 * wrong shape for "read this thread and tell me what the bug reports were",
 * which is the request that kept arriving. That job wants the whole thread as
 * plain lines on stdout, one message per line, oldest first, with the URLs and
 * filenames visible - small enough to pipe straight into another process.
 *
 * Read-only by construction: nothing here calls a write RPC.
 */

/** One message, flattened to a line's worth of fields. */
export interface DumpLine {
  id: number
  /** ISO to the minute. Seconds are noise in a conversation transcript. */
  at: string
  who: string
  text: string
  /** mtcute's media type ('photo', 'video', 'document', ...) or ''. */
  media: string
  /**
   * URLs and filenames pulled out of entities, link previews and documents.
   *
   * Kept separate from `text` because a Telegram link is often an entity with a
   * display label, so the URL never appears in the message text at all. A
   * transcript that drops them loses exactly the references worth following.
   */
  refs: string[]
  /**
   * Engagement, as a compact suffix: views, forwards, top reactions, replies,
   * and whether it was edited. Empty for a message that carries none of them,
   * which is every message in an ordinary 1:1 chat - Telegram simply does not
   * populate these fields there, so nothing has to filter them out by hand.
   */
  stats: string
}

/**
 * The engagement fields mtcute already exposes, folded into one short suffix.
 *
 * Only non-empty values appear. A raw dump of `reactions` would be a page of
 * structure per message; what a reader wants from a channel post is the shape
 * of the response, so this keeps the three loudest emoji with their counts.
 */
export function messageStats(msg: Message): string {
  const parts: string[] = []
  if (msg.views) parts.push(`${msg.views} views`)
  if (msg.forwards) parts.push(`${msg.forwards} fwd`)

  const reactions = msg.reactions?.reactions ?? []
  if (reactions.length > 0) {
    parts.push(
      [...reactions]
        .sort((a, b) => b.count - a.count)
        .slice(0, 3)
        // A custom emoji has no unicode form - its `emoji` is a Long id - so it
        // is shown as a marker rather than a number nobody can read.
        .map((r) => `${typeof r.emoji === 'string' ? r.emoji : 'custom'}${r.count}`)
        .join(' ')
    )
  }

  const replies = msg.replies?.count
  if (replies) parts.push(`${replies} replies`)
  // `hideEditMark` is Telegram's own "treat this as unedited" flag, which its
  // clients honour; an editDate alone would mark messages nobody sees as edited.
  if (msg.editDate && !msg.hideEditMark) parts.push('edited')

  return parts.join(', ')
}

/** Pull every URL and filename a message carries, without duplicates. */
export function messageRefs(msg: Message): string[] {
  const text = msg.text ?? ''
  const media = msg.media as unknown as Record<string, unknown> | undefined
  const refs: string[] = []

  for (const raw of ((msg as unknown as { entities?: unknown[] }).entities ?? [])) {
    const entity = raw as Record<string, unknown>
    // A plain url entity carries no href: the URL *is* the covered text.
    if (entity.kind === 'url' || entity.is === 'url') {
      const offset = Number(entity.offset ?? 0)
      const length = Number(entity.length ?? 0)
      if (length > 0) refs.push(text.slice(offset, offset + length))
    }
    // A text_link entity hides its target behind a label.
    if (typeof entity.url === 'string') refs.push(entity.url)
  }

  if (media) {
    for (const key of ['url', 'displayUrl'] as const) {
      if (typeof media[key] === 'string') refs.push(`preview:${media[key]}`)
    }
    if (typeof media.fileName === 'string') refs.push(`file:${media.fileName}`)
    if (typeof media.title === 'string') refs.push(`title:${media.title}`)
  }

  return [...new Set(refs.filter(Boolean))]
}

export interface DumpOptions {
  /** Cap on messages read. */
  limit?: number | undefined
  /** Stop at messages older than this. */
  since?: Date | undefined
}

/**
 * Read one chat into chronological lines.
 *
 * Rate limiting comes from `fetchMessages`, the single throttled history
 * iterator: 1.5s plus jitter every 100 messages. A second, unthrottled reader
 * is how an account gets limited, so there is deliberately only one.
 */
export async function dumpThread(
  tg: TelegramClient,
  chatId: number,
  options: DumpOptions = {}
): Promise<DumpLine[]> {
  const lines: DumpLine[] = []

  for await (const msg of fetchMessages(tg, chatId, {
    limit: options.limit,
    since: options.since
  })) {
    const text = (msg.text ?? '').trim()
    const media = (msg.media as unknown as { type?: string } | undefined)?.type ?? ''

    // A message with neither text nor media is a service event (joined, pinned,
    // renamed). It carries no conversation content, so it would only pad the
    // transcript the caller is about to read.
    if (!text && !media) continue

    lines.push({
      id: msg.id,
      at: msg.date.toISOString().slice(0, 16),
      who: (msg.sender as unknown as { firstName?: string })?.firstName ?? '?',
      text,
      media,
      refs: messageRefs(msg),
      stats: messageStats(msg)
    })
  }

  // fetchMessages yields newest-first; a transcript reads oldest-first.
  return lines.reverse()
}

/** Render a transcript. Pure, so a golden pins the format. */
export function renderDump(lines: DumpLine[]): string {
  if (lines.length === 0) return 'no messages\n'

  return `${lines
    .map((line) => {
      const media = line.media ? ` <${line.media}>` : ''
      const refs = line.refs.length > 0 ? ` [${line.refs.join(' ')}]` : ''
      const stats = line.stats ? ` (${line.stats})` : ''
      return `[${line.at}] ${line.who}: ${line.text}${media}${refs}${stats}`
    })
    .join('\n')}\n`
}
