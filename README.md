# tg

A command-line tool for reading your own Telegram from a terminal or an agent:
find a chat, dump a thread, pull media, archive folders into Markdown, and send
a message when you mean to.

![tg tour](https://raw.githubusercontent.com/qwadratic/tg/master/demo/out/tg-tour.gif)

*One binary, two audiences: the first half is what a person sees, the second is
what a coding agent parses. Recorded against a synthetic archive. Every folder and chat
name on screen is invented and no Telegram account is contacted, so the
recording is safe to publish. Rebuild it with `demo/record.sh`.*

## If you are an AI agent, read this first

`skill/SKILL.md` in this repo is written for you. It covers the setup workflow,
the user stories this tool supports, and the rules that are **enforced rather
than advisory** — the exit-code contract, why a refused send must not be routed
around with `--yes`, and why only a human can create a session.

```sh
# installed globally
cat "$(npm root -g)/@qwadratic/tg/skill/SKILL.md"

# from a checkout
cat skill/SKILL.md
```

Install it as a Claude Code skill so it loads automatically:

```sh
mkdir -p ~/.claude/skills/tg
cp "$(npm root -g)/@qwadratic/tg/skill/SKILL.md" ~/.claude/skills/tg/
```

The short version: run `tg doctor --json` before anything else, set
`TG_NON_INTERACTIVE=1`, and act on the exit code rather than parsing prose.
`AGENTS.md` carries the full contract and also ships in the package.

## Install

```sh
npm install -g @qwadratic/tg
```

### Secrets

`tg` needs your Telegram `API_ID` and `API_HASH` (get them at
[my.telegram.org](https://my.telegram.org/apps)). Two ways to supply them:

**Environment variables**, if you already have a way to manage secrets:

```sh
API_ID=... API_HASH=... tg session login
```

**Or [psst](https://github.com/vpetrigo/psst)**, a small encrypted vault, which
is what `tg init` sets up and what makes unattended runs work without any
secret sitting in your shell history. It is a separate binary that `npm` cannot
install for you; `tg init` checks and tells you if it is missing.

## Quick start

```sh
mkdir ~/chats/work && cd ~/chats/work

tg init                 # scaffold this directory as a workspace
psst init                # a vault for this workspace (or use env vars, see below)
tg session login        # once, at a terminal: phone + code + 2FA

tg peers list --type user --no-bots   # who do I talk to?
tg dump @durov --since last-7-days    # read one thread
```

After `session login`, no command ever prompts for a password again. That is
what makes cron jobs and agents possible.

## Workspaces

A workspace is a directory. Everything a run reads or writes lives under
`./data` inside it: the session, the config, the archive, the watermarks, the
send log.

```
~/chats/work/data/        <- one Telegram authorisation
~/chats/personal/data/    <- a different one
```

`cd` selects the workspace. No flag, no global config. Set `TG_DATA_DIR` to
point the data root somewhere else, e.g. `TG_DATA_DIR=/srv/tg` for a service.

**Each workspace logs in separately and owns its own auth key.** This is the
important rule and the reason `init` does not offer to copy a session:

- A session string *is* an auth key. Whoever holds it is logged in as you, with
  no password and no 2FA challenge in the way.
- One auth key used from two places desynchronises Telegram's `pts`/`qts`/`seq`
  message-box state and can earn `AUTH_KEY_DUPLICATED`, which revokes it for
  everyone using it.
- The single-instance lock cannot save you: `data/session.lock` is
  workspace-relative, so it cannot see another directory, let alone another host.

Distinct keys are free, and each is one revocable row under Settings > Privacy &
Security > Active Sessions. A shared key is the only genuinely dangerous
configuration.

App credentials are the deliberate exception. `API_ID` and `API_HASH` identify
the *application*, not the login, and Telegram expects one app to have many user
sessions, so a new workspace inherits them from your global vault (also accepted
as `TG_API_ID` / `TG_API_HASH`) and only has to do the phone-code step.

`tg init` also chmods the data root to `0700` and adds it to `.gitignore`,
because that directory holds a full account credential *and* real messages.

## Reading

| command | what it does |
| --- | --- |
| `peers list [--type user] [--since <date>] [--no-bots] [--json]` | chats, most recent activity first |
| `peers find <needle> [--json] [--id-only]` | chats whose name or username matches, accent-insensitively |
| `dump <peer> [--since <date>] [--limit n] [--json]` | one chat as a flat chronological transcript on stdout |
| `media pull [peer] [--kind photo,video] [--max n] [--to dir]` | download media; no peer means your Saved Messages |
| `watch [peer] [--minutes n] [--kind ...]` | wait for media that has not been sent yet, then download it |

### Naming a chat

Anywhere a command takes a chat, all four of these work:

```sh
tg dump 904417238             # a numeric id
tg dump @durov                # a username
tg dump https://t.me/durov    # a public link
tg dump me                    # your own Saved Messages
```

Whatever you type, the command resolves it and prints the identity it landed on
before doing anything:

```
reading Zoë Ünal (@zoe_unal) [id 904417238]
```

That line is the check. A username is convenient but it is also how you reach
the wrong person: `@durov` and `@durvo` are both valid handles belonging to
different people. The resolved name, handle and id are shown together so a
mistake is visible rather than silent.

Usernames only resolve for public chats and people you can reach. For a private
chat, look it up first:

```sh
tg peers find zoe                        # a table you read with your eyes
tg dump "$(tg peers find zoe --id-only)"   # or compose it directly
```

`--id-only` prints one id and nothing else, and **fails when the needle matches
more than one chat** rather than guessing. Guessing is how the wrong chat gets
read or texted.

`dump` writes the payload to stdout and everything else to stderr, so it pipes.

## Archiving

The archive path is the original job: whole folders of chats into one Markdown
file each, incrementally, shaped for a knowledge base.

- `export chats [--private-only] [--chats <ids>]` — export tracked folders, or
  just the listed chat ids
- `export recent --cutoff <value>` — combined recent export (cutoff required, inclusive)
- `export historical [--cutoff <value>]` — combined historical export (cutoff optional, exclusive)
- `folders list [--json]` — folders already synced, most recently updated first
- `folders update [--folder <id> | --all]` — re-export one folder, or every folder stalest-first
- `setup` — pick which folders to track
- `ship [--dry-run] [--all] [--skip-unroutable]` — push new archive files into
  [gbrain](https://github.com/garrytan/gstack), an optional external knowledge
  base. **Skip this command if you do not use gbrain**; nothing else depends on it.

  Every chat must map to a brain through its folder, and `ship` never guesses:
  a chat in an untracked folder, or a folder missing from `TG_BRAIN_MAP`, is
  refused. `--skip-unroutable` ships what it can and reports the rest, so one
  unroutable chat does not block the whole archive.

Recency exports are incremental and rely on `data/archive/sync-state.json` for
per-chat watermarks. Cutoffs are interpreted in your local timezone at the start
of the day, and must not move earlier than a previous run for the same mode.

Cutoff shortcuts, accepted anywhere a date is: `today`, `yesterday`,
`start-of-week` (Monday), `start-of-month`, `start-of-year`, `last-7-days`, or
`YYYY-MM-DD`.

`ship` runs AFTER an export has exited, never during: it is a separate process
that holds no Telegram credential. It needs
`TG_BRAIN_MAP="<folderId>=<gbrainSource>,..."`, and a file whose folder is
unmapped fails the run rather than picking a brain. See `deploy/README.md`.

## Sending

These are the only commands that write to Telegram, and they are built to be
hard to fire by accident.

| command | what it does |
| --- | --- |
| `send text <peer> <text>` | send a message |
| `send media <peer> <file> [--caption ...]` | send a file |
| `send rm <peer> <ids...>` | delete messages you sent, for everyone |
| `send forward <peer> <ids...> --to <target>` | forward messages into another chat |
| `send edit <peer> <id> <text>` | edit the text of a message you sent |
| `send read <peer>` | mark a chat as read |
| `note <text>` | send to your own Saved Messages |
| `send log [--json]` | what this workspace has sent |

Five guards, each one enforced by a test:

1. **The recipient is resolved and shown before anything is sent.** Whatever you
   typed becomes a name, a handle and an id, printed together, and you confirm.
   This is the main guard, because a mistyped username resolves to a real
   stranger rather than failing.
2. **Lookalike handles are refused outright.** Telegram usernames are ASCII, so
   a Cyrillic `о` pasted from a message is not a valid username at all and never
   reaches the network.
3. **Unattended runs need `--yes`.** Without a human to ask and without the flag,
   the send is refused rather than assumed.
4. **Capped.** 5 per run and 20 per day (`TG_MAX_SENDS_PER_RUN`,
   `TG_MAX_SENDS_PER_DAY`). Failed attempts count too, because a retry loop
   against a peer that rejects is exactly what draws a report.
5. **Logged.** Every attempt appends to `data/sent.jsonl`, mode `0600`, recording
   the peer, kind, size and outcome — never the message content.

`note` takes no peer at all, so the everyday case of leaving yourself a note
cannot be aimed at another person by mistake.

The unattended commands provably cannot send: `test/trust.test.ts` walks the
import graphs of `export`, `folders`, `ship` and every read verb and fails the
suite if any of them can reach the send module. A cron job cannot message anyone.

## Sessions

The session lives in a psst vault as `TG_SESSION_STRING`. A run resolves it
cheapest-first:

1. `$TG_SESSION_STRING` in the environment — set by `psst run`, `psst NAME -- cmd`, or CI
2. the local encrypted cache at `data/session.db`
3. this workspace's vault, imported into a fresh cache
4. an interactive login, whose result is written back to this workspace's vault

| command | purpose |
| --- | --- |
| `session login [--force]` | manual auth flow; stores the session string in psst |
| `session status [--json]` | session, peer cache and lock state; connects to nothing |
| `session verify` | proves the peer cache survives across separate processes |
| `session probe [--resolve n]` | one authenticated run, JSON report (used by `verify`) |

`session status` prints a **fingerprint** of the session string, never the
string, so you can tell two sessions apart without exposing either.

`TG_SESSION_DB_KEY` encrypts `data/session.db` at rest and is generated per
workspace on first use. It is not worth copying: the cache it protects is
regenerable.

### Why a local cache exists at all

A string session carries `{ version, primaryDcs, self, authKey }` and **no
peers**. Without `data/session.db` every run would re-resolve every chat's access
hash, which is slow and burns rate limit. `session verify` is the proof that it
works: it runs two independent processes and checks that the second one sees the
first one's peers *before* opening a connection.

### One instance at a time

`data/session.lock` holds the pid of the running instance. Two clients sharing
one auth key corrupt Telegram's message-box state, so a second run in the same
workspace is refused rather than queued. A lock left behind by a crash is
reclaimed automatically once its pid is gone.

Different workspaces have different locks and different auth keys, so they can
run at the same time.

## Automation

- `TG_NON_INTERACTIVE=1` turns "ask the user" into a clear failure. Set it in
  cron jobs and agent runs, which often have a pty and would otherwise hang
  forever on a phone-number prompt.
- `--json` is machine-readable on every read verb; stdout carries only the payload.
- Exit codes: `0` success, `1` failure. Environment problems print an
  instruction and no stack trace.
- Rate limiting is built in: history reads pause 1.5s plus jitter every 100
  messages, and `FLOOD_WAIT` is caught and waited out.

## Staying current

A global install keeps itself up to date. Once a day, in a detached background
process, `tg` asks the registry for the newest version and installs it if there
is one. Nothing is added to the time your command takes: the foreground reads a
single small cache file and moves on.

```sh
tg update            # check and install right now
tg update --check    # is there a newer version? install nothing
```

The new version applies to your **next** command, not the running one.

Turn it off:

```sh
export TG_NO_UPDATE=1                 # never check, never install
export TG_UPDATE_INTERVAL_HOURS=168   # or just check less often
```

If an update is interrupted part way through - the machine sleeps, the terminal
is closed, the process is killed - npm can leave the install incomplete, exactly
as an interrupted `npm install -g` would. One command repairs it:

```sh
npm install -g @qwadratic/tg@latest
```

Auto-update is skipped automatically when `CI` is set, so a build agent never
swaps versions mid-pipeline, and when `tg` is running from a git checkout, so
`npm install -g` can never overwrite a working copy. If an install fails twice
(usually a global prefix that needs elevated permissions) it stops retrying and
tells you the command to run yourself.

**Worth deciding deliberately:** this tool holds a full Telegram account
credential and can send messages. Auto-update means a future published version
gains that access without you reviewing it. Published releases are built by the
`publish.yml` workflow and carry [npm provenance](https://docs.npmjs.com/generating-provenance-statements),
which ties each tarball to the commit and workflow run that produced it, so you
can verify what you got:

```sh
npm view @qwadratic/tg --json | jq .dist.attestations
```

If that trade is not one you want, `TG_NO_UPDATE=1` leaves you in full control.

## Development

```sh
pnpm install
pnpm test              # node:test, no network, no framework
pnpm run typecheck
pnpm run build
```

CI runs the same gates on Node 22 and 24, checks that the published tarball
contains only runtime code (`scripts/check-package-contents.mjs`), and then
installs that tarball globally and drives it in an empty directory, which is how
the missing-psst and native-binding problems were found in the first place.

### Releasing

Publishing runs from GitHub Actions and needs no npm token: the workflow
authenticates with a short-lived OIDC token via npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers).

```sh
npm version patch          # or minor / major; writes package.json and tags
git push --follow-tags     # the v* tag triggers .github/workflows/publish.yml
```

The workflow refuses to publish if the tag disagrees with `package.json`, if the
version is already on the registry, or if any CI gate fails.

Work is tracked in `backlog/` (`backlog task list --plain`); the reasoning behind
the build is in `backlog/decisions/`. `AGENTS.md` is the contract for anything
automated working in this repo.

### The demo

`demo/record.sh` rebuilds the recording at the top. It drives the real binary
against a throwaway workspace that `demo/make-fixture.mjs` builds under `/tmp`,
records the cast with asciinema and renders the GIF with `agg`.

Two things run on every recording, because both have already been wrong once:

- **A leak scan.** The cast is published, and `tg doctor` prints an absolute
  data directory, so the first cut had the author's home directory in its very
  first command. The recorder now fails if the cast contains your home path,
  username, or checkout path. `/tmp` is used rather than `TMPDIR`, which on
  macOS is a per-user path containing a machine-identifying hash.
- **A duration check.** A v3 cast stores the gap *since the previous event*, not
  an absolute offset, so reading the last line makes a 50s recording look like
  3.6s. That misreading is how a `--speed 0.14` correction shipped and turned
  the tour into a 5m39s GIF. Playback is now real time, and the recorder prints
  the duration and warns past 2m30s.

The tour deliberately shows
the guardrails refusing bad input, because refusing correctly is most of what
this tool does.

### Remembered phone numbers

After a successful login, `tg` remembers the number in `~/.tg/phones.json`
(0600, per user rather than per workspace, since the human is the same one each
time). The next login offers an arrow-select list, newest first, with
`Use a different number` always at the bottom.

```
?  Log in with which number?
   +15550001111    last used 30m ago
   +442071234567   last used 3d ago
 > Use a different number
```

Only the number is stored - never the code, never the 2FA password - and only
after Telegram has accepted it, so the list never fills with numbers that do not
work. At most five are kept.

```sh
tg session phones                        # masked, newest first
tg session phones --reveal               # in full; needs a terminal
tg session phones --forget +15550001111  # or --forget all
TG_NO_PHONE_HISTORY=1 tg session login   # never read or written
```

`--json` and the default listing are masked. Full numbers appear only behind
`--reveal`, which refuses without a terminal: an unattended run has no one to
show them to, and `--json` is what an agent pastes into a transcript.

### The agent skill

`skill/SKILL.md` is the source of truth for agents and ships in the package. See
[If you are an AI agent, read this first](#if-you-are-an-ai-agent-read-this-first)
at the top. Keep it in step with `AGENTS.md`: the skill is the orientation, and
AGENTS.md is the contract.
