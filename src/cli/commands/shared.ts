import type { TelegramClient } from '@mtcute/node'
import { withSession, type OpenSessionOptions } from '../../session/index.js'
import { refreshTrackedChats } from '../../folders/index.js'
import { loadConfig } from '../../config/index.js'
import chalk from 'chalk'
import { OperatorError } from '../../errors.js'
import { EXIT } from '../../exit-codes.js'
import { describePeer, resolvePeerRef } from '../../peers/ref.js'

/**
 * Format duration in milliseconds to human-readable string.
 * Returns "Xm Ys" or just "Ys" if under a minute.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`
  }
  return `${seconds}s`
}

/**
 * Run `fn` with an authenticated client.
 *
 * No password prompt: the session comes from the psst vault or the local
 * encrypted cache, so every command below works unattended. The single-instance
 * lock is held for the duration.
 */
export async function withAuthenticatedClient<T>(
  fn: (tg: TelegramClient) => Promise<T>,
  options: OpenSessionOptions = {}
): Promise<T> {
  return withSession((tg) => fn(tg), options)
}

/**
 * The chat with yourself, which Telegram calls Saved Messages.
 *
 * It is not a special peer type: it is a normal chat whose id is your own user
 * id. Commands that default to "my own notes" resolve it here rather than
 * hardcoding the string 'self', so the id they act on is visible in logs and in
 * the send audit trail.
 */
export async function resolveSelfPeer(tg: TelegramClient): Promise<number> {
  const me = await tg.getMe()
  return me.id
}

/**
 * Resolve the chat a command should act on, and say out loud which one it is.
 *
 * `peer` absent means Saved Messages, which is the common default for the media
 * and watch verbs. When it is present it may be an id, an @username, a t.me link
 * or `me`; whatever it was, the resolved identity is announced on stderr so the
 * operator can see they aimed at the chat they meant. stderr, not stdout, so a
 * `--json` payload stays pipeable.
 */
export async function resolveTarget(
  tg: TelegramClient,
  peer: string | undefined,
  verb: string
): Promise<number> {
  if (!peer) return resolveSelfPeer(tg)

  const target = await resolvePeerRef(tg, peer)
  console.error(chalk.dim(`${verb} ${describePeer(target)}`))
  return target.id
}

/**
 * The tracked-chat config a sync verb should act on.
 *
 * No wizard: config is a plain file an agent or a script can write with no TTY
 * anywhere in the loop. An unconfigured workspace is an operator error, not a
 * prompt.
 */
export async function resolveExportConfig(tg: TelegramClient) {
  const config = loadConfig()
  // A chats-only config is valid: folders are a convenience for filling
  // trackedChatIds, not a requirement.
  if (config.trackedFolderIds.length === 0 && config.trackedChatIds.length === 0) {
    throw new OperatorError(
      'No folders or chats configured. Populate data/config.json directly - see README ' +
      '"Configuration" for the shape (trackedFolderIds, trackedChatIds, excludeChatIds, privateOnly).',
      EXIT.notConfigured
    )
  }

  const refreshed = await refreshTrackedChats(tg, config)
  const totalChats = refreshed.config.trackedChatIds.length
  if (totalChats === 0) {
    throw new OperatorError(
      'No chats found in the tracked folders. Edit data/config.json directly - see README ' +
      '"Configuration" for the shape (trackedFolderIds, trackedChatIds, excludeChatIds, privateOnly).',
      EXIT.notConfigured
    )
  }

  return refreshed.config
}

