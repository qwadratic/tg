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

Each workspace names itself in Telegram's own device list (Settings > Devices)
as `<date>/<directory>@<host>` - session creation date, the folder it lives in,
the machine - so the rows are told apart, and terminated, instead of five
identical `mtcute on Node.js` lines. The host can be renamed to something more
recognisable than a raw hostname: create `~/.tg/hosts.json` (or
`$TG_STATE_DIR/hosts.json`) with `{ "<raw hostname>": "<alias>" }`. It's a
hand-edited, per-machine file, never part of a workspace, never committed.

## Reading

| command | what it does |
| --- | --- |
| `peers list [--type user] [--since <date>] [--no-bots] [--json]` | chats, most recent activity first |
| `peers find <needle> [--json] [--id-only]` | chats whose name or username matches, accent-insensitively |
| `dump <peer> [--since <date>] [--limit n] [--topic <id> \| --thread <id>] [--json]` | one chat as a flat chronological transcript on stdout; `--topic` reads one forum topic, `--thread` the replies under one message |
| `media pull [peer] [--kind photo,video] [--max n] [--to dir]` | download media; no peer means your Saved Messages |
| `watch [peer] [--minutes n] [--kind ...]` | wait for media that has not been sent yet, then download it |
| `chat info <peer> [--basic] [--json]` | what a group, supergroup or channel is: kind, members, settings, description |
| `chat log <peer> [--type a,b] [--user ids] [--query text] [--limit n]` | the admin log of a supergroup or channel, newest first (needs admin rights) |
| `group member <peer> <user>` | one person's standing in a chat: role, rights, who invited or promoted them |
| `msg get <peer> <ids...> [--json]` | messages by id, in full |
| `msg link <url> [--json]` | the message a `t.me` link points at |
| `msg thread <peer> <id> [--depth n]` | one message in context: what it replies to, its album, where a post's comments live |
| `msg search <query> (--chat <peer> \| --global \| --hashtag \| --posts) [--filter kind] [--from id] [--since d] [--until d] [--limit n]` | search Telegram live, newest first |
| `user info <peer> [--basic] [--common] [--json]` | a person: name, handles, contact state, last seen, bio, shared chats |
| `contacts list [--query text] [--limit n]` | the address book by name (never phone numbers) |
| `dialogs show <peers...>` | where chats stand in your chat list: unread, pinned, muted, archived, last message |
| `draft list [--scan n] [--limit n]` | the unsent drafts waiting in your chats, with their text |
| `scheduled list <peer> [ids...]` | messages waiting to be sent in a chat, soonest first |
| `reactions show <peer> <id> [--users] [--limit n]` | the reactions on a message: counts, and with `--users` who |
| `account sessions` / `account privacy [key]` / `account notify [peer]` | the account's own sessions, privacy rules and notification settings |

`dump` appends an engagement suffix when Telegram populates one — views,
forwards, the three loudest reactions, the reply/comment count, and `edited`:

```
[2026-08-30T09:12] Ada: shipping today <photo> (1200 views, 3 fwd, ❤️9 🔥5, 7 replies)
```

A 1:1 chat carries none of those fields, so nothing is added there — no row of
zeroes on every line.

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

### Reading Telegram live

The verbs from `chat info` to `account notify` above only read, and they share the
rules below. `AGENTS.md` and `skill/SKILL.md` have the version for agents.

- **They cannot write.** None of them is behind the send gate, none can import the
  send module (a test walks the import graph), and the raw calls they make
  (`account.getAuthorizations`, `account.getPrivacy`, `account.getNotifySettings`)
  are on a list of reads that a test checks: a raw call to anything else outside
  `src/send/` fails the suite.
- **`--json` and `--limit`.** Every one takes `--json`, which prints only the
  payload on stdout. Anything that can be long takes `--limit` with a ceiling you
  must choose to reach, and pages through one paced walk: after every 100 items it
  waits 1.5s plus jitter, the same pacing `dump` has always had.
- **Exit codes.** A lookup or a search that finds nothing is `2` (the id or the
  needle was wrong), like `peers find --id-only`; a listing that is legitimately
  empty (no drafts, nothing scheduled) says so and exits `0`, like every other
  listing. `3` is `CHAT_ADMIN_REQUIRED`: a human with the right must act. `6` is
  Telegram throttling or failing, or the network.
- **Names.** A chat or a person can be an id, `@username`, a `t.me` link or `me`; the
  resolved identity is printed to stderr first, as everywhere (see above). `msg link`
  also takes a message link, and refuses an invite link by name, because nothing here
  joins anything.
- **What is left out on purpose.** Phone numbers are never printed (`contacts list`
  and `user info` have no phone field, so `--json` cannot export the address book).
  Chat invite links are not shown by `chat info` or `chat log`. `msg search --posts`
  uses only Telegram's free daily allowance of public-post searches; when it is used
  up the answer is exit `3` and nothing is ever paid in Stars. Nothing marks a
  message read, a reaction read or a story viewed.
- **Two searches.** `msg search` asks Telegram, so it costs requests and finds what
  was never archived. The offline search over the archive (TASK-26) keeps the name
  `tg search`; they are different verbs because one needs a session and the other
  does not.

The reasoning, and the fence checks that back these rules, are in
`backlog/decisions/2026-10-17-core-reads-and-fence-hardening.md` (D13f).

## Archiving

The archive path is the original job: whole folders of chats into one Markdown
file each, incrementally, shaped for a knowledge base.

- `sync chats [--once] [--interval <seconds>] [--private-only] [--chats <ids>] [--json] [--verbose]`
  — archive the tracked chats into one Markdown file each, incrementally.
  Repeats on an interval until you stop it, so an archive stays current without
  a cron entry; `--once` does a single pass and exits. It polls; there is no
  push stream. `--verbose` adds the new-chat and skipped-chat counts to the
  summary (and to the `--json` line), which the repeating default keeps quiet
  about on purpose.
- `sync recent --cutoff <value>` — combined recent export (cutoff required, inclusive)
- `sync historical [--cutoff <value>]` — combined historical export (cutoff optional, exclusive)
- `folders list [--json]` — folders already synced, most recently updated first
- `folders update [--folder <id> | --all]` — re-export one folder, or every folder stalest-first
- `ship [--dry-run] [--all] [--skip-unroutable]` — push new archive files into
  [gbrain](https://github.com/garrytan/gstack), an optional external knowledge
  base. **Skip this command if you do not use gbrain**; nothing else depends on it.

  Every chat must map to a brain through its folder, and `ship` never guesses:
  a chat in an untracked folder, or a folder missing from `TG_BRAIN_MAP`, is
  refused. `--skip-unroutable` ships what it can and reports the rest, so one
  unroutable chat does not block the whole archive.

```sh
tg sync chats                  # every 5 minutes until Ctrl+C
tg sync chats --once --json    # one pass, one JSON summary line
```

Bare `tg sync` prints help rather than picking a subcommand for you: `chats`,
`recent` and `historical` write different files and cost very different amounts
of time.

### Configuration

What gets archived is `data/config.json`, a plain hand-edited file. There is no
wizard and no CLI for it: a script or an agent can write it directly, with no
TTY anywhere in the loop.

```json
{
  "trackedFolderIds": [2, 5],
  "trackedChatIds": [904417238, -1003831472718],
  "excludeChatIds": [-1002222222222],
  "privateOnly": false
}
```

| field | meaning |
| --- | --- |
| `trackedFolderIds` | Telegram folder ids to archive. `tg folders list` shows the ones already known |
| `trackedChatIds` | the chats to archive. Overwritten from the tracked folders on every sync run — hand-added ids survive only when `trackedFolderIds` is empty, which is the supported chats-only setup |
| `excludeChatIds` | optional. Always skipped, folder membership notwithstanding |
| `privateOnly` | optional. Persisted default for `--private-only`, applied by `sync chats`, `sync recent` and `sync historical`; the `sync chats` flag still wins for a single run |

Any field may be absent - a missing list reads as empty, and an older config
with only the first two keys loads unchanged. A field of the wrong type is
refused at load with exit 4 rather than ignored: quoted ids (`["111"]`) would
silently disable an exclusion, which is a privacy failure, not a typo.

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
| `--topic <topicId>` on `send text` / `send media` | post into a forum topic (the topic id is its top message id) |
| `send rm <peer> <ids...>` | delete messages you sent, for everyone |
| `send forward <peer> <ids...> --to <target>` | forward messages into another chat |
| `send edit <peer> <id> <text>` | edit the text of a message you sent |
| `send read <peer>` | mark a chat as read |
| `send archive <peer>` / `send unarchive <peer>` | move a chat in or out of the archive |
| `send pin <peer>` / `send unpin <peer>` | pin or unpin a chat |
| `send mute <peer>` / `send unmute <peer>` | mute a chat indefinitely, or unmute it |
| `send unread <peer>` | mark a chat as unread |
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
   against a peer that rejects is exactly what draws a report. Acting on people
   in a chat (`tg group ban`, `add-members` and the rest) has a daily cap of its
   own, below.
5. **Logged.** Every attempt appends to `data/sent.jsonl`, mode `0600`, recording
   the peer, kind, size and outcome — never the message content.

`note` takes no peer at all, so the everyday case of leaving yourself a note
cannot be aimed at another person by mistake.

The unattended commands provably cannot send: `test/trust.test.ts` walks the
import graph and fails the suite unless exactly five files can reach the send
module (the registration root, the two write command files and the two files of
`src/send/`). Every other file, every read verb included, cannot, and a command
file nobody has classified fails too. A cron job cannot message anyone.

## Administering a group or channel

`tg group` changes what a chat *is* — its name, its picture, who may join, how
it is organised. Nothing here posts a message, so none of it spends the send
budget, but all of it goes through the same fence: a numeric peer id, the
confirmation prompt (or `--yes`), and a line in `data/sent.jsonl`.

| command | what it does |
| --- | --- |
| `group create-group <title> <ids...>` | create a legacy group with its first members |
| `group create-channel <title> [--description ...]` | create a broadcast channel |
| `group create-supergroup <title> [--forum]` | create a supergroup, optionally with topics |
| `group title <peer> <title>` | rename a chat |
| `group description <peer> <text>` | set the description; `""` clears it |
| `group photo <peer> <file>` | set the photo or video avatar from a local file |
| `group color <peer> <colorId> [--profile]` | set the accent colour by palette index |
| `group sticker-set <peer> <shortName>` | set the group's sticker set |
| `group username <peer> <username>` | claim a public @username |
| `group remove-username <peer>` | release it and go private again |
| `group invite-export <peer>` | regenerate the primary invite link — revokes the old one |
| `group invite-new <peer> [--expires ...] [--limit ...] [--approval]` | create an extra invite link |
| `group invite-edit <peer> <link> [...]` | edit a non-primary invite link |
| `group invite-list <peer> [--revoked]` | list your invite links (read-only) |
| `group invite-members <peer> [--link ...]` | who joined through a link (read-only) |
| `group topic-new <peer> <title> [--icon ...]` | create a forum topic |
| `group topic-edit <peer> <topicId> <title>` | rename a forum topic |
| `group topic-closed <peer> <topicId> <on\|off>` | close or reopen a topic |
| `group topic-pinned <peer> <topicId> <on\|off>` | pin or unpin a topic |
| `group topic-list <peer>` | list a forum's topics (read-only) |
| `group slow-mode <peer> <seconds>` | slow mode; `0` disables it |
| `group protect <peer> <on\|off>` | restrict saving and forwarding content |
| `group join-requests <peer> <on\|off>` | require admin approval to join by link |
| `group join-to-send <peer> <on\|off>` | require joining before posting |
| `group add-members <peer> <ids...>` | add people, numeric ids only, at most 20 per call |
| `group kick-member <peer> <id>` | remove one person (they may rejoin) |
| `group delete <peer>` | delete a supergroup or channel you created, irreversible |
| `group members <peer> [--type ...] [--query ...] [--limit ...]` | list members: id, name, @handle, role, title, admin rights (read-only; Telegram returns at most 200) |
| `group ban <peer> <ids...> [--until <date>]` | ban people, numeric ids only, at most 20 per call; forever unless `--until` |
| `group unban <peer> <ids...>` | let them join again and lift any restrictions; does not add them back |
| `group restrict <peer> <id> --deny <a,b> [--until <date>]` | take abilities away from one member, e.g. `send-messages,send-media` |
| `group promote <peer> <id> --rights <a,b> [--rank <title>]` | make one person an admin with exactly the rights named; terminal only, `--yes` does not bypass it |
| `group demote <peer> <id>` | take every admin right away; they stay a member |
| `group member <peer> <user>` | one person's standing in the chat: role, rights, who invited or promoted them (read-only) |

Two of these do not come back:

- `invite-export` revokes the previous primary link, so every copy already
  pasted into a message stops working.
- `remove-username` puts the handle straight back into the global pool, where a
  stranger can claim it seconds later.

`color` takes Telegram's own palette **index**, not an RGB value: `0-6` are the
built-in red, orange, purple, green, sea, blue, pink, and higher ids come from
the server's app config.

`add-members` adds people one at a time and reports each outcome. With `--json`
it prints `{"ok": true, "added": [ids], "failed": [{"user", "reason", "message"}]}`
and exits 0 even when some users could not be added, except for `cap` (the daily
moderation cap, below), which exits 4. `reason` is one of `privacy`, `not_mutual`,
`flood`, `too_many_channels`, `already_member`, `cap`, `other`.
A privacy block is not an error to retry: use `group invite-new` and share the
link. A flood limit stops the batch; the users not yet tried come back as
`flood`. `delete` refuses unless this account created the chat.

### Moderation and admin rights

`ban`, `unban`, `restrict`, `promote` and `demote` act on a *person*, so they
are stricter than the rest (the daily cap below also covers `add-members` and
`kick-member`):

- **People are positive numeric ids**, never `@handles` and never a chat id
  (`tg peers find <name> --id-only`). The prompt shows each person's name,
  handle and id, and says what the action does.
- **Supergroups and channels only.** A legacy group has no ban, restriction or
  admin rights in Telegram's model, so these refuse it and point at
  `kick-member`.
- **One request and one audit line per person.** The line in `data/sent.jsonl`
  names the person (`targetUserId`) and what was set (`detail`). A flood limit,
  a missing admin right or an unknown chat stops a batch; nothing is retried or
  waited on, and the people not reached come back as `skipped`.
- **`--until`** takes an ISO date between 30 seconds and 366 days ahead.
  Telegram reads anything else as *forever*, so anything else is refused rather
  than silently making a short ban permanent. Omit it for forever.
- **`restrict --deny`** takes a comma-separated list: `send-messages`,
  `send-plain`, `send-media`, `send-photos`, `send-videos`, `send-round-videos`,
  `send-audios`, `send-voices`, `send-docs`, `send-stickers`, `send-gifs`,
  `send-games`, `send-inline`, `send-polls`, `embed-links`, `change-info`,
  `invite-users`, `pin-messages`, `manage-topics`. Each named ability is taken
  away. Lift restrictions with `unban`; `view-messages` is a ban, so use `ban`.
- **`promote --rights`** names every right: `change-info`, `post-messages`,
  `edit-messages`, `delete-messages`, `ban-users`, `invite-users`,
  `pin-messages`, `add-admins`, `anonymous`, `manage-call`, `manage-topics`,
  `post-stories`, `edit-stories`, `delete-stories`, `manage-direct-messages`,
  `other` (an admin with no named power). There is no `all`, no ownership
  transfer, and a list naming every right is refused as an all-rights grant.
  `--rank` is a custom title of 1-16 characters. Promoting replaces the rights
  the person had; `add-admins` lets them appoint more admins, and the prompt
  says so.
- **`promote` is terminal-only.** It runs only from an interactive terminal:
  `--yes` does **not** bypass that, an unattended or agent run exits 3 with a
  message saying so, and at a terminal it always asks, whatever flags came with
  it. Handing someone power over a chat is the one write where the operator being
  present is the point, and `--yes` is a word an agent can add to its own command
  line. Setting `TG_NON_INTERACTIVE=1` closes it even on a pty, as agents are told
  to do. `demote` only takes rights away, so it stays behind the ordinary
  `--yes` gate.
- **A daily moderation cap of its own.** `add-members`, `kick-member`, `ban`,
  `unban`, `restrict`, `promote` and `demote` count one per person against 50 a
  day (`TG_MAX_MODERATION_PER_DAY`), counted from the audit log, failed attempts
  included, and apart from the send caps: 50 bans do not spend a message and 20
  messages do not spend a ban. A call that does not fit in what is left is refused
  whole, before a session opens, with exit 4 like the send caps. 50 is two full
  calls and a few more, enough to clear a spam wave; hundreds a day is what a ban
  sweep or a mass-add looks like to Telegram, so raising the number is something
  the operator does on purpose. A value that is not a whole number refuses
  moderation rather than turning the cap off. `tg send log` shows where you
  stand.

`ban` and `unban` with `--json` print `{"ok", "banned" | "unbanned": [ids],
"failed": [{"user", "reason", "message", "exit"}]}`. Unlike `add-members` they
exit 0 only when every person was done; otherwise they exit with the code of the
first refusal, after printing that result (with an `error` object alongside).
Reasons: `flood`, `not_admin`, `target_is_admin`, `target_is_creator`,
`not_member`, `invalid_user`, `invalid_chat`, `too_many_admins`, `invalid_rank`,
`cap`, `skipped`, `other`.

Not here, and not to be added without their own decision record: deleting a
legacy group, chat migration, message auto-delete (`setChatTtl`) and handing over
ownership. See
`backlog/decisions/2026-08-31-widen-the-fenced-write-verbs-to-group-channel-management.md`,
`backlog/decisions/2026-10-05-widen-the-fenced-write-verbs-to-membership-and-deletion.md`
and
`backlog/decisions/2026-10-17-widen-the-fenced-write-verbs-to-moderation-and-admin-rights.md`;
the terminal-only rule and the moderation cap are in
`backlog/decisions/2026-10-17-tty-only-guard-and-moderation-counter.md`.

Telegram refusals map to readable messages and exit codes: `CHAT_ADMIN_REQUIRED`,
`RIGHT_FORBIDDEN`, `USER_ADMIN_INVALID` and `ADMINS_TOO_MUCH` are 3 (a human must
grant a right or decide), `CHANNEL_FORUM_MISSING`, `TOPIC_CLOSED`,
`USER_NOT_PARTICIPANT`, `USER_CREATOR` and an unknown user or chat are 2,
`FLOOD_WAIT` and `PEER_FLOOD` are 6.

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
| `session login --qr` | same, but scan a QR code from the Telegram app instead of typing a number |
| `session login --ttl-days <n>` | days before this workspace's session self-expires (default 3; `0` disables) |
| `session status [--json]` | session, peer cache, TTL and lock state; connects to nothing |
| `session verify` | proves the peer cache survives across separate processes |
| `session probe [--resolve n]` | one authenticated run, JSON report (used by `verify`) |

`session status` prints a **fingerprint** of the session string, never the
string, so you can tell two sessions apart without exposing either. It also
prints when this workspace's session was created and when it expires.

### Sessions expire on their own

Each workspace's session lives **3 days by default**. Once it is past that, the
next run ends that one session server-side (`auth.logOut`, this auth key only -
never anything account-wide), forgets it locally, and falls into the ordinary
"please log in" flow at a terminal, or the usual no-session error unattended.

```sh
tg session login --ttl-days 30   # persisted for this workspace
TG_SESSION_TTL_DAYS=0 tg ...     # off for this run; no auto-expiry
```

`TG_SESSION_TTL_DAYS` overrides the stored value, and `0` or a negative number
switches expiry off entirely. Changing the length never restarts the clock, and
a workspace that logged in before this shipped is backfilled rather than
expired - the clock starts at the upgrade, not retroactively.

If Telegram cannot be reached to end an expired session, nothing is deleted
locally (exit 6, retry): a session forgotten here but still live at Telegram is
one this tool can no longer name or terminate.

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
- Exit codes are a contract, in `AGENTS.md`: `0` ok, `1` a bug in tg, `2` usage, `3`
  needs a human, `4` not configured, `5` busy, `6` upstream. Environment problems
  print an instruction and no stack trace.
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
pnpm run lint          # eslint, type-checked rules; `any` is an error
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
