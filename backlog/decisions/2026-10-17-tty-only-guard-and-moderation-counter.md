# D13e-a — a TTY-only guard class and a daily moderation counter

Date: 2026-10-17 | Author: agent, on the operator's instruction of 2026-10-17
Status: accepted
Amends: D13e (2026-10-17)
Scope: `src/send/gate.ts` (`assertInteractive`, `assertConfirmed(options, { terminalOnly })`, `TTY_ONLY_KINDS`, `MODERATION_KINDS`, the moderation cap), `tg group promote`, `add-members`, `kick-member`, `ban`, `unban`, `restrict`, `demote`, `tg send log`; evals 165-174. Answers questions 1, 2, 4 and 5 of TASK-43's section 8.

## Decision

TASK-43's coverage roadmap asked the operator five open questions. On 2026-10-17
he answered "делай как рекомендуешь" to all of them. This record turns the
answers that touch 0.7.0's verbs into code (0.7.1) and records the rest.

1. **A TTY-only guard class exists and `promote` is on it, now.** The most
   dangerous writes (history deletion, chat auto-delete and admin rights) run
   only from an interactive terminal. `--yes` does NOT bypass it; an unattended or
   agent run exits 3 with a message that says so. History deletion and chat
   auto-delete are not shipped; the class exists so 0.11 reuses it by adding their
   audit kinds to `TTY_ONLY_KINDS`. It is not left to 0.11 for `promote`: the verb
   ships in 0.7.0 before the class does, and every day it ran with `--yes` was a
   day an agent could grant admin rights unattended.
2. **Moderation has a daily counter of its own.** `add-members`, `kick-member`,
   `ban`, `unban`, `restrict`, `promote` and `demote` count one per person against
   `TG_MAX_MODERATION_PER_DAY`, default 50, apart from the send caps. The
   per-call limit of 20 stays.
3. **Business automation and session revocation are decided case by case**, not
   a permanent never. TASK-43's never-added table said "never" for both; the
   wording is changed to "not added yet, decided case by case", and each needs its
   own decision record when asked for. Nothing is built for them here.
4. **Phase 0.13 (publish and extend) is deferred**: built only on an explicit
   request.

Question 3 of TASK-43 (split `src/send/index.ts` by area, fence as a directory) was
not part of the instruction and stays open; its acceptance criterion still
requires an answer before 0.10.

## The TTY-only class

- **What "a terminal" means** is `canPrompt()` as everywhere: a TTY on stdin and no
  `TG_NON_INTERACTIVE=1`. That cannot tell a human from an agent that was handed a
  pty. Two things narrow the gap: AGENTS.md already tells agents to always set
  `TG_NON_INTERACTIVE=1`, which refuses these verbs even on a real TTY, and a
  TTY-only verb **always asks**. `--yes` is accepted and ignored (still declared
  on the command, so a refusal is exit 3 and not commander's unknown-option 2),
  and the command passes `false` to the prompt, so somebody has to answer it.
- **Exit 3, before a session opens and before the arguments are validated.** The
  refusal says "terminal-only: `--yes` does NOT bypass it" and tells an agent to ask
  the operator. It is first on purpose: an agent that cannot run the verb is told
  so once, instead of being walked through its usage errors.
- **Enforced twice.** The command layer and `promoteAdmin` call
  `assertConfirmed(options, { terminalOnly })`; `guardedSend` also refuses any
  kind on `TTY_ONLY_KINDS`, so a future verb whose author forgets the call is
  still refused. Library callers get the same rule: there is no option that waives
  it, and a test that exercises `promote` has to borrow a terminal on purpose.
- **`demote` is not on the class.** It is `editAdminRights` with empty rights: it
  can only take power away. It stays behind the ordinary `--yes` gate, and counts
  against the moderation cap.
- **Not in this release.** TASK-43 also planned, for 0.11, a before/after rights
  printout on `promote` and `--allow-add-admins` for the chain-escalation case. The
  operator's answer was about the TTY-only class; both stay in 0.11.

## The moderation counter

- **Counted from the audit log**, like the send cap: one audit line is one person
  (D13e wrote one line per person on purpose), over a rolling 24 hours, **failed
  attempts included**, because a retry loop against a person Telegram will not let
  us touch is the shape this bounds. The kinds are `add-member`, `kick-member`,
  `ban-member`, `unban-member`, `restrict-member`, `promote-admin` and
  `demote-admin` (`MODERATION_KINDS`).
- **Separate from the send caps in both directions.** These verbs still cost zero
  send units. 50 bans do not spend a message and 20 messages do not spend a ban.
  `tg send log` prints both counts.
- **Default 50, and why.** Two full 20-person calls plus a few single actions:
  room to clear a real spam wave in one sitting. It is also below the volume at
  which Telegram treats an account as running a ban sweep or a mass-add, both of
  which it throttles (`PEER_FLOOD`) and reports. The send cap is 20 a day, but a
  message goes to a stranger who did not ask for it and a moderation action goes
  to a chat the operator runs, so 2.5 times that is proportionate. Clearing
  hundreds in a day should be a decision, taken by raising the number.
- **Invalid values fail closed.** `Number('5O')` is NaN and a NaN cap compares
  false against everything, which would quietly turn the guard off. A value that is
  not a non-negative whole number refuses moderation with a message saying why;
  `0` is a deliberate off switch; an empty value is unset. The variable is read at
  call time, not import.
- **Refused whole, early.** The command layer checks the cap after the arguments
  are parsed and before any session opens (offline: it needs only the local log).
  A batch that does not fit in what is left is refused as a whole, not half done:
  "needs 6 more" against 5 free slots, nothing sent. `guardedSend` repeats the
  check per person as the backstop; if another process logged people mid-call, the
  batch stops, the person it stopped at is `cap` and the rest are `skipped`, with
  exit 4 and nothing retried. `add-members` keeps its exit 0 on partial failure
  except for `cap`, which exits 4. A cap refusal is not logged: no RPC was tried,
  which is how the send caps already behave.
- **Exit code 4**, the repo's code for a cap: `assertUnderCaps` throws an
  `OperatorError` with its default, and a test pins that the moderation cap carries
  the same one. A named subclass (`ModerationCapError`) exists only so a batch can
  recognise the wall.
- **Not added: a per-run counter.** TASK-43 proposed one for 0.11 (default 5). It
  would contradict the 20-person call limit, and the operator asked for the daily
  counter. The per-day join cap for 0.11 is unchanged.

## Exit codes and shapes

| situation | exit | where it shows |
| --- | --- | --- |
| `promote` without a terminal, with or without `--yes` | 3 | the standard failure envelope, message and detail say terminal-only |
| over the daily moderation cap, before any RPC | 4 | the standard failure envelope; `Daily moderation cap reached (n/cap ...)` |
| cap reached mid-batch | 4 | `ban`/`unban` JSON: `failed[].reason` is `cap` then `skipped`, plus the `error` object; `add-members` JSON: `ok: false`, `reason: "cap"`, an `error` object |
| `TG_MAX_MODERATION_PER_DAY` not a whole number | 4 | the same envelope, saying so |

## Not covered, on purpose

- A pty with no `TG_NON_INTERACTIVE` still counts as a terminal. The always-asking
  prompt is the second line: an agent that answers it has done the thing the
  operator wanted to be present for. The class does not claim to be a human test.
- The counter reads a local file. Two workspaces, or a deleted `data/sent.jsonl`,
  each start from zero. Same property as the send caps.
- 0.7.0's `promote` has been published for a short time without the class;
  nothing here can undo a grant that happened in that window. `tg group members
  --type admins` shows what is held.

## Release

Ships as 0.7.1, a patch: it narrows what 0.7.0 allows (an unattended `promote
--yes` now exits 3) and adds a refusal, and it adds no verb and no RPC, so
`WRITE_RPCS` and the allowlist are unchanged.
