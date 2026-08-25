---
name: tg
version: 1.0.0
description: Read, search and archive the operator's own Telegram from the command line, and feed it into a gbrain knowledge base. Use when the user asks to find, read, export or search their Telegram messages, chats, files or photos, or to send a message as themselves.
triggers:
  - search my telegram
  - read my chat history
  - find a chat / find someone on telegram
  - export telegram chats
  - what did we discuss with
  - send a telegram message
  - pull a file or photo from telegram
  - ingest telegram into gbrain
allowed-tools:
  - Bash
  - Read
---

# tg — Telegram for agents

`tg` is a CLI that holds the operator's own Telegram session and exposes it as
verbs an agent can call. It is installed globally:

```sh
npm install -g @qwadratic/tg     # binary is `tg`
```

Source and issues: https://github.com/qwadratic/tg

## Before anything else

**Always start with `tg doctor`.** It answers the one question that decides
whether the rest of a plan is worth making: will an unattended run work right
now? A session can look perfect on disk and have been revoked from another
device an hour ago; `doctor` does one authenticated round trip to find out.

```sh
tg doctor --json
```

Act on the exit code. Do not parse prose.

| code | meaning | what you do |
| --- | --- | --- |
| 0 | ready | proceed |
| 2 | usage | you passed something wrong; fix the command |
| 3 | needs a human | **STOP.** Only a human can resolve this, and retrying cannot. Either the workspace needs `tg session login` at a terminal (`status: needs_human_login`), or you tried to send unattended and no one authorised it. Ask the operator; do not add `--yes` yourself |
| 4 | `not_configured` | the report's `hint` is the fix; usually no human needed |
| 5 | busy | another run holds the workspace lock. Wait, retry |
| 6 | upstream | Telegram, gbrain or the network failed. Retry with backoff |
| 1 | a bug in tg | report it, with the stack |

Set `TG_NON_INTERACTIVE=1` on every call. Without it a run with a pty attached
will sit forever on "Enter your phone number".

When `--json` is passed, failures print an envelope on **stdout** as well:

```json
{ "ok": false, "error": { "code": "usage", "exit": 2, "message": "…" } }
```

## Setup, once per workspace

A workspace is a directory. Everything lives under `./data` inside it, and
`cd` selects it. Each workspace has its **own Telegram authorisation** — never
copy a session between them, because one auth key used from two places can get
it revoked for both.

```sh
mkdir -p ~/chats/work && cd ~/chats/work
tg init                    # scaffolds ./data, chmods 0700, gitignores it
psst init                  # a vault for this workspace (or use env vars)
tg session login           # HUMAN ONLY, once, at a terminal
```

Credentials come from a psst vault or straight from the environment:

```sh
API_ID=... API_HASH=... tg session login
```

Only a human can create a session, because only a human receives the login code.
If you are an agent and hit exit 3, stop and ask.

## User stories this supports

**"Who did I talk to about X?"**
```sh
tg peers list --type user --no-bots --json
tg peers find <name> --json          # accent-insensitive
tg peers find <name> --id-only       # one id, refuses when ambiguous
```

**"Read my thread with this person."**
```sh
tg dump @durov --since last-7-days --json
tg dump 108844221 --limit 200
```
A chat can be named by numeric id, `@username`, a `t.me` link, or `me` for
Saved Messages. The command prints the resolved identity to stderr before acting,
so the operator can see which chat it actually hit.

**"Get me that PDF / photo / recording."**
```sh
tg media pull @someone --kind document --max 5 --to ./files
tg media pull --kind photo            # no peer = Saved Messages
tg watch --minutes 30                 # wait for something about to be sent
```

**"Keep an archive of my chats."**
```sh
tg setup                    # pick which Telegram folders to track
tg export chats             # incremental; safe to re-run
tg sync --once --json       # one pass, one JSON summary line
tg folders list --json
```
Use `--once`. Plain `tg sync` loops on an interval until Ctrl+C and will hang
the process that called it.


**"Make my Telegram searchable."**
```sh
tg ship --skip-unroutable   # push archive pages into gbrain
gbrain search "recruiter"   # keyword, covers everything shipped
gbrain query "who offered me a job"   # semantic, needs embeddings
```

**"Send this."** See the hard rules below first.
```sh
tg send text <peer> "message"
tg send media <peer> ./file.pdf --caption "..."
tg send rm <peer> <id>      # delete a message you sent, for everyone
tg send forward <peer> <id> --to <target>
tg send edit <peer> <id> "new text"
tg send read <peer>         # mark a chat as read
tg note "remember this"     # to your own Saved Messages
tg send log                 # what this workspace has already sent
```

## Hard rules — these are enforced, not advisory

1. **Sending reaches a real person and cannot be undone.** `tg send` refuses in
   a non-interactive run unless `--yes` is passed. If a send was refused, that
   refusal is the feature: report it and ask the operator. Do not add `--yes` to
   get past it.
2. **Do not raise `TG_MAX_SENDS_PER_RUN` or `TG_MAX_SENDS_PER_DAY`** to push a
   batch through. The caps exist because a burst of outbound messages from a
   user account is what earns a report and a ban.
3. **Prefer a numeric id when you have one.** Handles are accepted, and
   `@durov` and `@durvo` are different real people. When you use a handle, read
   the resolved identity line back to the operator.
4. **Never print `TG_SESSION_STRING`.** It is a full account credential: whoever
   holds it is logged in, with no password and no 2FA in the way. Use
   `tg session status`, which prints a fingerprint.
5. **One instance per workspace.** Exit 5 means another run holds the lock. Wait,
   do not delete the lock.

## Rate limits are real

History reads pause 1.5s per 100 messages, and `FLOOD_WAIT` is caught and waited
out. A first full export of a large account takes hours. Prefer `--since` and
`--limit` over exporting everything, and never run two exports at once.

## Phone numbers

`tg session login` remembers the numbers this human has used and offers them in
an arrow-select picker. You will never see that picker: it only appears at a
terminal, and only a human can log in anyway.

`tg session phones --json` masks every number. Do not reach for `--reveal` - it
refuses without a terminal by design. These are personal numbers belonging to
someone who may not be watching this run, and there is no task here that needs
them in full. If the operator wants one removed:
`tg session phones --forget <number>`.

## What it does not do

- It does not read anyone else's Telegram. It is the operator's own session.
- It does not do semantic search itself; that is gbrain's job. `tg` produces the
  pages, gbrain embeds and answers.
- It does not extract text from PDFs or transcribe audio.
- It has no daemon. `tg watch` is the only long-lived command.

## When something is wrong

```sh
tg doctor                 # start here, always
tg session status --json  # what is on disk, connects to nothing
tg send log               # what has been sent from this workspace
tg update                 # self-update; skipped in CI and in a git checkout
```

`AGENTS.md` ships inside the package and carries the full contract.
