import type { TelegramClient } from '@mtcute/node'
import { pullMedia, type PulledFile } from '../media/index.js'
import { sleep } from '../utils/sleep.js'

/**
 * Poll a chat for media that arrives AFTER the watch starts.
 *
 * The use case: "I am about to send myself a screen recording, grab it." A
 * download command cannot serve that, because the file does not exist yet.
 *
 * WHY polling and not update handlers: `src/client.ts` sets
 * `disableUpdates: true`, so this client never receives push updates at all.
 * Turning them on would make every command a long-lived stateful connection and
 * change the account's traffic profile. A 15s poll of the most recent messages
 * is the smaller change, and for "wait for the thing I am about to send" the
 * latency is irrelevant.
 */

export interface WatchOptions {
  /** Where downloads land. */
  destDir: string
  /** Media kinds to accept. Empty means any. */
  kinds?: readonly string[] | undefined
  /** Give up after this long. */
  timeoutMinutes?: number | undefined
  /** Seconds between polls. */
  intervalSeconds?: number | undefined
  /** Stop after this many files. */
  max?: number | undefined
  onFile?: ((file: PulledFile) => void) | undefined
  onPoll?: ((attempt: number) => void) | undefined
}

/**
 * Wait for new media in `chatId`, downloading what arrives.
 *
 * The `startedAt` cutoff is the safety property: only messages posted after the
 * watch began are eligible, so pointing this at Saved Messages cannot silently
 * exfiltrate whatever happened to be sitting in there already.
 */
export async function watchForMedia(
  tg: TelegramClient,
  chatId: number,
  options: WatchOptions
): Promise<PulledFile[]> {
  const startedAt = new Date()
  const timeoutMs = (options.timeoutMinutes ?? 45) * 60_000
  const intervalMs = (options.intervalSeconds ?? 15) * 1000
  const max = options.max ?? 1
  const deadline = Date.now() + timeoutMs

  const collected: PulledFile[] = []
  const seen = new Set<number>()
  let attempt = 0

  while (Date.now() < deadline && collected.length < max) {
    attempt++
    options.onPoll?.(attempt)

    // A small scan window: only brand-new messages matter, and `since` stops the
    // walk at the cutoff anyway.
    const found = await pullMedia(tg, chatId, {
      destDir: options.destDir,
      kinds: options.kinds,
      max: max - collected.length,
      scanLimit: 20,
      since: startedAt
    })

    for (const file of found) {
      // pullMedia re-scans each poll, so a file already taken would download
      // twice without this.
      if (seen.has(file.messageId)) continue
      seen.add(file.messageId)
      collected.push(file)
      options.onFile?.(file)
    }

    if (collected.length >= max) break
    await sleep(intervalMs)
  }

  return collected
}
