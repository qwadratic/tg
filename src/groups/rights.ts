/**
 * The vocabulary of per-person rights, as Telegram spells them (D13e).
 *
 * Pure data, importing nothing, so both halves can use it: `src/send/index.ts`
 * (which writes rights) and `src/groups/index.ts` (which reads them, and must
 * not link the send module - eval-136). The CLI spells each right in kebab-case;
 * the value is the TL field name.
 */

/**
 * What an admin may do, one TL flag each.
 *
 * `anonymous` is a visibility flag rather than a power, and `other` is
 * Telegram's way to make somebody an admin who holds none of the named powers
 * (they still get the admin log, statistics and slow-mode immunity).
 */
export const ADMIN_RIGHTS = {
  'change-info': 'changeInfo',
  'post-messages': 'postMessages',
  'edit-messages': 'editMessages',
  'delete-messages': 'deleteMessages',
  'ban-users': 'banUsers',
  'invite-users': 'inviteUsers',
  'pin-messages': 'pinMessages',
  'add-admins': 'addAdmins',
  'anonymous': 'anonymous',
  'manage-call': 'manageCall',
  'manage-topics': 'manageTopics',
  'post-stories': 'postStories',
  'edit-stories': 'editStories',
  'delete-stories': 'deleteStories',
  'manage-direct-messages': 'manageDirectMessages',
  'other': 'other'
} as const

export type AdminRightName = keyof typeof ADMIN_RIGHTS
export type AdminRights = Partial<Record<(typeof ADMIN_RIGHTS)[AdminRightName], boolean>>

/**
 * What may be taken away from one member.
 *
 * These are RESTRICTIONS, not permissions: setting one to true DISALLOWS the
 * thing. mtcute passes the object through to `chatBannedRights` untranslated,
 * and so does this - a friendly permission model of our own would invert the
 * sense somewhere and silently grant what the operator meant to remove.
 *
 * `viewMessages` is deliberately absent: restricting that is a BAN, and a ban
 * has its own verb with its own prompt.
 */
export const RESTRICTIONS = {
  'send-messages': 'sendMessages',
  'send-plain': 'sendPlain',
  'send-media': 'sendMedia',
  'send-photos': 'sendPhotos',
  'send-videos': 'sendVideos',
  'send-round-videos': 'sendRoundvideos',
  'send-audios': 'sendAudios',
  'send-voices': 'sendVoices',
  'send-docs': 'sendDocs',
  'send-stickers': 'sendStickers',
  'send-gifs': 'sendGifs',
  'send-games': 'sendGames',
  'send-inline': 'sendInline',
  'send-polls': 'sendPolls',
  'embed-links': 'embedLinks',
  'change-info': 'changeInfo',
  'invite-users': 'inviteUsers',
  'pin-messages': 'pinMessages',
  'manage-topics': 'manageTopics'
} as const

export type RestrictionName = keyof typeof RESTRICTIONS
export type Restrictions = Partial<Record<(typeof RESTRICTIONS)[RestrictionName], boolean>>

/** The kebab names of the flags that are set, in the vocabulary's own order. */
export function adminRightNames(rights: AdminRights | null | undefined): AdminRightName[] {
  if (!rights) return []
  return (Object.keys(ADMIN_RIGHTS) as AdminRightName[]).filter((name) => rights[ADMIN_RIGHTS[name]] === true)
}
