import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { acquireLock, LockHeldError, LOCK_PATH } from '../src/session/lock.js'
import { peerCacheStats, SESSION_DB_PATH } from '../src/session/cache.js'
import { EncryptedSqliteStorage } from '../src/storage/encrypted.js'
import { folderStatuses, relativeTime } from '../src/folders/status.js'
import { readSecret } from '../src/session/psst.js'
import { canPrompt } from '../src/session/index.js'
import { updateChatState, updateFolderState, type SyncState } from '../src/sync/state.js'
import { withTempDir } from './helpers.js'

function emptyState(): SyncState {
  return {
    version: 1,
    chats: {},
    recency: { recent: { cutoff: null, chats: {} }, historical: { cutoff: null, chats: {} } },
    folders: {}
  }
}

test('peer cache reports mtcute timestamps as real dates', async () => {
  await withTempDir(async (dir) => {
    // A real encrypted db, because the sqlite read is the part that regressed.
    const path = join(dir, 'session.db')
    const key = 'test-key'
    // mtcute writes `updated` in unix MILLISECONDS. Treating it as seconds
    // dated the peer cache to the year 58562 in `session status`.
    const updated = 1785889250803

    const db = new Database(path)
    db.pragma(`key='${key}'`)
    db.exec('create table peers (id integer primary key, updated integer)')
    db.prepare('insert into peers (id, updated) values (?, ?)').run(1, updated - 1000)
    db.prepare('insert into peers (id, updated) values (?, ?)').run(2, updated)
    db.close()

    const stats = peerCacheStats(key, path)
    assert.equal(stats.count, 2)
    assert.equal(stats.lastUpdated, new Date(updated).toISOString())
    // The actual bug: any scaling lands outside the range a clock can produce.
    assert.ok(
      new Date(stats.lastUpdated).getUTCFullYear() < 3000,
      `peer cache timestamp is not a plausible date: ${stats.lastUpdated}`
    )
  })
})

test('peer cache is empty, not a crash, when there is no db', () => {
  assert.deepEqual(peerCacheStats('unused', 'definitely/missing.db'), {
    count: 0,
    lastUpdated: null
  })
})

test('single-instance lock admits one holder and survives release', async () => {
  await withTempDir(async () => {
    const release = acquireLock()
    assert.ok(existsSync(LOCK_PATH), 'lock file should exist while held')
    assert.equal(readFileSync(LOCK_PATH, 'utf-8').trim(), String(process.pid))

    // A second acquire from a *live* pid must be refused. The lock records our
    // own pid, so we simulate a different live process by rewriting the file
    // with a pid that is certainly running: pid 1.
    writeFileSync(LOCK_PATH, '1\n')
    assert.throws(() => acquireLock(), LockHeldError)

    release()
    assert.equal(existsSync(LOCK_PATH), false, 'release should remove the lock file')

    // Releasing twice is a no-op, not a crash.
    release()
  })
})

test('lock reclaims a stale file left by a dead process', async () => {
  await withTempDir(async () => {
    mkdirSync('data', { recursive: true })

    // A pid that has certainly exited: spawn a process and let it finish.
    const deadPid = Number(
      execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf-8' }).trim()
    )
    writeFileSync(LOCK_PATH, `${deadPid}\n`)

    const release = acquireLock()
    assert.equal(readFileSync(LOCK_PATH, 'utf-8').trim(), String(process.pid))
    release()
  })
})

test('lock treats an empty or garbage file as stale', async () => {
  await withTempDir(async () => {
    mkdirSync('data', { recursive: true })
    writeFileSync(LOCK_PATH, '')

    const release = acquireLock()
    assert.equal(readFileSync(LOCK_PATH, 'utf-8').trim(), String(process.pid))
    release()
  })
})

test('folder statuses sort by last update, newest first, never-synced last', () => {
  const state = emptyState()
  updateFolderState(state, 1, [10, 11], 'Work')
  updateFolderState(state, 2, [20], 'Family')
  updateFolderState(state, 3, [30], 'Archive')

  updateChatState(state, 10, 500, 'Standup')
  state.chats[10].lastSyncedAt = '2026-02-01T10:00:00.000Z'
  updateChatState(state, 11, 900, 'Design')
  state.chats[11].lastSyncedAt = '2026-02-03T10:00:00.000Z'
  updateChatState(state, 20, 42, 'Mum')
  state.chats[20].lastSyncedAt = '2026-02-05T10:00:00.000Z'
  // Folder 3's chat was never exported.

  const statuses = folderStatuses(state)
  assert.deepEqual(statuses.map((f) => f.title), ['Family', 'Work', 'Archive'])

  const work = statuses.find((f) => f.title === 'Work')!
  assert.equal(work.chatCount, 2)
  assert.equal(work.syncedChatCount, 2)
  // Folder recency is the newest of its chats, not the oldest or an average.
  assert.equal(work.lastUpdated, '2026-02-03T10:00:00.000Z')
  assert.equal(work.lastMessageId, 900)

  const archive = statuses.find((f) => f.title === 'Archive')!
  assert.equal(archive.lastUpdated, null)
  assert.equal(archive.syncedChatCount, 0)
})

test('folder titles survive a state written before titles existed', () => {
  const state = emptyState()
  // Simulate an old on-disk state: membership but no title.
  state.folders[7] = { chatIds: [70], lastSyncedAt: '2026-01-01T00:00:00.000Z' }

  assert.equal(folderStatuses(state)[0].title, 'folder 7')

  updateFolderState(state, 7, [70], 'Reading')
  assert.equal(folderStatuses(state)[0].title, 'Reading')
  // A later refresh that omits the title must not erase it.
  updateFolderState(state, 7, [70, 71])
  assert.equal(folderStatuses(state)[0].title, 'Reading')
})

test('relativeTime renders coarse buckets and handles never', () => {
  const now = Date.parse('2026-02-05T12:00:00.000Z')
  assert.equal(relativeTime(null, now), 'never')
  assert.equal(relativeTime('2026-02-05T11:59:30.000Z', now), 'just now')
  assert.equal(relativeTime('2026-02-05T11:20:00.000Z', now), '40m ago')
  assert.equal(relativeTime('2026-02-05T07:00:00.000Z', now), '5h ago')
  assert.equal(relativeTime('2026-02-01T12:00:00.000Z', now), '4d ago')
  assert.equal(relativeTime('not-a-date', now), 'unknown')
})

test('readSecret prefers an injected env var and reports absence as null', () => {
  const name = 'TG_TEST_SECRET_DO_NOT_STORE'
  process.env[name] = '  injected-value  '
  try {
    assert.equal(readSecret(name), 'injected-value', 'env injection should win and be trimmed')
  } finally {
    delete process.env[name]
  }

  // Absent everywhere: no vault entry, and possibly no psst at all. Either way
  // the contract is null rather than a throw, so callers can fall back.
  assert.equal(readSecret('TG_TEST_SECRET_THAT_IS_NEVER_SET'), null)
})

test('TG_NON_INTERACTIVE gates prompting, and the old name is dead', () => {
  // canPrompt needs a tty to have anything to suppress.
  const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
  const before = { ...process.env }

  try {
    delete process.env.TG_NON_INTERACTIVE
    delete process.env.SYMBIOTIC_NON_INTERACTIVE
    assert.equal(canPrompt(), true, 'a tty with no guard set may prompt')

    // The rename was deliberately hard: no fallback. A reintroduced fallback
    // would be invisible in every other test, so it is asserted here.
    process.env.SYMBIOTIC_NON_INTERACTIVE = '1'
    assert.equal(canPrompt(), true, 'the retired variable must have no effect')

    process.env.TG_NON_INTERACTIVE = '1'
    assert.equal(canPrompt(), false, 'TG_NON_INTERACTIVE=1 must suppress prompting')
  } finally {
    process.env = before
    if (tty) Object.defineProperty(process.stdin, 'isTTY', tty)
    else delete (process.stdin as { isTTY?: boolean }).isTTY
  }
})

test('the session database is created 0600, never 0644', async () => {
  // 0644 on a session cache is precisely the bug found on tg-saved's
  // telegram.session.db, and this file holds a full account credential:
  // whoever reads it is logged in, no password, no 2FA in the way.
  await withTempDir(async () => {
    mkdirSync('data', { recursive: true })
    const storage = new EncryptedSqliteStorage(SESSION_DB_PATH, 'test-key')
    const db = storage._createDatabase() as unknown as { close: () => void }
    try {
      assert.equal(statSync(SESSION_DB_PATH).mode & 0o777, 0o600)
    } finally {
      db.close()
    }
  })
})
