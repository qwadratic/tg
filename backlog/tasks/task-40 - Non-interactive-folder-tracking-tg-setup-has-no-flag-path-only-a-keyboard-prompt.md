---
id: TASK-40
title: >-
  Non-interactive folder tracking: tg setup has no flag path, only a keyboard
  prompt
status: To Do
assignee: []
created_date: '2026-08-30 03:53'
labels:
  - design
dependencies: []
ordinal: 40000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Right now `tg setup [--select]` is the ONLY way to change which folders `data/archive` and `tg sync` track, and it is 100% interactive: `selectFolders()` (src/folders/index.ts) always calls clack's `multiselect()`, no flag path exists. `sync --chats <ids>` / `export chats --chats <ids>` exist but are explicitly one-off overrides - "everything else is left untouched" - never written to config.json.

Net effect: an agent or unattended script can never durably change what this workspace tracks. A human has to sit at a keyboard once per config change, forever, even though every other piece of config in this tool (--ttl-days, TG_SESSION_TTL_DAYS, TG_DATA_DIR, hosts.json) has a non-interactive path.

BUILD (needs a design call first, not mechanical - see below): a way to persist tracked-folder/chat selection without a prompt. Two shapes worth comparing before picking one:
  a) `tg setup --folders <ids>` (or `--chats <ids>`) - non-interactive twin of the existing wizard, writes straight to config.json.
  b) fold persistence into `sync`/`export chats` itself via a `--track` flag: run once with `--chats <ids> --track` and it both syncs those chats now AND makes them the new persisted config, collapsing two commands (setup, then sync) into one call an agent can make.

(b) is closer to what was asked ("done with cmd params of the sync subcommand") and removes a whole command from the agent-facing surface, but changes what `--chats` means for anyone already using it as a pure one-off - needs a compat decision (new flag vs behavior change) before implementation.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 agent/script can change tracked folders or chats without a TTY prompt
- [ ] #2 existing --chats one-off override behavior on sync/export is not silently broken
- [ ] #3 decision recorded (backlog/decisions/) on the setup-vs-sync-flag question before implementation starts
<!-- AC:END -->
