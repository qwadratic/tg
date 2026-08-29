# Decision — the fenced write verb set gains seven chat-state verbs

Date: 2026-08-30 | Author: agent
Scope: `src/send/`, `src/cli/commands/send.ts`, evals 29, 29b, 65, 97, 100.

Amends D13 of
`backlog/decisions/2026-08-17-narrow-the-no-write-back-rule-and-build-the-missing-gates.md`
and its D13a amendment of 2026-08-19. Nothing in either is overturned; the
enumerated verb list is extended again, on the record.

---

## D13b — archive, unarchive, pin, unpin, mute, unmute and mark-unread

DECIDED: the fenced set gains `tg send archive`, `unarchive`, `pin`, `unpin`,
`mute`, `unmute` and `unread`. Each lives behind the same guards D13 built:
numeric peer id via `assertPeerId`, `assertConfirmed`, the per-run and per-day
caps, the resolved-identity confirmation, and one audit line per attempt.

BECAUSE these are the wacli verbs with no `tg` equivalent, and the fence is a
place to put writes, not a reason not to have them.

**None of the seven is visible to a counterparty.** That is the substantive
difference from every verb fenced before them, and it is worth stating plainly:

- `text`, `media`, `forward` and `edit` put new or changed content on someone
  else's screen.
- `read` sends no content but still leaks — a read receipt tells the other party
  a human is awake and reading right now. D13a fenced it for exactly that.
- `rm` removes content from someone else's screen.
- These seven change the ACCOUNT OWNER'S OWN chat list and nothing else.
  Archiving, pinning, muting and marking unread are private UI state. Nobody on
  the other side of the chat can observe any of them, ever.

They are fenced anyway. The property that makes `src/send/` reviewable is "every
write RPC in this codebase is in this one file", not "every dangerous one is". A
harmless write outside the fence still costs the reader the certainty that the
fence is complete. They log `messageId: 0` and `size: 0`, the sentinel `read`
already established for a write with no message behind it.

## The fence had to learn to read string literals

`archiveChats`, `unarchiveChats` and `markChatUnread` are ordinary named mtcute
methods and fit the existing detection: eval-29 greps for `.name(`.

`pin`/`unpin` and `mute`/`unmute` do not. This mtcute version ships NO
high-level wrapper for dialog pinning or notify settings, so they go through the
generic `tg.call({ _: 'messages.toggleDialogPin', ... })` and
`tg.call({ _: 'account.updateNotifySettings', ... })` escape hatch, with
`muteUntil: 2147483647` — Telegram's own max-int32 "mute indefinitely"
convention — and `0` to unmute.

A regex looking for `toggleDialogPin(` would have found NOTHING and silently
fenced nothing, which is the worst failure mode a mechanical check has: a green
test that checks an empty set. So `WRITE_TL_METHODS` was added beside
`WRITE_RPCS` and matched as string literals, and eval-29b asserts the positive
direction as well — each raw method must appear in `src/send/index.ts`, and in
exactly one file.

Anything added later through `tg.call()` must be added to that list too.

NOT DECIDED: anything beyond these. Reactions, joins, profile edits and contact
writes stay out. The next verb needs the next amendment.
