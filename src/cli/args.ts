import { OperatorError } from '../errors.js'
import { EXIT } from '../exit-codes.js'

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function startOfWeek(date: Date): Date {
  const day = date.getDay()
  const diff = day === 0 ? -6 : 1 - day
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate() + diff)
  return startOfDay(start)
}

export function parseCutoffDate(value: string): Date | null {
  const trimmed = value.trim().toLowerCase()
  const today = startOfDay(new Date())
  switch (trimmed) {
    case 'today':
      return today
    case 'yesterday':
      return new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
    case 'start-of-week':
      return startOfWeek(today)
    case 'start-of-month':
      return new Date(today.getFullYear(), today.getMonth(), 1)
    case 'start-of-year':
      return new Date(today.getFullYear(), 0, 1)
    case 'last-7-days':
      return new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7)
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)
  if (!match) return null
  const [, rawYear, rawMonth, rawDay] = match
  if (rawYear === undefined || rawMonth === undefined || rawDay === undefined) return null
  const year = Number.parseInt(rawYear, 10)
  const month = Number.parseInt(rawMonth, 10)
  const day = Number.parseInt(rawDay, 10)
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const date = new Date(year, month - 1, day)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null
  }
  return date
}

/**
 * Parse a `--since` value, or fail with an instruction.
 *
 * Wraps {@link parseCutoffDate} rather than adding a second date parser, so
 * `--since last-7-days` means the same thing everywhere in this CLI. The
 * difference is only in the failure mode: an export cutoff may legitimately be
 * absent, whereas a `--since` the user actually typed and got wrong must not be
 * silently treated as "no filter" and quietly read ten years of history.
 */
export function parseSince(value: string): Date {
  const parsed = parseCutoffDate(value)
  if (!parsed) {
    throw new OperatorError(
      `Unrecognised date: ${JSON.stringify(value)}\n` +
      '  Use YYYY-MM-DD, or one of: today, yesterday, start-of-week,\n' +
      '  start-of-month, start-of-year, last-7-days',
      EXIT.usage
    )
  }
  return parsed
}

export function normalizePhoneInput(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const hasPlus = trimmed.startsWith('+')
  const digitsOnly = trimmed.replace(/\D/g, '')
  if (!digitsOnly) return ''
  return hasPlus ? `+${digitsOnly}` : digitsOnly
}

/**
 * A non-negative whole number, digits only.
 *
 * `Number()` alone reads `1e3` as a thousand, `0x10` as sixteen and `''` as zero, so
 * `--limit 1e3` would quietly mean something else. Same rule `assertPeerId` applies
 * to a peer.
 */
export function parseCount(raw: string, what: string): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new OperatorError(`Not a ${what}: ${raw}. Give a non-negative integer, digits only.`, EXIT.usage)
  }
  return Number(raw.trim())
}

/**
 * A `--limit`: a whole number from 1 to `max`, or the default when absent.
 *
 * A read that can page through ten thousand messages needs a ceiling the caller
 * has to see and choose to hit, not an unbounded default.
 */
export function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback
  const value = parseCount(raw, 'limit')
  if (value < 1 || value > max) {
    throw new OperatorError(`--limit must be between 1 and ${max}, got ${raw}.`, EXIT.usage)
  }
  return value
}

/** Positive message ids, in the order given, with repeats dropped. */
export function parseMessageIds(raw: readonly string[], max: number, flag = 'message id'): number[] {
  const ids = raw.flatMap((part) => part.split(',')).map((part) => part.trim()).filter(Boolean)
  if (ids.length === 0) throw new OperatorError(`Give at least one ${flag}.`, EXIT.usage)

  const parsed = ids.map((id) => {
    const value = parseCount(id, flag === 'message id' ? flag : `${flag} (a message id)`)
    if (value === 0 || !Number.isSafeInteger(value)) {
      throw new OperatorError(`Not a message id: ${id}. Message ids are positive whole numbers.`, EXIT.usage)
    }
    return value
  })

  const unique = [...new Set(parsed)]
  if (unique.length > max) {
    throw new OperatorError(`At most ${max} message ids per call, got ${unique.length}.`, EXIT.usage)
  }
  return unique
}

/** One value out of a fixed set, or a usage error that names the set. */
export function parseChoice<T extends string>(raw: string, flag: string, choices: readonly T[]): T {
  const found = choices.find((choice) => choice === raw)
  if (found === undefined) {
    throw new OperatorError(`${flag} must be one of: ${choices.join(', ')}. Got ${JSON.stringify(raw)}.`, EXIT.usage)
  }
  return found
}

/** A comma-separated list where every item is one of a fixed set. Order kept, repeats dropped. */
export function parseChoices<T extends string>(raw: string, flag: string, choices: readonly T[]): T[] {
  const items = raw.split(',').map((item) => item.trim()).filter(Boolean)
  if (items.length === 0) {
    throw new OperatorError(`${flag} needs at least one value. One of: ${choices.join(', ')}.`, EXIT.usage)
  }
  return [...new Set(items.map((item) => parseChoice(item, flag, choices)))]
}

/** Positive numeric user ids, comma separated or repeated. */
export function parseUserIds(raw: readonly string[], flag: string, max: number): number[] {
  const parts = raw.flatMap((part) => part.split(',')).map((part) => part.trim()).filter(Boolean)
  const ids = parts.map((part) => {
    const value = parseCount(part, 'user id')
    if (value === 0 || !Number.isSafeInteger(value)) {
      throw new OperatorError(`${flag}: ${part} is not a user id. Use positive numeric ids (tg peers find <name> --id-only).`, EXIT.usage)
    }
    return value
  })
  const unique = [...new Set(ids)]
  if (unique.length > max) {
    throw new OperatorError(`${flag} takes at most ${max} ids, got ${unique.length}.`, EXIT.usage)
  }
  return unique
}
