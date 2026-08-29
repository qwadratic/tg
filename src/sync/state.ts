import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomic } from '../utils/atomic.js'
import { STATE_PATH } from '../paths.js'

/**
 * Sync state structure for tracking incremental exports.
 * Stores last message ID per chat and folder membership snapshots.
 */
export interface SyncState {
  version: 1
  chats: Record<number, {
    lastMessageId: number
    lastSyncedAt: string  // ISO timestamp
    chatName: string      // Cached for display
  }>
  recency: Record<'recent' | 'historical', {
    cutoff: string | null
    chats: Record<number, {
      lastMessageId: number
      lastExportedAt: string
    }>
  }>
  folders: Record<number, {
    chatIds: number[]     // Snapshot at last sync
    lastSyncedAt: string
    title?: string | undefined        // Cached for display; absent in states written before v0.2
  }>
}

/** Path to the sync state file. Derived from the workspace data root. */
export { STATE_PATH }

/**
 * Load sync state from disk. Returns empty state if file doesn't exist.
 * Uses sync operations for CLI simplicity and to avoid race conditions.
 */
export function loadState(): SyncState {
  if (!existsSync(STATE_PATH)) {
    return {
      version: 1,
      chats: {},
      recency: {
        recent: { cutoff: null, chats: {} },
        historical: { cutoff: null, chats: {} }
      },
      folders: {}
    }
  }

  const content = readFileSync(STATE_PATH, 'utf-8')
  const parsed = JSON.parse(content) as SyncState
  if (!parsed.recency) {
    parsed.recency = {
      recent: { cutoff: null, chats: {} },
      historical: { cutoff: null, chats: {} }
    }
  }
  return parsed
}

/**
 * Save sync state to disk. Creates data/ directory if needed.
 *
 * Atomic, because a half-written watermark is worse than a lost archive file:
 * the watermark is what decides whether the missing messages are ever fetched
 * again. 0600 because this file names every chat being archived.
 */
export function saveState(state: SyncState): void {
  const dir = dirname(STATE_PATH)

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  writeFileAtomic(STATE_PATH, JSON.stringify(state, null, 2), 0o600)
}

/**
 * Update chat state with new last message ID.
 * Mutates the state object in place - caller is responsible for saving.
 *
 * @param state - Sync state object to update
 * @param chatId - Chat ID to update
 * @param lastMessageId - Last exported message ID
 * @param chatName - Chat name for display (cached)
 */
export function updateChatState(
  state: SyncState,
  chatId: number,
  lastMessageId: number,
  chatName: string
): void {
  state.chats[chatId] = {
    lastMessageId,
    lastSyncedAt: new Date().toISOString(),
    chatName
  }
}

/**
 * Update folder state with current chat membership.
 * Mutates the state object in place - caller is responsible for saving.
 *
 * @param state - Sync state object to update
 * @param folderId - Folder ID to update
 * @param chatIds - Current chat IDs in folder
 * @param title - Folder title, cached so listings work without a network call
 */
export function updateFolderState(
  state: SyncState,
  folderId: number,
  chatIds: number[],
  title?: string | undefined
): void {
  state.folders[folderId] = {
    chatIds,
    lastSyncedAt: new Date().toISOString(),
    title: title ?? state.folders[folderId]?.title
  }
}
