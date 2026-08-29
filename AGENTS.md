# Working in this repo

This tool holds a live Telegram account credential and can message real people.
Read this before running anything.

## Check before you commit to a long task

`tg doctor` answers one question: will an unattended run work right now? It runs
the offline checks plus ONE authenticated round trip, because a session can look
perfect on disk and have been revoked from another device an hour ago.

```sh
tg doctor --json      # full report
tg doctor --offline   # no network, no lock
```

Exit codes are the contract. Act on them, do not parse prose:

| code | meaning | what to do |
| --- | --- | --- |
| 0 | ok | proceed |
| 1 | a bug in this tool | report it, with the stack |
| 2 | usage error | fix the command |
| 3 | needs a human | STOP. Either the workspace needs `tg session login`, or an unattended send was refused. Ask the operator; retrying is pointless and `--yes` is theirs to give, not yours to add |
| 4 | `not_configured` | the report's `hint` is the fix; it usually needs no human |
| 5 | busy | another run holds the lock. Wait and retry |
| 6 | upstream | Telegram, gbrain or the network failed. Not your fault; retry with backoff |

Every code above is emitted by real code paths; eval-93 fails the suite if any
becomes decorative. When you pass `--json`, a failure prints a JSON envelope on
**stdout** alongside the exit code, so a piped consumer never sees an empty
stream and a bare number:

```json
{ "ok": false, "error": { "code": "usage", "exit": 2, "message": "...", "detail": "..." } }
```

Zero results is `usage` (2), not `not_configured` (4): a needle that matched
nothing is a bad search term, not a broken workspace.

## Run commands, do not ask for passwords

There is no session password prompt. `openSession()` in `src/session/index.ts`
resolves auth from the psst vault or the local cache. If a command asks you for
anything, that is a bug.

Always set `TG_NON_INTERACTIVE=1`. Without it, a run with a pty attached that
has no session will stop on "Enter your phone number" and wait forever.

```sh
TG_NON_INTERACTIVE=1 tg folders list --json
```

Only a human can create a session, because only a human receives the login code.
When you see `No usable Telegram session`, stop and ask for `tg session login`
to be run at a terminal. Do not try to work around it.

## Never print a session

`TG_SESSION_STRING` is a full account credential: whoever holds it is logged in
as the user, and no password or 2FA challenge stands in the way.

- Do not `psst get TG_SESSION_STRING` to "check" it. Use `tg session status`,
  which prints a fingerprint.
- Do not echo it into a log, a commit, an issue, or a demo recording.
- Write secrets with `psst set NAME --stdin` so the value goes over a pipe and
  never lands in argv, where `ps` and shell history can see it.

If one does leak, revoking it in Telegram (Settings > Privacy & Security >
Active Sessions) is the fix. Deleting the vault entry does nothing.

## Never move a session between directories or hosts

Each workspace runs its own `tg session login` and owns its own auth key. Do not
copy `TG_SESSION_STRING` from one workspace or machine to another, and do not
"helpfully" seed a new workspace from an existing one.

One auth key used from two places desynchronises Telegram's `pts`/`qts`/`seq`
message-box state and can earn `AUTH_KEY_DUPLICATED`, which revokes it for
everyone using it. The lock cannot prevent this: `data/session.lock` is
workspace-relative and cannot see another directory.

## Sending is different from everything else

Every other command here reads. Sending cannot be undone, and it reaches a real
person, so it has rules that are enforced by `test/trust.test.ts`, not by taste:

- **Prefer a numeric id when you have one.** Commands also accept `@username`
  and `t.me` links (D17), which is convenient and is also how you reach the
  wrong person: `@durov` and `@durvo` both exist and belong to different people.
  When an id is available - from `tg peers find <name> --id-only` or from a
  previous resolution - use it. When you use a handle, read the resolved
  identity line back to the operator before continuing.
- **Never pass a name the operator did not give you verbatim.** Do not guess a
  handle from a display name, and do not "correct" one that fails to resolve.
  A failed resolution is a question for the operator, not a puzzle to solve.
- **Do not pass `--yes` to route around a refusal.** `--yes` is the operator
  stating that an unattended send is intended. If you are an agent and a send was
  refused, that refusal is the feature. Report it and ask.
- **Do not raise `TG_MAX_SENDS_PER_RUN` or `TG_MAX_SENDS_PER_DAY`** to get a
  batch through. The caps exist because a burst of outbound messages from a user
  account is what earns a report and a ban.
- **Do not resolve a peer inside `src/send/`.** Resolution happens in the command
  layer so that exactly one place turns a reference into an identity, and that
  identity is what gets confirmed and logged. eval-33 and eval-65 pin this.
- **Do not add a write RPC anywhere outside `src/send/`.** eval-29 fails the
  suite if `sendText`, `sendMedia`, `forwardMessages`, `deleteMessages`,
  `editMessage` or `readHistory` is called from any file not on the allowlist.
- **Do not import `src/send/` from an unattended path.** eval-30 and eval-31 walk
  the import graphs of `export`, `folders`, `ship`, `sync` and every read verb,
  and fail if any of them can reach it. That is what makes "a cron job cannot
  message anyone" a fact rather than a hope.

`tg send log` shows what this workspace has already sent. Check it before
sending anything in a series.

## Do not fight the updater

A global install updates itself daily in a detached background process. If you
are scripting `tg`, set `TG_NO_UPDATE=1` for reproducibility rather than
letting a version change under a long workflow. `CI=true` already does this.

Never call `npm install -g @qwadratic/tg` yourself to "fix" a version notice:
`tg update` exists, knows whether this is even a global install, and records
the attempt so a failing install stops retrying.

## One instance at a time

`data/session.lock` is taken by every command that connects. Do not run two
commands in the same workspace concurrently and do not delete the lock to
"unblock" a run — two clients on one auth key corrupt Telegram's message-box
state and can get the session revoked. If a lock is genuinely stale, the next run
reclaims it on its own once the recorded pid is gone.

`tg watch` holds the lock for as long as it runs, up to 45 minutes by default.
That is intended. Do not start an export beside it.

## Layout

| path | role |
| --- | --- |
| `src/paths.ts` | every data path, derived from `TG_DATA_DIR`. Add new paths HERE |
| `src/session/psst.ts` | vault access; the only place that shells out to `psst` |
| `src/session/lock.ts` | single-instance lock |
| `src/session/cache.ts` | local encrypted cache and peer-count helpers |
| `src/session/index.ts` | `openSession` / `withSession` — the entry point for auth |
| `src/workspace/index.ts` | `tg init` scaffolding and workspace status |
| `src/peers/ref.ts` | `parsePeerRef` / `resolvePeerRef` — id, @username, t.me link or `me` |
| `src/peers/id.ts` | `assertPeerId` — the send module's own numeric boundary |
| `src/peers/index.ts` | dialog listing and name matching |
| `src/dump/index.ts` | flat chat transcripts |
| `src/media/index.ts` | media download |
| `src/watch/index.ts` | polling for media not yet sent |
| `src/send/gate.ts` | send caps, confirmation rule, audit log. No RPCs |
| `src/send/index.ts` | **the only module that calls a Telegram write RPC** |
| `src/messages/fetch.ts` | the single rate-limited history iterator. Do not add a second |
| `src/folders/status.ts` | pure derivation of folder recency from sync state |
| `src/update/index.ts` | self-update: cache, version compare, detached worker |
| `src/cli/commands/` | one file per command group, registered in `src/index.ts` |

Data paths resolve against `TG_DATA_DIR`, default `data`, which is relative — so
they resolve against the current directory at the moment of the call. That is how
`cd` selects a workspace. Keep the default relative.

## Conventions

- `OperatorError` (`src/errors.ts`) is for environment problems: the CLI prints
  its message with no stack trace, so the message must say what to do next.
  Anything else is a bug and keeps its stack.
- Folder recency is derived from per-chat watermarks, never stored separately.
  Keep it that way, or the two drift apart.
- Rendering is a pure function (`renderPeers`, `renderDump`, `renderPulled`) so a
  golden can pin the output. Keep formatting out of the code that fetches.
- `--json` writes only the payload to stdout. Progress and warnings go to stderr.
- Tests are `node:test` + `assert`, no framework: `pnpm test`.
- Typecheck with `npx tsc --noEmit` and lint with `pnpm run lint` before calling
  anything done. `any` is a lint error, not a style preference: prefer `unknown`
  plus narrowing at an untyped third-party boundary.
- The version lives as a literal in `src/index.ts` AND in `package.json`.
  eval-72 fails if they drift; change both or neither.

## Goldens

A missing golden is written once, announced loudly, and passes — that is a
bootstrap, not a verification. **Read a bootstrapped golden by eye before
committing it.** A golden that exists and differs FAILS and is never rewritten:
either the code regressed, or the change is intended and the golden file must be
moved by hand in the same commit.

## Tasks and decisions

- `backlog/` is the only tracker. Use the CLI (`backlog task list --plain`);
  never edit `backlog/tasks/**` by hand.
- `backlog/decisions/` records WHY. If you reverse a decision recorded there, say
  so explicitly in a new decision file or an amendment — do not silently
  contradict it. Two of this repo's worst defects were a README that documented
  what this file forbids, and a decision log that claimed mechanical gates which
  did not exist.

## Before you commit

The pre-commit hook runs psst and gitleaks. It is tracked at
`.githooks/pre-commit`; a fresh clone needs `git config core.hooksPath .githooks`
once. Never bypass it to get a commit through.

Never commit anything under `data/` — it holds the session cache, real exported
messages and the send log. It is gitignored; keep it that way.
