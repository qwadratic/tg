import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPrivateChat } from '../src/sync/index.js'
import { selectChatIds } from '../src/sync/chat-ids.js'

test('isPrivateChat separates users from groups and channels', () => {
  assert.equal(isPrivateChat(283706115), true) // user
  assert.equal(isPrivateChat(-1003831472718), false) // supergroup/channel
  assert.equal(isPrivateChat(-5112579792), false) // basic group
  assert.equal(isPrivateChat(0), false)
})

test('eval-129 excludeChatIds always wins and privateOnly falls back to config', () => {
  const base = { trackedFolderIds: [1], trackedChatIds: [10, 10, -20, 30] }

  // Deduplicated, nothing dropped without a reason to drop it.
  assert.deepEqual(selectChatIds(base), [10, -20, 30])

  // An excluded chat is gone even though its folder is tracked.
  assert.deepEqual(selectChatIds({ ...base, excludeChatIds: [30] }), [10, -20])

  // Persisted default applies when the flag is absent...
  assert.deepEqual(selectChatIds({ ...base, privateOnly: true }), [10, 30])
  // ...and the flag still wins per run, in both directions.
  assert.deepEqual(selectChatIds(base, { privateOnly: true }), [10, 30])
  assert.deepEqual(selectChatIds({ ...base, privateOnly: true }, { privateOnly: false }), [10, -20, 30])

  // An explicit --chats list does not buy its way past an exclusion.
  assert.deepEqual(
    selectChatIds({ ...base, trackedChatIds: [30], excludeChatIds: [30] }),
    []
  )
})
