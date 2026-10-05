# D13d — widen the fenced write verbs to membership and owner-only deletion

Date: 2026-10-05 | Author: agent, on the operator's instruction of 2026-10-05
Status: accepted
Amends: D13c (2026-08-31)
Scope: `tg group add-members`, `kick-member`, `delete`; the `--topic` flag on `tg send text` and `tg send media`; evals 29, 142-149.

## Decision

D13c left Tier 2 (membership) and Tier 3 (destruction) out "without their own
decision record". The operator asked for add, kick and delete on 2026-10-05. This
is that record, and it is narrower than the tiers it opens:

- Added: `addChatMembers`, `kickChatMember`, `deleteChannel` (mtcute high-level
  methods, so the existing call-site fence catches them; all three are in
  `WRITE_RPCS`).
- NOT added, still needing their own record: `banChatMember`, `unbanChatMember`,
  `restrictChatMember`, `editAdminRights`, chat migration, `deleteGroup`,
  `setChatTtl`.

The `--topic` flag is not a new RPC: it passes `replyTo` (a forum topic is its
top message) to the existing `sendText`/`sendMedia`.

## Safeguards that make this acceptable

- **The prompt names the person**, resolved to name, handle and id, not the chat
  alone (D13c's requirement for Tier 2). People are numeric ids only, exactly as
  `create-group` already requires: a mistyped handle must not reach a stranger.
- **`add-members` takes at most 20 users**, refused as a usage error before any
  network. One RPC per user, one audit line each. A flood signal stops the batch
  and nothing is retried or slept on. Privacy blocks point at `invite-new`.
- **`delete` only for a chat this account created**, checked with a read first;
  otherwise exit 2 and nothing is logged as a write. The confirmation says it is
  permanent. `deleteGroup` (legacy groups) is not used.
- Unattended runs without `--yes` exit 3, as for every write.
- Zero cap units, as in D13c: none delivers a message. The backstops are the
  batch cap, stop-on-flood, the ownership check and the audit log.

## Exit codes and shapes

`add-members --json` prints `{ok, added, failed:[{user, reason, message}]}` and
exits 0 on partial failure, because the command did its job and the caller must
read `failed`. Reasons: `privacy`, `not_mutual`, `flood`, `too_many_channels`,
`already_member`, `other`. Telegram refusals elsewhere map: `CHAT_ADMIN_REQUIRED`
3, `CHANNEL_FORUM_MISSING` and `TOPIC_CLOSED` 2, `FLOOD_WAIT`/`PEER_FLOOD` 6.
`--topic` on a non-forum is detected from Telegram's own refusal rather than a
pre-flight read, which would add a round trip and a race.

## Release note

package.json already said 0.7.0 on master although the last tag was v0.5.0 and
nothing between was published. The thirteen unreleased commits ship together as
0.6.0, as the operator asked; the stray 0.7.0 literal was never published.
