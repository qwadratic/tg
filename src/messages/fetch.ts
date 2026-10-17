import type { TelegramClient, Message } from '@mtcute/node'
import { sleep } from '../utils/sleep.js'

/**
 * Options for fetching messages.
 */
export interface FetchMessagesOptions {
  /** Only fetch messages with ID > minId (exclusive). For incremental sync. */
  minId?: number | undefined
  /** Called every 100 messages with current count. */
  onProgress?: ((count: number) => void) | undefined
  /**
   * Stop after yielding this many messages.
   *
   * For bounded reads (`tg dump`, `tg media pull`) where the caller wants a
   * slice, not the whole history. Omitted means "until the chat runs out",
   * which is what the export path needs.
   */
  limit?: number | undefined
  /**
   * Stop when a message older than this is reached.
   *
   * Iteration is newest-first, so the first message older than `since` means
   * every remaining message is older too and the walk can end there. That is
   * the difference between reading a week and reading ten years.
   */
  since?: Date | undefined
  /**
   * Read one thread instead of the whole chat: a forum topic (its id is the
   * topic's first message) or the replies under a message.
   *
   * `getHistory` has no thread parameter in mtcute, so a thread is read through
   * `searchMessages` with an empty query, which returns exactly the messages of
   * that thread, newest first like history does.
   */
  threadId?: number | undefined
}

/** Messages per request, and how often the paced walk stops to breathe. */
export const PAGE_SIZE = 100

/** How a paced walk is bounded and watched. */
export interface PacedOptions<T> {
  /** Stop after yielding this many items. Omitted: until the source runs out. */
  limit?: number | undefined
  /** Stop at the first item older than this. Only meaningful newest-first, with `dateOf`. */
  since?: Date | undefined
  /** The date of an item, for `since`. */
  dateOf?: ((item: T) => Date) | undefined
  /** Called every {@link PAGE_SIZE} items with the running count, and once more at the end. */
  onProgress?: ((count: number) => void) | undefined
}

/**
 * The size of one request when the caller wants at most `limit` items: a small
 * read must not pull a hundred rows and throw ninety-five away.
 */
export function pageSizeFor(limit: number | undefined): number {
  return limit === undefined ? PAGE_SIZE : Math.max(1, Math.min(PAGE_SIZE, limit))
}

/**
 * The one paced walk. Every list that comes out of Telegram page by page goes
 * through it: history, a thread, a search, the admin log, who reacted, a
 * dialog scan. `test/trust.test.ts` fails if an `iter*` method of the client is
 * called anywhere else, because a second, unthrottled reader is how an account
 * gets limited.
 *
 * - After every {@link PAGE_SIZE} items it waits 1.5s plus 0 to 500ms of jitter,
 *   so a long read is a slow trickle of requests and not a burst.
 * - `limit` and `since` end the walk early; the source is abandoned, which stops
 *   its next request from ever being made.
 * - `onProgress` is called at each page boundary and once at the end, with the
 *   count so far.
 *
 * The source is passed in already created, so a caller picks the iterator
 * (`iterHistory`, `iterSearchMessages`, `iterChatEventLog`, ...) and this decides
 * only how fast it is read.
 */
export async function* paced<T>(source: AsyncIterable<T>, options: PacedOptions<T> = {}): AsyncGenerator<T> {
  const onProgress = options.onProgress
  let count = 0

  for await (const item of source) {
    // Newest-first, so the first item past the cutoff ends the walk: every
    // item after it is older still.
    if (options.since && options.dateOf && options.dateOf(item) < options.since) break

    yield item
    count++

    if (options.limit !== undefined && count >= options.limit) break

    // Rate limit every chunk
    if (count % PAGE_SIZE === 0) {
      if (onProgress) {
        onProgress(count)
      }
      // 1.5s + random 0-500ms jitter
      const delay = 1500 + Math.random() * 500
      await sleep(delay)
    }
  }

  // Final progress update for remaining items
  if (onProgress && count % PAGE_SIZE !== 0) {
    onProgress(count)
  }
}

/**
 * Async generator that fetches messages from a chat with rate limiting.
 *
 * - Uses iterHistory (or iterSearchMessages for one thread) with a page of 100
 * - After every 100 messages, waits 1.5s + random 0-500ms jitter
 * - Calls onProgress callback (if provided) with current message count
 * - Messages are yielded newest-first (as returned by iterHistory)
 * - When minId is provided, only messages newer than minId are fetched
 *
 * Note: The writer layer should handle reversal for chronological output.
 * Note: mtcute's minId is EXCLUSIVE - messages with ID > minId are returned.
 *
 * @param tg - Telegram client instance
 * @param chatId - Chat ID to fetch messages from
 * @param options - Optional fetch options (minId, onProgress)
 */
export async function* fetchMessages(
  tg: TelegramClient,
  chatId: number,
  options?: FetchMessagesOptions
): AsyncGenerator<Message> {
  const chunkSize = pageSizeFor(options?.limit)
  // Spread, not `minId: options?.minId`: mtcute declares minId as
  // optional-without-undefined, which exactOptionalPropertyTypes rejects.
  const minId = options?.minId === undefined ? {} : { minId: options.minId }

  yield* paced(
    options?.threadId === undefined
      ? tg.iterHistory(chatId, { chunkSize, ...minId })
      : tg.iterSearchMessages({ chatId, threadId: options.threadId, query: '', chunkSize, ...minId }),
    {
      limit: options?.limit,
      since: options?.since,
      dateOf: (msg) => msg.date,
      onProgress: options?.onProgress
    }
  )
}
