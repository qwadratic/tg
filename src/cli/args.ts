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
