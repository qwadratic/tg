import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Message, TelegramClient } from '@mtcute/node'
import { fetchMessages } from '../messages/fetch.js'

/**
 * Download media out of a chat.
 *
 * WHY this is a verb: three separate throwaway scripts existed to do this
 * (photos from Saved Messages, videos from one person, "the last N photos"),
 * differing only in which media type they kept and where they wrote it. One
 * verb with a type filter covers all three.
 *
 * Read-only with respect to Telegram: downloads, never posts, edits or deletes.
 */

/** Media kinds worth asking for by name. */
export const MEDIA_KINDS = ['photo', 'video', 'document', 'audio', 'voice'] as const
export type MediaKind = (typeof MEDIA_KINDS)[number]

export interface PulledFile {
  messageId: number
  at: string
  kind: string
  path: string
  bytes: number
  caption: string
}

/**
 * Does this message's media match the requested kinds?
 *
 * A video sent as a file arrives as `document` with a .mov/.mp4 name, so asking
 * for 'video' has to catch it or the obvious request silently returns nothing.
 */
export function mediaMatches(msg: Message, kinds: readonly string[]): boolean {
  const media = msg.media as unknown as { type?: string; fileName?: string } | undefined
  if (!media?.type) return false
  if (kinds.length === 0) return true
  if (kinds.includes(media.type)) return true

  if (kinds.includes('video') && media.type === 'document') {
    return /\.(mov|mp4|m4v|webm)$/i.test(media.fileName ?? '')
  }
  return false
}

/**
 * Filename for a downloaded file.
 *
 * The message id leads, so two files with the same original name cannot collide.
 *
 * Deliberately NOT `sanitizeFilename` from utils: that helper is built for chat
 * archive files and always appends `_<chatId>`, which lands AFTER the extension
 * ("report.png" becomes "report.png_5") and leaves a file no viewer will open.
 * Media keeps its extension, because the extension is what makes the download
 * useful to whatever reads it next.
 *
 * A Telegram filename is attacker-controlled text about to become a path, so
 * separators, traversal and control characters are stripped rather than trusted.
 */
export function mediaFilename(msg: Message): string {
  const media = msg.media as unknown as { type?: string; fileName?: string } | undefined
  const original = media?.fileName

  if (original) {
    const safe = original
      // Take the basename only: "../../etc/passwd" must not escape destDir.
      .replace(/^.*[/\\]/, '')
      // eslint-disable-next-line no-control-regex -- stripping control characters is the point
      .replace(/[<>:"|?*\x00-\x1f]/g, '')
      .replace(/\s+/g, '-')
      // A name that is only dots ("." or "..") would resolve to a directory.
      .replace(/^\.+$/, '')
      .slice(0, 120)
    if (safe) return `${msg.id}-${safe}`
  }

  const extension = media?.type === 'photo' ? 'jpg' : 'bin'
  return `${msg.id}.${extension}`
}

export interface PullOptions {
  /** Destination directory. Created if absent. */
  destDir: string
  /** Media kinds to keep. Empty means every kind. */
  kinds?: readonly string[] | undefined
  /** Stop after this many downloads. */
  max?: number | undefined
  /** Cap on messages scanned while looking for matches. */
  scanLimit?: number | undefined
  /** Ignore messages older than this. */
  since?: Date | undefined
  /** Called per file, for progress on a slow download. */
  onFile?: ((file: PulledFile) => void) | undefined
}

/**
 * Download matching media from a chat into `destDir`.
 *
 * `scanLimit` and `max` are separate on purpose: scanning 500 messages to find
 * 2 photos is normal, and conflating the two would either stop the search early
 * or download far more than asked.
 */
export async function pullMedia(
  tg: TelegramClient,
  chatId: number,
  options: PullOptions
): Promise<PulledFile[]> {
  const kinds = options.kinds ?? []
  const max = options.max ?? 10
  const pulled: PulledFile[] = []

  mkdirSync(options.destDir, { recursive: true })

  for await (const msg of fetchMessages(tg, chatId, {
    limit: options.scanLimit ?? 200,
    since: options.since
  })) {
    if (!mediaMatches(msg, kinds)) continue

    const path = join(options.destDir, mediaFilename(msg))
    const buffer = await tg.downloadAsBuffer(msg.media as never)
    await writeFile(path, buffer)

    const file: PulledFile = {
      messageId: msg.id,
      at: msg.date.toISOString().slice(0, 16),
      kind: (msg.media as unknown as { type?: string })?.type ?? 'unknown',
      path,
      bytes: buffer.length,
      caption: (msg.text ?? '').replace(/\s+/g, ' ').slice(0, 120)
    }
    pulled.push(file)
    options.onFile?.(file)

    if (pulled.length >= max) break
  }

  return pulled
}

/** Render a download report. Pure, so a golden pins the format. */
export function renderPulled(files: PulledFile[]): string {
  if (files.length === 0) return 'no matching media\n'

  return `${files
    .map(
      (f) =>
        `${f.at}  ${f.kind.padEnd(8)}  ${String(Math.round(f.bytes / 1024)).padStart(6)} KB  ${f.path}`
    )
    .join('\n')}\n`
}
