import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tl } from '@mtcute/node'
import { withFloodWaitHandling } from '../src/utils/flood-wait.js'
import { fetchMessages } from '../src/messages/fetch.js'
import { syncChats } from '../src/sync/index.js'
import { saveState } from '../src/sync/state.js'
import { writeChatFile } from '../src/messages/writer.js'
import { handleChalkError, handlePlainError } from '../src/cli/errors.js'
import { makeMessage, makeMockClient, withTempDir } from './helpers.js'

test('withFloodWaitHandling uses buffer when waiting', async () => {
  const originalSetTimeout = global.setTimeout
  const delays: number[] = []
  global.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number) => {
    if (typeof ms === 'number') delays.push(ms)
    fn()
    return 0 as unknown as NodeJS.Timeout
  }) as typeof setTimeout

  try {
    let attempts = 0
    const result = await withFloodWaitHandling(async () => {
      attempts += 1
      if (attempts === 1) {
        throw tl.RpcError.fromTl({ errorCode: 420, errorMessage: 'FLOOD_WAIT_1' })
      }
      return 'ok'
    })
    assert.equal(result, 'ok')
    assert.equal(delays[0], 2000)
  } finally {
    global.setTimeout = originalSetTimeout
  }
})

test('fetchMessages applies rate limiting delay', async () => {
  await withTempDir(async () => {
    const originalSetTimeout = global.setTimeout
    const originalRandom = Math.random
    const delays: number[] = []
    global.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number) => {
      if (typeof ms === 'number') delays.push(ms)
      fn()
      return 0 as unknown as NodeJS.Timeout
    }) as typeof setTimeout
    Math.random = () => 0

    try {
      const messages = Array.from({ length: 100 }, (_, i) =>
        makeMessage({ id: i + 1, date: new Date(Date.UTC(2025, 0, 1, 0, 0, i)) })
      )
      const client = makeMockClient({ 1: messages })
      let progressCount = 0
      for await (const _ of fetchMessages(client, 1, {
        onProgress: (count) => { progressCount = count }
      })) {
        // consume
      }
      assert.equal(progressCount, 100)
      assert.equal(delays[0], 1500)
    } finally {
      global.setTimeout = originalSetTimeout
      Math.random = originalRandom
    }
  })
})

test('sync updates state and appends to existing archive', async () => {
  await withTempDir(async () => {
    const initialMessage = makeMessage({
      id: 1,
      date: new Date(Date.UTC(2025, 0, 1, 0, 0, 0)),
      text: 'Initial'
    })
    await writeChatFile('Chat 10', 10, [initialMessage])
    saveState({
      version: 1,
      chats: {
        10: {
          lastMessageId: 1,
          lastSyncedAt: new Date().toISOString(),
          chatName: 'Chat 10'
        }
      },
      recency: {
        recent: { cutoff: null, chats: {} },
        historical: { cutoff: null, chats: {} }
      },
      folders: {}
    })

    const newMessage = makeMessage({
      id: 2,
      date: new Date(Date.UTC(2025, 0, 2, 0, 0, 0)),
      text: 'New'
    })
    const client = makeMockClient({
      10: [newMessage]
    })
    await syncChats(client, {
      trackedFolderIds: [1],
      trackedChatIds: [10]
    })

    const archiveContent = readFileSync(join('data', 'archive', 'chat-10_10.md'), 'utf-8')
    assert.ok(archiveContent.includes('Initial'))
    assert.ok(archiveContent.includes('New'))

    const state = JSON.parse(readFileSync(join('data', 'archive', 'sync-state.json'), 'utf-8')) as {
      chats: Record<string, { lastMessageId: number }>
    }
    assert.equal(state.chats['10']?.lastMessageId, 2)
  })
})

test('error handlers include stack traces', () => {
  const originalError = console.error
  // eslint-disable-next-line @typescript-eslint/unbound-method -- stashed to restore the property, never called detached
  const originalExit = process.exit
  const errors: string[] = []

  console.error = ((message?: unknown) => {
    errors.push(String(message))
  }) as typeof console.error
  process.exit = ((code?: number) => {
    throw new Error(`exit:${code ?? 0}`)
  })

  try {
    const err = new Error('boom')
    err.stack = 'Error: boom\n    at src/index.ts:1:1'
    assert.throws(() => handleChalkError(err))
    assert.ok(errors.some(line => line.includes('src/index.ts')))

    errors.length = 0
    assert.throws(() => handlePlainError(err))
    assert.ok(errors.some(line => line.includes('src/index.ts')))
  } finally {
    console.error = originalError
    process.exit = originalExit
  }
})
