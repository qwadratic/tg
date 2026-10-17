---
id: TASK-26
title: 'tg search over the archive, before any FTS5 index'
status: To Do
assignee: []
created_date: '2026-08-18 03:58'
updated_date: '2026-10-17 11:37'
labels:
  - search
dependencies: []
priority: high
ordinal: 26000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From the 2026-08-18 autoplan review. The original plan led with an encrypted FTS5 index; all three voices pushed back and two findings killed it as a first step.

1. rg over data/archive already answers 'where did we discuss X' today, at zero build cost, across 130 flat markdown files. The real delta of an index is ranking, media metadata and --from/--since, not the ability to grep.
2. VERIFIED: FTS5 with unicode61 remove_diacritics 2 returns NOTHING for MATCH 'budapest' against 'Budapesten a rekruter irt'. Hungarian agglutination, and no stemming for Russian either. A naive index would silently fail on exactly the people in this operator's chats.

BUILD: tg search <query> [--from] [--since] [--kind] [--json] as a ranked reader over data/archive. No second copy of every message, no new key, no new blast radius. Add FTS5 only when measured on the real corpus, and only with a trigram companion table OR'd in for substring matching. Never porter.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 search ranks results across all archived chats and supports --from/--since/--json
- [ ] #2 a Hungarian and a Russian query both return their known hit, asserted in a test
- [ ] #3 no new on-disk copy of message content is created
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-17: the name `tg search` is yours. D13f (backlog/decisions/2026-10-17-core-reads-and-fence-hardening.md) settled the collision with TASK-43 phase 0.8: the LIVE search of Telegram is `tg msg search` (chat, global, hashtag, public posts), so this task needs no flag and no rename. The two are different verbs on purpose: this one reads Markdown files and needs no session, the live one asks Telegram.
<!-- SECTION:NOTES:END -->
