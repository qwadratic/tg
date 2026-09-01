---
id: TASK-39
title: Chat-state verbs should not spend the outbound message budget
status: Done
assignee: []
created_date: '2026-08-29 21:52'
updated_date: '2026-09-01 05:56'
labels: []
dependencies: []
ordinal: 39000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
archive/unarchive/pin/unpin/mute/unmute/unread call guardedSend with units 1, so they share the 5/run and 20/day caps with real sends. Archiving 6 chats in one run is refused with 'a burst is what earns a report' - a rationale D13b's own argument says cannot apply to state no counterparty can observe.

Options: units 0 for the chat-state kinds, or a separate counter with its own (looser) cap. Keep the audit log entry either way - the record of what was done is not the same thing as the anti-spam cap.

Acceptance: 6 archives in one unattended run succeed; a 6th send text in the same run is still refused; send log still lists all of them; trust suite green.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 chat-state verbs do not consume the outbound send budget
- [ ] #2 text/media/forward/edit caps unchanged
- [ ] #3 send log still records every chat-state action
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Fixed: archiveChat/unarchiveChat/pinChat/unpinChat/muteChat/unmuteChat/markUnread now pass {units:0} to guardedSend explicitly (guardedSend's 3rd positional arg is size, not units - they set size:0 but never passed the units-bearing extra arg, so units defaulted to 1). eval-141 (test/chat-state.test.ts) proves behaviorally: 6 chat-state actions in one run cost 0 budget, real sendText still caps at MAX_SENDS_PER_RUN=5 in the same run. 178/178 tests passing.
<!-- SECTION:NOTES:END -->
