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
  /**
   * The PERSON a membership or admin-rights verb acted on, absent for every
   * other kind.
   *
   * Same reasoning as `fromPeerId`: the risk such a write carries is not the
   * chat, it is which human was removed, banned, muted or promoted. `peerId` is
   * the chat, so forty `ban-member` lines would not say whether that was forty
   * people or one person forty times - and the second is the harassment case
   * the zero-unit decision (D13d, D13e) leans on this log to make visible. One
   * RPC per person means one id per line.
   */
  targetUserId?: number
  /**
   * What a person-directed write set, in words: the rights granted, the
   * restrictions applied, the end of a ban. Never message content.
   */
  detail?: string
  kind:
    | 'text' | 'photo' | 'video' | 'document' | 'delete' | 'forward' | 'edit' | 'read'
    // Chat state, private to the account owner: no counterparty ever sees these.
    | 'archive' | 'unarchive' | 'pin' | 'unpin' | 'mute' | 'unmute' | 'unread'
    // Group/channel administration (D13c). Unlike the chat-state seven these
    // ARE visible to everyone in the chat, and some (a revoked primary invite
    // link, a released username) cannot be undone.
    | 'create-group' | 'create-channel' | 'create-supergroup'
    | 'chat-title' | 'chat-description' | 'chat-photo' | 'chat-color'
    | 'chat-sticker-set' | 'chat-username'
    | 'invite-link' | 'forum-topic'
    | 'slow-mode' | 'content-protection' | 'join-requests' | 'join-to-send'
    // Membership and destruction (D13d). Unlike every verb above, these act on
    // a PERSON or destroy a chat outright rather than changing a setting.
    | 'add-member' | 'kick-member' | 'delete-chat'
    // Moderation and admin rights (D13e). Each acts on one PERSON.
    | 'ban-member' | 'unban-member' | 'restrict-member' | 'promote-admin' | 'demote-admin'
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
  /** The forum topic a text or media send was posted into, when `--topic` was given. */
  topicId?: number
  ok: boolean
  error?: string
}

/**
 * The audit kinds that need a human at a terminal, whatever flags were passed
 * (the TTY-only guard class, D13e-a).
 *
 * `guardedSend` checks this list itself, so a verb that is added here is refused
 * unattended even if its command layer or its send function forgets to ask. The
 * list is the class: 0.11 adds history deletion and chat auto-delete by adding
 * their kinds. `demote-admin` is deliberately NOT on it: it only takes rights
 * away, so it stays behind the ordinary `--yes` gate.
 */
export const TTY_ONLY_KINDS: readonly SentRecord['kind'][] = ['promote-admin']

/**
 * The audit kinds that act on one PERSON in a chat: the moderation budget.
 *
 * Each audit line of these kinds is one person, so counting lines is counting
 * people. They cost no send units (they deliver no message), which is exactly
 * why they need a budget of their own: nothing else bounds how many people a
 * loop of `ban` calls can reach in a day (D13e-a).
 */
export const MODERATION_KINDS: readonly SentRecord['kind'][] = [
  'add-member', 'kick-member', 'ban-member', 'unban-member',
  'restrict-member', 'promote-admin', 'demote-admin'
]

/**
 * Refuse unless a human is at a terminal. `--yes` does not help.
 *
 * The TTY-only guard class (D13e-a). `assertConfirmed` lets `--yes` stand in for
 * a human, which is right for most writes and wrong for the few where the
 * operator's presence is the whole point: `--yes` is one word an agent can add
 * to its own command line, so for these the answer to "is somebody there" must
 * not be something the caller can assert. Today that is admin rights
 * (`promote`); history deletion and chat auto-delete join it when they ship.
 *
 * "At a terminal" is exactly {@link canPrompt}: a TTY on stdin and no
 * `TG_NON_INTERACTIVE=1`. That cannot tell a human from an agent that was handed
 * a pty, which is why AGENTS.md tells agents to always set `TG_NON_INTERACTIVE=1`
 * and why these verbs also always ASK, even with `--yes` - somebody has to answer.
 *
 * Exit 3, for the reason `assertConfirmed` gives: 4 would read as "fixable
 * unattended" and invite the workaround.
 */
export function assertInteractive(action: string): void {
  if (canPrompt()) return

  throw new OperatorError(
    `Refusing to ${action} from a non-interactive run.\n` +
    '  This is a terminal-only action: --yes does NOT bypass it, because the point is that a\n' +
    '  human is at the keyboard and answers the prompt. If you are an agent, stop here and ask\n' +
    '  the operator to run this command themselves in a terminal.',
    EXIT.needsHuman
  )
}

/**
 * Require a human, or an explicit stand-in for one.
 *
 * `--yes` is the caller stating on the record that an unattended run is meant to
 * send. Without it an agent or cron job is refused rather than trusted, because
 * sending is the one thing here that cannot be undone.
 *
 * `terminalOnly` names an action that `--yes` may NOT stand in for (see
 * {@link assertInteractive}); it is checked first, so a refused run says "needs
 * a terminal" rather than "add --yes", which would be the wrong advice.
 */
export function assertConfirmed(
  options: { yes?: boolean | undefined },
  gate: { terminalOnly?: string } = {}
): void {
  if (gate.terminalOnly !== undefined) assertInteractive(gate.terminalOnly)
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

/** The moderation cap when nobody set one: 50 people in 24 hours. See {@link maxModerationPerDay}. */
export const DEFAULT_MAX_MODERATION_PER_DAY = 50

/**
 * The daily moderation cap, from `TG_MAX_MODERATION_PER_DAY` (D13e-a).
 *
 * The default is 50 people. That is two full 20-person calls and a few single
 * actions - room for a real clean-up of a spam wave in one sitting - and well
 * under the volume that looks to Telegram like a ban sweep or a mass-add run,
 * both of which it throttles and reports. Clearing hundreds in a day is
 * something the operator should do on purpose, by raising the number.
 *
 * Read at call time, not at import, so a test can set it. A value that is not a
 * non-negative whole number fails CLOSED (the cap becomes 0 and
 * {@link assertUnderModerationCap} says why): `Number('5O')` is NaN, and a NaN
 * cap would compare false against everything and quietly switch the guard off.
 */
export function maxModerationPerDay(env: NodeJS.ProcessEnv = process.env): number {
  return readModerationCap(env).value
}

function readModerationCap(env: NodeJS.ProcessEnv): { value: number; invalid: string | null } {
  const raw = env.TG_MAX_MODERATION_PER_DAY
  if (raw === undefined || raw.trim() === '') return { value: DEFAULT_MAX_MODERATION_PER_DAY, invalid: null }
  if (!/^\d+$/.test(raw.trim())) return { value: 0, invalid: raw }
  return { value: Number(raw.trim()), invalid: null }
}

/**
 * People acted on in the last 24h, successful or not: one per moderation audit line.
 *
 * A refused attempt counts, as it does for sends: a retry loop against a person
 * Telegram will not let us touch is the pattern this exists to bound.
 */
export function moderationToday(records: SentRecord[], now = Date.now()): number {
  const cutoff = now - 24 * 60 * 60 * 1000
  return records.filter((r) => Date.parse(r.at) >= cutoff && MODERATION_KINDS.includes(r.kind)).length
}

/**
 * Raised when the daily moderation cap would be passed.
 *
 * Exit 4, the code every other cap in this repo carries (`assertUnderCaps`
 * throws an `OperatorError` with its default). A named subclass only so a batch
 * can recognise it and stop instead of reporting an unknown failure.
 */
export class ModerationCapError extends OperatorError {
  constructor(message: string) {
    super(message, EXIT.notConfigured)
    this.name = 'ModerationCapError'
  }
}

/**
 * Throw unless `persons` more people fit under today's moderation cap.
 *
 * Separate from the send caps on purpose: 20 messages sent today leave the
 * moderation budget untouched, and 50 bans leave the send budget untouched.
 */
export function assertUnderModerationCap(persons = 1, now = Date.now()): void {
  const { value: cap, invalid } = readModerationCap(process.env)
  if (invalid !== null) {
    throw new ModerationCapError(
      `TG_MAX_MODERATION_PER_DAY=${JSON.stringify(invalid)} is not a whole number, so moderation is refused.\n` +
      '  Fix or unset it. Nothing was done.'
    )
  }

  const today = moderationToday(readSendLog(), now)
  if (today + persons > cap) {
    throw new ModerationCapError(
      `Daily moderation cap reached (${today}/${cap} people in the last 24h; this call needs ${persons} more).\n` +
      '  Every add, removal, ban, unban, restriction and admin change counts one per person, refused attempts too.\n' +
      '  Telegram throttles an account that moderates or adds dozens of people a day. A human can raise\n' +
      '  TG_MAX_MODERATION_PER_DAY if this is intended; if you are an agent, do not: stop and ask the operator.'
    )
  }
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
  extra: { units?: number; fromPeerId?: number; topicId?: number; targetUserId?: number; detail?: string } = {}
): Promise<SentRecord> {
  const units = extra.units ?? 1
  // The backstops. Command layers and send functions check these first, so a
  // refusal is cheap and early; this is the one that cannot be forgotten.
  if (TTY_ONLY_KINDS.includes(kind)) assertInteractive(`do a ${kind} write`)
  if (MODERATION_KINDS.includes(kind)) assertUnderModerationCap(1)
  assertUnderCaps(units)

  const base = {
    at: new Date().toISOString(),
    peerId,
    kind,
    size,
    ...(extra.fromPeerId === undefined ? {} : { fromPeerId: extra.fromPeerId }),
    ...(extra.topicId === undefined ? {} : { topicId: extra.topicId }),
    ...(extra.targetUserId === undefined ? {} : { targetUserId: extra.targetUserId }),
    ...(extra.detail === undefined ? {} : { detail: extra.detail }),
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
