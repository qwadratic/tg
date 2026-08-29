import type { TelegramClient, Message } from '@mtcute/node'
import { spinner } from '@clack/prompts'
import type { Config } from '../config/index.js'
import { getChatName } from '../utils/chat-name.js'
import { loadState, saveState, updateChatState } from './state.js'
import { appendToChatFile } from './append.js'
import { fetchMessages } from '../messages/fetch.js'
import { writeChatFile } from '../messages/writer.js'
import { foldersForChat } from '../folders/status.js'
import type { FolderRef } from '../messages/frontmatter.js'

/**
 * Result from a sync operation.
 */
export interface SyncResult {
  chatsProcessed: number
  messagesAppended: number
  filesUpdated: number
  newChatsAdded: number
  newFoldersAdded: number
  chatsSkipped: number
  durationMs: number
}

async function fetchNewMessages(
  tg: TelegramClient,
  chatId: number,
  lastMsgId: number | undefined,
  onProgress: (count: number) => void
): Promise<Message[]> {
  const messages: Message[] = []
  for await (const msg of fetchMessages(tg, chatId, {
    minId: lastMsgId,
    onProgress
  })) {
    messages.push(msg)
  }
  return messages
}

async function appendOrWriteChat(options: {
  chatName: string
  chatId: number
  messages: Message[]
  isFirstSync: boolean
  lastMsgId: number | undefined
  folders: FolderRef[]
}): Promise<{ messagesAppended: number; filesUpdated: number; skipped: boolean; newestMsgId: number }> {
  if (options.messages.length === 0) {
    if (options.isFirstSync || !options.lastMsgId) {
      const { filesWritten } = await writeChatFile(options.chatName, options.chatId, options.messages, options.folders)
      return { messagesAppended: 0, filesUpdated: filesWritten, skipped: false, newestMsgId: 0 }
    }
    return { messagesAppended: 0, filesUpdated: 0, skipped: true, newestMsgId: options.lastMsgId ?? 0 }
  }

  if (options.isFirstSync || !options.lastMsgId) {
    // Full export for new chats
    const { messagesWritten, filesWritten } = await writeChatFile(options.chatName, options.chatId, options.messages, options.folders)
    return {
      messagesAppended: messagesWritten,
      filesUpdated: filesWritten,
      skipped: false,
      newestMsgId: options.messages[0]?.id ?? 0
    }
  }

  // Incremental: append all new messages to existing chat file
  const result = appendToChatFile(options.chatName, options.chatId, options.messages, options.folders)
  return {
    messagesAppended: result.messagesAppended,
    filesUpdated: result.messagesAppended > 0 ? 1 : 0,
    skipped: false,
    newestMsgId: options.messages[0]?.id ?? 0
  }
}

function updateStateForChat(
  state: ReturnType<typeof loadState>,
  chatId: number,
  newestMsgId: number,
  chatName: string
) {
  updateChatState(state, chatId, newestMsgId, chatName)
}

// stdout belongs to `--json`: one summary line per pass and nothing else. Every
// progress line here goes to stderr so `tg sync --once --json | jq` parses.
function printSyncSummary(skippedChats: string[], newChatLabels: string[]) {
  if (skippedChats.length > 0) {
    const preview = skippedChats.slice(0, 3)
    const remaining = skippedChats.length - preview.length
    console.error('Skipped chats:')
    for (const chatLabel of preview) {
      console.error(chatLabel)
    }
    if (remaining > 0) {
      console.error(`... and ${remaining} more\n`)
    }
  }

  if (newChatLabels.length > 0) {
    const preview = newChatLabels.slice(0, 3)
    const remaining = newChatLabels.length - preview.length
    console.error('New chats added:')
    for (const chatLabel of preview) {
      console.error(chatLabel)
    }
    if (remaining > 0) {
      console.error(`... and ${remaining} more`)
    }
  }
}

/**
 * Sync tracked chats incrementally.
 *
 * Orchestrates the complete sync flow:
 * 1. Load state and detect changes (new/removed chats, new folders)
 * 2. Prompt user for new folders detected in Telegram
 * 3. Prompt user for new/removed chats
 * 4. Fetch messages incrementally (only newer than last sync)
 * 5. Append to existing files or write new files
 * 6. Save updated state
 *
 * @param tg - Connected Telegram client
 * @param config - Configuration with tracked chats
 * @returns Sync statistics
 */
export function isPrivateChat(chatId: number): boolean {
  // Telegram convention: users get positive ids, groups and channels negative.
  return chatId > 0
}

export async function syncChats(
  tg: TelegramClient,
  config: Config,
  options: { privateOnly?: boolean | undefined } = {}
): Promise<SyncResult> {
  const startTime = Date.now()
  const state = loadState()
  const isFirstSync = Object.keys(state.chats).length === 0

  // Use tracked chat IDs from config for every run
  const chatsToSync = options.privateOnly
    ? config.trackedChatIds.filter(isPrivateChat)
    : config.trackedChatIds
  const newChatsAdded = chatsToSync.filter(id => !state.chats[id]).length
  const newFoldersAdded = 0

  // Step 4: Sync each chat
  const s = spinner({ output: process.stderr })
  s.start('Starting sync...')

  let messagesAppended = 0
  let filesUpdated = 0
  let chatsProcessed = 0
  let chatsSkipped = 0
  const skippedChats: string[] = []
  const newChatLabels: string[] = []

  // Deduplicate chat IDs
  const uniqueChatIds = [...new Set(chatsToSync)]

  for (const chatId of uniqueChatIds) {
    // ponytail: one unreachable peer used to abort the whole run (left folder, deleted
    // account, blocked). Skip it and keep going; the watermark for that chat is simply
    // not advanced, so a later run retries it. Ceiling: a chat that fails EVERY run stays
    // silently absent. Upgrade path: count consecutive failures in sync-state and warn.
    try {
    const chatName = await getChatName(tg, chatId)
    const existingChat = state.chats[chatId]
    const lastMsgId = existingChat?.lastMessageId
    if (!existingChat) {
      newChatLabels.push(`${chatName} (${chatId})`)
    }

    s.message(`Syncing ${chatName}...`)

    const messages = await fetchNewMessages(tg, chatId, lastMsgId, (count) => {
      s.message(`${chatName}: fetched ${count} messages...`)
    })

    const { messagesAppended: appendedCount, filesUpdated: updatedCount, skipped, newestMsgId } =
      await appendOrWriteChat({
        chatName,
        chatId,
        messages,
        isFirstSync,
        lastMsgId,
        folders: foldersForChat(state, chatId)
      })

    if (skipped) {
      skippedChats.push(`${chatName} (${chatId})`)
      chatsSkipped++
      continue
    }

    if (messages.length > 0) {
      chatsProcessed++
    }

    messagesAppended += appendedCount
    filesUpdated += updatedCount

    updateStateForChat(state, chatId, newestMsgId, chatName)
    saveState(state)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      skippedChats.push(`${chatId} (unreachable: ${reason})`)
      chatsSkipped++
    }
  }

  saveState(state)

  s.stop('Sync complete')

  printSyncSummary(skippedChats, newChatLabels)

  return {
    chatsProcessed,
    messagesAppended,
    filesUpdated,
    newChatsAdded,
    newFoldersAdded,
    chatsSkipped,
    durationMs: Date.now() - startTime
  }
}
