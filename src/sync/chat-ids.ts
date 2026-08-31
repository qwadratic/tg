import type { Config } from '../config/index.js'

export function isPrivateChat(chatId: number): boolean {
  // Telegram convention: users get positive ids, groups and channels negative.
  return chatId > 0
}

/**
 * The chat list a run should actually fetch.
 *
 * One place decides this, so every caller - `sync chats`, `sync recent`,
 * `sync historical`, `folders update` - honours `excludeChatIds` and the
 * persisted `privateOnly` default identically. Exclusion is unconditional: a
 * chat named there is skipped even when it was passed explicitly via `--chats`.
 */
export function selectChatIds(
  config: Config,
  options: { privateOnly?: boolean | undefined } = {}
): number[] {
  const excluded = new Set(config.excludeChatIds ?? [])
  const privateOnly = options.privateOnly ?? config.privateOnly ?? false

  return [...new Set(config.trackedChatIds)].filter(
    (id) => !excluded.has(id) && (!privateOnly || isPrivateChat(id))
  )
}
