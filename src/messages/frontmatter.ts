/**
 * A Telegram folder this chat belongs to.
 *
 * `id` is the routing key the shipper greps to pick a destination brain;
 * `title` is display only. Dual membership is a list, not a duplicate export.
 */
export interface FolderRef {
  id: number
  title: string
}

/**
 * The gbrain page type. MUST be one of the 15 in gbrain-base-v2.yaml.
 *
 * Anything else is silently retyped with a `legacy_type` field, and that
 * drift is invisible in production - which is why this is a frozen constant
 * and the eval asserts the literal string, not membership of a set.
 */
export const GBRAIN_PAGE_TYPE = 'note'

/**
 * Quote a value as a YAML double-quoted scalar.
 *
 * The backslash MUST be escaped before the quote, and it must be escaped at
 * all: inside a YAML double-quoted scalar `\s` is an unknown escape and the
 * whole document fails to parse. A chat literally named `back\slash` was
 * enough to make the file an invalid gbrain page.
 */
function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** `[7, 12]`, or `[]` for a chat in no tracked folder - never omitted. */
function yamlIdList(folders: FolderRef[]): string {
  return `[${folders.map((folder) => folder.id).join(', ')}]`
}

/**
 * The four fields that turn an archive file into a valid gbrain page.
 *
 * `folder_title` is the FIRST folder's title and is display only; routing
 * reads `folder_ids`, which carries every membership.
 */
/** First folder's title, YAML-quoted, or the literal `null` when there is none. */
function folderTitleValue(folders: FolderRef[]): string {
  const first = folders[0]
  return first ? yamlQuote(first.title) : 'null'
}

function gbrainFields(chatName: string, folders: FolderRef[]): string[] {
  return [
    `type: ${GBRAIN_PAGE_TYPE}`,
    `title: ${yamlQuote(chatName)}`,
    `folder_ids: ${yamlIdList(folders)}`,
    `folder_title: ${folderTitleValue(folders)}`
  ]
}

function buildFrontmatterBlock(lines: string[]): string {
  return `---\n${lines.join('\n')}\n---\n\n`
}

/**
 * Create YAML frontmatter for a chat archive file.
 *
 * @param chatName - Display name of the chat
 * @param chatId - Numeric chat ID
 * @param firstMsgId - ID of the first (oldest) message in this file
 * @param lastMsgId - ID of the last (newest) message in this file
 * @param messageCount - Total messages in this file
 * @param minDate - Earliest message date (ISO 8601)
 * @param maxDate - Latest message date (ISO 8601)
 * @param folders - Tracked folders this chat belongs to (the routing key)
 * @returns YAML frontmatter string including the trailing newlines
 */
export function buildFrontmatter(
  chatName: string,
  chatId: number,
  firstMsgId: number,
  lastMsgId: number,
  messageCount: number,
  minDate: string,
  maxDate: string,
  folders: FolderRef[] = []
): string {
  const now = new Date().toISOString()

  return buildFrontmatterBlock([
    ...gbrainFields(chatName, folders),
    `chat_name: ${yamlQuote(chatName)}`,
    `chat_id: ${chatId}`,
    `first_message_id: ${firstMsgId}`,
    `last_message_id: ${lastMsgId}`,
    `message_count: ${messageCount}`,
    `min_date: "${minDate}"`,
    `max_date: "${maxDate}"`,
    `exported_at: "${now}"`
  ])
}

/**
 * Create YAML frontmatter for an empty chat archive file.
 */
export function buildEmptyFrontmatter(
  chatName: string,
  chatId: number,
  folders: FolderRef[] = []
): string {
  const now = new Date().toISOString()

  return buildFrontmatterBlock([
    ...gbrainFields(chatName, folders),
    `chat_name: ${yamlQuote(chatName)}`,
    `chat_id: ${chatId}`,
    'first_message_id: null',
    'last_message_id: null',
    'message_count: 0',
    'min_date: null',
    'max_date: null',
    `exported_at: "${now}"`
  ])
}

export function buildRecencyFrontmatter(params: {
  mode: 'recent' | 'historical'
  cutoff: string | null
  chatsWithMessages: number
  messagesExported: number
  minDate: string | null
  maxDate: string | null
}): string {
  const now = new Date().toISOString()
  const minDateValue = params.minDate ?? 'null'
  const maxDateValue = params.maxDate ?? 'null'
  const cutoffValue = params.cutoff ?? 'null'
  return buildFrontmatterBlock([
    `export_kind: "${params.mode}"`,
    `cutoff_date: ${cutoffValue === 'null' ? 'null' : `"${cutoffValue}"`}`,
    `chats_with_messages: ${params.chatsWithMessages}`,
    `message_count: ${params.messagesExported}`,
    `min_date: ${minDateValue === 'null' ? 'null' : `"${minDateValue}"`}`,
    `max_date: ${maxDateValue === 'null' ? 'null' : `"${maxDateValue}"`}`,
    `exported_at: "${now}"`
  ])
}

export function getFrontmatterValue(frontmatter: string, key: string): string | null {
  const regex = new RegExp(`^${key}:\\s*(.+)$`, 'm')
  const match = frontmatter.match(regex)
  if (!match) return null
  const captured = match[1]
  if (captured === undefined) return null
  const rawValue = captured.trim()
  if (rawValue === 'null') return null
  if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
    // Inverse of yamlQuote: one pass, so `\\"` unescapes to `\` + `"` and not
    // to a stray quote. A two-pass replace would corrupt exactly that case.
    return rawValue.slice(1, -1).replace(/\\(["\\])/g, '$1')
  }
  return rawValue
}

function upsertField(source: string, key: string, value: string): string {
  const regex = new RegExp(`^${key}:\\s*.+$`, 'm')
  if (regex.test(source)) {
    return source.replace(regex, `${key}: ${value}`)
  }
  return `${source}\n${key}: ${value}`
}

/**
 * Backfill the gbrain fields onto frontmatter written before they existed.
 *
 * Files already on disk predate TASK-5, so an append would otherwise leave
 * them permanently unshippable. `title` falls back to the file's own
 * `chat_name`, which is the only name an old file carries.
 */
function ensureGbrainFields(
  frontmatter: string,
  folders: FolderRef[] | undefined
): string {
  const chatName = getFrontmatterValue(frontmatter, 'chat_name') ?? 'Telegram chat'
  let updated = upsertField(frontmatter, 'type', GBRAIN_PAGE_TYPE)
  if (getFrontmatterValue(updated, 'title') === null) {
    updated = upsertField(updated, 'title', yamlQuote(chatName))
  }
  // Folder membership is only rewritten when the caller actually knows it;
  // a caller that does not must never blank an existing routing key.
  if (folders) {
    updated = upsertField(updated, 'folder_ids', yamlIdList(folders))
    updated = upsertField(
      updated,
      'folder_title',
      folderTitleValue(folders)
    )
  } else if (getFrontmatterValue(updated, 'folder_ids') === null) {
    updated = upsertField(updated, 'folder_ids', '[]')
  }
  return updated
}

export function updateFrontmatter(options: {
  frontmatter: string
  newLastMsgId: number
  newMessageCount: number
  newMinDate: string
  newMaxDate: string
  folders?: FolderRef[]
}): string {
  const existingCount = Number(getFrontmatterValue(options.frontmatter, 'message_count') ?? 0)
  const existingMinDate = getFrontmatterValue(options.frontmatter, 'min_date')
  const existingMaxDate = getFrontmatterValue(options.frontmatter, 'max_date')

  const minDate = existingMinDate
    ? new Date(existingMinDate) < new Date(options.newMinDate) ? existingMinDate : options.newMinDate
    : options.newMinDate
  const maxDate = existingMaxDate
    ? new Date(existingMaxDate) > new Date(options.newMaxDate) ? existingMaxDate : options.newMaxDate
    : options.newMaxDate

  let updatedFrontmatter = ensureGbrainFields(options.frontmatter, options.folders)
  updatedFrontmatter = upsertField(updatedFrontmatter, 'last_message_id', String(options.newLastMsgId))
  updatedFrontmatter = upsertField(
    updatedFrontmatter,
    'message_count',
    String(existingCount + options.newMessageCount)
  )
  updatedFrontmatter = upsertField(updatedFrontmatter, 'min_date', `"${minDate}"`)
  updatedFrontmatter = upsertField(updatedFrontmatter, 'max_date', `"${maxDate}"`)
  updatedFrontmatter = upsertField(updatedFrontmatter, 'exported_at', `"${new Date().toISOString()}"`)

  return updatedFrontmatter
}
