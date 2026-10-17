# D13f — core reads and fence hardening

Date: 2026-10-17 | Author: agent, on the operator's instruction of 2026-10-17
Status: accepted
Amends: D13c (2026-08-31), whose admission that "a raw `tg.call` twin would not be caught" is closed here; D13b (2026-08-30), whose `WRITE_TL_METHODS` gains a reading counterpart
Scope: `test/trust.test.ts` (evals 29-31, 175-181), `test/fence-scan.ts`, `test/mtcute-api.ts`, `test/coverage-manifest.ts`; the read verbs of 0.8.0 (`chat info|log`, `group member`, `msg get|link|thread|search`, `dump --topic|--thread`, `user info`, `contacts list`, `dialogs show`, `draft list`, `scheduled list`, `reactions show`, `account sessions|privacy|notify`), evals 182-200. Answers question 3 of TASK-43's section 8.

## Decision

Phase 0.8 of TASK-43 has two halves, shipped together as 0.8.0 and sharing this record. It adds no write RPC and widens nothing the account can do to other people.

1. **The fence is checked from the syntax tree and from the installed mtcute, deny by default.** What the first generation enforced with hand-kept lists and text patterns is now derived. This half is hardening only: it can make a suite fail that used to pass, never the reverse.
2. **Core reads become verbs.** Chat info and the admin log, a single member, messages by id, link and thread, live search, user info, contacts, dialogs, drafts, scheduled messages, reactions, and the account's sessions and privacy and notification settings, plus `--topic` and `--thread` on `dump`. Every one reads; none can reach `src/send/`.
3. **`src/send/index.ts` is not split in this release.** See "Question 3".

The operator answered TASK-43's open questions on 2026-10-17 with "делай как рекомендуешь"; the recommendation for question 3, recorded below, is the one this release follows.

## Fence hardening

All four checks live in `test/trust.test.ts`. Their scanners are in `test/fence-scan.ts`, which parses each file of `src/` with the TypeScript compiler API (no type-check, so it is fast), and each eval runs a scanner on synthetic files first, then on the real tree, then on the real tree with a violation injected next to it (the D14 tripwire check). Reading the syntax tree instead of the text is what makes them immune to a comment that mentions a method, a string that looks like a call, a regex literal, and a quote style.

### 1. Raw-call tripwire (eval-175)

D13b put `messages.toggleDialogPin` and `account.updateNotifySettings` on `WRITE_TL_METHODS` and D13c admitted the rest: a raw `tg.call({ _: 'messages.sendMessage' })` anywhere outside `src/send/` passed every test, because nobody had listed that method. The rule now runs the other way.

- Outside `src/send/`, a `.call(...)` (also `['call'](...)`, `tg._client.call(...)`) passes only if its first argument is an object literal whose `_` is a string literal that is on `READ_TL_METHODS`. A variable, a spread or a computed `_` is refused on its own: a call that cannot be read cannot be fenced.
- Any object literal outside `src/send/` that writes out an RPC method name (`_: 'messages.sendMessage'`) is refused unless it is a listed read, even if it is only built there and passed in later. Which names are methods and which are constructors (`inputPeerEmpty`, which a read needs to describe its question) is read from the TL schema bundled with mtcute, not from a naming convention.
- `const { call } = tg` is refused: it hides every later raw call from the scan.
- Inside `src/send/` a raw call must still be listed, as a write or a read. eval-29b only checked the positive direction (a listed method appears), so an unlisted raw write in the one file allowed to write was invisible.
- `READ_TL_METHODS` and `WRITE_TL_METHODS` must name real methods of the installed TL schema (a typo fences nothing), and every entry of `READ_TL_METHODS` must be a `get*` method, so a write cannot be put on the list by mistake.

### 2. Alias tripwire (eval-176)

eval-29 matches `.sendText(`. These are the other ways to hold the same method, refused outside the allowlisted files: `tg.sendText` that is not called (taken, passed, bound), `tg['sendText']`, `const { sendText } = tg` and `{ sendText: post }`, `Reflect.get(tg, 'sendText')` and `'sendText' in tg`, and an indexing of the client with a name that is not a literal (`tg[method](...)`). Plain calls stay eval-29's job, so no violation is reported twice. Two TL flag names share a spelling with a fenced method (`deleteMessages`, an admin right; `sendMedia`, a restriction); property access on something named rights, permissions or restrictions, and a bare string, are not aliases.

### 3. eval-31, derived from the module graph

The old eval-31 listed five entry points by hand, so a new read verb was checked only if somebody remembered to add it. Now:

- Every file under `src/cli/commands/` is classified in `COMMAND_CLASS` (write, legacy-write, unattended, read, plumbing). A command file in no class fails the suite until somebody decides what it is.
- The write class is exactly the command files on `WRITE_ALLOWLIST`, and `legacy-write` is exactly the commands that import `src/contacts/import.ts` (`check-phones`, D13's older exception).
- The set of files whose import closure reaches `src/send/index.ts` or `src/send/gate.ts` must equal five named files: `index.ts` (the registration root), `cli/commands/send.ts`, `cli/commands/group.ts`, `send/gate.ts` and `send/index.ts`. Every other file in `src/`, including every read module, today's and tomorrow's, cannot. `group.ts` mixes reads and writes, so its reads are checked through the read module they import, which this rule covers like any other file.
- The walk is built from the syntax tree, so a side-effect import (`import '../send/gate.js'`), `export * from`, a dynamic `import('...')` and `require` are edges (eval-177), and a dynamic import whose argument is not a literal fails the suite instead of being skipped. The text pattern it replaces saw only `from '...'`. eval-30 and eval-32 use the same walk.

### 4. Coverage manifest (evals 178-180)

`test/coverage-manifest.ts` classifies every method of mtcute's `TelegramClient` and a curated set of raw TL methods, as TASK-43 planned: `covered`, `planned:<release>`, `defer`, `never`, `excluded:<reason>`.

- The method names are read from the installed `@mtcute/core` declaration (`highlevel/client.d.ts`) and the RPC methods from the TL schema bundled with it. A method mtcute adds that is not in the manifest fails eval-178, so an upgrade cannot widen what the account can do without somebody deciding what the new method is; a method mtcute removes fails it too, so the manifest cannot rot. A test shows the deny-by-default by adding a fictitious method.
- The manifest has a second axis that TASK-43 did not ask for, and it is what lets it do fence work: each entry is `read`, `write` or `session` (the login lifecycle). eval-179 then holds the manifest and the code to each other: a method marked covered is called from `src/` (or its `iter*` twin is); outside the allowlisted files only reads and the login lifecycle are called; a write that is called anywhere is on `WRITE_RPCS` (or is one of the two older `check-phones` calls, `importContacts` and `deleteContacts`, which 0.9 moves into `src/send/`). That closes a hole eval-29 could not: a write method nobody had put on `WRITE_RPCS`, called from any file, was invisible.
- eval-180: a `never` method is called nowhere, and the raw TL methods written out in `src/` are exactly the ones the raw manifest calls covered, which are exactly `READ_TL_METHODS` plus `WRITE_TL_METHODS`.
- The 307 names split into 90 excluded (12 login, 21 internal, 17 `iter*` twins, 24 variants, 16 bot-only) and 217 in scope, the denominator TASK-43 counts against. Where TASK-43's hand-made table (never 25, defer 20) and its section 6 (the reasons) disagree, section 6 won: the manifest has 29 never and 16 defer, and the totals are unchanged.

## Question 3: `src/send/index.ts` stays one file

TASK-43 asked whether to split the send module by area, which would turn the fence from "one file" into "one directory". The operator's instruction was to split it in this release only if the read verbs had to touch it, and never to mix a refactor with features.

- **They do not touch it.** Every read verb here lives in its own module under `src/` and imports nothing from `src/send/`; the one thing a read needs that lives there, the mapping of Telegram's refusals to exit codes (`friendlyTelegramError`), is not imported either: the reads get their own mapper in `src/reads/errors.ts`, so the send module is byte-for-byte unchanged by 0.8.0.
- **Answer: keep one file.** Today it is 1654 lines (TASK-43 counted 1133 before the 0.6 and 0.7 verbs) and the roadmap adds about 300 a phase. What the single file buys is that "every write RPC in this codebase is in this one file" is true of a file a reviewer can open, which is the property D13 was built around; a directory keeps the property but changes what eval-29, eval-29b, eval-31's `WRITE_CAPABLE`, the allowlist and AGENTS.md all say. Nothing in phase 0.8 or 0.9 is blocked by the size.
- **The trigger to revisit** is a phase whose review cannot be done in one sitting, or the file passing 2500 lines. If it is split, it is its own pull request that moves code and changes no behaviour, the fence becomes the prefix `send/`, and eval-29, 29b, 31, the raw tripwire (which already treats `send/` as a prefix) and AGENTS.md are updated in the same commit. TASK-43's acceptance criterion 12, which asks for this answer before 0.10 starts, is met by this record.

## The read verbs

Each verb, and what it asks Telegram. 22 client methods and 3 raw TL reads become covered: 47 of 217 in-scope methods (22%) become 69 (32%), and raw TL 2 of 37 become 5.

| verb | asks |
| --- | --- |
| `chat info <peer> [--basic]` | `getFullChat`; `getChat` only with `--basic` |
| `chat log <peer> [--type] [--user] [--query] [--limit]` | `getChatEventLog`, through `iterChatEventLog` |
| `group member <peer> <user>` | `getChatMember` |
| `msg get <peer> <ids...>` | `getMessages` |
| `msg link <url>` | `getMessageByLink` |
| `msg thread <peer> <id> [--depth]` | `getMessages`, `getReplyTo`, `getMessageGroup`, `getDiscussionMessage`, each only when the message has the thing |
| `dump <peer> --topic <id>` / `--thread <id>` | `searchMessages` with a thread, through `iterSearchMessages` |
| `msg search <query> --chat\|--global\|--hashtag\|--posts` | `searchMessages`, `searchGlobal`, `searchHashtag`, `searchPostsGlobal` |
| `user info <peer> [--basic] [--common]` | `getFullUser` (or `getUser`), `getCommonChats` |
| `contacts list [--query] [--limit]` | `getContacts` |
| `dialogs show <peers...>` | `getPeerDialogs` |
| `draft list [--scan] [--limit]` | `iterDialogs` (already covered), the draft each dialog carries |
| `scheduled list <peer> [ids...]` | `getAllScheduledMessages`, `getScheduledMessages` |
| `reactions show <peer> <id> [--users]` | `getMessageReactions`, `getReactionUsers` |
| `account sessions` / `privacy [key]` / `notify [peer]` | raw `account.getAuthorizations`, `account.getPrivacy`, `account.getNotifySettings` |

## Why these are not gated, and what keeps them that way

A read changes nothing on Telegram's side and tells nobody. In particular none of these can leak that a human is awake (D13a): none calls `readHistory`, `readReactions`, `readStories`, `incrementStoriesViews` or opens a chat, and `reactions show` and `draft list` only look. So they take no `--yes`, no confirmation and no cap, and they write no line to `data/sent.jsonl`, like `peers list` and `dump` before them.

What keeps them reads is not their authors' care but the fence: the module-graph rule (no read module reaches `src/send/`), the raw-call tripwire (the three raw methods are on `READ_TL_METHODS` and nothing else passes), the manifest's read/write axis (a read verb cannot call a method the manifest knows as a write), and eval-181 (every list is walked by the one paced walk). `test/reads-cli.test.ts` also pins that no read command file mentions `--yes`, `assertConfirmed`, `guardedSend` or the send log.

## Cost model

Zero send units and no audit line. The cost of a read is requests, and they are bounded: every verb that can be long takes `--limit` with a ceiling (`chat log` 1000, `msg search` 500, `contacts list` 5000, `reactions show --users` 1000, `draft list` 1000 and a scan of at most 2000 chats), a small limit asks for a small page, and every list goes through `paced()` in `src/messages/fetch.ts`: 1.5s plus jitter after each 100 items, the pacing `dump` has always had. `msg thread` climbs at most 20 replies, one request each. `account privacy` with no key makes one request per setting, the same ones the app makes when it opens Settings. `dialogs show` takes at most 20 chats because each is resolved first.

## RPCs added

No write RPC. Three raw reads join `READ_TL_METHODS`: `account.getAuthorizations`, `account.getPrivacy`, `account.getNotifySettings`. The other six raw reads of TASK-43's section 2 (`contacts.getBlocked`, `account.getAccountTTL`, `account.getGlobalPrivacySettings`, `messages.getPollVotes`, `channels.getAdminedPublicChannels`, `channels.getInactiveChannels`) stay `planned:0.8.1`.

## Safeguards

- **Names are resolved then shown (D17).** Every chat or person a read names goes through `resolvePeerRef`, and the identity is printed to stderr before the answer, so `--json` stays pipeable. A person where a chat is needed (`chat info` on a user) or the reverse is refused with the verb to use instead, before a request is spent. `group member` and `msg search --from` accept a handle or `me` for the person because they only read; the moderation verbs still take numeric ids only (eval-161 now says so per write).
- **No phone numbers.** `contacts list` and `user info` have no phone field. A contact's number is another person's data, `tg session phones` already masks the operator's own, and TASK-43's section 6 keeps phone-book enumeration to `check-phones` with its own pacing. `--json` cannot be used to export the address book, and a test feeds a mock with a phone number and checks it never appears.
- **No invite links.** `chat info` does not read the full profile's invite link, `chat log` reports an invite event as "an invite link" without the link, and `msg link` refuses `t.me/+...` and `t.me/joinchat/...` by name, offline: an invite link points at a join flow and nothing here joins anything.
- **No Stars.** `msg search --posts` never passes `payStars`. Telegram allows a number of free public-post searches a day; when it is used up the answer is empty with the allowance attached, and the verb exits 3 saying how many Stars Telegram wants and that tg never spends them. A test pins that the source never names the parameter.
- **No session revocation.** `account sessions` lists, and the hash it reports is for the future revoke verb TASK-43 phase 0.12 weighs; nothing here ends a session, because each workspace owns its own auth key (D3).
- **Refusals map to the contract.** `src/reads/errors.ts` turns Telegram's refusals of a read into exit codes: `CHAT_ADMIN_REQUIRED` 3; a flood, `PEER_FLOOD`, any 5xx, a timeout and a socket error 6; a private or unknown chat, user, message or topic, a user not in the chat, anonymous reactions, an empty search 2; anything it does not name stays a bug with its stack. It is separate from the send module's table on purpose (a read cannot import it, eval-31), and the older group reads (`members`, `invite-list`, `invite-members`, `topic-list`) and `dump` use it too now.

## Decisions inside the reads

- **The live search is `tg msg search`, and `tg search` stays TASK-26's.** TASK-43 asked to settle the collision before release. The archive search reads Markdown files and needs no session, no network and no credential; the live one asks Telegram, costs requests and finds what was never archived. Two trust classes should not share a verb with a flag between them, and TASK-26 named `tg search` first. Scope is required (`--chat`, `--global`, `--hashtag` or `--posts`, exactly one): `searchMessages` with no chat silently covers only private chats and small groups.
- **Zero results.** A lookup or a search that finds nothing is exit 2, as AGENTS.md says of a needle that matched nothing (`msg get` for ids that are not there, `msg search` with no hits, `group member` for someone who is not in the chat, `reactions show` for a message that does not exist). A listing that is legitimately empty (`draft list`, `scheduled list`, `contacts list`, `chat log`) says so and exits 0, as every shipped listing does (eval-137); a consumer asking "do I have drafts" must not receive an error. TASK-43's acceptance criterion 9 says "2 for zero results" without that distinction; this is the reading that matches AGENTS.md's stated reason.
- **`dump --topic` and `--thread` take one flag each and are the same thing.** A forum topic is a thread whose id is its first message; giving both is a usage error.
- **`msg thread` is context, not a transcript.** It shows the message, the chain it replies to (bounded), its album and where a channel post's comments live. The replies below are `dump --thread`, which pages through the paced walk.
- **`dialogs show` and `draft list` read the chat list as Telegram keeps it.** `draft list` looks through the 200 most recent chats unless told otherwise, archived chats included (mtcute leaves them out of a dialog walk by default, and a forgotten draft is exactly what lives in an archived chat), and says it is a scan: a draft in a chat older than that is not found.
- **`peers/index.ts` is a named exception to the paced walk.** It walks dialogs directly, predates the helper and is bounded by `--limit`; pacing it would add 1.5s per hundred dialogs to every `peers find`. eval-181 names it so it cannot be copied.

## What building it showed about TASK-43

TASK-43 was written from the type declarations; reading the implementations found five things it could not know. They are recorded because the next phases lean on the same methods.

1. **`getHistory` has no thread parameter in mtcute 0.27.8**, so "`dump --topic` needs no new method (`replyTo` through the single fetch iterator)" does not hold. A thread is read through `searchMessages` with `threadId` and an empty query, which Telegram answers with exactly that thread, newest first. It is still one paced walk (`fetchMessages` picks the source), and it covers `searchMessages`, which TASK-43 already counted.
2. **`iterReactionUsers` never ends.** When the last page has no next offset it starts again from the first and yields the same people until `limit`, so a message with two reactors read with `--users --limit 100` would list them fifty times. `reactions show` pages `getReactionUsers` by hand and stops when Telegram gives no next page; eval-196b pins it with a mock that would repeat forever.
3. **`iterDialogs` skips archived chats by default**; `draft list` passes `archived: 'keep'`.
4. **`FullChat.membersCount` reads 0 for a basic group**, so `chat info` falls back to the count on the chat object when the full profile's is empty, and reports null when Telegram gives none.
5. **Section 6 and the hand-made count disagree.** The table says never 25 and defer 20; section 6 lists reasons that make 29 and 16 (`getNearbyChats`, `deleteGroup`, `setGlobalTtl` and `resolvePhoneNumber` are "not added" there but counted as deferred in the table). The manifest follows section 6, the policy. The total in scope (217), the covered count (47) and every phase size (62, 11, 11, 12, 7, 22) came out exactly as TASK-43 computed them.

## Exit codes and shapes

| situation | exit | where it shows |
| --- | --- | --- |
| a bad id, limit, date, filter, scope, link or setting name; a person where a chat is needed | 2 | the standard failure envelope, before a session is opened |
| a lookup or search that finds nothing; a missing chat, user, message or topic; reactions in a broadcast channel | 2 | the envelope, saying what was not found |
| `CHAT_ADMIN_REQUIRED` (admin log, a member of a channel, scheduled messages) | 3 | the envelope; a human must grant the right |
| `msg search --posts` with the free allowance used up | 3 | the envelope, with the allowance and the Stars Telegram wants |
| `FLOOD_WAIT`, `PEER_FLOOD`, a Telegram 5xx, a timeout, a socket error | 6 | the envelope; retry with backoff |
| an empty listing | 0 | `[]` with `--json`, a sentence otherwise |

Successful `--json` output is the bare payload: an array for lists (`contacts list`, `draft list`, `chat log`, `account privacy`, `account notify`); an object for one thing (`chat info`, `user info`, `group member`, `reactions show`, `msg thread`, `account sessions`); `{chatId, messages, missing}` where some ids may be absent (`msg get`, `scheduled list`); `{dialogs, missing}` for `dialogs show`; and `{scope, query, messages, quota?}` for search.

## Explicitly out of scope

Phase 0.8's other verbs, shipped as 0.8.1 and later without a decision record because they only read: `chat preview`, `chat similar`, `msg preview`, `msg translate` and the fact check, `user photos`, `group invite-show`, `folders show` and `folders preview`, `account me`, `blocked`, `ttl` and `channels` with the remaining raw reads, `poll voters`, and the long tail (stories, stickers, boosts, Stars, gifts, business links, saved music). Every write remains where TASK-43 put it, behind its own record.

## Not decided

- Whether `peers list` should be paced after all. It would make `peers find` slower for a protection nobody has asked for; revisit if `peers` ever pages beyond its default `--limit`.
- Whether a listing that is empty should ever be exit 2. This record says no; the operator can overrule it with one line in AGENTS.md and one test.
- Whether `msg search --posts` should grow an opt-in to spend Stars. It would be a money decision with its own record and a spend ledger; section 6 keeps money out until then.

## Release

Ships as 0.8.0, a minor: it adds verbs and tightens tests, and it adds no write RPC, so `WRITE_RPCS`, `WRITE_TL_METHODS` and `WRITE_ALLOWLIST` are unchanged.

## Limits, said plainly

The fence still matches syntax, not semantics. A method name assembled at run time (`tg['send' + 'Text']`), `eval`, `Function(...)` and code loaded from outside `src/` are not caught by anything short of running the code. The dynamic-lookup rule makes the common spelling of that (`tg[name]`) a failure of its own; the rest is the review that D13 already relies on.
