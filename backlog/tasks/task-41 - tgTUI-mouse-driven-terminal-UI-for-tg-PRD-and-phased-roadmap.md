---
id: TASK-41
title: 'tgTUI: mouse-driven terminal UI for tg - PRD and phased roadmap'
status: To Do
assignee: []
created_date: '2026-08-30 03:54'
labels:
  - prd
  - design
dependencies: []
ordinal: 41000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
PRD, not a build ticket. Research done 2026-08-30 before writing this: no existing Node/mtcute TUI for Telegram found; closest prior art is `tgt` (FedericoBruzzone/tgt, Rust, tdlib) - explicitly "without using a mouse" per its own listing - and one unscraped Reddit vibe-coded client mentioning mouse + command palette + folder tabs + vim nav as the feature shape people actually want. Pi's own `@earendil-works/pi-tui` was checked and ruled out: it's coupled to Pi's extension-host render loop, not usable as a standalone terminal app.

## Problem
tg is deliberately scriptable/agent-friendly (pull-based, disableUpdates:true, exit codes, --json everywhere) and deliberately NOT a place to read/reply live - that's what Telegram's own apps are for. There's no daily-driver terminal UI, and the one comparable OSS project has no mouse.

## Goal
A full-screen, MOUSE-DRIVABLE terminal UI, built as a new presentation layer on top of tg's existing primitives - not a rewrite. Click a chat to open it, scroll to read history, click to reply, click to archive/pin/mute.

## Non-goals (whole roadmap)
Voice/video calls. Group/channel admin (matches the CLI, which has none either). Multi-account in one session (matches the CLI's one-workspace-one-session model). Sticker/media rendering beyond a phase-4 stretch goal.

## Users
The same operator who already runs the tg CLI. NOT agent-facing - mouse-driven means human-only, same reasoning that kept --qr login out of skill/SKILL.md: an agent cannot click.

## Stack
neo-blessed (maintained blessed fork) or terminal-kit - both have real SGR mouse-mode support (click, scroll, drag), proven in other Node terminal apps. New dependency either way; nothing currently in package.json (clack, chalk) does full-screen mouse UI. Ink (React-for-CLI) explicitly considered and rejected: mouse support is weak-to-absent there.

## Reuse, not rebuild
- Session/auth: as-is (login, QR, TTL, device labeling already shipped).
- History: src/messages + existing sync/archive for offline scrollback.
- Sends: routes through the EXISTING src/send/index.ts fenced verbs - a TUI send is a human clicking a real UI element in real time, the same trust class as a human typing a CLI command, not an unattended write. No new unguarded RPC path. Confirm-dialogs replace the CLI's y/N prompt but keep the same guarantee (D13/D13a/D13b still apply).
- Chat-state actions (archive/pin/mute/mark-unread): call the exact D13b-fenced functions from a context menu - no new RPC surface, just a new trigger for verbs that already exist.

## Roadmap
- Phase 0 - read-only shell: chat list (archive + live peers), scrollable message pane, mouse click to select, mouse scroll for history, keyboard nav fallback. No sends. Proves the render pipeline and mouse handling actually work across real terminals.
- Phase 1 - live send: text box wired to the existing send/index.ts text path and its confirm/cap/audit guards.
- Phase 2 - chat-state actions as UI affordances (archive/pin/mute/unread), same fenced functions, new trigger only.
- Phase 3 - folder/workspace switcher, depends on TASK-40 (non-interactive folder tracking) if a mouse click is meant to do what `tg setup --select` does today.
- Phase 4 (stretch) - inline media preview via kitty/iTerm2 graphics protocol where supported, plain link fallback elsewhere.

## Open risk, needs its own decision before Phase 1
mtcute's client runs with `disableUpdates:true` (deliberate, CLI-wide, pull-only). A "live chat" TUI polling on that model may feel laggy. Flipping to live updates for the TUI specifically is a real architectural question, not implied by this PRD, and should get its own decision record before Phase 1 starts.

## Compatibility risk
Mouse support quality varies by terminal (Ghostty/iTerm2/kitty solid; tmux passthrough and some SSH paths are known trouble spots). Phase 0 should include a compatibility check across the terminals actually used, not an assumption of universal support.

## Success bar
No usage metrics to instrument for a single-operator tool. Proposed bar instead: the operator prefers tgTUI over the Telegram desktop app for daily triage. Qualitative, reassessed after Phase 0.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Phase 0 (read-only shell + mouse nav) scope confirmed by operator before any code
- [ ] #2 send/chat-state actions route through existing src/send fenced functions, no new write RPC path
- [ ] #3 disableUpdates/live-update question gets its own decision record before Phase 1
<!-- AC:END -->
