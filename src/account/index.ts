import type { tl, TelegramClient } from '@mtcute/node'
import { OperatorError } from '../errors.js'
import { EXIT } from '../exit-codes.js'
import { reading } from '../reads/errors.js'

/**
 * The account's own settings, read: `tg account sessions`, `privacy` and `notify`.
 *
 * Reads only, and the first verbs that use raw TL: mtcute has no wrapper for
 * these, so each goes through `tg.call({ _: '...' })` with a method that is on
 * `READ_TL_METHODS` in `test/trust.test.ts` (D13f). Changing any of these
 * settings is a write, a different tier, and is not here: in particular nothing
 * ends a session, because each workspace owns its own auth key (D3) and ending the
 * wrong row signs a sibling workspace out.
 */

const minute = (seconds: number): string => (seconds > 0 ? new Date(seconds * 1000).toISOString().slice(0, 16) : '')

/* -------------------------------------------------------------- sessions */

/** One logged-in device or workspace. */
export interface SessionRow {
  /** True for the session this very run is using. */
  current: boolean
  /** Telegram's identifier for the row, as text: it is a 64-bit number. Only the future revoke verb needs it. */
  hash: string
  device: string
  platform: string
  system: string
  app: string
  appVersion: string
  /** An official Telegram app (as opposed to one made with an API id). */
  official: boolean
  ip: string
  country: string
  region: string
  created: string
  active: string
  /** Logged in but waiting for the two-step password. */
  passwordPending: boolean
  /** A login Telegram has not yet confirmed (a new device that has not been approved). */
  unconfirmed: boolean
}

export interface SessionsResult {
  sessions: SessionRow[]
  /** Days of inactivity after which Telegram ends a session by itself, when it says. */
  autoTerminateDays: number | null
}

/**
 * Every session of the account, the current one first.
 *
 * Telegram's own list (Settings > Devices). Print this to see which workspace is
 * which: each names itself as `<date>/<directory>@<host>` (`workspaceDeviceLabel`).
 */
export async function listSessions(tg: TelegramClient): Promise<SessionsResult> {
  const res = await reading(() => tg.call({ _: 'account.getAuthorizations' }))

  const sessions = res.authorizations
    .map((auth): SessionRow => ({
      current: auth.current === true,
      hash: String(auth.hash),
      device: auth.deviceModel,
      platform: auth.platform,
      system: auth.systemVersion,
      app: auth.appName,
      appVersion: auth.appVersion,
      official: auth.officialApp === true,
      ip: auth.ip,
      country: auth.country,
      region: auth.region,
      created: minute(auth.dateCreated),
      active: minute(auth.dateActive),
      passwordPending: auth.passwordPending === true,
      unconfirmed: auth.unconfirmed === true
    }))
    .sort((a, b) => Number(b.current) - Number(a.current) || b.active.localeCompare(a.active))

  return { sessions, autoTerminateDays: res.authorizationTtlDays ?? null }
}

export function renderSessions(result: SessionsResult): string {
  if (result.sessions.length === 0) return 'no sessions\n'

  const lines = result.sessions.map((s) => {
    const marks = [
      s.current ? 'THIS SESSION' : null,
      s.unconfirmed ? 'unconfirmed' : null,
      s.passwordPending ? 'password pending' : null,
      s.official ? 'official app' : null
    ].filter((mark): mark is string => mark !== null)
    const where = [s.ip, s.region, s.country].filter(Boolean).join(', ')
    return (
      `${s.device} - ${s.app} ${s.appVersion} (${s.platform} ${s.system})${marks.length > 0 ? `  ${marks.join(', ')}` : ''}\n` +
      `    ${where || 'location unknown'}  created ${s.created || '?'}, last active ${s.active || '?'}`
    )
  })
  if (result.autoTerminateDays) lines.push(`Telegram ends a session left unused for ${result.autoTerminateDays} days.`)
  return `${lines.join('\n')}\n`
}

/* --------------------------------------------------------------- privacy */

/**
 * The privacy settings, by the names this CLI uses and the TL key each reads.
 * `account.getPrivacy` takes one key per request.
 */
export const PRIVACY_KEYS = {
  'last-seen': 'inputPrivacyKeyStatusTimestamp',
  'phone-number': 'inputPrivacyKeyPhoneNumber',
  'found-by-phone': 'inputPrivacyKeyAddedByPhone',
  'profile-photo': 'inputPrivacyKeyProfilePhoto',
  about: 'inputPrivacyKeyAbout',
  birthday: 'inputPrivacyKeyBirthday',
  forwards: 'inputPrivacyKeyForwards',
  calls: 'inputPrivacyKeyPhoneCall',
  'p2p-calls': 'inputPrivacyKeyPhoneP2P',
  groups: 'inputPrivacyKeyChatInvite',
  'voice-messages': 'inputPrivacyKeyVoiceMessages',
  'paid-messages': 'inputPrivacyKeyNoPaidMessages',
  gifts: 'inputPrivacyKeyStarGiftsAutoSave',
  'saved-music': 'inputPrivacyKeySavedMusic'
} as const satisfies Record<string, tl.TypeInputPrivacyKey['_']>

export type PrivacyKeyName = keyof typeof PRIVACY_KEYS

export function isPrivacyKey(name: string): name is PrivacyKeyName {
  return Object.hasOwn(PRIVACY_KEYS, name)
}

/** One rule of a privacy setting. Rules apply in order; the first that matches a person decides. */
export interface PrivacyRuleRow {
  /** `allow-all`, `deny-contacts`, `allow-users`, ... */
  rule: string
  /** User ids or chat ids the rule names; empty for the rules that name nobody. */
  ids: number[]
}

export interface PrivacyRow {
  key: PrivacyKeyName
  rules: PrivacyRuleRow[]
}

const RULES: Record<tl.TypePrivacyRule['_'], string> = {
  privacyValueAllowAll: 'allow-all',
  privacyValueAllowContacts: 'allow-contacts',
  privacyValueAllowCloseFriends: 'allow-close-friends',
  privacyValueAllowPremium: 'allow-premium',
  privacyValueAllowBots: 'allow-bots',
  privacyValueAllowUsers: 'allow-users',
  privacyValueAllowChatParticipants: 'allow-chat-members',
  privacyValueDisallowAll: 'deny-all',
  privacyValueDisallowContacts: 'deny-contacts',
  privacyValueDisallowBots: 'deny-bots',
  privacyValueDisallowUsers: 'deny-users',
  privacyValueDisallowChatParticipants: 'deny-chat-members'
}

function ruleRow(rule: tl.TypePrivacyRule): PrivacyRuleRow {
  const ids =
    rule._ === 'privacyValueAllowUsers' || rule._ === 'privacyValueDisallowUsers'
      ? rule.users
      : rule._ === 'privacyValueAllowChatParticipants' || rule._ === 'privacyValueDisallowChatParticipants'
        ? rule.chats
        : []
  return { rule: RULES[rule._] ?? rule._, ids: [...ids] }
}

/**
 * Who may see or do each thing: one setting, or all of them.
 *
 * All of them is one request per setting, the same ones the app makes when it
 * opens Settings > Privacy. Rules are reported as Telegram sends them, in order;
 * ids are numbers, not names, so the answer is exactly what is stored.
 */
export async function readPrivacy(tg: TelegramClient, keys: readonly PrivacyKeyName[]): Promise<PrivacyRow[]> {
  const rows: PrivacyRow[] = []
  for (const key of keys) {
    const res = await reading(() => tg.call({ _: 'account.getPrivacy', key: { _: PRIVACY_KEYS[key] } }))
    rows.push({ key, rules: res.rules.map(ruleRow) })
  }
  return rows
}

export function renderPrivacy(rows: PrivacyRow[]): string {
  if (rows.length === 0) return 'no privacy settings\n'

  const width = Math.max(...rows.map((row) => row.key.length))
  return `${rows
    .map((row) => {
      const text =
        row.rules.length === 0
          ? 'no rule: Telegram\'s default'
          : row.rules.map((r) => `${r.rule.replace(/-/g, ' ')}${r.ids.length > 0 ? ` ${r.ids.join(',')}` : ''}`).join('; ')
      return `${row.key.padEnd(width)}  ${text}`
    })
    .join('\n')}\n`
}

/* ---------------------------------------------------------------- notify */

/** Whose notification settings: the three defaults, or one chat. */
export type NotifyScope = { kind: 'users' | 'chats' | 'channels' } | { kind: 'peer'; peerId: number }

export interface NotifyRow {
  scope: string
  /** forever | until <ISO> | no. */
  muted: string
  /** on | off | default. */
  previews: string
  silent: boolean
  storiesMuted: boolean
}

/** Telegram's own "mute indefinitely": the largest 32-bit time. */
const MUTED_FOREVER = 2147483647

function notifyRow(scope: string, settings: tl.RawPeerNotifySettings, now: number): NotifyRow {
  const until = settings.muteUntil ?? 0
  return {
    scope,
    muted: until >= MUTED_FOREVER ? 'forever' : until > now ? `until ${minute(until)}` : 'no',
    previews: settings.showPreviews === undefined ? 'default' : settings.showPreviews ? 'on' : 'off',
    silent: settings.silent === true,
    storiesMuted: settings.storiesMuted === true
  }
}

/**
 * Notification settings.
 *
 * With no peer: the three account-wide defaults (private chats, groups, channels),
 * three requests. With a peer: that chat's own settings, which fall back to the
 * default for its kind when it has none.
 */
export async function readNotify(
  tg: TelegramClient,
  scopes: readonly NotifyScope[],
  now = Math.floor(Date.now() / 1000)
): Promise<NotifyRow[]> {
  const rows: NotifyRow[] = []
  for (const scope of scopes) {
    if (scope.kind === 'peer') {
      const peer = await reading(() => tg.resolvePeer(scope.peerId))
      const settings = await reading(() => tg.call({ _: 'account.getNotifySettings', peer: { _: 'inputNotifyPeer', peer } }))
      rows.push(notifyRow(`chat ${scope.peerId}`, settings, now))
      continue
    }

    const peer: tl.TypeInputNotifyPeer =
      scope.kind === 'users'
        ? { _: 'inputNotifyUsers' }
        : scope.kind === 'chats'
          ? { _: 'inputNotifyChats' }
          : { _: 'inputNotifyBroadcasts' }
    const settings = await reading(() => tg.call({ _: 'account.getNotifySettings', peer }))
    rows.push(notifyRow(scope.kind === 'users' ? 'private chats' : scope.kind === 'chats' ? 'groups' : 'channels', settings, now))
  }
  return rows
}

export function renderNotify(rows: NotifyRow[]): string {
  if (rows.length === 0) return 'no notification settings\n'

  const width = Math.max(...rows.map((row) => row.scope.length))
  return `${rows
    .map((row) => {
      const extra = [row.silent ? 'silent' : null, row.storiesMuted ? 'stories muted' : null].filter(
        (part): part is string => part !== null
      )
      return `${row.scope.padEnd(width)}  muted ${row.muted}, previews ${row.previews}${extra.length > 0 ? `, ${extra.join(', ')}` : ''}`
    })
    .join('\n')}\n`
}

/** The error for a privacy key that is not one of ours, naming the ones that are. */
export function unknownPrivacyKey(name: string): OperatorError {
  return new OperatorError(
    `Not a privacy setting: ${name}. One of: ${Object.keys(PRIVACY_KEYS).join(', ')}`,
    EXIT.usage
  )
}
