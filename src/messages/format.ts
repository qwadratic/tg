import type { Message, User, Chat, PeerSender } from '@mtcute/node'

/**
 * Format a sender for display in Markdown.
 *
 * Handles:
 * - Anonymous senders: returns displayName
 * - Users: returns "FirstName LastName (@username)" or just name if no username
 * - Chats (channel posts): returns title
 *
 * @param sender - The sender to format
 * @returns Formatted sender string
 */
export function formatSender(sender: User | Chat | PeerSender): string {
  // Handle anonymous senders (users with hidden forwards)
  if ('type' in sender && sender.type === 'anonymous') {
    return (sender as { displayName: string }).displayName
  }

  // Handle users
  if ('firstName' in sender) {
    const user = sender
    const name = user.lastName ? `${user.firstName} ${user.lastName}` : user.firstName
    return user.username ? `${name} (@${user.username})` : name
  }

  // Handle chats (channels, groups)
  if ('title' in sender) {
    return (sender).title
  }

  // Fallback for any other type with displayName
  if ('displayName' in sender) {
    return (sender as { displayName: string }).displayName
  }

  return 'Unknown'
}

/**
 * Format a message date as YYYY-MM-DD HH:MM:SS UTC
 */
function formatDate(date: Date): string {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  const hours = String(date.getUTCHours()).padStart(2, '0')
  const minutes = String(date.getUTCMinutes()).padStart(2, '0')
  const seconds = String(date.getUTCSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} UTC`
}

function formatHeader(timestamp: string, sender: string, messageId: number): string {
  return `**[${timestamp}]** **${sender}** [id:${messageId}]\n\n`
}

function formatForwardBlock(msg: Message): string {
  if (!msg.forward) return ''
  const fwdSender = msg.forward.sender
  const fwdName = formatSender(fwdSender)
  return `> Forwarded from: ${fwdName}\n\n`
}

function formatReplyBlock(msg: Message): string {
  if (!msg.replyToMessage) return ''
  const replyId = msg.replyToMessage.id
  if (replyId === null) return ''
  const quoteText = msg.replyToMessage.quoteText || ''
  if (quoteText) {
    const truncatedQuote =
      quoteText.length > 100 ? `${quoteText.slice(0, 100)}...` : quoteText
    const escapedQuote = truncatedQuote.replace(/\n/g, ' ')
    return `> In reply to [id:${replyId}]: "${escapedQuote}"\n\n`
  }
  return `> In reply to [id:${replyId}]\n\n`
}

function formatAttachmentBlock(msg: Message): string {
  if (!msg.media) return ''
  const mediaType = msg.media.type
  return `[Attachment: ${mediaType}]\n\n`
}

function formatMessageBody(text: string | undefined | null): string {
  if (!text) return ''
  return `${text}\n\n`
}

/**
 * Format a Telegram message to Markdown.
 *
 * Output format:
 * ```
 * **[YYYY-MM-DD HH:MM:SS]** **Sender Name (@username)** [id:123]
 *
 * > Forwarded from: Source Name
 *
 * > In reply to [id:456]: "First 100 chars of original..."
 *
 * [Attachment: photo]
 *
 * Message text with **formatting** preserved
 *
 * ---
 * ```
 *
 * @param msg - The Telegram message to format
 * @returns Formatted Markdown string
 */
export function formatMessage(msg: Message): string {
  const timestamp = formatDate(msg.date)
  const sender = formatSender(msg.sender)

  // Header line with timestamp, sender, and message ID
  let output = formatHeader(timestamp, sender, msg.id)
  output += formatForwardBlock(msg)
  output += formatReplyBlock(msg)
  output += formatAttachmentBlock(msg)
  output += formatMessageBody(msg.text)
  output += '---\n\n'
  return output
}
