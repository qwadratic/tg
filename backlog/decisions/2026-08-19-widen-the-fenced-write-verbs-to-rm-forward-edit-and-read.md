# Decision — the fenced write verb set gains `rm`, `forward`, `edit` and `read`

Date: 2026-08-19 | Author: agent
Scope: `src/send/`, `src/cli/commands/send.ts`, evals 29-31, 65, 97, 100.

Amends D13 of
`backlog/decisions/2026-08-17-narrow-the-no-write-back-rule-and-build-the-missing-gates.md`.
Nothing in it is overturned; the enumerated verb list is extended, on the record.

---

## D13a — the fence now holds seven write verbs, not four

DECIDED: the fenced set is `tg send text`, `tg send media`, `tg send rm`,
`tg send forward`, `tg send edit`, `tg send read`, `tg note`, plus the read-only
`tg send log`. Every one of them lives behind the same guards D13 built: numeric
peer id, `assertConfirmed`, the per-run and per-day caps, and one audit line per
attempt.

BECAUSE the boundary D13 drew was "one fenced module, mechanically checked", not
"exactly these four verbs forever". Adding a verb inside the fence changes what
the tool can do, so it is a decision and gets written down — `rm` was added in
dc32d73 with no record at all, and that silent drift is what this amendment
exists to stop, not to repeat.

Two of the new verbs are not ordinary message sends and are called out
explicitly:

- **`forward`** is the only write with two peers. It can copy a private thread
  to a third party, so the audit record carries `fromPeerId` alongside the
  destination, and it costs ONE CAP UNIT PER MESSAGE ID — the caps bound
  delivered messages, not RPC calls. The id list is refused above 100, which is
  Telegram's own ceiling.
- **`read`** delivers no content at all, which is why it needed deciding rather
  than assuming. A read receipt tells the other party a human is awake and
  reading right now; an unattended run clearing unreads is a signal leak about
  the operator. It is gated and budgeted exactly like a send.

NOT DECIDED: anything beyond these. Reactions, pins, joins, profile edits and
contact writes stay out. The next verb needs the next amendment.
