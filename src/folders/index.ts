import { TelegramClient, tl } from '@mtcute/node'
import { getMarkedPeerId } from '@mtcute/core'
import { multiselect, isCancel } from '@clack/prompts'
import { loadConfig, saveConfig, Config } from '../config/index.js'
import { loadState, saveState, updateFolderState } from '../sync/state.js'

/**
 * Basic folder information for display
 */
export interface FolderInfo {
  id: number
  title: string
  chatCount: number
}

/**
 * Folder type that contains enumerable peers (excludes dialogFilterDefault)
 */
export type EnumerableFolder = tl.RawDialogFilter | tl.RawDialogFilterChatlist

/**
 * List all user folders with their basic info.
 * Excludes the "All Chats" pseudo-folder (dialogFilterDefault).
 */
export async function listFolders(tg: TelegramClient): Promise<FolderInfo[]> {
  const result = await tg.getFolders()

  const folders: FolderInfo[] = []

  for (const filter of result.filters) {
    // Skip "All Chats" pseudo-folder - it has no enumerable content
    if (filter._ === 'dialogFilterDefault') {
      continue
    }

    // Both dialogFilter and dialogFilterChatlist have id, title, pinnedPeers, includePeers
    folders.push({
      id: filter.id,
      title: filter.title.text,
      chatCount: filter.pinnedPeers.length + filter.includePeers.length,
    })
  }

  return folders
}

/**
 * Extract marked chat IDs from a folder's peer lists.
 * Marked IDs are bot API compatible (positive for users, negative for chats/channels).
 */
export function getChatIdsFromFolder(folder: EnumerableFolder): number[] {
  const peers = [...folder.pinnedPeers, ...folder.includePeers]

  const chatIds: number[] = []

  for (const peer of peers) {
    // Skip empty and self peers - they don't represent actual chats
    if (peer._ === 'inputPeerEmpty' || peer._ === 'inputPeerSelf') {
      continue
    }

    // getMarkedPeerId converts InputPeer to marked ID:
    // - Users: positive ID
    // - Chats: negative ID
    // - Channels: negative ID with -1e12 offset
    chatIds.push(getMarkedPeerId(peer))
  }

  return chatIds
}

/**
 * Interactive folder selection using multiselect prompt.
 * Returns array of selected folder IDs.
 * @param currentSelection - Optional array of folder IDs to pre-select
 */
export async function selectFolders(folders: FolderInfo[], currentSelection?: number[]): Promise<number[]> {
  const selected = await multiselect({
    message: 'Select folders to export:',
    options: folders.map(f => ({
      value: f.id,
      label: `${f.title} (${f.chatCount} chats)`
    })),
    required: false,
    // Spread, not `initialValues: currentSelection`: clack declares the prop as
    // optional-without-undefined, which exactOptionalPropertyTypes rejects.
    ...(currentSelection === undefined ? {} : { initialValues: currentSelection })
  })

  if (isCancel(selected)) {
    process.exit(0)
  }

  return selected
}

/**
 * Compare stored and current chat lists to detect changes.
 * Returns arrays of added and removed chat IDs.
 */
export function diffChatLists(
  stored: number[],
  current: number[]
): { added: number[]; removed: number[] } {
  const storedSet = new Set(stored)
  const currentSet = new Set(current)

  const added = current.filter(id => !storedSet.has(id))
  const removed = stored.filter(id => !currentSet.has(id))

  return { added, removed }
}

async function getChatDisplayName(tg: TelegramClient, chatId: number): Promise<string> {
  try {
    const peer = await tg.getPeer(chatId)
    return peer.displayName || String(chatId)
  } catch {
    return String(chatId)
  }
}

function haveSameChatIds(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a)
  for (const id of b) {
    if (!setA.has(id)) return false
  }
  return true
}

/**
 * Build a deduplicated list of chat IDs from tracked folders.
 * Removes any folder IDs that no longer exist.
 *
 * @param tg - Connected Telegram client
 * @param trackedFolderIds - Selected folder IDs
 */
export async function buildTrackedChatIds(
  tg: TelegramClient,
  trackedFolderIds: number[]
): Promise<{
  folderIds: number[]
  chatIds: number[]
  /** Per-folder membership, kept so folder listings work offline. */
  folders: { id: number; title: string; chatIds: number[] }[]
}> {
  const rawResult = await tg.getFolders()
  const rawFilters = rawResult.filters.filter(
    (f): f is EnumerableFolder => f._ !== 'dialogFilterDefault'
  )

  const validFolderIds: number[] = []
  const folders: { id: number; title: string; chatIds: number[] }[] = []
  const chatIdSet = new Set<number>()

  for (const folderId of trackedFolderIds) {
    const rawFilter = rawFilters.find(f => f.id === folderId)

    if (!rawFilter) {
      console.log(`Folder ${folderId} no longer exists, removing from config`)
      continue
    }

    validFolderIds.push(folderId)
    const currentChatIds = getChatIdsFromFolder(rawFilter)
    folders.push({ id: folderId, title: rawFilter.title.text, chatIds: currentChatIds })
    for (const id of currentChatIds) {
      chatIdSet.add(id)
    }
  }

  return { folderIds: validFolderIds, chatIds: [...chatIdSet], folders }
}

/**
 * Persist folder membership into sync state.
 *
 * Kept separate from config because config answers "what should we export" while
 * sync state answers "what did we already export, and when" - which is what the
 * `folders list` view reads.
 */
function recordFolderMembership(folders: { id: number; title: string; chatIds: number[] }[]): void {
  const state = loadState()
  for (const folder of folders) {
    updateFolderState(state, folder.id, folder.chatIds, folder.title)
  }
  // Drop folders the user has stopped tracking so listings do not show ghosts.
  const tracked = new Set(folders.map(f => f.id))
  for (const id of Object.keys(state.folders)) {
    if (!tracked.has(Number(id))) delete state.folders[Number(id)]
  }
  saveState(state)
}

/**
 * Refresh tracked chats from selected folders and persist if changed.
 */
export async function refreshTrackedChats(
  tg: TelegramClient,
  config: Config
): Promise<{ updated: boolean; config: Config }> {
  const { folderIds, chatIds, folders } = await buildTrackedChatIds(tg, config.trackedFolderIds)
  const { added, removed } = diffChatLists(config.trackedChatIds, chatIds)
  const chatsChanged = !haveSameChatIds(config.trackedChatIds, chatIds)

  recordFolderMembership(folders)

  if (added.length > 0) {
    const addedWithNames = await Promise.all(
      added.map(async id => ({
        id,
        name: await getChatDisplayName(tg, id)
      }))
    )
    for (const chat of addedWithNames) {
      // stderr: this runs inside `tg sync --json`, whose stdout must stay NDJSON.
      console.error(`New chat: ${chat.name} (${chat.id})`)
    }
  }

  if (removed.length > 0) {
    const removedWithNames = await Promise.all(
      removed.map(async id => ({
        id,
        name: await getChatDisplayName(tg, id)
      }))
    )
    for (const chat of removedWithNames) {
      console.error(`Removed chat: ${chat.name} (${chat.id})`)
    }
  }

  if (chatsChanged || folderIds.length !== config.trackedFolderIds.length) {
    config.trackedChatIds = chatIds
    saveConfig(config)
  }

  return { updated: chatsChanged, config }
}

/**
 * Main orchestration function for the setup command.
 * Handles first-run selection and subsequent refresh.
 * @param forceSelect - If true, show folder selection even if already configured
 */
export async function syncFolderConfig(tg: TelegramClient, forceSelect = false): Promise<void> {
  // Get folder info for display
  const folders = await listFolders(tg)

  if (folders.length === 0) {
    console.log('No folders found in your Telegram account.')
    return
  }

  // Load existing config
  const config = loadConfig()
  const isFirstRun = config.trackedFolderIds.length === 0

  // Determine which folders to track
  let trackedFolderIds: number[]

  if (isFirstRun || forceSelect) {
    // First run or forced re-selection: show selection prompt
    console.log(`Found ${folders.length} folder(s):`)
    trackedFolderIds = await selectFolders(folders, config.trackedFolderIds)
  } else {
    // Subsequent run: use existing tracked folders
    trackedFolderIds = config.trackedFolderIds
    console.log(`Refreshing chat list from ${trackedFolderIds.length} selected folder(s)...`)
  }

  const { folderIds, chatIds, folders: membership } = await buildTrackedChatIds(tg, trackedFolderIds)

  recordFolderMembership(membership)

  config.trackedFolderIds = folderIds
  config.trackedChatIds = chatIds

  // Save updated config
  saveConfig(config)

  console.log(`Tracking ${folderIds.length} folders with ${chatIds.length} total chats`)
}
