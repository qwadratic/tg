import { existsSync, readFileSync } from 'node:fs'
import type { Message } from '@mtcute/node'
import { formatMessage } from '../messages/format.js'
import { buildFrontmatter, updateFrontmatter, type FolderRef } from '../messages/frontmatter.js'
import { sortMessagesChronological } from '../messages/sort.js'
import { getArchivePath } from '../utils/archive-path.js'
import { writeFileAtomic } from '../utils/atomic.js'
import { ARCHIVE_FILE_MODE } from '../utils/archive-path.js'

/**
 * Result of appending messages to a monthly file.
 */
export interface AppendResult {
  messagesAppended: number
  fileCreated: boolean
}

/**
 * Update frontmatter with new counts and dates, then append messages.
 *
 * @param existingContent - Current file content
 * @param newMessages - Formatted messages to append
 * @param newLastMsgId - ID of the last message being appended
 * @param newMessageCount - Number of messages being appended
 * @param newMinDate - Earliest date of appended messages (ISO 8601)
 * @param newMaxDate - Latest date of appended messages (ISO 8601)
 * @returns Updated file content
 */
function updateFrontmatterAndAppend(
  existingContent: string,
  newMessages: string,
  newLastMsgId: number,
  newMessageCount: number,
  newMinDate: string,
  newMaxDate: string,
  folders: FolderRef[]
): string {
  // Match frontmatter block
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n/
  const match = existingContent.match(frontmatterRegex)

  if (!match) {
    throw new Error('Invalid file format: no frontmatter found')
  }

  const frontmatter = match[1] ?? ''
  const body = existingContent.slice(match[0].length)

  const updatedFrontmatter = updateFrontmatter({
    frontmatter,
    newLastMsgId,
    newMessageCount,
    newMinDate,
    newMaxDate,
    folders
  })

  return `---\n${updatedFrontmatter}\n---\n${body}${newMessages}`
}

/**
 * Append messages to an existing chat archive file.
 *
 * Per CONTEXT.md: Only append to existing files, skip if file doesn't exist.
 *
 * @param chatName - Display name of the chat
 * @param chatId - Numeric chat ID
 * @param messages - Array of messages to append (can be in any order)
 * @returns Result with count of messages appended
 */
export function appendToChatFile(
  chatName: string,
  chatId: number,
  messages: Message[],
  folders: FolderRef[] = []
): AppendResult {
  // Skip if no messages
  if (messages.length === 0) {
    return { messagesAppended: 0, fileCreated: false }
  }

  const filePath = getArchivePath(chatName, chatId)

  const orderedMessages = sortMessagesChronological(messages)
  const firstMsg = orderedMessages[0]
  const lastMsg = orderedMessages.at(-1)
  // Unreachable: the empty case returned above, so both ends exist.
  if (!firstMsg || !lastMsg) return { messagesAppended: 0, fileCreated: false }

  // Create file if it doesn't exist to avoid data loss
  if (!existsSync(filePath)) {
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
    for (const msg of orderedMessages) {
      content += formatMessage(msg)
    }
    writeFileAtomic(filePath, content, ARCHIVE_FILE_MODE)

    return { messagesAppended: orderedMessages.length, fileCreated: true }
  }

  // Read existing content
  const existingContent = readFileSync(filePath, 'utf-8')

  // Format new messages
  let newMessages = ''
  for (const msg of orderedMessages) {
    newMessages += formatMessage(msg)
  }

  // Get the last message ID for frontmatter update
  const newLastMsgId = lastMsg.id
  const newMinDate = firstMsg.date.toISOString()
  const newMaxDate = lastMsg.date.toISOString()

  // Update frontmatter and append messages
  const updatedContent = updateFrontmatterAndAppend(
    existingContent,
    newMessages,
    newLastMsgId,
    orderedMessages.length,
    newMinDate,
    newMaxDate,
    folders
  )

  // Write updated content
  writeFileAtomic(filePath, updatedContent, ARCHIVE_FILE_MODE)

  return { messagesAppended: messages.length, fileCreated: false }
}
