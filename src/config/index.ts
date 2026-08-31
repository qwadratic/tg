import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { CONFIG_PATH } from '../paths.js'
import { OperatorError } from '../errors.js'
import { EXIT } from '../exit-codes.js'

/**
 * Configuration structure for tracked folders and chats.
 * Stored at data/config.json for persistence across runs.
 */
export interface Config {
  trackedFolderIds: number[]
  trackedChatIds: number[]
  /** Chats to skip even when their folder is tracked. */
  excludeChatIds?: number[]
  /** Persisted default for --private-only. The CLI flag still wins per run. */
  privateOnly?: boolean
}

/** Path to the config file. Derived from the workspace data root. */
export { CONFIG_PATH }

/**
 * Load config from disk. Returns empty config if file doesn't exist.
 * Uses sync operations for CLI simplicity and to avoid race conditions.
 */
export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    return { trackedFolderIds: [], trackedChatIds: [] }
  }

  const content = readFileSync(CONFIG_PATH, 'utf-8')
  const parsed = JSON.parse(content) as Record<string, unknown>

  // Every field is optional and every field is checked. A silently ignored
  // excludeChatIds is a privacy failure, and config.json is the only interface:
  // `["111"]` must fail loudly, not archive the chat it was meant to skip.
  const privateOnly = parsed['privateOnly']
  if (privateOnly !== undefined && typeof privateOnly !== 'boolean') {
    throw new OperatorError(
      `${CONFIG_PATH}: "privateOnly" must be true or false. Fix the file and re-run.`,
      EXIT.notConfigured
    )
  }

  return {
    trackedFolderIds: numberArray(parsed['trackedFolderIds'], 'trackedFolderIds'),
    trackedChatIds: numberArray(parsed['trackedChatIds'], 'trackedChatIds'),
    ...(parsed['excludeChatIds'] === undefined
      ? {}
      : { excludeChatIds: numberArray(parsed['excludeChatIds'], 'excludeChatIds') }),
    ...(privateOnly === undefined ? {} : { privateOnly })
  }
}

/** A missing list defaults to empty; a malformed one is an operator error. */
function numberArray(value: unknown, field: string): number[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'number' || !Number.isFinite(id))) {
    throw new OperatorError(
      `${CONFIG_PATH}: "${field}" must be an array of numbers (ids are unquoted, e.g. [904417238]). ` +
      'Fix the file and re-run.',
      EXIT.notConfigured
    )
  }
  return value as number[]
}

/**
 * Save config to disk. Creates data/ directory if needed.
 * Uses sync operations for CLI simplicity and to avoid race conditions.
 */
export function saveConfig(config: Config): void {
  const dir = dirname(CONFIG_PATH)

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}

/**
 * Update config file with new values.
 * Alias for saveConfig - kept for semantic clarity when modifying existing config.
 */
export function updateConfig(config: Config): void {
  saveConfig(config)
}
