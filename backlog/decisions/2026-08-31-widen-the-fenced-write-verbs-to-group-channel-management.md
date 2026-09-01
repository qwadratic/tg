# D13c — widen the fenced write verbs to group/channel management

Date: 2026-08-31 | Author: agent
Status: accepted
Amends: D13 (2026-08-17), D13a (2026-08-19), D13b (2026-08-30)
Scope: `tg group`, `src/groups/`, dump engagement fields, evals 29, 29b, 30, 31,
131-140.

## Decision

`tg group` is added as a new top-level command group holding Tier 1 chat
administration: creation, identity (title, description, photo, colour, sticker
set, public username), invite links, forum topics, and the four chat settings
(slow mode, content protection, join requests, join-to-send).

Every write among them goes through the existing fence unchanged — numeric peer
id (`assertPeerId`), the confirmation gate (`assertConfirmed`, skippable only by
an explicit `--yes`), `guardedSend`, and a line in `data/sent.jsonl`. The RPCs
themselves live in `src/send/index.ts` and nowhere else; `src/cli/commands/group.ts`
joins the `WRITE_ALLOWLIST` because it names those imported functions.

Three verbs (`invite-list`, `invite-members`, `topic-list`) are reads and are NOT
gated. They live in `src/groups/index.ts`, which does not import `src/send/`, so
a future read verb can list a forum without linking the code that can write.

## Why these are gated at all

D13b fenced the chat-state seven (archive, pin, mute, unread) even though none of
them is visible to a counterparty, on the principle that "every write RPC is
here" is the property that makes the module reviewable.

This batch is not that. These writes are visible to **every member of the chat**,
and two of them cannot be undone:

- `invite-export` regenerates the primary invite link, which revokes the old one.
  Every copy already pasted into a message or a README stops working, and there
  is no way to put it back.
- `remove-username` (`setChatUsername(chat, null)`) releases the handle into the
  global pool immediately. A stranger can claim it seconds later, and then owns
  a plausible impersonation of the chat.

A renamed channel, a changed avatar or a wiped description also produce a service
message in the chat, so an unattended run "tidying up" is something the members
watch happen. That is exactly the class of action the `--yes` gate exists for.

## Cost model: zero units, deliberately

All of these call `guardedSend` with `units: 0`. The D13b seven do NOT: they omit
the `extra` argument, so `gate.ts` defaults them to `units: 1`. That is a known
defect, filed as TASK-39 and still unfixed; this batch does not change it. So
today `tg send archive` spends send budget while `tg group title` does not. The caps
(`MAX_SENDS_PER_RUN`, `MAX_SENDS_PER_DAY`) exist to bound DELIVERED messages,
because a burst of outbound messages from a user account is what earns a report.
None of these delivers a message. Charging them budget would mean a legitimate
setup session — create a supergroup, set a title, a photo, a description and an
invite link — exhausts the run cap and blocks a genuine send afterwards, for no
safety gained. The audit log still records all of them, which is the part that
matters for an action nobody can take back.

Chat creation has no target peer at the time of the call, so it logs `peerId: 0`
and reports the id of the chat that came into existence in `messageId`.

Because `units: 0` can never trip `assertUnderCaps`, group writes are effectively
uncapped: the only remaining backstop against a runaway loop is Telegram's own
`FLOOD_WAIT`, plus the audit log after the fact. That is accepted deliberately -
these deliver no messages - but it is the cost of the choice, not an oversight.

## mtcute methods added to WRITE_RPCS

All high-level, so `test/trust.test.ts` catches them with the existing call-site
regex; none needed the raw-TL literal list that pin/mute required:

```
createGroup            createChannel            createSupergroup
setChatTitle           setChatDescription       setChatPhoto
setChatColor           setChatStickerSet        setChatUsername
exportInviteLink       createInviteLink         editInviteLink
createForumTopic       editForumTopic           toggleForumTopicClosed
toggleForumTopicPinned setSlowMode              toggleContentProtection
toggleJoinRequests     toggleJoinToSend
```

The fence matches call SYNTAX, not semantics, and always has: it looks for
`.methodName(` and for raw TL method-name string literals. An indirect call
(`const { setChatTitle } = tg`) or a raw `tg.call({_: 'channels.editTitle'})`
twin of a high-level method would not be caught. That gap is pre-existing, not
introduced here - but this change widens the fenced surface twentyfold, so the
limit is worth writing down rather than leaving implied. Adding the raw-TL twins
to `WRITE_TL_METHODS` is not the fix: eval-29b requires every listed method to
actually appear in `send/index.ts`, and these do not.

`setChatColor` takes Telegram's palette **index** (0-6 built in, higher ids from
`help.getAppConfig`), not an RGB value. It is exposed exactly as mtcute spells
it; inventing a friendly palette here would go stale the first time Telegram adds
a colour, and would silently mean a different colour than the operator asked for.

## Explicitly out of scope

Not implemented, and not to be added without their own decision record:

- **Tier 2, membership**: `addChatMembers`, `kickChatMember`, `banChatMember`,
  `unbanChatMember`, `restrictChatMember`. These act on a PERSON rather than on
  a chat's settings, and a wrong peer id here throws someone out of a group
  rather than renaming it. They need their own confirmation wording (the person,
  not the chat) before they are safe to ship.
- **Tier 3, rights and destruction**: `editAdminRights`, chat migration via raw
  TL, the `delete*` family, `setChatTtl`. Handing out admin rights is a privilege
  escalation performed by an agent; deletion and TTL destroy history that this
  tool exists to archive.

## Also in this change (not a fence question)

`tg dump` now surfaces the engagement fields mtcute already exposes on messages
it has fetched — views, forwards, the three loudest reactions, reply/comment
count, and whether the message was edited — as one short suffix per line, and
only when present. Pure read-side formatting: no RPC, no new fetch.
