import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { OperatorError } from '../errors.js'
import { EXIT } from '../exit-codes.js'
import { SEND_LOG_PATH } from '../paths.js'
import { canPrompt } from '../session/index.js'

/**
 * The guards around sending. No Telegram RPC appears in this file.
 *
 * Split from `src/send/index.ts` so the caps, the confirmation rule and the
 * audit log can be tested and reasoned about without touching the two functions
 * that actually write to Telegram.
 */

/** Per-run cap. A loop that goes wrong stops here. */
export const MAX_SENDS_PER_RUN = Number(process.env.TG_MAX_SENDS_PER_RUN ?? 5)

/**
 * Per-day cap, counted from the send log.
 *
 * Telegram limits outbound messaging from user accounts aggressively, and a
 * burst to people who did not expect it is the classic path to a report and a
 * ban. The operator's own stated ceiling for outreach was three a day; twenty
 * leaves room for ordinary conversation without leaving room for a runaway.
 */
export const MAX_SENDS_PER_DAY = Number(process.env.TG_MAX_SENDS_PER_DAY ?? 20)

/** One line of the send log. Never contains message content. */
export interface SentRecord {
  at: string
  peerId: number
  /**
   * Source chat for a forward, absent for every other kind.
   *
   * A forward is the one write with two peers, and the risk it carries is
   * exactly the pair: which chat was copied OUT of, into which. Logging only
   * the destination would make `tg send log` unable to answer that.
   */
  fromPeerId?: number
  kind:
    | 'text' | 'photo' | 'video' | 'document' | 'delete' | 'forward' | 'edit' | 'read'
    // Chat state, private to the account owner: no counterparty ever sees these.
    | 'archive' | 'unarchive' | 'pin' | 'unpin' | 'mute' | 'unmute' | 'unread'
  /**
   * Message id on success, null on failure. For a delete, the first id removed;
   * for a forward, the first message created in the destination chat; for an
   * edit, the message edited; for a read or any chat-state verb, always 0 -
   * there is no message id to report.
   */
  messageId: number | null
  /**
   * Characters for text, bytes for media, message count for a delete or a
   * forward, characters for an edit, and always 0 for a read or a chat-state
   * verb - they carry no content.
   */
  size: number
  /**
   * How much of the send budget this attempt consumed. Absent means 1.
   *
   * A forward delivers one message per id, so it costs one unit per id: the
   * caps exist to bound DELIVERED messages, not RPC calls.
   */
  units?: number
  ok: boolean
  error?: string
}

/**
 * Require a human, or an explicit stand-in for one.
 *
 * `--yes` is the caller stating on the record that an unattended run is meant to
 * send. Without it an agent or cron job is refused rather than trusted, because
 * sending is the one thing here that cannot be undone.
 */
export function assertConfirmed(options: { yes?: boolean | undefined }): void {
  if (options.yes) return
  if (canPrompt()) return

  // Exit 3, not the OperatorError default of 4. The contract tells an agent
  // that 4 means "the hint is the fix; usually no human needed", which invites
  // exactly the workaround this gate exists to prevent: retrying with --yes
  // bolted on. 3 means stop and ask the operator, which is the truth here.
  throw new OperatorError(
    'Refusing to send from a non-interactive run without --yes.\n' +
    '  This run cannot ask anyone, and sending is not reversible.\n' +
    '  --yes is the operator stating an unattended send is intended. If you are\n' +
    '  an agent and no one told you to send, stop here and ask them.',
    EXIT.needsHuman
  )
}

/** Read the send log. Missing or corrupt lines are skipped, never fatal. */
export function readSendLog(path = SEND_LOG_PATH): SentRecord[] {
  if (!existsSync(path)) return []

  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as SentRecord]
      } catch {
        // A truncated final line from a killed process is not a reason to
        // refuse every future send.
        return []
      }
    })
}

/** Attempts in the last 24h, successful or not. */
export function sendsToday(records: SentRecord[], now = Date.now()): number {
  const cutoff = now - 24 * 60 * 60 * 1000
  return records
    .filter((r) => Date.parse(r.at) >= cutoff)
    .reduce((total, r) => total + (r.units ?? 1), 0)
}

/**
 * Append one attempt to the log, 0600.
 *
 * ponytail: written AFTER the RPC returns, so a process killed between a
 * successful send and this append under-counts the daily cap by one. Recording
 * before the call would instead log every network failure as a delivered
 * message, corrupting the audit trail rather than the budget - and the trail is
 * the thing you cannot reconstruct later. Upgrade path if the budget ever
 * matters more: a two-phase record with an `intent` line reconciled next run.
 */
export function recordSend(record: SentRecord, path = SEND_LOG_PATH): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf-8', mode: 0o600 })
}

/** Sends attempted by THIS process. */
let sentThisRun = 0

/** Reset the per-run counter. Tests only; a real run is one process. */
export function resetRunCounter(): void {
  sentThisRun = 0
}

/** Throw unless both caps allow another send. */
export function assertUnderCaps(units = 1): void {
  if (sentThisRun + units > MAX_SENDS_PER_RUN) {
    throw new OperatorError(
      `Per-run send cap reached (${MAX_SENDS_PER_RUN}).\n` +
      '  Raise it deliberately with TG_MAX_SENDS_PER_RUN if this is intended.'
    )
  }

  const today = sendsToday(readSendLog())
  if (today + units > MAX_SENDS_PER_DAY) {
    throw new OperatorError(
      `Daily send cap reached (${today}/${MAX_SENDS_PER_DAY} in the last 24h).\n` +
      '  Telegram limits outbound messaging from user accounts, and a burst is\n' +
      '  what earns a report. Raise with TG_MAX_SENDS_PER_DAY if intended.'
    )
  }
}

/**
 * Run one write under the caps, logging the attempt either way.
 *
 * A FAILED attempt still increments the run counter: a retry loop against a
 * peer that rejects is exactly the pattern that draws attention, so it has to
 * consume budget rather than being free.
 */
export async function guardedSend(
  peerId: number,
  kind: SentRecord['kind'],
  size: number,
  rpc: () => Promise<{ id: number }>,
  extra: { units?: number; fromPeerId?: number } = {}
): Promise<SentRecord> {
  const units = extra.units ?? 1
  assertUnderCaps(units)

  const base = {
    at: new Date().toISOString(),
    peerId,
    kind,
    size,
    ...(extra.fromPeerId === undefined ? {} : { fromPeerId: extra.fromPeerId }),
    ...(units === 1 ? {} : { units })
  }

  try {
    const message = await rpc()
    sentThisRun += units
    const record: SentRecord = { ...base, messageId: message.id, ok: true }
    recordSend(record)
    return record
  } catch (error) {
    sentThisRun += units
    const record: SentRecord = {
      ...base,
      messageId: null,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
    recordSend(record)
    throw error
  }
}
