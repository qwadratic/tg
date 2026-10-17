import { SearchFilters, type Message, type TelegramClient } from '@mtcute/node'
import { OperatorError } from '../errors.js'
import { EXIT } from '../exit-codes.js'
import { readingEach } from '../reads/errors.js'
import { PAGE_SIZE, paced, pageSizeFor } from './fetch.js'
import { messageRow, type MessageRow } from './read.js'

/**
 * Live search: ask Telegram to search, `tg msg search`.
 *
 * NOT the archive search of TASK-26. That one reads the Markdown files under
 * `data/archive`, needs no session and no network. This one asks Telegram, so it
 * costs requests and finds what was never archived. They are two verbs on purpose
 * (D13f): the offline one keeps the name `tg search` that TASK-26 gave it, and
 * this one lives under `msg` with the other things that read messages from
 * Telegram.
 *
 * Reads only. Every scope goes through the one paced walk.
 */

/** Where to search. Exactly one is required: a search with no scope is a footgun. */
export type SearchScope =
  | { kind: 'chat'; chatId: number }
  | { kind: 'global' }
  | { kind: 'hashtag' }
  | { kind: 'posts' }

/**
 * The message filters Telegram offers, by the names this CLI uses. The values are
 * mtcute's own `SearchFilters`; the test pins that every one of them is reachable.
 */
export const SEARCH_FILTERS = {
  photo: SearchFilters.Photo,
  video: SearchFilters.Video,
  'photo-video': SearchFilters.PhotoAndVideo,
  document: SearchFilters.Document,
  url: SearchFilters.Url,
  gif: SearchFilters.Gif,
  voice: SearchFilters.Voice,
  audio: SearchFilters.Audio,
  'chat-photo': SearchFilters.ChatPhotoChange,
  call: SearchFilters.Call,
  round: SearchFilters.Round,
  'round-voice': SearchFilters.RoundAndVoice,
  mention: SearchFilters.MyMention,
  location: SearchFilters.Location,
  contact: SearchFilters.Contact,
  pinned: SearchFilters.Pinned
} as const

export type SearchFilterName = keyof typeof SEARCH_FILTERS

export interface SearchOptions {
  limit: number
  filter?: SearchFilterName | undefined
  /** Only messages by this user (numeric id). Chat scope only. */
  from?: number | undefined
  since?: Date | undefined
  until?: Date | undefined
}

/** What Telegram says about the free public-post searches left, when it says. */
export interface PostsQuota {
  free: boolean
  remaining: number
  daily: number
  /** ISO to the minute when the next free search is allowed, or ''. */
  nextFreeAt: string
}

export interface SearchResult {
  rows: MessageRow[]
  /** Only for the public-post scope. */
  quota?: PostsQuota
}

/** Where the next page of a public-post search starts, as mtcute hands it back. */
type PostsOffset = NonNullable<Awaited<ReturnType<TelegramClient['searchPostsGlobal']>>['next']>

/** A hashtag as typed: `#mtcute` or `mtcute`; no spaces. */
export function normalizeHashtag(raw: string): string {
  const tag = raw.trim().replace(/^#/, '')
  if (!tag || /\s/.test(tag)) {
    throw new OperatorError(`Not a hashtag: ${JSON.stringify(raw)}. Give one word, with or without the #.`, EXIT.usage)
  }
  return tag
}

/**
 * Pages of a public-post search, as one stream of messages.
 *
 * mtcute has no iterator for this one, so the paging is here, but it is still the
 * paced walk that sets the speed. `payStars` is NEVER passed: the search is free
 * up to Telegram's daily allowance and then it asks for Stars, and this tool does
 * not spend money. When the allowance is gone the answer is empty and says so.
 */
async function* postPages(
  tg: TelegramClient,
  query: string,
  limit: number,
  onQuota: (quota: PostsQuota) => void
): AsyncGenerator<Message> {
  let offset: PostsOffset | undefined
  let yielded = 0

  for (;;) {
    const page = await tg.searchPostsGlobal(query, {
      limit: Math.min(PAGE_SIZE, limit - yielded),
      ...(offset ? { offset } : {})
    })

    const limits = page.limits
    if (limits && limits._ === 'searchPostsFlood') {
      onQuota({
        free: limits.queryIsFree ?? false,
        remaining: limits.remains,
        daily: limits.totalDaily,
        nextFreeAt: limits.waitTill ? new Date(limits.waitTill * 1000).toISOString().slice(0, 16) : ''
      })
    }

    for (const msg of page) {
      yield msg
      yielded++
    }
    if (!page.next || page.length === 0) return
    offset = page.next
  }
}

/**
 * Search Telegram for messages.
 *
 * `query` is the text for `chat` and `global`, the hashtag for `hashtag`, the
 * keywords for `posts`. Results are newest first, at most `limit`.
 */
export async function searchLive(
  tg: TelegramClient,
  scope: SearchScope,
  query: string,
  options: SearchOptions
): Promise<SearchResult> {
  const chunkSize = pageSizeFor(options.limit)
  const range = {
    ...(options.since ? { minDate: options.since } : {}),
    ...(options.until ? { maxDate: options.until } : {})
  }
  const filter = options.filter ? { filter: SEARCH_FILTERS[options.filter] } : {}

  let quota: PostsQuota | undefined
  const rows: MessageRow[] = []
  const limit = { limit: options.limit }

  // Each scope names its iterator inside `paced(...)`: the walk is what sets the
  // speed, and a test fails if an iter* method is called anywhere it is not.
  switch (scope.kind) {
    case 'chat':
      for await (const msg of paced(readingEach(tg.iterSearchMessages({
        query,
        chatId: scope.chatId,
        limit: options.limit,
        chunkSize,
        ...filter,
        ...range,
        ...(options.from === undefined ? {} : { fromUser: options.from })
      })), limit)) rows.push(messageRow(msg))
      break
    case 'global':
      for await (const msg of paced(readingEach(tg.iterSearchGlobal({
        query,
        limit: options.limit,
        chunkSize,
        ...filter,
        ...range
      })), limit)) rows.push(messageRow(msg))
      break
    case 'hashtag':
      for await (const msg of paced(readingEach(tg.iterSearchHashtag(normalizeHashtag(query), {
        limit: options.limit,
        chunkSize
      })), limit)) rows.push(messageRow(msg))
      break
    case 'posts':
      for await (const msg of paced(readingEach(postPages(tg, query, options.limit, (q) => { quota = q })), limit)) {
        rows.push(messageRow(msg))
      }
      if (rows.length === 0 && quota && !quota.free) {
        throw new OperatorError(
          `Telegram wants Stars for this search: the free allowance for public posts is used up (${quota.remaining} of ${quota.daily} left)` +
          `${quota.nextFreeAt ? `, the next free one is at ${quota.nextFreeAt}` : ''}. ` +
          'tg never spends Stars. Search again later, or spend them in the Telegram app.',
          EXIT.needsHuman
        )
      }
      break
  }

  return { rows, ...(quota ? { quota } : {}) }
}

/** Whether `name` is one of the filter names: an own key, so `toString` and `__proto__` are not. */
export function isSearchFilter(name: string): name is SearchFilterName {
  return Object.hasOwn(SEARCH_FILTERS, name)
}
