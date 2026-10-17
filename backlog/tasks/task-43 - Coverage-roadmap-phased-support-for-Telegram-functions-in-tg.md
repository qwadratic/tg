---
id: TASK-43
title: 'Coverage roadmap: phased support for Telegram functions in tg'
status: To Do
assignee: []
created_date: '2026-10-17 09:04'
updated_date: '2026-10-17 09:08'
labels:
  - roadmap
  - coverage
  - fence
dependencies: []
priority: medium
ordinal: 43000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The owner wants `tg` to support, gradually, every Telegram function an operator uses, through the repo's fenced-write model (D13 of 2026-08-17, D13a-b, D13c tiers of 2026-08-31, D13d of 2026-10-05, D13e for 0.7.0). Today `tg` 0.6.0 reaches 42 of the 217 operator-facing methods in mtcute's `TelegramClient` (19%): reading one chat at a time, archiving, 15 send verbs and 27 `tg group` verbs. 0.7.0 (moderation, being built on a separate worktree under D13e) brings it to 47 (22%). This task is the map and the order of work, not a build ticket. Each phase below becomes its own backlog task when the operator confirms its scope, exactly as TASK-41 (tgTUI) is a PRD rather than a build ticket.

Two constraints decide the shape of everything below, and both are the repo's own: reads are cheap to add because a read verb must not be able to reach `src/send/` (eval-31 lists its read entry points by hand, five once 0.7.0 lands; phase 0.8 derives the list so every new read verb is checked), and every write is a decision (D13a and D13b: "The next verb needs the next amendment"). So the roadmap puts every read first and spends one decision record per write phase.

## How the numbers were derived

Source: `@mtcute/core` 0.27.8 (the pin in `pnpm-lock.yaml`; the global install on the dev VM has 0.27.9 with the identical 307 method names). The checkout had no `node_modules`, so the declarations were read from the npm tarball. The `TelegramClient` interface declares 308 signatures = 307 distinct names. Of those, 90 are excluded as not operator verbs and 217 are in scope:

| excluded bucket | n | what |
| --- | --- | --- |
| auth lifecycle | 12 | `signIn`, `signInQr`, `sendCode`, `checkPassword`, `logOut`, `start`... already owned by `tg session`; `signInBot` is out because tg is a user-account tool |
| internal / resolution | 21 | `resolvePeer*`, `getPeer`, `_normalize*`, `withParams`, `uploadFile`, `openChat`, `findDialogs`... |
| `iter*` duplicates | 17 | `iterSearchMessages` is folded into `searchMessages`, and so on (only `iterDialogs` has no `get` sibling and is counted) |
| convenience wrappers and variants | 25 | `replyText`, `commentMedia`, `quoteWithText`, `deleteMessages` (object form of `deleteMessagesById`), `downloadAsStream`... |
| bot-account-only | 15 | `answerCallbackQuery`, `setMyCommands`, `answerInlineQuery`, `getBusinessConnection`... meaningless for a user account |

"Covered" means an operator can reach the method through a `tg` verb today. Raw TL calls that mtcute has no wrapper for are counted separately (section 2). The 0.8 phase turns this classification into a checked-in manifest with a test, so it cannot rot. Counts are given for today (0.6.0) and for after 0.7.0, the moderation release the owner decided to ship first. The 0.7.0 verbs (`group members`, `ban`, `unban`, `restrict`, `promote`, `demote`) were read from the in-progress worktree, not from a released version; D13e is authoritative if it differs.

## 1. Coverage table (mtcute high-level methods in scope)

| area | in scope | covered today (0.6.0) | covered after 0.7.0 | planned after 0.7.0 | defer | never |
| --- | --- | --- | --- | --- | --- | --- |
| messages (send, edit, delete, forward, read, get, pin, translate) | 23 | 6 | 6 | 14 | 1 | 2 |
| media and files | 3 | 2 | 2 | 1 | 0 | 0 |
| chats, groups, channels, invite links | 38 | 19 | 19 | 14 | 3 | 2 |
| members and admin rights | 10 | 2 | 7 | 2 | 0 | 1 |
| forum topics | 9 | 5 | 5 | 4 | 0 | 0 |
| contacts and users | 16 | 2 | 2 | 13 | 1 | 0 |
| folders and dialogs | 12 | 5 | 5 | 6 | 1 | 0 |
| stickers and reactions | 16 | 0 | 0 | 15 | 0 | 1 |
| polls and todo lists | 4 | 0 | 0 | 2 | 2 | 0 |
| stories | 17 | 0 | 0 | 15 | 2 | 0 |
| bots and inline (user-account side) | 8 | 0 | 0 | 2 | 4 | 2 |
| privacy and account settings (own profile, 2FA, TTL) | 23 | 1 | 1 | 9 | 5 | 8 |
| search | 4 | 0 | 0 | 4 | 0 | 0 |
| drafts | 1 | 0 | 0 | 1 | 0 | 0 |
| scheduled messages | 4 | 0 | 0 | 4 | 0 | 0 |
| premium, boosts, stars, gifts | 23 | 0 | 0 | 13 | 1 | 9 |
| business features | 6 | 0 | 0 | 6 | 0 | 0 |
| calls | 0 | 0 | 0 | 0 | 0 | 0 |
| total | 217 | 42 | 47 | 125 | 20 | 25 |

0.7.0 delivers five methods: `getChatMembers` (read), `banChatMember`, `unbanChatMember`, `restrictChatMember`, `editAdminRights`. `getChatMember` (single lookup) is not in the worktree and stays in 0.8. Planned splits by phase after 0.7.0: 0.8 = 62, 0.9 = 11, 0.10 = 11, 0.11 = 12, 0.12 = 7, 0.13 = 22. Calls: mtcute 0.27.8 has no high-level call methods at all (the TL `phone.*` RPCs exist, but a call needs a WebRTC/tgcalls media stack that tg does not have). Note only; out of scope. Call service messages already show up in `dump`, and `search --filter call` will find them.

### What tg has today (0.6.0), and what is missing

| area | tg has today | missing (highlights) |
| --- | --- | --- |
| messages | `send text/edit/rm/forward/read`, `note`, `dump` (history, engagement suffix) | read one message by id or t.me link, replies/comment threads, pin/unpin message, copy without attribution, translate; send options (see section 3) |
| media | `send media` (photo, video, document), `media pull`, `watch` | albums; 17 of the 20 `InputMedia` kinds (voice, audio, sticker, location, venue, contact, dice, poll, quiz...) |
| chats/groups/channels | `group` create x3, title, description, photo, color, sticker-set, username, remove-username, invites (export, new, edit, list, members), slow-mode, protect, join-requests, join-to-send, delete (owner only) | `chat info` (`getFullChat`), admin log (`getChatEventLog`), join, leave, revoke invite link, approve one join request, delete photo, delete history, chat TTL, private-invite preview |
| members/admin | `add-members` (max 20), `kick-member`; 0.7.0 adds `group members` (read), `ban`, `unban`, `restrict`, `promote`, `demote` | after 0.7.0: single-member lookup, default permissions |
| forum topics | `topic-new/edit/closed/pinned/list`, `--topic` on send | `dump --topic`, reorder pinned, delete topic history, forum settings, hide General |
| contacts/users | `check-phones` only (`importContacts` + `deleteContacts`, an allowlisted exception) | contact list, user info, common chats, profile photos, add/note/delete contact, block/unblock, close friends |
| folders/dialogs | `peers list/find`, `folders list` (archive view of tracked folders), `send archive/unarchive/pin/unpin/mute/unmute/unread` (pin and mute via raw TL) | Telegram folder CRUD and reorder, folder contents, shared-folder preview, per-peer dialog info |
| stickers/reactions | `group sticker-set` | sticker set reads, custom emoji, react, who reacted, mark reactions read, own sticker sets |
| polls | none | create (via `InputMedia`), vote, close, voters |
| stories | none | list, show, viewers, post, edit, delete, pin, archive, react |
| bots/inline | none | bot info for bots you own; inline results; pressing bot buttons |
| privacy/account | none (`session status` shows the local session only) | profile read/write, username, photo, birthday, emoji status, privacy rules, sessions list, notification and TTL settings |
| search | none live (TASK-26 is the local archive search) | in-chat, global, hashtag, public posts |
| drafts | none | list, set, clear |
| scheduled | none | list, send now, delete, schedule a send |
| premium/boosts | none | boost stats and slots, Stars transactions, gift reads |
| business | none | chat links, intro, work hours (away/greeting/quick replies stay out) |

## 2. Raw TL gaps (RPCs mtcute does not wrap)

Curated, not exhaustive: TL layer 221 has 759 methods; these are the ones an operator would plausibly ask for. Every raw write must be listed in `WRITE_TL_METHODS` and appear in `src/send/index.ts` (eval-29b); every raw read in a new `READ_TL_METHODS` list (phase 0.8).

| status | n | RPCs |
| --- | --- | --- |
| covered | 2 | `messages.toggleDialogPin`, `account.updateNotifySettings` (pin/unpin, mute/unmute) |
| planned read, 0.8 | 9 | `account.getAuthorizations`, `account.getPrivacy`, `account.getNotifySettings`, `contacts.getBlocked`, `account.getAccountTTL`, `account.getGlobalPrivacySettings`, `messages.getPollVotes`, `channels.getAdminedPublicChannels`, `channels.getInactiveChannels` |
| planned write | 6 | 0.11: `messages.setChatAvailableReactions`, `channels.toggleSignatures`, `channels.toggleAntiSpam`, `channels.toggleParticipantsHidden`; 0.12: `account.setPrivacy`, `account.setGlobalPrivacySettings` |
| defer (operator decision) | 6 | `account.resetAuthorization` (one session), `messages.migrateChat`, `account.updateBusinessAwayMessage`, `account.updateBusinessGreetingMessage`, `messages.getInlineBotResults`, `messages.sendInlineBotResult` |
| never | 14 | `auth.resetAuthorizations`, `account.deleteAccount`, `account.changePhone`, `account.setAccountTTL`, `account.setAuthorizationTTL`, `account.invalidateSignInCodes`, `messages.clearAllDrafts`, `channels.convertToGigagroup`, `messages.report`, `messages.reportSpam`, `account.reportPeer`, `channels.reportSpam`, `account.updateConnectedBot`, `messages.sendQuickReplyMessages` |
| unsupported | - | `phone.*` (calls), `messages.requestEncryption` (secret chats) |

## 3. Option-level gaps inside methods tg already calls

Coverage by method name hides these; several of them are what an operator actually asks for first.

- `sendText`: only `replyTo` for `--topic`. Missing: reply to a message, comment on a channel post (`commentTo`), quote, `silent`, `schedule`, `disableWebPreview`, markdown/HTML entities, `forbidForwards`, `clearDraft`.
- `sendMedia`: 3 of the 20 `InputMedia` kinds (photo, video, document; `auto` aside). No albums (`sendMediaGroup`), no spoiler/TTL flag, no thumbnail (existing `ponytail:` note in `src/send/index.ts`).
- `dump`/`iterHistory`: no `--topic`, `--thread`, `--from`, `--min-id`, no filters. Drafts, folder and unread filters are missing on `peers list`.
- `mute`: indefinite only. `read`: whole chat only. `forward`: no `--silent`, no topic destination.
- `editMessage`: text only.
- `check-phones`: its `importContacts`/`deleteContacts` calls sit outside `src/send/` under an allowlist entry that D13 called "one of several"; it is the last write RPC the fence does not own.

## 4. Rules every phase follows (the D13 recipe)

Reads (no decision record needed):
- New file under `src/cli/commands/`, no import of `src/send/`, registered above the "Write verbs last" comment in `src/index.ts`. Rendering is a pure function with a golden. `--json` writes only the payload to stdout; the resolved identity line goes to stderr (D17).
- Iteration goes through one shared paced helper generalised from `src/messages/fetch.ts` ("a second, unthrottled reader is how an account gets limited"). No second history iterator.
- Exit codes follow the contract: 0 ok, 2 usage or zero results, 3 needs a human (including `CHAT_ADMIN_REQUIRED`), 4 not configured, 5 busy, 6 upstream (`FLOOD_WAIT`, `PEER_FLOOD`, network).

Writes (one decision record per phase, `backlog/decisions/<date>-widen-the-fenced-write-verbs-to-<slug>.md`, lettered D13f onward because D13e is the 0.7.0 moderation record, with the sections of D13c/D13d: Decision, Why gated, Cost model, RPCs added, Safeguards, Exit codes and shapes, Explicitly out of scope, Not decided):
- The RPC lives in `src/send/index.ts` only and its name goes into `WRITE_RPCS` (or `WRITE_TL_METHODS` for raw TL). The command file names only imported function names and joins `WRITE_ALLOWLIST` with a stated reason. Peer resolution stays in the command layer (eval-33, eval-65).
- Gate: `assertPeerId`, resolved-identity confirmation naming the peer (the person for membership verbs, per D13c), `assertConfirmed` (exit 3 unattended without `--yes`), `guardedSend`, one audit line in `data/sent.jsonl` with a new `kind`, never content.
- Cost rubric, so each decision does not reinvent it:

| class | examples | seen by | units | extra guard |
| --- | --- | --- | --- | --- |
| delivers content | text, media, album item, poll, copy, scheduled message (charged when scheduled), story post | recipients | 1 per delivered item | caps 5/run, 20/day; never raised |
| signal without content | reaction, story reaction (D13a: a read receipt is budgeted like a send) | that counterparty | 1 | same caps |
| shared chat metadata or membership | D13c settings, ban, restrict, pin message, join, leave | members | 0 | audit; prompt names chat and person; per-run counter |
| private account state | drafts, folders, contacts, block, mute, archive | operator (block is inferable) | 0 | audit |
| destroys history or cannot be undone | delete history, TTL, topic history, delete chat, username release, revoke link | varies | 0 | ownership check or archive-first guard, irreversibility spelled out, TTY-only for the worst |
| account and security | privacy rules, profile, sessions | everyone viewing the profile | 0 | before/after in the prompt; anything that widens exposure is TTY-only |

- New guard class, proposed here: **TTY-only**. The verb refuses a non-interactive run with exit 3 even when `--yes` is passed, because for these the operator's presence is the point and `--yes` is too easy to add. Precedent: `session phones --reveal` already refuses without a terminal.
- **Archive-first guard** for anything that destroys history (`delete-history`, TTL, topic history): refuse with exit 2 unless the chat is outside the tracked config, is in `excludeChatIds`, or its sync watermark already covers the latest message. D13c's reason: "deletion and TTL destroy history that this tool exists to archive".
- Batch and counter limits mirror D13d (`add-members` at most 20, stop on flood). In the 0.7.0 worktree `ban` and `unban` take at most 20 numeric ids per call with one RPC and one audit line per person (a `targetUserId` field on the log record). Because a shell loop can still drive person-directed verbs, 0.11 adds a per-run counter for them and a per-day counter for joins in `gate.ts`, documented in AGENTS.md next to the send caps as "do not raise".
- Every write phase: README tables, `skill/SKILL.md`, AGENTS.md layout table; version literal in `src/index.ts` and `package.json` together (eval-72); new evals continue after the highest existing number (eval-163 once 0.7.0 lands); the fence is tripwire-verified by injecting a call and watching eval-29 fail (D14); tests use mocked clients, no network.

## 5. Phases

Phases ship in order. 0.7.0 is already decided and in progress. Reads (0.8) can be split across patch releases. Write phases serialise on `src/send/index.ts`, `src/send/gate.ts` and `test/trust.test.ts`, so only one write phase is in flight at a time. No calendar dates: size is stated in methods.

### 0.7.0 Moderation (5 methods, in progress on a separate worktree): D13e

Decided by the owner on 2026-10-17 and built outside this task; it is listed so the counts and the later phases stay consistent. Not planned work here.
- Scope: `group members` (read, `getChatMembers` with `--type`, `--query`, `--limit`; Telegram returns at most 200), `group ban`, `group unban`, `group restrict`, `group promote` and `group demote` (both `editAdminRights`).
- RPCs added to `WRITE_RPCS`: `banChatMember`, `unbanChatMember`, `restrictChatMember`, `editAdminRights`. The worktree also lists `deleteGroup` and `setChatTtl` as fenced but not called, so 0.11 only has to start calling `setChatTtl` under its own record.
- As drafted in the worktree (D13e itself is authoritative): numeric user ids, ban and unban up to 20 per call, one RPC and one audit line per person with new `targetUserId` and `detail` fields on the log record, zero units, `groups/index.ts` added to eval-31's read list.
- Stays in this roadmap: single-member lookup (0.8), default permissions (0.11), and the guard classes and counters (0.11), which also retrofit onto these verbs where D13e does not already have them.

### 0.8 Core reads and fence hardening (62 methods, 9 raw reads, no new write RPC)

Decision D13f (hardening only, widens nothing): what the fence enforces by hand-kept list today becomes enforced by derivation.
- Raw-call tripwire: any `.call({ _: '...' })` outside `src/send/` fails unless the method is in `READ_TL_METHODS`. This closes the gap D13c admitted ("a raw `tg.call` twin would not be caught") before the phases that need raw writes.
- Alias tripwire: destructuring or bracket access of any `WRITE_RPCS` name outside the allowlist fails.
- eval-31 derived: every command file that is neither in `WRITE_ALLOWLIST` nor on the unattended list is a read verb and must not reach `src/send/`, and so is every read module such as `groups/index.ts` (added to the list by 0.7.0); a command file in neither list fails the suite, which forces the classification. `group.ts` mixes reads and writes, so its reads are checked through the read module, not the command file.
- Coverage manifest + test: every `TelegramClient` method name in the installed mtcute is classified (covered, planned:<phase>, defer, never, excluded:<reason>); an mtcute upgrade that adds an unclassified method fails the suite. Deny by default.
- Decide whether to split `src/send/index.ts` (1133 lines today, roughly 300 more per phase) by area, which would redefine the fence from "one file" to "one directory" in AGENTS.md and eval-29b. Record the answer before 0.10.

Read verbs (all `--json`, all paced):

| verb | methods |
| --- | --- |
| `chat info <peer>`, `chat preview <t.me/+link>`, `chat similar <channel>` | `getChat`, `getFullChat`, `getChatPreview`, `getSimilarChannels` |
| `chat log <peer> [--type] [--user]` | `getChatEventLog` (admin only: `CHAT_ADMIN_REQUIRED` is exit 3) |
| `group member <peer> <user>` | `getChatMember` (the list read `group members` ships in 0.7.0) |
| `msg get <peer> <ids...>`, `msg link <url>`, `msg thread <peer> <id>`, `msg preview <url>`, `msg translate` | `getMessages`, `getMessageByLink`, `getMessageGroup`, `getReplyTo`, `getDiscussionMessage`, `getFactCheck`, `getWebPagePreview`, `translateMessage`, `translateText` |
| `dump --topic <id>` / `--thread <id>` | no new method (`replyTo` through the single fetch iterator) |
| `search <query> [--chat] [--global] [--hashtag] [--posts] [--filter] [--from] [--since]` | `searchMessages`, `searchGlobal`, `searchHashtag`, `searchPostsGlobal`. Name collision with TASK-26 (archive search): settle `search` (live) versus `search --archive` or `grep` before release |
| `user info <peer>`, `user photos`, `contacts list` | `getUser(s)`, `getFullUser`, `getPeerSettings`, `getCommonChats`, `getProfilePhoto(s)`, `getContacts` |
| `dialogs show <peers...>`, `draft list`, `scheduled list <peer>`, `reactions show <peer> <id>` | `getPeerDialogs`, drafts from dialogs, `getAllScheduledMessages`, `getScheduledMessages`, `getMessageReactions`, `getReactionUsers` |
| `group invite-show`, `folders show`, `folders preview <link>` | `getInviteLink`, `getPrimaryInviteLink`, `getFolders` (live definition, not the archive view), `getChatlistPreview` |
| `account me\|sessions\|privacy\|notify\|blocked\|ttl\|channels` | `getMe`, `getMyUsername`, `getGlobalTtl`, plus the 9 raw reads in section 2 (`channels` = public channels you administer and inactive ones, for `CHANNELS_TOO_MUCH`) |

Long tail as patch releases (0.8.x), no decision record: `stories list/show/viewers` (never calls `incrementStoriesViews` or `readStories`, so reading never marks a story viewed), `stickers show/installed/emoji`, `boosts`, `stars`, `gifts`, `business links`, `getSavedMusic`, `poll voters`.

Acceptance criteria for 0.8 are in the list below.

### 0.9 Own-account organiser writes (11 methods): D13g

Private state, below Tier 1. The highest value for the lowest risk, and the answer to the outreach pain in TASK-25: an agent can prepare drafts that a human reviews and sends from Telegram itself, so no message is ever sent by the tool.
- RPCs: `saveDraft`, `createFolder`, `editFolder`, `deleteFolder`, `setFoldersOrder`, `addContact`, `setContactNote`, `blockUser`, `unblockUser`, `editCloseFriends`, `readReactions` (the 11 new methods), plus `importContacts` and `deleteContacts` moved from `src/contacts/import.ts` into `src/send/` and added to `WRITE_RPCS`. Mute gains `--for/--until` on the existing raw RPC.
- Verbs: `draft set|clear`, `folders create|edit|delete|order|add-chat|remove-chat`, `contacts add|note|rm|block|unblock|close-friends`, `reactions read <peer>`.
- Safeguards: `draft set` refuses to overwrite an existing draft without `--replace` (checked with a read first), never logs text, never clears all drafts. Folder verbs warn on stderr when the folder is in `trackedFolderIds`, because an edit changes what `tg sync` archives; `delete` shows name and chat count. Contact verbs: numeric ids, prompt names the person, `rm` at most 20 ids per call. Block is inferable by the other side (messages stop being delivered), so it is stated in the prompt.
- Cost: 0 units, one audit line per attempt, new `kind` values. Exit codes as in section 4; `--json` shapes `{ok, peer, replaced}` for drafts and per-id `{ok, done, failed}` for lists.
- Not added: `resolvePhoneNumber` (`check-phones` already does phone-to-user lookup with its own pacing; a second enumeration path waits for the operator), `contacts.getSaved`/`resetSaved`.

### 0.10 Message-level writes (11 methods, options on `send text`/`send media`): D13h

The D13/D13a class: content or signals on someone else's screen. Everything here is budgeted like a send.
- RPCs added to `WRITE_RPCS`: `sendCopy`, `sendCopyGroup`, `sendMediaGroup`, `pinMessage`, `unpinMessage`, `unpinAllMessages`, `sendReaction`, `closePoll`, `sendVote`, `sendScheduled`, `deleteScheduledMessages`. `sendText` and `sendMedia` gain options but no new name.
- `send text`: `--reply-to`, `--comment-to`, `--quote`, `--silent`, `--no-preview`, `--parse md|html`, `--schedule <time>`. A scheduled message is a delayed unattended delivery, so units are charged when it is scheduled and the horizon is capped (proposed 30 days).
- `send media` kinds: voice, audio, sticker, location, venue, contact, dice, poll, quiz; `send album` (`sendMediaGroup`) costs one unit per item, so with default caps an album is at most 5 items per run and larger is refused with a usage error. The cap is not raised.
- `send copy <peer> <ids...> --to <target>`: one unit per message, audit carries `fromPeerId`, prompt names both chats and says there will be no "forwarded from" header; refused before the RPC for protected-content chats. Higher risk than `forward` because it strips attribution.
- `send react` one unit, one reaction per call, `--remove`. `pin-message`, `unpin-message`: 0 units (service message, the D13c class). `unpin-all` states how many pins go. `poll vote` and `poll close` (own polls only): prompt states that a quiz vote cannot be retracted and a closed poll cannot reopen.
- No verb takes several destination peers; a CLI-shape test asserts it.
- Not added: `sendTyping`/`setTyping` (presence leak, no operator use), `sendPaidReaction` (money), `appendTodoList`/`toggleTodoCompleted` (defer, low value).

### 0.11 Remaining management (12 methods, 4 raw): D13i

The Tier 2 and Tier 3 remainder after 0.7.0, plus the guard classes and counters that D13c and D13d imply and that 0.7.0's verbs also need.
- RPCs added to `WRITE_RPCS`: `setChatDefaultPermissions`, `joinChat`, `leaveChat`, `hideJoinRequest`, `revokeInviteLink`, `deleteChatPhoto`, `deleteHistory`, `reorderPinnedForumTopics`, `deleteForumTopicHistory`, `updateForumSettings`, `toggleGeneralTopicHidden`; `setChatTtl` is already fenced by D13e and is called for the first time here. Added to `WRITE_TL_METHODS`: `messages.setChatAvailableReactions`, `channels.toggleSignatures`, `channels.toggleAntiSpam`, `channels.toggleParticipantsHidden`.
- Guard classes and counters introduced here and retrofitted onto 0.7.0's verbs where D13e lacks them: a per-run counter for person-directed verbs (proposed default 5; covers ban, unban, restrict, promote, demote, kick, add-members) so repeated calls are bounded as well as one call; the TTY-only class (below) for `promote`, which also gets a before/after rights printout and refuses to grant `addAdmins` unless `--allow-add-admins` is given (chain escalation).
- `default-permissions` is the same shape as `restrict` but for everyone in the chat: named flags only, before/after in the prompt.
- Joins: one per call, per-day join cap counted from the audit log (proposed `TG_MAX_JOINS_PER_DAY`, default 5), because bulk joining is a spam shape and Telegram throttles it. `hideJoinRequest` approves or declines one request at a time.
- Destructive set (`delete-history`, `ttl`, `topic-delete-history`): TTY-only and archive-first. `deleteGroup` (legacy) stays deferred as in D13d and D13e.
- Error map extended and tested per mapping for the new verbs, and checked against 0.7.0's: `USER_PRIVACY_RESTRICTED`, `USER_NOT_PARTICIPANT`, `USER_ADMIN_INVALID`, `CHANNELS_TOO_MUCH`, `INVITE_HASH_EXPIRED`, `INVITE_REQUEST_SENT`, `CHAT_ADMIN_REQUIRED` (3), `FLOOD_WAIT`/`PEER_FLOOD` (6).
- Not added: `hideAllJoinRequests`, `joinChatlist`, `deleteUserHistory` (section 6).

### 0.12 Me and my account (7 methods, 2 raw): D13j

A new tier (call it Tier 4, account), not in D13c.
- RPCs: `updateProfile`, `setMyUsername`, `setMyProfilePhoto`, `deleteProfilePhotos`, `setMyBirthday`, `setEmojiStatus`, `hideMyStoriesViews`; raw `account.setPrivacy`, `account.setGlobalPrivacySettings`.
- `setMyUsername` carries the same irreversibility wording as `remove-username`: the old handle returns to the pool at once.
- `account privacy set <key> ...` prints current and new rules, takes numeric ids in allow/deny lists, and any change that widens exposure (toward "everybody") is TTY-only.
- Session revocation: record the decision either way. If built, `account.resetAuthorization` for ONE session by hash taken from `account sessions`, refusing the current session, printing the device label, TTY-only. Reason for care: each workspace owns its own auth key (D3, AGENTS.md), so revoking the wrong row kills another workspace. `auth.resetAuthorizations` (all sessions) never.

### 0.13 Publish and extend (22 methods): D13k, optional

Long tail. Build only on request.
- Stories: `sendStory`, `editStory`, `deleteStories`, `toggleStoriesPinned`, `togglePeerStoriesArchived`, `sendStoryReaction`, `canSendStory`. A story is a public post: one unit, prompt states the audience. `incrementStoriesViews` and `readStories` stay out (view receipts leak that a human is awake, D13a).
- Sticker sets (`createStickerSet`, `addStickerToSet`, `deleteStickerFromSet`, `moveStickerInSet`, `replaceStickerInSet`, `setStickerSetThumb`): only sets from `getMyStickerSets`, ownership checked before the RPC, as `delete` does for chats.
- `getBotInfo`/`setBotInfo` for bots you own, `applyBoost` (spends a slot that cannot be moved for a while), `togglePinnedStarGifts`, business profile (`setBusinessIntro`, `setBusinessWorkHours`, chat link create/edit/delete).
- Stays out: business away, greeting and quick-reply automation and connected bots (section 6).

### 1.0 Operator-complete

Reached when 0.7.0 and 0.8-0.12 are shipped (0.13 optional). The manifest has no `planned` entry left: every in-scope method is covered, deferred or never, each with a reason. README, SKILL.md and AGENTS.md tables are checked against the manifest by a test. TASK-41's stale non-goal ("group/channel admin: the CLI has none") is corrected. 1.0.0 is tagged only on the operator's word.

## 6. Never added, and why (the repo's own rules)

| not added | why | instead |
| --- | --- | --- |
| mass or bulk messaging: loops over many peers, `--peers-file`, multi-destination forward/copy, `add-members` beyond the D13d cap of 20 per call, `hideAllJoinRequests`, `joinChatlist` | AGENTS.md: "a burst of outbound messages from a user account is what earns a report and a ban"; the 5/run and 20/day caps are not raised (D13); D13d capped `add-members` at 20 for the same reason | TASK-25 outreach queue (human review, drip within caps, human-invoked) or drafts (0.9) that a human sends |
| any write reachable from an unattended path: auto-reply, auto-react, update handlers, timers | eval-30/31 make "a cron job cannot message anyone" a fact; `disableUpdates: true` is deliberate | none; keep tg pull-based |
| automation Telegram runs on the account's behalf: business away/greeting/quick replies, `messages.sendQuickReplyMessages`, connected bots (`account.updateConnectedBot` hands every chat to a third party) | same burst shape with tg out of the loop, no cap can apply | the operator sets these in the Telegram app |
| account takeover or lockout: 2FA set/change/remove (6 methods), `account.changePhone`, `account.deleteAccount`, `account.setAccountTTL`, `account.setAuthorizationTTL`, `account.invalidateSignInCodes`, `auth.resetAuthorizations` | AGENTS.md: only a human creates a session; never move or print one; D3: each workspace owns its own auth key, and resetting all sessions kills sibling workspaces | Telegram app, by the operator |
| money: all Stars and gift spending or transfer (9 gift methods, `getStarGiftWithdrawalUrl`, `sendPaidReaction`, pre-checkout answers) | caps bound messages, not money; there is no spend ledger or limit in the fence | read-only Stars and gift views (0.8) |
| presence and read-receipt leaks with no operator use: `setTyping`/`sendTyping`, `setOnline`/`sendOnline`, marking stories viewed | D13a: a read receipt tells the other party a human is awake, and an unattended run leaks that | none |
| harassment-shaped: `messages.report`, `messages.reportSpam`, `account.reportPeer`, `channels.reportSpam`, `deleteUserHistory`, `getNearbyChats` | irreversible effects on third parties, or location privacy; no operator workflow justifies an agent doing them | Telegram app |
| third-party code or actions as the operator: `openWebview`/`closeWebview` (mini apps); `getCallbackAnswer`, inline-bot sends deferred | cannot be audited or bounded; a button press can buy something | defer until asked |
| irreversible lifecycle without a guard: `deleteGroup` (fenced by D13e, never called), `messages.migrateChat`, `channels.convertToGigagroup`, `setGlobalTtl` | D13c Tier 3 and D13d "not added"; TTL and deletion destroy history this tool archives | `deleteChannel` already covers owner-only deletion; others only after a decision |
| more phone-book enumeration than `check-phones` already does: `contacts.getSaved`, `contacts.resetSaved`, `resolvePhoneNumber` | third parties' phone numbers and flood limits | existing `check-phones` |

## 7. Relationship to other tasks

- TASK-25 (outreach queue) stays the only sanctioned shape for contacting strangers; 0.9 drafts are its safest approval surface. Its `run` must remain human-invoked (eval-30).
- TASK-26 (search over the archive): complementary to 0.8's live `search`; settle the name together.
- TASK-37 (exclusion list), TASK-40 (non-interactive folder tracking): the 0.9 folder verbs and the archive-first guard read the same config; coordinate so a folder edit and the tracked-folder list cannot disagree silently.
- TASK-41 (tgTUI): every fenced function added here becomes a TUI action with no new RPC path (its Phase 2 pattern).
- TASK-39 (chat-state units): the cost rubric in section 4 generalises its outcome.

## 8. Open questions for the operator

1. Is the new TTY-only guard class acceptable, or should those verbs use `--yes` like the rest? And should it be retrofitted onto 0.7.0's `promote` in 0.11 as written, or earlier, since promote ships before the class exists?
2. Are the new per-run person-directed counter and per-day join counter in `gate.ts` acceptable, or should they fold into the existing caps?
3. Split `src/send/index.ts` by area (fence becomes a directory), or keep one file?
4. Do business automation and session revocation stay out for good, or is a decision wanted?
5. Is 0.13 (publish and extend) wanted at all, or does the roadmap stop at 1.0 after 0.12?
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 All phases after 0.7.0: before any code for a phase starts, the operator confirms that phase's scope and its defer/never entries, and the phase becomes its own backlog task
- [ ] #2 All phases: each phase ships README command tables, skill/SKILL.md and the AGENTS.md layout table, bumps the version literal in src/index.ts and package.json together (eval-72), and is released by tag through publish.yml with typecheck, lint, test and build green
- [ ] #3 All write phases: the phase's decision record (D13 pattern: Decision, Why gated, Cost model, RPCs added, Safeguards, Exit codes and shapes, Explicitly out of scope, Not decided) is committed with the code; no phase raises TG_MAX_SENDS_PER_RUN or TG_MAX_SENDS_PER_DAY or weakens eval-30 and eval-31
- [ ] #4 All write phases: every RPC is added to WRITE_RPCS or WRITE_TL_METHODS, lives only in src/send/index.ts, is tripwire-verified (inject a call elsewhere, eval-29 fails), and is tested with a mocked client and no network; new evals continue after the highest existing number
- [ ] #5 0.7.0 (in progress on a separate worktree, tracked here only for coverage): decision D13e covers group members, ban, unban, restrict, promote and demote; banChatMember, unbanChatMember, restrictChatMember and editAdminRights are in WRITE_RPCS; the release is tagged as 0.7.0 and this task's counts (47 of 217 covered after 0.7.0) are re-checked against the verbs that actually shipped
- [ ] #6 0.8: decision D13f is recorded and the raw-call tripwire fails the suite when a raw TL literal with a non-listed method appears outside src/send/, with READ_TL_METHODS as the only way for a raw read to pass
- [ ] #7 0.8: an alias tripwire fails the suite when a WRITE_RPCS name is destructured or bracket-accessed outside the allowlist, and eval-31 is derived (command files and read modules such as groups/index.ts) so a new file that is neither allowlisted nor on the unattended list fails until classified
- [ ] #8 0.8: a coverage manifest classifies every TelegramClient method in the installed mtcute (covered, planned:phase, defer, never, excluded:reason) and a test fails on any unclassified method after an mtcute upgrade
- [ ] #9 0.8: chat info, chat log, group member, msg get, link and thread, dump --topic and --thread, search (chat, global, hashtag, posts), user info, contacts list, dialogs show, draft list, scheduled list and reactions show ship as read verbs with --json, golden-tested rendering, and exit codes 2 for zero results, 3 for CHAT_ADMIN_REQUIRED and 6 for upstream
- [ ] #10 0.8: every new list read iterates through one shared paced helper generalised from src/messages/fetch.ts, and no second unthrottled iterator exists
- [ ] #11 0.8: account me, sessions, privacy, notify, blocked, ttl and channels use only the nine raw reads in READ_TL_METHODS, and the live search verb name is settled with TASK-26 before release
- [ ] #12 0.8: the decision on splitting src/send/index.ts by area (fence as a directory versus one file) is recorded before 0.10 starts
- [ ] #13 0.8.x: stories, stickers, boosts, stars, gifts and business-link reads ship as patch releases with no decision record, and the stories reads never call incrementStoriesViews or readStories
- [ ] #14 0.9: decision D13g is recorded for drafts, folders, contacts, block and reaction-read marks; importContacts and deleteContacts move from src/contacts/import.ts into src/send/ and the contacts/import.ts entry leaves WRITE_ALLOWLIST with eval-29 green
- [ ] #15 0.9: draft set refuses to overwrite an existing draft without --replace, never logs text and never clears all drafts; the audit line records the new kind with size only
- [ ] #16 0.9: folder create, edit, delete, order, add-chat and remove-chat require a numeric folder id, warn on stderr when the folder is in trackedFolderIds, and show name and chat count before delete
- [ ] #17 0.9: contacts add, note, rm, block, unblock and close-friends name the person in the prompt, take numeric ids, cap rm at 20 ids per call, and exit 3 when run unattended without --yes; all of 0.9 costs 0 units and still writes one audit line per attempt
- [ ] #18 0.10: decision D13h is recorded; sendCopy, sendCopyGroup, sendMediaGroup, pinMessage, unpinMessage, unpinAllMessages, sendReaction, closePoll, sendVote, sendScheduled and deleteScheduledMessages are in WRITE_RPCS
- [ ] #19 0.10: send text gains --reply-to, --comment-to, --quote, --silent, --no-preview, --parse and --schedule; a scheduled message is charged its unit when scheduled and the schedule horizon is capped
- [ ] #20 0.10: send album costs one unit per item and is refused above the caps with a usage error; send copy costs one unit per message id, logs fromPeerId, names both chats in the prompt, states there is no forwarded-from header, and is refused for protected-content chats
- [ ] #21 0.10: send react costs one unit; pin-message and unpin-message cost 0; poll vote and poll close state irreversibility in the prompt; a CLI-shape test asserts no send verb accepts more than one destination peer
- [ ] #22 0.11: decision D13i is recorded; setChatDefaultPermissions, joinChat, leaveChat, hideJoinRequest, revokeInviteLink, deleteChatPhoto, deleteHistory, reorderPinnedForumTopics, deleteForumTopicHistory, updateForumSettings and toggleGeneralTopicHidden are in WRITE_RPCS, setChatTtl (already fenced by D13e) is called for the first time, and the four raw channel and reaction RPCs are in WRITE_TL_METHODS
- [ ] #23 0.11: a per-run counter for person-directed verbs (ban, unban, restrict, promote, demote, kick-member, add-members) and a per-day join cap read from the audit log exist in gate.ts, are documented in AGENTS.md as do-not-raise, and hideJoinRequest names the person and the chat in its prompt
- [ ] #24 0.11: the TTY-only guard class exists and promote (retrofit from 0.7.0), delete-history, ttl and topic-delete-history exit 3 on a non-interactive run even with --yes; promote prints before and after rights and refuses to grant addAdmins without --allow-add-admins
- [ ] #25 0.11: delete-history and ttl refuse with exit 2 unless the chat is untracked, excluded, or fully synced to its latest message; the refusal names which condition failed
- [ ] #26 0.11: hideAllJoinRequests, joinChatlist and deleteUserHistory are absent from src and from WRITE_RPCS and deleteGroup stays fenced but uncalled, asserted by a test, and every new Telegram error maps to a readable message and an exit code with one test per mapping
- [ ] #27 0.12: decision D13j is recorded for updateProfile, setMyUsername, setMyProfilePhoto, deleteProfilePhotos, setMyBirthday, setEmojiStatus, hideMyStoriesViews, account.setPrivacy and account.setGlobalPrivacySettings
- [ ] #28 0.12: setMyUsername states that the old handle returns to the pool at once; account privacy set prints current and new rules, takes numeric ids, and any widening change is TTY-only
- [ ] #29 0.12: the session revocation question is decided in writing; if built, it revokes one session by hash, refuses the current session, prints the device label and is TTY-only, and auth.resetAuthorizations stays absent
- [ ] #30 0.12: a test asserts the 2FA methods, account.changePhone, account.deleteAccount, account.setAccountTTL, setOnline and sendOnline appear nowhere in src
- [ ] #31 0.13: only if the operator asks: decision D13k covers stories, own sticker sets, bot info, applyBoost, pinned gifts and the business profile; story posting costs one unit and names the audience, sticker verbs check ownership through getMyStickerSets first, and business away, greeting, quick-reply and connected-bot RPCs stay absent
- [ ] #32 1.0: the manifest has no planned entry left, README, SKILL.md and AGENTS.md command tables are checked against it by a test, TASK-41's stale group-admin non-goal is corrected, and 1.0.0 is tagged only on the operator's word
<!-- AC:END -->
