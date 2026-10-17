/**
 * The coverage manifest: every high-level method of mtcute's `TelegramClient`,
 * classified (TASK-43, phase 0.8; D13f).
 *
 * `eval-178` compares this file against the mtcute that is installed: a method
 * mtcute adds that is not listed here fails the suite, so an upgrade cannot widen
 * what the account can do without somebody deciding what the new method is.
 * Deny by default.
 *
 * Each entry is `[status, access]`.
 *
 * status
 * - `covered`            reachable through a tg verb
 * - `planned:<release>`  on the roadmap, not built
 * - `defer`              only when the operator asks
 * - `never`              not added, and a test fails if it appears in src/
 * - `excluded:<reason>`  not an operator verb (auth, internal, iter, variant, bot)
 *
 * access
 * - `read`     changes nothing on Telegram's side. The only kind a file outside the
 *              fence may call (eval-179).
 * - `write`    changes state, or acts as the account, or sends a signal. Must be in
 *              WRITE_RPCS and be called from src/send/ only if it is covered.
 * - `session`  the login lifecycle, called from the auth and session modules.
 *
 * The 217 methods that are not `excluded` are the denominator TASK-43 counts
 * coverage against. Sources: @mtcute/core 0.27.8; where TASK-43's hand-made table
 * and its section 6 disagreed about `never` versus `defer`, section 6 won (D13f).
 */
export type ExcludedReason = 'auth' | 'internal' | 'iter' | 'variant' | 'bot'
export type Status =
  | 'covered'
  | 'defer'
  | 'never'
  | `planned:${string}`
  | `excluded:${ExcludedReason}`
export type Access = 'read' | 'write' | 'session'
export type Entry = readonly [Status, Access]

export const CLIENT_METHODS: Record<string, Entry> = {
  // --- Covered: an operator reaches the method through a tg verb today. A covered method that the fence knows as a write is also in WRITE_RPCS (eval-179).
  addChatMembers: ['covered', 'write'],
  archiveChats: ['covered', 'write'],
  banChatMember: ['covered', 'write'],
  createChannel: ['covered', 'write'],
  createForumTopic: ['covered', 'write'],
  createGroup: ['covered', 'write'],
  createInviteLink: ['covered', 'write'],
  createSupergroup: ['covered', 'write'],
  deleteChannel: ['covered', 'write'],
  deleteContacts: ['covered', 'write'],
  deleteMessagesById: ['covered', 'write'],
  downloadAsBuffer: ['covered', 'read'],
  editAdminRights: ['covered', 'write'],
  editForumTopic: ['covered', 'write'],
  editInviteLink: ['covered', 'write'],
  editMessage: ['covered', 'write'],
  exportInviteLink: ['covered', 'write'],
  forwardMessagesById: ['covered', 'write'],
  getAllScheduledMessages: ['covered', 'read'],
  getChat: ['covered', 'read'],
  getChatEventLog: ['covered', 'read'],
  getChatMember: ['covered', 'read'],
  getChatMembers: ['covered', 'read'],
  getCommonChats: ['covered', 'read'],
  getContacts: ['covered', 'read'],
  getDiscussionMessage: ['covered', 'read'],
  getFolders: ['covered', 'read'],
  getForumTopics: ['covered', 'read'],
  getFullChat: ['covered', 'read'],
  getFullUser: ['covered', 'read'],
  getHistory: ['covered', 'read'],
  getInviteLinkMembers: ['covered', 'read'],
  getInviteLinks: ['covered', 'read'],
  getMe: ['covered', 'read'],
  getMessageByLink: ['covered', 'read'],
  getMessageGroup: ['covered', 'read'],
  getMessageReactions: ['covered', 'read'],
  getMessages: ['covered', 'read'],
  getPeerDialogs: ['covered', 'read'],
  getReactionUsers: ['covered', 'read'],
  getReplyTo: ['covered', 'read'],
  getScheduledMessages: ['covered', 'read'],
  getUser: ['covered', 'read'],
  importContacts: ['covered', 'write'],
  iterDialogs: ['covered', 'read'],
  kickChatMember: ['covered', 'write'],
  markChatUnread: ['covered', 'write'],
  readHistory: ['covered', 'write'],
  restrictChatMember: ['covered', 'write'],
  searchGlobal: ['covered', 'read'],
  searchHashtag: ['covered', 'read'],
  searchMessages: ['covered', 'read'],
  searchPostsGlobal: ['covered', 'read'],
  sendMedia: ['covered', 'write'],
  sendText: ['covered', 'write'],
  setChatColor: ['covered', 'write'],
  setChatDescription: ['covered', 'write'],
  setChatPhoto: ['covered', 'write'],
  setChatStickerSet: ['covered', 'write'],
  setChatTitle: ['covered', 'write'],
  setChatUsername: ['covered', 'write'],
  setSlowMode: ['covered', 'write'],
  toggleContentProtection: ['covered', 'write'],
  toggleForumTopicClosed: ['covered', 'write'],
  toggleForumTopicPinned: ['covered', 'write'],
  toggleJoinRequests: ['covered', 'write'],
  toggleJoinToSend: ['covered', 'write'],
  unarchiveChats: ['covered', 'write'],
  unbanChatMember: ['covered', 'write'],

  // --- Planned, 0.8 reads that did not make 0.8.0 (TASK-43 phase 0.8 and its 0.8.x long tail). No decision record needed: they only read.
  getAllStories: ['planned:0.8.1', 'read'],
  getBoosts: ['planned:0.8.1', 'read'],
  getBoostStats: ['planned:0.8.1', 'read'],
  getBusinessChatLinks: ['planned:0.8.1', 'read'],
  getChatlistPreview: ['planned:0.8.1', 'read'],
  getChatPreview: ['planned:0.8.1', 'read'],
  getCustomEmojis: ['planned:0.8.1', 'read'],
  getCustomEmojisFromMessages: ['planned:0.8.1', 'read'],
  getFactCheck: ['planned:0.8.1', 'read'],
  getGlobalTtl: ['planned:0.8.1', 'read'],
  getInstalledStickers: ['planned:0.8.1', 'read'],
  getInviteLink: ['planned:0.8.1', 'read'],
  getMyBoostSlots: ['planned:0.8.1', 'read'],
  getMyStickerSets: ['planned:0.8.1', 'read'],
  getMyUsername: ['planned:0.8.1', 'read'],
  getPeerSettings: ['planned:0.8.1', 'read'],
  getPeerStories: ['planned:0.8.1', 'read'],
  getPrimaryInviteLink: ['planned:0.8.1', 'read'],
  getProfilePhoto: ['planned:0.8.1', 'read'],
  getProfilePhotos: ['planned:0.8.1', 'read'],
  getProfileStories: ['planned:0.8.1', 'read'],
  getSavedMusic: ['planned:0.8.1', 'read'],
  getSavedStarGifts: ['planned:0.8.1', 'read'],
  getSavedStarGiftsById: ['planned:0.8.1', 'read'],
  getSimilarChannels: ['planned:0.8.1', 'read'],
  getStarGiftOptions: ['planned:0.8.1', 'read'],
  getStarGiftResaleOptions: ['planned:0.8.1', 'read'],
  getStarGiftUpgradeOptions: ['planned:0.8.1', 'read'],
  getStarGiftValue: ['planned:0.8.1', 'read'],
  getStarsTransactions: ['planned:0.8.1', 'read'],
  getStickerSet: ['planned:0.8.1', 'read'],
  getStoriesById: ['planned:0.8.1', 'read'],
  getStoriesInteractions: ['planned:0.8.1', 'read'],
  getStoryLink: ['planned:0.8.1', 'read'],
  getStoryViewers: ['planned:0.8.1', 'read'],
  getUniqueStarGift: ['planned:0.8.1', 'read'],
  getUsers: ['planned:0.8.1', 'read'],
  getWebPagePreview: ['planned:0.8.1', 'read'],
  translateMessage: ['planned:0.8.1', 'read'],
  translateText: ['planned:0.8.1', 'read'],

  // --- Planned 0.9: own-account organiser writes (D13g).
  addContact: ['planned:0.9', 'write'],
  blockUser: ['planned:0.9', 'write'],
  createFolder: ['planned:0.9', 'write'],
  deleteFolder: ['planned:0.9', 'write'],
  editCloseFriends: ['planned:0.9', 'write'],
  editFolder: ['planned:0.9', 'write'],
  readReactions: ['planned:0.9', 'write'],
  saveDraft: ['planned:0.9', 'write'],
  setContactNote: ['planned:0.9', 'write'],
  setFoldersOrder: ['planned:0.9', 'write'],
  unblockUser: ['planned:0.9', 'write'],

  // --- Planned 0.10: message-level writes (D13h).
  closePoll: ['planned:0.10', 'write'],
  deleteScheduledMessages: ['planned:0.10', 'write'],
  pinMessage: ['planned:0.10', 'write'],
  sendCopy: ['planned:0.10', 'write'],
  sendCopyGroup: ['planned:0.10', 'write'],
  sendMediaGroup: ['planned:0.10', 'write'],
  sendReaction: ['planned:0.10', 'write'],
  sendScheduled: ['planned:0.10', 'write'],
  sendVote: ['planned:0.10', 'write'],
  unpinAllMessages: ['planned:0.10', 'write'],
  unpinMessage: ['planned:0.10', 'write'],

  // --- Planned 0.11: remaining chat management and the guard classes (D13i).
  deleteChatPhoto: ['planned:0.11', 'write'],
  deleteForumTopicHistory: ['planned:0.11', 'write'],
  deleteHistory: ['planned:0.11', 'write'],
  hideJoinRequest: ['planned:0.11', 'write'],
  joinChat: ['planned:0.11', 'write'],
  leaveChat: ['planned:0.11', 'write'],
  reorderPinnedForumTopics: ['planned:0.11', 'write'],
  revokeInviteLink: ['planned:0.11', 'write'],
  setChatDefaultPermissions: ['planned:0.11', 'write'],
  setChatTtl: ['planned:0.11', 'write'],
  toggleGeneralTopicHidden: ['planned:0.11', 'write'],
  updateForumSettings: ['planned:0.11', 'write'],

  // --- Planned 0.12: the operator's own account (D13j).
  deleteProfilePhotos: ['planned:0.12', 'write'],
  hideMyStoriesViews: ['planned:0.12', 'write'],
  setEmojiStatus: ['planned:0.12', 'write'],
  setMyBirthday: ['planned:0.12', 'write'],
  setMyProfilePhoto: ['planned:0.12', 'write'],
  setMyUsername: ['planned:0.12', 'write'],
  updateProfile: ['planned:0.12', 'write'],

  // --- Planned 0.13: publish and extend (D13k), deferred: only on an explicit request.
  addStickerToSet: ['planned:0.13', 'write'],
  applyBoost: ['planned:0.13', 'write'],
  canSendStory: ['planned:0.13', 'read'],
  createBusinessChatLink: ['planned:0.13', 'write'],
  createStickerSet: ['planned:0.13', 'write'],
  deleteBusinessChatLink: ['planned:0.13', 'write'],
  deleteStickerFromSet: ['planned:0.13', 'write'],
  deleteStories: ['planned:0.13', 'write'],
  editBusinessChatLink: ['planned:0.13', 'write'],
  editStory: ['planned:0.13', 'write'],
  getBotInfo: ['planned:0.13', 'read'],
  moveStickerInSet: ['planned:0.13', 'write'],
  replaceStickerInSet: ['planned:0.13', 'write'],
  sendStory: ['planned:0.13', 'write'],
  sendStoryReaction: ['planned:0.13', 'write'],
  setBotInfo: ['planned:0.13', 'write'],
  setBusinessIntro: ['planned:0.13', 'write'],
  setBusinessWorkHours: ['planned:0.13', 'write'],
  setStickerSetThumb: ['planned:0.13', 'write'],
  togglePeerStoriesArchived: ['planned:0.13', 'write'],
  togglePinnedStarGifts: ['planned:0.13', 'write'],
  toggleStoriesPinned: ['planned:0.13', 'write'],

  // --- Deferred: only when the operator asks for them, each with its own decision.
  appendTodoList: ['defer', 'write'],
  canApplyBoost: ['defer', 'read'],
  closeWebview: ['defer', 'write'],
  getAvailableMessageEffects: ['defer', 'read'],
  getCallbackAnswer: ['defer', 'write'],
  getCollectibleInfo: ['defer', 'read'],
  incrementStoriesViews: ['defer', 'write'],
  initTakeoutSession: ['defer', 'write'],
  openWebview: ['defer', 'write'],
  readStories: ['defer', 'write'],
  reorderUsernames: ['defer', 'write'],
  saveMusicToProfile: ['defer', 'write'],
  toggleEmojiStatusPermission: ['defer', 'write'],
  toggleFragmentUsername: ['defer', 'write'],
  toggleTodoCompleted: ['defer', 'write'],
  unsaveMusicFromProfile: ['defer', 'write'],

  // --- Never added (TASK-43 section 6): money, takeover, presence leaks, bulk and harassment shapes. Eval-180 fails if any of these is called from src.
  acceptStarGift: ['never', 'write'],
  answerPreCheckoutQuery: ['never', 'write'],
  buyResaleGift: ['never', 'write'],
  cancelPasswordEmail: ['never', 'write'],
  changeCloudPassword: ['never', 'write'],
  deleteGroup: ['never', 'write'],
  deleteUserHistory: ['never', 'write'],
  enableCloudPassword: ['never', 'write'],
  getNearbyChats: ['never', 'read'],
  getStarGiftWithdrawalUrl: ['never', 'read'],
  hideAllJoinRequests: ['never', 'write'],
  joinChatlist: ['never', 'write'],
  prepayStarGiftUpgrade: ['never', 'write'],
  removeCloudPassword: ['never', 'write'],
  resendPasswordEmail: ['never', 'write'],
  resolvePhoneNumber: ['never', 'read'],
  resolveStarGiftOffer: ['never', 'write'],
  sendOnline: ['never', 'write'],
  sendPaidReaction: ['never', 'write'],
  sendStarGift: ['never', 'write'],
  sendStarGiftOffer: ['never', 'write'],
  sendTyping: ['never', 'write'],
  setGlobalTtl: ['never', 'write'],
  setOnline: ['never', 'write'],
  setResaleStarGiftPrice: ['never', 'write'],
  setTyping: ['never', 'write'],
  transferStarGift: ['never', 'write'],
  upgradeStarGift: ['never', 'write'],
  verifyPasswordEmail: ['never', 'write'],

  // --- Excluded, the login lifecycle: owned by `tg session`; only a human creates a session.
  checkPassword: ['excluded:auth', 'session'],
  getPasswordHint: ['excluded:auth', 'read'],
  logOut: ['excluded:auth', 'session'],
  recoverPassword: ['excluded:auth', 'session'],
  resendCode: ['excluded:auth', 'session'],
  sendCode: ['excluded:auth', 'session'],
  sendRecoveryCode: ['excluded:auth', 'session'],
  signIn: ['excluded:auth', 'session'],
  signInBot: ['excluded:auth', 'session'],
  signInQr: ['excluded:auth', 'session'],
  start: ['excluded:auth', 'session'],
  startTest: ['excluded:auth', 'session'],

  // --- Excluded, internal plumbing: peer resolution, input normalisers, uploads, takeout.
  closeChat: ['excluded:internal', 'write'],
  findDialogs: ['excluded:internal', 'read'],
  findFolder: ['excluded:internal', 'read'],
  getMessageAuthor: ['excluded:internal', 'read'],
  getMessagesUnsafe: ['excluded:internal', 'read'],
  getPeer: ['excluded:internal', 'read'],
  isPeerAvailable: ['excluded:internal', 'read'],
  isSelfPeer: ['excluded:internal', 'read'],
  _normalizeFileDownloadLocation: ['excluded:internal', 'read'],
  _normalizeInputFile: ['excluded:internal', 'read'],
  _normalizeInputMedia: ['excluded:internal', 'read'],
  _normalizeInputStarGift: ['excluded:internal', 'read'],
  _normalizePrivacyRules: ['excluded:internal', 'read'],
  openChat: ['excluded:internal', 'write'],
  resolveChannel: ['excluded:internal', 'read'],
  resolvePeer: ['excluded:internal', 'read'],
  resolvePeerMany: ['excluded:internal', 'read'],
  resolveUser: ['excluded:internal', 'read'],
  uploadFile: ['excluded:internal', 'write'],
  uploadMedia: ['excluded:internal', 'write'],
  withParams: ['excluded:internal', 'read'],

  // --- Excluded, the `iter*` twin of a method that is counted on its own; the paced helper reaches them.
  iterAllStories: ['excluded:iter', 'read'],
  iterBoosters: ['excluded:iter', 'read'],
  iterChatEventLog: ['excluded:iter', 'read'],
  iterChatMembers: ['excluded:iter', 'read'],
  iterForumTopics: ['excluded:iter', 'read'],
  iterHistory: ['excluded:iter', 'read'],
  iterInviteLinkMembers: ['excluded:iter', 'read'],
  iterInviteLinks: ['excluded:iter', 'read'],
  iterProfilePhotos: ['excluded:iter', 'read'],
  iterProfileStories: ['excluded:iter', 'read'],
  iterReactionUsers: ['excluded:iter', 'read'],
  iterSavedStarGifts: ['excluded:iter', 'read'],
  iterSearchGlobal: ['excluded:iter', 'read'],
  iterSearchHashtag: ['excluded:iter', 'read'],
  iterSearchMessages: ['excluded:iter', 'read'],
  iterStarsTransactions: ['excluded:iter', 'read'],
  iterStoryViewers: ['excluded:iter', 'read'],

  // --- Excluded, a convenience wrapper or alternate form of a method that is counted on its own.
  answerMedia: ['excluded:variant', 'write'],
  answerMediaGroup: ['excluded:variant', 'write'],
  answerText: ['excluded:variant', 'write'],
  commentMedia: ['excluded:variant', 'write'],
  commentMediaGroup: ['excluded:variant', 'write'],
  commentText: ['excluded:variant', 'write'],
  deleteMessages: ['excluded:variant', 'write'],
  deleteSupergroup: ['excluded:variant', 'write'],
  downloadAsIterable: ['excluded:variant', 'read'],
  downloadAsNodeStream: ['excluded:variant', 'read'],
  downloadAsStream: ['excluded:variant', 'read'],
  downloadChunk: ['excluded:variant', 'read'],
  downloadToFile: ['excluded:variant', 'read'],
  editCloseFriendsRaw: ['excluded:variant', 'write'],
  forwardMessages: ['excluded:variant', 'write'],
  getForumTopicsById: ['excluded:variant', 'read'],
  getMessageReactionsById: ['excluded:variant', 'read'],
  quoteWithMedia: ['excluded:variant', 'write'],
  quoteWithMediaGroup: ['excluded:variant', 'write'],
  quoteWithText: ['excluded:variant', 'write'],
  replyMedia: ['excluded:variant', 'write'],
  replyMediaGroup: ['excluded:variant', 'write'],
  replyText: ['excluded:variant', 'write'],
  unrestrictChatMember: ['excluded:variant', 'write'],

  // --- Excluded, meaningless for a user account (bot-only surface).
  answerCallbackQuery: ['excluded:bot', 'write'],
  answerInlineQuery: ['excluded:bot', 'write'],
  deleteMyCommands: ['excluded:bot', 'write'],
  editInlineMessage: ['excluded:bot', 'write'],
  getBotMenuButton: ['excluded:bot', 'read'],
  getBusinessConnection: ['excluded:bot', 'read'],
  getCallbackQueryMessage: ['excluded:bot', 'read'],
  getGameHighScores: ['excluded:bot', 'read'],
  getInlineGameHighScores: ['excluded:bot', 'read'],
  getMyCommands: ['excluded:bot', 'read'],
  prepareInlineMessage: ['excluded:bot', 'write'],
  setBotMenuButton: ['excluded:bot', 'write'],
  setGameScore: ['excluded:bot', 'write'],
  setInlineGameScore: ['excluded:bot', 'write'],
  setMyCommands: ['excluded:bot', 'write'],
  setMyDefaultRights: ['excluded:bot', 'write'],
}

/**
 * The raw TL methods (`tg.call({ _: '...' })`) that tg uses or may one day use,
 * classified like the client methods. mtcute has no wrapper for these, so the
 * client manifest cannot see them (TASK-43 section 2). Curated, not exhaustive:
 * the schema has 759 methods, and eval-175 is what stops an unlisted one.
 *
 * `unsupported` is a fifth status that only raw methods have: the schema has them
 * and tg cannot do the job (`phone.*` needs a media stack, secret chats need a
 * key exchange the tool does not have).
 */
export type RawStatus = Exclude<Status, `excluded:${string}`> | 'unsupported'
export type RawEntry = readonly [RawStatus, Access]

export const RAW_TL_METHODS: Record<string, RawEntry> = {
  // --- Covered. Raw writes live in src/send/index.ts (WRITE_TL_METHODS); raw reads are READ_TL_METHODS.
  'messages.toggleDialogPin': ['covered', 'write'],
  'account.updateNotifySettings': ['covered', 'write'],

  // --- Raw reads, TASK-43 phase 0.8. Each is covered when its verb ships.
  'account.getAuthorizations': ['covered', 'read'],
  'account.getPrivacy': ['covered', 'read'],
  'account.getNotifySettings': ['covered', 'read'],
  'contacts.getBlocked': ['planned:0.8.1', 'read'],
  'account.getAccountTTL': ['planned:0.8.1', 'read'],
  'account.getGlobalPrivacySettings': ['planned:0.8.1', 'read'],
  'messages.getPollVotes': ['planned:0.8.1', 'read'],
  'channels.getAdminedPublicChannels': ['planned:0.8.1', 'read'],
  'channels.getInactiveChannels': ['planned:0.8.1', 'read'],

  // --- Planned raw writes.
  'messages.setChatAvailableReactions': ['planned:0.11', 'write'],
  'channels.toggleSignatures': ['planned:0.11', 'write'],
  'channels.toggleAntiSpam': ['planned:0.11', 'write'],
  'channels.toggleParticipantsHidden': ['planned:0.11', 'write'],
  'account.setPrivacy': ['planned:0.12', 'write'],
  'account.setGlobalPrivacySettings': ['planned:0.12', 'write'],

  // --- Deferred: only when the operator asks, each with its own decision record.
  'account.resetAuthorization': ['defer', 'write'],
  'messages.migrateChat': ['defer', 'write'],
  'account.updateBusinessAwayMessage': ['defer', 'write'],
  'account.updateBusinessGreetingMessage': ['defer', 'write'],
  'messages.getInlineBotResults': ['defer', 'write'],
  'messages.sendInlineBotResult': ['defer', 'write'],

  // --- Never (TASK-43 section 6). Eval-180 fails if any of these appears in src/.
  'auth.resetAuthorizations': ['never', 'write'],
  'account.deleteAccount': ['never', 'write'],
  'account.changePhone': ['never', 'write'],
  'account.setAccountTTL': ['never', 'write'],
  'account.setAuthorizationTTL': ['never', 'write'],
  'account.invalidateSignInCodes': ['never', 'write'],
  'messages.clearAllDrafts': ['never', 'write'],
  'channels.convertToGigagroup': ['never', 'write'],
  'messages.report': ['never', 'write'],
  'messages.reportSpam': ['never', 'write'],
  'account.reportPeer': ['never', 'write'],
  'channels.reportSpam': ['never', 'write'],
  'account.updateConnectedBot': ['never', 'write'],
  'messages.sendQuickReplyMessages': ['never', 'write'],

  // --- Unsupported.
  'messages.requestEncryption': ['unsupported', 'write']
}

/** `phone.*` is unsupported as a family: calls need a WebRTC media stack tg does not have. */
export const UNSUPPORTED_TL_PREFIXES = ['phone.'] as const

/** Counts by status, the way TASK-43 counts them. */
export function summarize(): {
  total: number
  excluded: number
  inScope: number
  covered: number
  planned: Record<string, number>
  defer: number
  never: number
} {
  const planned: Record<string, number> = {}
  let covered = 0
  let defer = 0
  let never = 0
  let excluded = 0

  for (const [status] of Object.values(CLIENT_METHODS)) {
    if (status.startsWith('excluded:')) excluded++
    else if (status === 'covered') covered++
    else if (status === 'defer') defer++
    else if (status === 'never') never++
    else planned[status.slice('planned:'.length)] = (planned[status.slice('planned:'.length)] ?? 0) + 1
  }

  const total = Object.keys(CLIENT_METHODS).length
  return { total, excluded, inScope: total - excluded, covered, planned, defer, never }
}
