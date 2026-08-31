import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { formatMessage } from '../src/messages/format.js'
import { exportRecencyChats } from '../src/messages/recency.js'
import { buildRecencyFrontmatter } from '../src/messages/frontmatter.js'
import { sanitizeFilename } from '../src/utils/filename.js'
import { loadConfig } from '../src/config/index.js'
import { normalizePhoneInput, parseCutoffDate } from '../src/cli/args.js'
import { makeMessage, makeMockClient, withTempDir } from './helpers.js'

test('formatMessage includes forward and reply context', () => {
  const message = makeMessage({
    id: 10,
    date: new Date(Date.UTC(2025, 0, 2, 3, 4, 5)),
    forwardName: 'Forward Source',
    replyToId: 9,
    replyQuote: 'Quoted reply',
    text: 'Body'
  })

  const formatted = formatMessage(message)
  assert.ok(formatted.includes('Forwarded from: Forward Source'))
  assert.ok(formatted.includes('In reply to [id:9]: "Quoted reply"'))
  assert.ok(formatted.includes('Body'))
})

test('sanitizeFilename removes invalid chars and falls back', () => {
  assert.equal(sanitizeFilename('A/B:C*D?', 1), 'abcd_1')
  assert.equal(sanitizeFilename('   ', 123), 'chat_123')
  assert.equal(sanitizeFilename('Hello  World', 2), 'hello-world_2')
})

test('parseCutoffDate validates YYYY-MM-DD', () => {
  const valid = parseCutoffDate('2025-02-10')
  assert.ok(valid)
  assert.equal(valid?.getFullYear(), 2025)
  assert.equal(valid?.getMonth(), 1)
  assert.equal(valid?.getDate(), 10)
  assert.ok(parseCutoffDate('today'))
  assert.ok(parseCutoffDate('yesterday'))
  assert.ok(parseCutoffDate('start-of-week'))
  assert.ok(parseCutoffDate('start-of-month'))
  assert.ok(parseCutoffDate('start-of-year'))
  assert.ok(parseCutoffDate('last-7-days'))
  assert.equal(parseCutoffDate('2025-13-01'), null)
  assert.equal(parseCutoffDate('2025-02-31'), null)
  assert.equal(parseCutoffDate('bad'), null)
})

test('normalizePhoneInput strips non-digits and keeps plus', () => {
  assert.equal(normalizePhoneInput(' +1 (234) 567-8900 '), '+12345678900')
  assert.equal(normalizePhoneInput(''), '')
  assert.equal(normalizePhoneInput('abc'), '')
})

test('exportRecencyChats writes combined archive with cutoff', async () => {
  await withTempDir(async () => {
    const client = makeMockClient({
      1: [
        makeMessage({ id: 1, date: new Date(Date.UTC(2025, 0, 1, 0, 0, 0)) }),
        makeMessage({ id: 2, date: new Date(Date.UTC(2025, 0, 3, 0, 0, 0)) }),
      ]
    })

    const result = await exportRecencyChats(
      client,
      { trackedFolderIds: [1], trackedChatIds: [1] },
      new Date(Date.UTC(2025, 0, 2, 0, 0, 0)),
      'recent',
      '2025-01-02'
    )

    const content = readFileSync(result.outputPath, 'utf-8')
    assert.ok(content.includes('export_kind: "recent"'))
    assert.ok(content.includes('cutoff_date: "2025-01-02"'))
    assert.ok(content.includes('Chat 1 (1)'))
    assert.ok(content.includes('[2025-01-03 00:00:00 UTC]'))
    assert.ok(!content.includes('[2025-01-01 00:00:00 UTC]'))
  })
})

test('exportRecencyChats writes historical archive with cutoff', async () => {
  await withTempDir(async () => {
    const client = makeMockClient({
      1: [
        makeMessage({ id: 1, date: new Date(Date.UTC(2025, 0, 1, 0, 0, 0)) }),
        makeMessage({ id: 2, date: new Date(Date.UTC(2025, 0, 3, 0, 0, 0)) }),
      ]
    })

    const result = await exportRecencyChats(
      client,
      { trackedFolderIds: [1], trackedChatIds: [1] },
      new Date(Date.UTC(2025, 0, 2, 0, 0, 0)),
      'historical',
      '2025-01-02'
    )

    const content = readFileSync(result.outputPath, 'utf-8')
    assert.ok(content.includes('export_kind: "historical"'))
    assert.ok(content.includes('cutoff_date: "2025-01-02"'))
    assert.ok(content.includes('Chat 1 (1)'))
    assert.ok(content.includes('[2025-01-01 00:00:00 UTC]'))
    assert.ok(!content.includes('[2025-01-03 00:00:00 UTC]'))
  })
})

test('exportRecencyChats allows historical export without cutoff', async () => {
  await withTempDir(async () => {
    const client = makeMockClient({
      1: [
        makeMessage({ id: 1, date: new Date(Date.UTC(2025, 0, 1, 0, 0, 0)) }),
        makeMessage({ id: 2, date: new Date(Date.UTC(2025, 0, 3, 0, 0, 0)) }),
      ]
    })

    const result = await exportRecencyChats(
      client,
      { trackedFolderIds: [1], trackedChatIds: [1] },
      null,
      'historical',
      null
    )

    const content = readFileSync(result.outputPath, 'utf-8')
    assert.ok(content.includes('export_kind: "historical"'))
    assert.ok(content.includes('cutoff_date: null'))
    assert.ok(content.includes('Chat 1 (1)'))
    assert.ok(content.includes('[2025-01-01 00:00:00 UTC]'))
    assert.ok(content.includes('[2025-01-03 00:00:00 UTC]'))
  })
})

test('exportRecencyChats appends to recent when cutoff unchanged', async () => {
  await withTempDir(async () => {
    const archiveDir = join('data', 'archive')
    mkdirSync(archiveDir, { recursive: true })

    const initialMessage = makeMessage({
      id: 1,
      date: new Date(Date.UTC(2025, 0, 2, 0, 0, 0)),
      text: 'Initial'
    })
    const initialSection = `## Chat: Chat 1 (1)\n\n${formatMessage(initialMessage)}`
    const initialFrontmatter = buildRecencyFrontmatter({
      mode: 'recent',
      cutoff: '2025-01-02',
      chatsWithMessages: 1,
      messagesExported: 1,
      minDate: initialMessage.date.toISOString(),
      maxDate: initialMessage.date.toISOString()
    })
    writeFileSync(join(archiveDir, 'recent.md'), `${initialFrontmatter}${initialSection}`, 'utf-8')

    writeFileSync(
      join(archiveDir, 'sync-state.json'),
      JSON.stringify({
        version: 1,
        chats: {},
        recency: {
          recent: { cutoff: '2025-01-02', chats: { 1: { lastMessageId: 1, lastExportedAt: new Date().toISOString() } } },
          historical: { cutoff: null, chats: {} }
        },
        folders: {}
      }, null, 2)
    )

    const client = makeMockClient({
      1: [
        makeMessage({ id: 2, date: new Date(Date.UTC(2025, 0, 3, 0, 0, 0)), text: 'Newer' })
      ]
    })

    const result = await exportRecencyChats(
      client,
      { trackedFolderIds: [1], trackedChatIds: [1] },
      new Date(2025, 0, 2),
      'recent',
      '2025-01-02'
    )

    const content = readFileSync(result.outputPath, 'utf-8')
    assert.ok(content.includes('Initial'))
    assert.ok(content.includes('Newer'))
    assert.equal((content.match(/^## Chat:/gm) ?? []).length, 1)
    assert.ok(/message_count:\s+2/.test(content))
  })
})

test('exportRecencyChats rejects decreasing cutoff', async () => {
  await withTempDir(async () => {
    const archiveDir = join('data', 'archive')
    mkdirSync(archiveDir, { recursive: true })
    writeFileSync(
      join(archiveDir, 'sync-state.json'),
      JSON.stringify({
        version: 1,
        chats: {},
        recency: {
          recent: { cutoff: '2025-02-01', chats: {} },
          historical: { cutoff: null, chats: {} }
        },
        folders: {}
      }, null, 2)
    )

    const client = makeMockClient({ 1: [] })
    await assert.rejects(
      () => exportRecencyChats(
        client,
        { trackedFolderIds: [1], trackedChatIds: [1] },
        new Date(2025, 0, 1),
        'recent',
        '2025-01-01'
      ),
      /Cutoff must not move earlier/
    )
  })
})

test('exportRecencyChats keeps no-messages body when empty', async () => {
  await withTempDir(async () => {
    const archiveDir = join('data', 'archive')
    mkdirSync(archiveDir, { recursive: true })
    const frontmatter = buildRecencyFrontmatter({
      mode: 'recent',
      cutoff: '2025-01-02',
      chatsWithMessages: 0,
      messagesExported: 0,
      minDate: null,
      maxDate: null
    })
    writeFileSync(join(archiveDir, 'recent.md'), `${frontmatter}No messages.\n`, 'utf-8')
    writeFileSync(
      join(archiveDir, 'sync-state.json'),
      JSON.stringify({
        version: 1,
        chats: {},
        recency: {
          recent: { cutoff: '2025-01-02', chats: {} },
          historical: { cutoff: null, chats: {} }
        },
        folders: {}
      }, null, 2)
    )

    const client = makeMockClient({ 1: [] })
    const result = await exportRecencyChats(
      client,
      { trackedFolderIds: [1], trackedChatIds: [1] },
      new Date(2025, 0, 2),
      'recent',
      '2025-01-02'
    )

    const content = readFileSync(result.outputPath, 'utf-8')
    assert.ok(content.includes('No messages.'))
  })
})

test('exportRecencyChats appends new chat section when config adds chat', async () => {
  await withTempDir(async () => {
    const archiveDir = join('data', 'archive')
    mkdirSync(archiveDir, { recursive: true })

    const initialMessage = makeMessage({
      id: 1,
      date: new Date(Date.UTC(2025, 0, 2, 0, 0, 0)),
      text: 'Existing'
    })
    const initialSection = `## Chat: Chat 1 (1)\n\n${formatMessage(initialMessage)}`
    const initialFrontmatter = buildRecencyFrontmatter({
      mode: 'recent',
      cutoff: '2025-01-02',
      chatsWithMessages: 1,
      messagesExported: 1,
      minDate: initialMessage.date.toISOString(),
      maxDate: initialMessage.date.toISOString()
    })
    writeFileSync(join(archiveDir, 'recent.md'), `${initialFrontmatter}${initialSection}`, 'utf-8')

    writeFileSync(
      join(archiveDir, 'sync-state.json'),
      JSON.stringify({
        version: 1,
        chats: {},
        recency: {
          recent: { cutoff: '2025-01-02', chats: { 1: { lastMessageId: 1, lastExportedAt: new Date().toISOString() } } },
          historical: { cutoff: null, chats: {} }
        },
        folders: {}
      }, null, 2)
    )

    const client = makeMockClient({
      1: [],
      2: [makeMessage({ id: 1, date: new Date(Date.UTC(2025, 0, 3, 0, 0, 0)), text: 'New chat' })]
    })

    const result = await exportRecencyChats(
      client,
      { trackedFolderIds: [1], trackedChatIds: [1, 2] },
      new Date(2025, 0, 2),
      'recent',
      '2025-01-02'
    )

    const content = readFileSync(result.outputPath, 'utf-8')
    assert.ok(content.includes('Chat 1 (1)'))
    assert.ok(content.includes('Chat 2 (2)'))
    assert.ok(content.includes('New chat'))
    assert.ok(/chats_with_messages:\s+2/.test(content))
  })
})

test('exportRecencyChats appends to middle chat section', async () => {
  await withTempDir(async () => {
    const archiveDir = join('data', 'archive')
    mkdirSync(archiveDir, { recursive: true })

    const chat1Message = makeMessage({
      id: 1,
      date: new Date(Date.UTC(2025, 0, 2, 0, 0, 0)),
      text: 'Chat1'
    })
    const chat2Message = makeMessage({
      id: 1,
      date: new Date(Date.UTC(2025, 0, 2, 1, 0, 0)),
      text: 'Chat2'
    })
    const initialSection1 = `## Chat: Chat 1 (1)\n\n${formatMessage(chat1Message)}`
    const initialSection2 = `## Chat: Chat 2 (2)\n\n${formatMessage(chat2Message)}`
    const initialFrontmatter = buildRecencyFrontmatter({
      mode: 'recent',
      cutoff: '2025-01-02',
      chatsWithMessages: 2,
      messagesExported: 2,
      minDate: chat1Message.date.toISOString(),
      maxDate: chat2Message.date.toISOString()
    })
    writeFileSync(
      join(archiveDir, 'recent.md'),
      `${initialFrontmatter}${initialSection1}\n${initialSection2}`,
      'utf-8'
    )

    writeFileSync(
      join(archiveDir, 'sync-state.json'),
      JSON.stringify({
        version: 1,
        chats: {},
        recency: {
          recent: {
            cutoff: '2025-01-02',
            chats: {
              1: { lastMessageId: 1, lastExportedAt: new Date().toISOString() },
              2: { lastMessageId: 1, lastExportedAt: new Date().toISOString() }
            }
          },
          historical: { cutoff: null, chats: {} }
        },
        folders: {}
      }, null, 2)
    )

    const client = makeMockClient({
      1: [makeMessage({ id: 2, date: new Date(Date.UTC(2025, 0, 3, 0, 0, 0)), text: 'Chat1 New' })],
      2: []
    })

    const result = await exportRecencyChats(
      client,
      { trackedFolderIds: [1], trackedChatIds: [1, 2] },
      new Date(2025, 0, 2),
      'recent',
      '2025-01-02'
    )

    const content = readFileSync(result.outputPath, 'utf-8')
    const chat1Index = content.indexOf('## Chat: Chat 1 (1)')
    const chat2Index = content.indexOf('## Chat: Chat 2 (2)')
    const newIndex = content.indexOf('Chat1 New')
    assert.ok(chat1Index >= 0 && chat2Index > chat1Index)
    assert.ok(newIndex > chat1Index && newIndex < chat2Index)
  })
})

test('exportRecencyChats rebuilds recent when cutoff moves forward', async () => {
  await withTempDir(async () => {
    const archiveDir = join('data', 'archive')
    mkdirSync(archiveDir, { recursive: true })

    const oldMessage = makeMessage({
      id: 1,
      date: new Date(Date.UTC(2025, 0, 1, 0, 0, 0)),
      text: 'Old'
    })
    const newMessage = makeMessage({
      id: 2,
      date: new Date(Date.UTC(2025, 0, 3, 0, 0, 0)),
      text: 'New'
    })
    const initialSection = `## Chat: Chat 1 (1)\n\n${formatMessage(oldMessage)}${formatMessage(newMessage)}`
    const initialFrontmatter = buildRecencyFrontmatter({
      mode: 'recent',
      cutoff: '2025-01-01',
      chatsWithMessages: 1,
      messagesExported: 2,
      minDate: oldMessage.date.toISOString(),
      maxDate: newMessage.date.toISOString()
    })
    writeFileSync(join(archiveDir, 'recent.md'), `${initialFrontmatter}${initialSection}`, 'utf-8')

    writeFileSync(
      join(archiveDir, 'sync-state.json'),
      JSON.stringify({
        version: 1,
        chats: {},
        recency: {
          recent: { cutoff: '2025-01-01', chats: { 1: { lastMessageId: 2, lastExportedAt: new Date().toISOString() } } },
          historical: { cutoff: null, chats: {} }
        },
        folders: {}
      }, null, 2)
    )

    const client = makeMockClient({ 1: [] })
    const result = await exportRecencyChats(
      client,
      { trackedFolderIds: [1], trackedChatIds: [1] },
      new Date(2025, 0, 2),
      'recent',
      '2025-01-02'
    )

    const content = readFileSync(result.outputPath, 'utf-8')
    assert.ok(content.includes('New'))
    assert.ok(!content.includes('Old'))
    assert.ok(/message_count:\s+1/.test(content))
  })
})

test('exportRecencyChats appends to historical when cutoff moves forward', async () => {
  await withTempDir(async () => {
    const archiveDir = join('data', 'archive')
    mkdirSync(archiveDir, { recursive: true })

    const olderMessage = makeMessage({
      id: 1,
      date: new Date(Date.UTC(2025, 0, 1, 0, 0, 0)),
      text: 'Older'
    })
    const initialSection = `## Chat: Chat 1 (1)\n\n${formatMessage(olderMessage)}`
    const initialFrontmatter = buildRecencyFrontmatter({
      mode: 'historical',
      cutoff: '2025-01-02',
      chatsWithMessages: 1,
      messagesExported: 1,
      minDate: olderMessage.date.toISOString(),
      maxDate: olderMessage.date.toISOString()
    })
    writeFileSync(join(archiveDir, 'historical.md'), `${initialFrontmatter}${initialSection}`, 'utf-8')

    writeFileSync(
      join(archiveDir, 'sync-state.json'),
      JSON.stringify({
        version: 1,
        chats: {},
        recency: {
          recent: { cutoff: null, chats: {} },
          historical: { cutoff: '2025-01-02', chats: { 1: { lastMessageId: 1, lastExportedAt: new Date().toISOString() } } }
        },
        folders: {}
      }, null, 2)
    )

    const client = makeMockClient({
      1: [makeMessage({ id: 2, date: new Date(Date.UTC(2025, 0, 2, 12, 0, 0)), text: 'Added' })]
    })

    const result = await exportRecencyChats(
      client,
      { trackedFolderIds: [1], trackedChatIds: [1] },
      new Date(2025, 0, 3),
      'historical',
      '2025-01-03'
    )

    const content = readFileSync(result.outputPath, 'utf-8')
    assert.ok(content.includes('Older'))
    assert.ok(content.includes('Added'))
    assert.ok(/message_count:\s+2/.test(content))
  })
})

test('exportRecencyChats keeps ordering with overlapping timestamps', async () => {
  await withTempDir(async () => {
    const archiveDir = join('data', 'archive')
    mkdirSync(archiveDir, { recursive: true })

    const chat1Message = makeMessage({
      id: 1,
      date: new Date(Date.UTC(2025, 0, 2, 12, 0, 0)),
      text: 'Chat1 Old'
    })
    const chat2Message = makeMessage({
      id: 1,
      date: new Date(Date.UTC(2025, 0, 2, 12, 0, 0)),
      text: 'Chat2 Old'
    })
    const initialSection1 = `## Chat: Chat 1 (1)\n\n${formatMessage(chat1Message)}`
    const initialSection2 = `## Chat: Chat 2 (2)\n\n${formatMessage(chat2Message)}`
    const initialFrontmatter = buildRecencyFrontmatter({
      mode: 'recent',
      cutoff: '2025-01-02',
      chatsWithMessages: 2,
      messagesExported: 2,
      minDate: chat1Message.date.toISOString(),
      maxDate: chat2Message.date.toISOString()
    })
    writeFileSync(
      join(archiveDir, 'recent.md'),
      `${initialFrontmatter}${initialSection1}\n${initialSection2}`,
      'utf-8'
    )

    writeFileSync(
      join(archiveDir, 'sync-state.json'),
      JSON.stringify({
        version: 1,
        chats: {},
        recency: {
          recent: {
            cutoff: '2025-01-02',
            chats: {
              1: { lastMessageId: 1, lastExportedAt: new Date().toISOString() },
              2: { lastMessageId: 1, lastExportedAt: new Date().toISOString() }
            }
          },
          historical: { cutoff: null, chats: {} }
        },
        folders: {}
      }, null, 2)
    )

    const client = makeMockClient({
      1: [makeMessage({ id: 2, date: new Date(Date.UTC(2025, 0, 2, 12, 0, 0)), text: 'Chat1 New' })],
      2: [makeMessage({ id: 2, date: new Date(Date.UTC(2025, 0, 2, 12, 0, 0)), text: 'Chat2 New' })]
    })

    const result = await exportRecencyChats(
      client,
      { trackedFolderIds: [1], trackedChatIds: [1, 2] },
      new Date(2025, 0, 2),
      'recent',
      '2025-01-02'
    )

    const content = readFileSync(result.outputPath, 'utf-8')
    const chat1Section = content.split('## Chat: Chat 1 (1)')[1]
    const chat2Section = content.split('## Chat: Chat 2 (2)')[1]
    assert.ok(chat1Section?.includes('Chat1 Old'))
    assert.ok(chat1Section?.includes('Chat1 New'))
    assert.ok(chat2Section?.includes('Chat2 Old'))
    assert.ok(chat2Section?.includes('Chat2 New'))
  })
})
test('loadConfig reads tracked ids', async () => {
  await withTempDir(async () => {
    const configDir = join('data')
    mkdirSync(configDir, { recursive: true })
    const configPath = join(configDir, 'config.json')
    writeFileSync(
      configPath,
      JSON.stringify({ trackedFolderIds: [1, 2], trackedChatIds: [10, 20, 30] }, null, 2)
    )
    const config = loadConfig()
    assert.deepEqual(config.trackedFolderIds, [1, 2])
    assert.deepEqual(config.trackedChatIds, [10, 20, 30])
  })
})

test('eval-130 a malformed config is refused instead of silently ignored', async () => {
  await withTempDir(async () => {
    mkdirSync('data', { recursive: true })
    const configPath = join('data', 'config.json')

    // A missing list defaults to empty; the rest of the file survives.
    writeFileSync(configPath, JSON.stringify({ trackedFolderIds: [2], excludeChatIds: [111] }))
    const partial = loadConfig()
    assert.deepEqual(partial.trackedFolderIds, [2])
    assert.deepEqual(partial.trackedChatIds, [])
    assert.deepEqual(partial.excludeChatIds, [111])

    // Quoted ids would disable the exclusion. That must fail loudly.
    writeFileSync(configPath, JSON.stringify({ trackedChatIds: [111], excludeChatIds: ['111'] }))
    assert.throws(() => loadConfig(), /excludeChatIds/)

    writeFileSync(configPath, JSON.stringify({ privateOnly: 'yes' }))
    assert.throws(() => loadConfig(), /privateOnly/)
  })
})
