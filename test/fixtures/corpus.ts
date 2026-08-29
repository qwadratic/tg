/**
 * Frozen inputs for the golden corpus.
 *
 * Every value here is a literal. Nothing reads the clock, the filesystem or
 * the network: a Message is a plain object shaped like an mtcute Message and
 * history iteration is a generator over an array. An eval that could reach
 * Telegram would not be reproducible, and a corpus that is not reproducible
 * cannot tell an intended diff from a regression.
 */
import type { Message } from '@mtcute/node'
import { makeMessage } from '../helpers.js'
import type { SyncState } from '../../src/sync/state.js'
import type { FolderRef } from '../../src/messages/frontmatter.js'

export const CHAT_ID = -1001234567890
export const CHAT_NAME = 'Project "Ada" / notes'

/** The routing key stamped into frontmatter; matches folder 7 in seededState. */
export const FOLDERS: FolderRef[] = [{ id: 7, title: 'Work' }]

/** A conversation exercising forward, reply-with-quote, and plain text. */
export const CONVERSATION: Message[] = [
  makeMessage({
    id: 101,
    date: new Date('2026-01-04T09:15:30.000Z'),
    senderName: 'Ada',
    username: 'ada',
    text: 'Kickoff at ten.'
  }),
  makeMessage({
    id: 102,
    date: new Date('2026-01-04T09:16:00.000Z'),
    senderName: 'Grace',
    username: '', // falsy on purpose: exercises the no-username branch of formatSender
    text: 'Forwarding the spec.',
    forwardName: 'Spec Channel'
  }),
  makeMessage({
    id: 103,
    date: new Date('2026-01-05T18:02:11.000Z'),
    senderName: 'Ada',
    username: 'ada',
    text: 'Done.',
    replyToId: 101,
    replyQuote: 'Kickoff at ten.'
  })
]

/**
 * Deliberately out of order: the writer must sort chronologically.
 * CONVERSATION is a three-element literal above, so 0..2 are present.
 */
export const UNSORTED: Message[] = [CONVERSATION[2]!, CONVERSATION[0]!, CONVERSATION[1]!]

/** Names that have historically broken filenames. */
export const AWKWARD_NAMES: [name: string, chatId: number][] = [
  ['Simple Chat', 1],
  ['Project "Ada" / notes', 2],
  ['  spaced   out  ', 3],
  ['../../etc/passwd', 4],
  ['trailing dots...', 5],
  ['<>:"/\\|?*', 6],
  ['', 7],
  ['Привет мир 🌍', 8],
  ['x'.repeat(250), 9]
]

/** A state with two folders, one exported and one never touched. */
export function seededState(): SyncState {
  return {
    version: 1,
    chats: {
      10: { lastMessageId: 500, lastSyncedAt: '2026-01-05T18:00:00.000Z', chatName: 'Ada' },
      11: { lastMessageId: 42, lastSyncedAt: '2026-01-02T08:00:00.000Z', chatName: 'Grace' }
    },
    recency: {
      recent: { cutoff: '2026-01-01', chats: {} },
      historical: { cutoff: null, chats: {} }
    },
    folders: {
      7: { chatIds: [10, 11], lastSyncedAt: '2026-01-05T18:00:00.000Z', title: 'Work' },
      12: { chatIds: [99], lastSyncedAt: '2026-01-01T00:00:00.000Z', title: 'Untouched' }
    }
  }
}
