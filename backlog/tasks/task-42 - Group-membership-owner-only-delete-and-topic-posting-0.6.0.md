---
id: TASK-42
title: 'Group membership, owner-only delete and --topic posting (0.6.0)'
status: Done
assignee: []
created_date: '2026-10-05 13:48'
labels:
  - release
dependencies: []
ordinal: 42000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Ivan asked on 2026-10-05 for group and forum-topic management in tg, shipped via GitHub. Tier 1 (create, title, invites, topics) already existed on master; this adds membership (add-members, kick-member), owner-only delete, send --topic, Telegram error mapping, and releases the 13 unreleased commits as 0.6.0. Decision: D13d.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 add-members/kick-member/delete behind the --yes gate, with JSON shapes and error mapping
- [ ] #2 send text/media --topic posts into a forum topic
- [ ] #3 typecheck, lint, test, build green; v0.6.0 published via publish.yml
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added tg group add-members (max 20, per-user result with stable reasons), kick-member, owner-only delete, and --topic on send text/media; Telegram errors map to repo exit codes; D13d decision record amends D13c; 8 new tests (eval-142..149), 200/200 pass. Version set to 0.6.0 (master carried an unpublished 0.7.0 literal). Not added: ban, restrict, admin rights, legacy-group delete, invite --name (mtcute 0.27 has no title field).
<!-- SECTION:FINAL_SUMMARY:END -->
