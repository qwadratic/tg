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
      refs: messageRefs(msg)
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
      return `[${line.at}] ${line.who}: ${line.text}${media}${refs}`
    })
    .join('\n')}\n`
}
