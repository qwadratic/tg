import { join } from 'node:path'
import type { Message } from '@mtcute/node'
import { ensureArchiveDir, getArchivePath } from '../utils/archive-path.js'
import { writeFileAtomic } from '../utils/atomic.js'
import { ARCHIVE_FILE_MODE } from '../utils/archive-path.js'
import { formatMessage } from './format.js'
import { buildEmptyFrontmatter, buildFrontmatter, type FolderRef } from './frontmatter.js'
import { sortMessagesChronological } from './sort.js'

function buildMessageBody(messages: Message[]): string {
  let content = ''
  for (const msg of messages) {
    content += formatMessage(msg)
  }
  return content
}

/**
 * Write messages to a single chat archive file.
 *
 * Creates files at: data/archive/{sanitized-chat-name}.md
 *
 * Each file contains:
 * - YAML frontmatter with chat metadata
 * - Formatted messages in chronological order (oldest first)
 *
 * @param chatName - Display name of the chat
 * @param chatId - Numeric chat ID
 * @param messages - Array of messages to write (can be in any order)
 * @param folders - Tracked folders this chat belongs to; stamped into
 *   frontmatter as the shipper's routing key
 * @returns Counts of files and messages written
 */
export async function writeChatFile(
  chatName: string,
  chatId: number,
  messages: Message[],
  folders: FolderRef[] = []
): Promise<{ filesWritten: number; messagesWritten: number }> {
  // Create an empty file if no messages
  if (messages.length === 0) {
    const filePath = getArchivePath(chatName, chatId)
    const content = `${buildEmptyFrontmatter(chatName, chatId, folders)}No messages.\n`
    writeFileAtomic(filePath, content, ARCHIVE_FILE_MODE)
    return { filesWritten: 1, messagesWritten: 0 }
  }

  const orderedMessages = sortMessagesChronological(messages)
  const filePath = getArchivePath(chatName, chatId)

  const firstMsg = orderedMessages[0]
  const lastMsg = orderedMessages[orderedMessages.length - 1]
  // Unreachable: the empty case returned above, so both ends exist.
  if (!firstMsg || !lastMsg) throw new Error('sortMessagesChronological dropped every message')

  const firstMsgId = firstMsg.id
  const lastMsgId = lastMsg.id
  const minDate = firstMsg.date.toISOString()
  const maxDate = lastMsg.date.toISOString()

  let content = buildFrontmatter(
    chatName,
    chatId,
    firstMsgId,
    lastMsgId,
    orderedMessages.length,
    minDate,
    maxDate,
    folders
  )
  content += buildMessageBody(orderedMessages)

  writeFileAtomic(filePath, content, ARCHIVE_FILE_MODE)

  return { filesWritten: 1, messagesWritten: orderedMessages.length }
}

/**
 * Write a combined archive file in data/archive.
 */
export function writeCombinedArchiveFile(
  fileName: string,
  content: string
): string {
  const filePath = join(ensureArchiveDir(), fileName)
  writeFileAtomic(filePath, content, ARCHIVE_FILE_MODE)
  return filePath
}
