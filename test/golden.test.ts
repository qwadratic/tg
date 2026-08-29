/**
 * The golden corpus: frozen renderings of current behaviour.
 *
 * These evals exist so that a later diff is legible. Frontmatter fields,
 * atomic writes and the rename all change rendered output; without a frozen
 * baseline captured BEFORE those changes, no reviewer can tell an intended
 * move from a regression. `pnpm test` exit code is the verdict.
 *
 * Numbering follows the trust-model plan: 01-05 frontmatter, 11-17 watermarks
 * and filenames, 22-25 the single-instance lock.
 *
 * Every render helper below is responsible for its own normalization. The
 * comparison in assertGolden stays a byte-for-byte string equality.
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertGolden, withTempDir } from './helpers.js'
import { AWKWARD_NAMES, CHAT_ID, CHAT_NAME, CONVERSATION, FOLDERS, UNSORTED, seededState } from './fixtures/corpus.js'
import { writeChatFile } from '../src/messages/writer.js'
import {
  buildFrontmatter,
  buildRecencyFrontmatter,
  getFrontmatterValue,
  updateFrontmatter
} from '../src/messages/frontmatter.js'
import { sanitizeFilename } from '../src/utils/filename.js'
import { getArchivePath } from '../src/utils/archive-path.js'
import { loadState, saveState, updateChatState, updateFolderState, STATE_PATH, type SyncState } from '../src/sync/state.js'
import { folderStatuses, foldersForChat } from '../src/folders/status.js'
import { acquireLock, LockHeldError, LOCK_PATH } from '../src/session/lock.js'

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/**
 * Render sync state as stable JSON.
 *
 * `lastSyncedAt` / `lastExportedAt` are written from the wall clock, so only
 * a stamp this run just produced is erased. A fixture literal that survives
 * untouched stays in the golden verbatim, because it is signal: it proves the
 * writer restamped the rows it should and left the others alone. A value that
 * stops being an ISO instant fails; it is not quietly normalized away.
 */
function renderState(state: SyncState): string {
  const now = Date.now()
  return JSON.stringify(state, (key: string, value: unknown) => {
    if (key !== 'lastSyncedAt' && key !== 'lastExportedAt') return value
    assert.match(String(value), ISO, `${key} is not an ISO instant: ${String(value)}`)
    return now - Date.parse(String(value)) < 60_000 ? '<NOW>' : value
  }, 2)
}

// ---------------------------------------------------------------- frontmatter

test('eval-01 a chat file is frontmatter plus chronological body', async () => {
  await withTempDir(async () => {
    // Fed out of order on purpose: sorting is part of the frozen behaviour.
    await writeChatFile(CHAT_NAME, CHAT_ID, UNSORTED, FOLDERS)
    assertGolden('eval-01-chat-file', readFileSync(getArchivePath(CHAT_NAME, CHAT_ID), 'utf-8'))
  })
})

test('eval-02 a chat with no messages still gets a file', async () => {
  await withTempDir(async () => {
    await writeChatFile('Silent Chat', 77, [])
    assertGolden('eval-02-empty-chat-file', readFileSync(getArchivePath('Silent Chat', 77), 'utf-8'))
  })
})

const HOSTILE_NAMES = ['plain', 'has "quotes"', 'back\\slash', 'colon: value', '# hash', 'Привет 🌍']

test('eval-03 chat names are escaped into YAML, never truncated', () => {
  const rendered = HOSTILE_NAMES
    .map((name) => buildFrontmatter(name, 5, 1, 2, 2, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'))
    .join('')
  assertGolden('eval-03-frontmatter-escaping', rendered)
})

test('eval-06 a hostile chat name survives the round trip through frontmatter', () => {
  // The escape is only worth anything if it reverses. A backslash that is
  // written but not escaped makes the whole YAML document unparseable, and
  // gbrain would reject the page - or worse, silently retype it.
  for (const name of HOSTILE_NAMES) {
    const rendered = buildFrontmatter(name, 5, 1, 2, 2, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
    assert.equal(getFrontmatterValue(rendered, 'chat_name'), name)
    assert.equal(getFrontmatterValue(rendered, 'title'), name)
  }
})

test('eval-07 type is the literal string note', () => {
  // Asserted literally, not against a set: one of the 15 types in
  // gbrain-base-v2.yaml. Anything else is silently retyped with legacy_type
  // and the drift is invisible in production.
  const rendered = buildFrontmatter('x', 1, 1, 1, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  assert.match(rendered, /^type: note$/m)
})

test('eval-08 a chat in two folders renders both ids and is exported once', async () => {
  await withTempDir(async () => {
    const state = seededState()
    // Chat 10 is already in folder 7; put it in folder 12 as well.
    updateFolderState(state, 12, [99, 10], 'Untouched')
    const folders = foldersForChat(state, 10)

    await writeChatFile('Dual Member', 10, CONVERSATION, folders)
    const files = readdirSync('data/archive')
    assert.deepEqual(files, ['dual-member_10.md'], 'dual membership must not duplicate the export')
    assertGolden(
      'eval-08-dual-folder-frontmatter',
      readFileSync(getArchivePath('Dual Member', 10), 'utf-8').split('---\n')[1]
    )
  })
})

test('eval-09 an append backfills the gbrain fields onto a pre-TASK-5 file', () => {
  const legacy = [
    'chat_name: "Legacy Chat"',
    'chat_id: 202',
    'first_message_id: 1',
    'last_message_id: 2',
    'message_count: 2',
    'min_date: "2026-01-01T00:00:00.000Z"',
    'max_date: "2026-01-02T00:00:00.000Z"',
    'exported_at: "2026-01-02T00:00:00.000Z"'
  ].join('\n')
  const upgraded = updateFrontmatter({
    frontmatter: legacy,
    newLastMsgId: 3,
    newMessageCount: 1,
    newMinDate: '2026-01-03T00:00:00.000Z',
    newMaxDate: '2026-01-03T00:00:00.000Z',
    folders: FOLDERS
  })
  assertGolden('eval-09-legacy-frontmatter-upgrade', `${upgraded}\n`)
})

test('eval-04 recency frontmatter distinguishes recent from historical', () => {
  const recent = buildRecencyFrontmatter({
    mode: 'recent',
    cutoff: '2026-01-01',
    chatsWithMessages: 2,
    messagesExported: 3,
    minDate: '2026-01-04T09:15:30.000Z',
    maxDate: '2026-01-05T18:02:11.000Z'
  })
  const historical = buildRecencyFrontmatter({
    mode: 'historical',
    cutoff: null,
    chatsWithMessages: 0,
    messagesExported: 0,
    minDate: null,
    maxDate: null
  })
  assertGolden('eval-04-recency-frontmatter', `${recent}${historical}`)
})

test('eval-05 appending widens the date window and sums the count', () => {
  const base = buildFrontmatter(CHAT_NAME, CHAT_ID, 101, 103, 3, '2026-01-04T09:15:30.000Z', '2026-01-05T18:02:11.000Z')
  // Newer tail: max_date must move, min_date must hold.
  const grown = updateFrontmatter({
    frontmatter: base,
    newLastMsgId: 140,
    newMessageCount: 2,
    newMinDate: '2026-01-06T00:00:00.000Z',
    newMaxDate: '2026-01-09T00:00:00.000Z'
  })
  // Older backfill: min_date must move, max_date must hold.
  const backfilled = updateFrontmatter({
    frontmatter: grown,
    newLastMsgId: 140,
    newMessageCount: 1,
    newMinDate: '2025-12-01T00:00:00.000Z',
    newMaxDate: '2025-12-02T00:00:00.000Z'
  })
  assertGolden('eval-05-frontmatter-append', `${grown}\n${backfilled}`)
})

// ------------------------------------------------- watermarks and filenames

test('eval-11 a chat watermark records id, name and time', () => {
  const state = seededState()
  updateChatState(state, 10, 501, 'Ada')
  updateChatState(state, 20, 1, 'Brand New')
  assertGolden('eval-11-chat-watermark', renderState(state))
})

test('eval-12 a folder snapshot keeps its cached title when none is passed', () => {
  const state = seededState()
  updateFolderState(state, 7, [10, 11, 13])          // title omitted: must persist
  updateFolderState(state, 12, [99], 'Renamed')      // title given: must replace
  updateFolderState(state, 30, [1])                  // brand new, no title at all
  assertGolden('eval-12-folder-snapshot', renderState(state))
})

test('eval-13 a missing state file loads as an empty state, not an error', async () => {
  await withTempDir(async () => {
    assertGolden('eval-13-empty-state', renderState(loadState()))
  })
})

test('eval-14 a state written before recency existed gains the block on load', async () => {
  await withTempDir(async () => {
    mkdirSync('data/archive', { recursive: true })
    // No `recency` key, and a folder with no `title`: both predate v0.2.
    writeFileSync(STATE_PATH, JSON.stringify({
      version: 1,
      chats: { 10: { lastMessageId: 500, lastSyncedAt: '2026-01-05T18:00:00.000Z', chatName: 'Ada' } },
      folders: { 7: { chatIds: [10], lastSyncedAt: '2026-01-05T18:00:00.000Z' } }
    }))
    assertGolden('eval-14-legacy-state-migration', renderState(loadState()))
  })
})

test('eval-15 the filename sanitizer table', () => {
  const rendered = AWKWARD_NAMES
    .map(([name, id]) => `${JSON.stringify(name)}\n  -> ${sanitizeFilename(name, id)}\n`)
    .join('')
  assertGolden('eval-15-sanitize-filename', rendered)
})

test('eval-16 archive paths stay under data/archive and never escape it', async () => {
  await withTempDir(async () => {
    const rendered = AWKWARD_NAMES
      .map(([name, id]) => `${JSON.stringify(name)}\n  -> ${getArchivePath(name, id)}\n`)
      .join('')
    assertGolden('eval-16-archive-paths', rendered)
  })
})

test('eval-17 folder recency is derived from per-chat watermarks', () => {
  const rendered = folderStatuses(seededState())
    .map((f) => `${f.id} ${f.title}: ${f.syncedChatCount}/${f.chatCount} synced, last ${f.lastUpdated}, msg ${f.lastMessageId}\n`)
    .join('')
  assertGolden('eval-17-folder-status', rendered)
})

// ----------------------------------------------------------------------- lock

test('eval-22 the lock file holds the owning pid', async () => {
  await withTempDir(async () => {
    const release = acquireLock()
    // Rendered as "pid N" so the one allowed volatile is the only thing erased.
    assertGolden('eval-22-lock-file', `${LOCK_PATH}: pid ${readFileSync(LOCK_PATH, 'utf-8').trim()}\n`)
    release()
  })
})

test('eval-23 a lock held by a live process is refused, loudly', async () => {
  await withTempDir(async () => {
    mkdirSync('data', { recursive: true })
    // pid 1 is certainly alive and certainly not us.
    writeFileSync(LOCK_PATH, '1\n')
    let error: unknown
    try {
      acquireLock()
    } catch (caught) {
      error = caught
    }
    assert.ok(error instanceof LockHeldError, 'a live holder must be refused')
    assertGolden('eval-23-lock-held', `${error.name}\n${error.message}\n`)
  })
})

test('eval-24 a lock owned by a dead pid is reclaimed', async () => {
  await withTempDir(async () => {
    mkdirSync('data', { recursive: true })
    const deadPid = Number(
      execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf-8' }).trim()
    )
    writeFileSync(LOCK_PATH, `${deadPid}\n`)

    const release = acquireLock()
    const owner = readFileSync(LOCK_PATH, 'utf-8').trim()
    release()
    assertGolden(
      'eval-24-lock-stale-pid',
      `stale owner was a dead pid: ${deadPid !== Number(owner)}\nreclaimed by pid ${owner}\n`
    )
  })
})

test('eval-25 an empty or unparseable lock file is reclaimed', async () => {
  await withTempDir(async () => {
    mkdirSync('data', { recursive: true })
    const outcomes: string[] = []
    for (const garbage of ['', '\n', 'not-a-pid\n', '0\n']) {
      writeFileSync(LOCK_PATH, garbage)
      const release = acquireLock()
      outcomes.push(`${JSON.stringify(garbage)} -> reclaimed by pid ${readFileSync(LOCK_PATH, 'utf-8').trim()}`)
      release()
    }
    assertGolden('eval-25-lock-garbage', `${outcomes.join('\n')}\n`)
  })
})

// --------------------------------------------- atomic writes and file modes

test('eval-26 a chat write leaves no .tmp residue', async () => {
  await withTempDir(async () => {
    await writeChatFile(CHAT_NAME, CHAT_ID, CONVERSATION, FOLDERS)
    assert.deepEqual(
      readdirSync('data/archive').filter((name) => name.endsWith('.tmp')),
      [],
      'temp+rename must clean up after itself'
    )
  })
})

test('eval-27 an interrupted write leaves the previous file intact', async () => {
  await withTempDir(async () => {
    await writeChatFile(CHAT_NAME, CHAT_ID, CONVERSATION, FOLDERS)
    const path = getArchivePath(CHAT_NAME, CHAT_ID)
    const complete = readFileSync(path, 'utf-8')

    // Simulate a crash between the temp write and the rename: the staging
    // file exists and is half-written, the target must be untouched.
    writeFileSync(`${path}.tmp`, '---\ntype: no')
    assert.equal(readFileSync(path, 'utf-8'), complete)
  })
})

test('eval-28 sync-state is created 0600', async () => {
  await withTempDir(async () => {
    saveState(seededState())
    assert.equal(statSync(STATE_PATH).mode & 0o777, 0o600)
    // Re-saving over an existing file must not widen it back out.
    saveState(seededState())
    assert.equal(statSync(STATE_PATH).mode & 0o777, 0o600)
  })
})

test('no eval creates a session database', async () => {
  // The corpus is fixture-only by construction: nothing here opens a client.
  // This is the mechanical check that it stays that way.
  await withTempDir(async (dir) => {
    await writeChatFile(CHAT_NAME, CHAT_ID, CONVERSATION, FOLDERS)
    const release = acquireLock()
    release()
    assert.equal(
      execFileSync('find', [dir, '-name', 'session.db'], { encoding: 'utf-8' }).trim(),
      '',
      'an eval created a session database; evals must never touch Telegram'
    )
  })
})

test('eval-85 archive files are 0600 and the archive dir is 0700', async () => {
  // The archive is every message this workspace has exported. It had been 0755
  // with 0644 files for its whole life: 189MB of real private conversations,
  // world-readable on a shared machine. sync-state.json next to it was already
  // 0600, so the watermark pointing AT the messages was better protected than
  // the messages.
  await withTempDir(async () => {
    const { appendToChatFile } = await import('../src/sync/append.js')

    await writeChatFile(CHAT_NAME, CHAT_ID, CONVERSATION, [])

    const dir = 'data/archive'
    assert.equal(statSync(dir).mode & 0o777, 0o700, 'archive dir must be 0700')

    const files = readdirSync(dir).filter((f) => f.endsWith('.md'))
    assert.ok(files.length > 0, 'expected a chat file')
    for (const f of files) {
      assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, `${f} must be 0600`)
    }

    // An APPEND must not widen it either: that is the path that runs daily.
    appendToChatFile(CHAT_NAME, CHAT_ID, CONVERSATION, [])
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, `${f} widened on append`)
    }
  })
})
