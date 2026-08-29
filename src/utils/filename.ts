/**
 * Characters invalid on Windows/Mac/Linux filesystems.
 * Includes: < > : " / \ | ? * and control characters (0x00-0x1f, 0x80-0x9f)
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const INVALID_CHARS = /[<>:"/\\|?*\x00-\x1f\x80-\x9f]/g

/**
 * Maximum filename length (leave room for path and .md extension)
 */
const MAX_LENGTH = 200

/**
 * Sanitize a string for use as a filename.
 *
 * Handles:
 * - Removes characters invalid on Windows/Mac/Linux
 * - Collapses multiple spaces to single space
 * - Trims whitespace
 * - Removes trailing dots (Windows issue)
 * - Truncates to 200 characters
 * - Always appends _{chatId} to avoid collisions
 *
 * @param name - The string to sanitize
 * @param chatId - Chat ID to append as suffix
 * @returns A filesystem-safe filename
 */
export function sanitizeFilename(name: string, chatId: number): string {
  let safe = name
    .replace(INVALID_CHARS, '') // Remove invalid chars
    .replace(/\s+/g, '-') // Collapse whitespace into dashes
    .trim()
    .replace(/^-+|-+$/g, '') // Trim leading/trailing dashes
    .replace(/\.+$/, '') // Remove trailing dots (Windows)
    .toLowerCase()

  const suffix = `_${chatId}`
  const maxBaseLength = Math.max(1, MAX_LENGTH - suffix.length)

  // Truncate base to max length, preserving suffix
  if (safe.length > maxBaseLength) {
    safe = safe.slice(0, maxBaseLength)
  }

  // Fallback if empty
  if (!safe) {
    safe = 'chat'
  }

  return `${safe}${suffix}`
}
