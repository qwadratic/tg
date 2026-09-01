import assert from 'node:assert'
import test from 'node:test'
import type { TelegramClient } from '@mtcute/node'
import {
  archiveChat,
  muteChat,
  pinChat,
  sendText,
  unarchiveChat,
  unmuteChat,
  unpinChat,
  markUnread
} from '../src/send/index.js'
import { MAX_SENDS_PER_RUN, readSendLog, resetRunCounter, sendsToday } from '../src/send/gate.js'
import { withTempDir } from './helpers.js'

/**
 * task-39: archive/unarchive/pin/unpin/mute/unmute/unread must cost zero cap
 * units. Chat-state visible only to the account owner is not the "burst
 * message to people who did not expect it" risk the caps exist to bound
 * (D13a's own argument for why `read` - a different verb - IS budgeted).
 *
 * `trust.test.ts` proves the fence holds these RPCs to one file; it does not
 * prove the cap accounting is right. This does, behaviorally.
 */

function stateClient(): TelegramClient {
  return {
    archiveChats: () => Promise.resolve(),
    unarchiveChats: () => Promise.resolve(),
    markChatUnread: () => Promise.resolve(),
    resolvePeer: () => Promise.resolve({}),
    call: () => Promise.resolve({}),
    sendText: () => Promise.resolve({ id: 1 })
  } as unknown as TelegramClient
}

test('eval-141 six chat-state actions in one run cost nothing, a 6th real send is still capped', async () => {
  await withTempDir(async () => {
    resetRunCounter()
    const tg = stateClient()
    const peer = 555
    const yes = { yes: true }

    // Six chat-state actions - well past MAX_SENDS_PER_RUN (5) - all succeed.
    await archiveChat(tg, peer, yes)
    await unarchiveChat(tg, peer, yes)
    await pinChat(tg, peer, yes)
    await unpinChat(tg, peer, yes)
    await muteChat(tg, peer, yes)
    await unmuteChat(tg, peer, yes)
    await markUnread(tg, peer, yes)
    assert.equal(sendsToday(readSendLog()), 0, 'chat-state actions must not touch the send budget')

    // Real sends still cap at MAX_SENDS_PER_RUN in the same run.
    for (let i = 0; i < MAX_SENDS_PER_RUN; i++) {
      await sendText(tg, peer, 'hi', yes)
    }
    await assert.rejects(
      () => sendText(tg, peer, 'one too many', yes),
      /cap/i
    )
  })
})
