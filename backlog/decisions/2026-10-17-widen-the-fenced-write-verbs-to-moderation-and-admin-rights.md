# D13e — widen the fenced write verbs to moderation and admin rights

Date: 2026-10-17 | Author: agent, on the operator's instruction of 2026-10-17
Status: accepted
Amends: D13d (2026-10-05)
Scope: `tg group members`, `ban`, `unban`, `restrict`, `promote`, `demote`; `src/send/index.ts`, `src/groups/`, `SentRecord` (`targetUserId`, `detail`); evals 29, 150-163.

## Decision

D13d added add, kick and delete and kept ban, unban, restrict and admin rights
out "without their own decision record". The operator asked for them on
2026-10-17 ("release with groups, with the administrator functionality"). This is
that record.

- Added to `WRITE_RPCS` and called only from `src/send/index.ts`: `banChatMember`,
  `unbanChatMember`, `restrictChatMember`, `editAdminRights` (mtcute high-level
  methods, so the call-site fence catches them).
- Added as reads, ungated, in `src/groups/index.ts`: `tg group members <peer>`
  (id, name, @handle, role, custom title and admin rights; `--type`, `--query`,
  `--limit`, `--json`). `src/groups/` still imports nothing from `src/send/`
  (eval-136), and eval-31 now walks its import graph.
- NOT added, still needing their own record: `deleteGroup`, chat migration,
  `setChatTtl`. The first and last are in `WRITE_RPCS` anyway as fenced-but-unshipped
  names (eval-163 pins that nothing calls them), so a write to them outside
  `src/send/` fails the suite before it ships. Ownership transfer does not exist
  here at all: mtcute has no high-level method and nothing in this tool calls the
  raw TL one.

| verb | mtcute method | units |
| --- | --- | --- |
| `members <peer>` | `getChatMembers`, a READ | none |
| `ban <peer> <ids...> [--until]` | `banChatMember` | 0 |
| `unban <peer> <ids...>` | `unbanChatMember` | 0 |
| `restrict <peer> <id> --deny a,b [--until]` | `restrictChatMember` | 0 |
| `promote <peer> <id> --rights a,b [--rank]` | `editAdminRights` | 0 |
| `demote <peer> <id>` | `editAdminRights` with empty rights | 0 |

Every write takes the whole fence unchanged: numeric peer id, the confirmation
gate, `guardedSend`, a line in `data/sent.jsonl`. `src/cli/commands/group.ts` is
already on `WRITE_ALLOWLIST` from D13c, so no new allowlist entry was needed.

## Safeguards (D13d's, plus what this batch adds)

- **The prompt names the person**, resolved to name, handle and numeric id, for
  every person in the batch, plus the chat. It says what the action does: a ban
  cannot be undone in the eyes of everyone who watched it; `unban` does not add
  anyone back; `promote` replaces whatever rights the person had; `add-admins` in
  the list prints a warning that the person can appoint further admins.
- **People are positive numeric ids only.** A handle is refused (`@durov` and
  `@durvo` are different people, and here the typo bans one). A negative id is a
  chat or channel, never somebody to ban or promote, and is refused too. The send
  module enforces both, so a library caller cannot skip the command layer.
- **At most 20 people per call**, de-duplicated, refused as a usage error before
  any network. **One RPC per person, one audit line each.** The line carries the
  new `targetUserId` (the person; `peerId` is the chat) and `detail` (what was
  set: `until=...`, `deny=...`, `rights=... rank=...`, never message content). A
  chat with forty `ban-member` lines now says whether that was forty people or one
  person forty times. D13d's `add-member` and `kick-member` lines now record
  `targetUserId` too; they did not before.
- **A wall stops the batch.** A flood signal, a missing admin right, an unknown
  chat or "too many admins" halts a batch: nothing is retried, nothing sleeps, and
  the people not yet reached come back as `skipped`. A refusal about one person
  (they are an admin this account may not change, they are not a member, they are
  the creator) is theirs alone and the batch goes on.
- **Unattended without `--yes` exits 3**, before any session is opened, as for
  every write (eval-159, and eval-162 through the real CLI).
- **Only supergroups and channels.** A legacy group has no ban, no restriction
  and no admin rights in Telegram's model: mtcute's ban there is a plain removal
  and its unban a no-op, so reporting "banned" would be a lie. The verbs refuse
  such a chat from the id alone (marked ids below -10^12), with no round trip,
  and point at `kick-member`. A private chat is refused the same way.
- **`--until` is checked against Telegram's window.** An end date under 30
  seconds ahead or over 366 days out is read by Telegram as FOREVER, and mtcute's
  seconds field wraps in 2038, which also means forever. `Date.parse("5")` is the
  year 2001, so a short ban would silently become permanent. Anything outside the
  window is a usage error ("omit `--until` if you mean forever"). Forever is the
  absence of the flag.
- **`restrict` names the restrictions** with `--deny a,b` (19 names, one per TL
  flag). Telegram's sense is passed through untranslated: true means DISALLOWED.
  An empty list is refused and points at `unban`, which lifts restrictions;
  `view-messages` is refused and points at `ban`, because restricting that is a
  ban. The names are checked with `hasOwn`, so `--deny __proto__` is a usage error
  rather than an inherited-member lookup. The flag is one comma-separated list and
  not a `--no-send-messages` per right: commander reads a `--no-x` flag as the
  negation of `x`, so those options would default to true in the parsed object and
  mean the opposite of what they say, and getting the sense of a restriction
  backwards silently grants what the operator meant to remove.
- **`promote` lists rights explicitly.** There is no `all`: `all`, `*`,
  `everything`, `full`, `owner`, `creator`, `founder` and `transfer` are refused,
  and so is a list that names every one of the 16 rights, which is the same grant
  spelled out. The guard is against the shortcut, not against an operator who
  wants a near-full admin and says so by leaving one right out. An empty list is
  refused and points at `demote`. `--rank` is 1-16 visible characters (Telegram's
  limit). `demote` is empty rights, and the person stays a member.
- **Telegram's refusals map to the repo's exit codes:** `CHAT_ADMIN_REQUIRED`,
  `RIGHT_FORBIDDEN`, `USER_ADMIN_INVALID` and `ADMINS_TOO_MUCH` are 3 (a human
  must grant or decide); `USER_CREATOR`, `USER_NOT_PARTICIPANT`, `USER_ID_INVALID`,
  `PARTICIPANT_ID_INVALID`, `CHANNEL_INVALID`, `CHANNEL_PRIVATE`,
  `ADMIN_RANK_INVALID` are 2; `FLOOD_WAIT` and `PEER_FLOOD` are 6. An error not on
  the list stays exit 1 with its stack, as everywhere else.
- **Zero cap units, as in D13c and D13d**: none of these delivers a message. The
  record carries `units: 0`. The backstops are the 20-person cap, stop-on-wall,
  the audit line per person and Telegram's own flood limits.

## Exit codes and shapes

`ban` and `unban` print, with `--json`, `{ok, banned|unbanned: [ids], failed:
[{user, reason, message, exit}]}`. Reasons: `flood`, `not_admin`,
`target_is_admin`, `target_is_creator`, `not_member`, `invalid_user`,
`invalid_chat`, `too_many_admins`, `invalid_rank`, `skipped`, `other`.

This deliberately differs from `add-members`, which exits 0 on partial failure
because a privacy refusal there is routine. A refusal in a moderation action is
never routine, so the process exits 0 only when everything was done, and
otherwise with the code of the FIRST refusal, after printing the per-person
result (and an `error` object, `{code, exit, message}`, in the same document).
`restrict`, `promote` and `demote` act on one person and fail the usual way: an
`OperatorError` with the mapped code and, with `--json`, the standard failure
envelope. Each success prints the audit record.

## Why `--deny` and not the mtcute spelling, and what was taken from the old branch

`origin/wip/d13d-membership-2026-09-01` was an older parallel attempt at D13d,
saved unmerged on 2026-10-17. Its add-member and remove-member code duplicates
what 0.6.0 shipped and was not taken. Ported and hardened from it: the member
listing, the ban/unban/restrict verbs, the `--deny` vocabulary and `hasOwn` check,
the `--until` window, and the idea of recording the target person in the audit
line. Changed from it: `view-messages` is not a restriction, a missing `--deny`
is refused rather than lifting everything, a legacy group is refused rather than
pretended, and the audit field is one id per line because each RPC is one person.

## Not covered, on purpose

- `promote` replaces rights and does not read the current ones first, so it can
  narrow what a person had. The prompt says it replaces; `members --type admins`
  shows what is held before and after.
- `add-admins` is one escalation step the fence cannot make safe. It is allowed
  when named, and its prompt says what it means.
- The fence still matches call syntax, not semantics (D13c): an indirect call or
  a raw TL twin of these four methods would not be caught.

## Release

Ships as 0.7.0. `npm version` now keeps the version literal in `src/index.ts` in
step with `package.json` (a `version` script), so a release is `npm version minor`
and a tag push, and eval-72 cannot be tripped by a bump.
