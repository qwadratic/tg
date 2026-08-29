import type { MessageBlock, ParsedSection } from './recency-types.js'
import { getFrontmatterValue } from './frontmatter.js'

function parseTimestamp(value: string): Date | null {
  const iso = value.replace(' UTC', 'Z').replace(' ', 'T')
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return date
}

export function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const match = content.match(/^---\n[\s\S]*?\n---\n\n/)
  if (!match) return { frontmatter: null, body: content }
  return { frontmatter: match[0], body: content.slice(match[0].length) }
}

export function parseCombinedSections(body: string): Map<number, ParsedSection> {
  const sections = new Map<number, ParsedSection>()
  if (body.trim() === 'No messages.') {
    return sections
  }

  const lines = body.split('\n')
  let currentChatId: number | null = null
  let currentHeader = ''
  let currentBlocks: MessageBlock[] = []
  let currentBlockLines: string[] | null = null
  let currentBlockDate: Date | null = null

  const flushBlock = () => {
    if (!currentBlockLines || !currentChatId) return
    const text = `${currentBlockLines.join('\n')}\n`
    currentBlocks.push({ text, timestamp: currentBlockDate })
    currentBlockLines = null
    currentBlockDate = null
  }

  const flushSection = () => {
    if (currentChatId == null) return
    sections.set(currentChatId, { header: currentHeader, blocks: currentBlocks })
    currentChatId = null
    currentHeader = ''
    currentBlocks = []
  }

  for (const line of lines) {
    if (line.startsWith('## Chat: ')) {
      flushBlock()
      flushSection()
      const idMatch = line.match(/\((-?\d+)\)\s*$/)
      if (!idMatch) continue
      const rawChatId = idMatch[1]
      if (rawChatId === undefined) continue
      currentChatId = Number(rawChatId)
      currentHeader = line
      continue
    }

    const headerMatch = line.match(/^\*\*\[(.+?)\]\*\*/)
    if (headerMatch) {
      flushBlock()
      currentBlockLines = [line]
      currentBlockDate = parseTimestamp(headerMatch[1] ?? '')
      continue
    }

    if (currentBlockLines) {
      currentBlockLines.push(line)
    }
  }

  flushBlock()
  flushSection()
  return sections
}

export function buildSectionBody(blocks: MessageBlock[]): string {
  return blocks.map(block => block.text).join('')
}

export function parseRecencyFrontmatter(frontmatter: string | null): {
  messageCount: number
  chatsWithMessages: number
  minDate: string | null
  maxDate: string | null
} {
  if (!frontmatter) {
    return { messageCount: 0, chatsWithMessages: 0, minDate: null, maxDate: null }
  }
  const messageCount = Number(getFrontmatterValue(frontmatter, 'message_count') ?? 0)
  const chatsWithMessages = Number(getFrontmatterValue(frontmatter, 'chats_with_messages') ?? 0)
  const minDate = getFrontmatterValue(frontmatter, 'min_date')
  const maxDate = getFrontmatterValue(frontmatter, 'max_date')
  return { messageCount, chatsWithMessages, minDate, maxDate }
}

export function appendMessagesToBody(
  body: string,
  chatId: number,
  header: string,
  newBody: string
): { body: string; isNewSection: boolean } {
  const headerRegex = new RegExp(`^## Chat: .*?\\(${chatId}\\)\\s*$`, 'm')
  const match = headerRegex.exec(body)
  if (!match) {
    const trimmed = body.trim()
    const prefix = trimmed ? `${trimmed}\n\n` : ''
    return { body: `${prefix}${header}\n\n${newBody}`.trimEnd() + '\n', isNewSection: true }
  }

  const startIndex = match.index
  const afterHeader = startIndex + match[0].length
  const nextHeaderRegex = /^## Chat: /gm
  nextHeaderRegex.lastIndex = afterHeader
  const nextMatch = nextHeaderRegex.exec(body)
  const insertIndex = nextMatch ? nextMatch.index : body.length
  const insertion = `${body[insertIndex - 1] === '\n' ? '' : '\n'}${newBody}`
  const updatedBody = body.slice(0, insertIndex) + insertion + body.slice(insertIndex)
  return { body: updatedBody, isNewSection: false }
}
