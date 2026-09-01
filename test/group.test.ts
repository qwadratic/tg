import assert from 'node:assert'
import test from 'node:test'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Message, TelegramClient } from '@mtcute/node'
import {
  createChannel,
  createForumTopic,
  createGroup,
  createInviteLink,
  createSupergroup,
  editForumTopic,
  editInviteLink,
  exportInviteLink,
  setChatColor,
  setChatDescription,
  setChatPhoto,
  setChatStickerSet,
  setChatTitle,
  setChatUsername,
  setContentProtection,
  setForumTopicClosed,
  setForumTopicPinned,
  setJoinRequests,
  setJoinToSend,
  setSlowMode
} from '../src/send/index.js'
import { readSendLog, resetRunCounter, sendsToday } from '../src/send/gate.js'
import {
  listForumTopics,
  listInviteLinks,
  renderForumTopics,
  renderInviteLinks,
  renderInviteMembers
} from '../src/groups/index.js'
import { messageStats, renderDump } from '../src/dump/index.js'
import { withTempDir } from './helpers.js'

/**
 * `tg group` - chat administration behind the same fence as sending (D13c).
 *
 * The point of these evals is not that mtcute works: it is that every one of
 * these verbs goes through the gate, records what it did, and costs zero cap
 * units, so administering a chat can never eat the budget that exists to bound
 * DELIVERED messages.
 */

/** Records every method name and argument list it is asked for. */
function adminClient(): { tg: TelegramClient; calls: [string, unknown[]][] } {
  const calls: [string, unknown[]][] = []
  const record = (name: string) => (...args: unknown[]) => {
    calls.push([name, args])
    return Promise.resolve({ id: 7, link: 'https://t.me/+abc', chat: { id: -100999 } })
  }

  const tg = {
    createGroup: record('createGroup'),
    createChannel: record('createChannel'),
    createSupergroup: record('createSupergroup'),
    setChatTitle: record('setChatTitle'),
    setChatDescription: record('setChatDescription'),
    setChatPhoto: record('setChatPhoto'),
    setChatColor: record('setChatColor'),
    setChatStickerSet: record('setChatStickerSet'),
    setChatUsername: record('setChatUsername'),
    exportInviteLink: record('exportInviteLink'),
    createInviteLink: record('createInviteLink'),
    editInviteLink: record('editInviteLink'),
    createForumTopic: record('createForumTopic'),
    editForumTopic: record('editForumTopic'),
    toggleForumTopicClosed: record('toggleForumTopicClosed'),
    toggleForumTopicPinned: record('toggleForumTopicPinned'),
    setSlowMode: record('setSlowMode'),
    toggleContentProtection: record('toggleContentProtection'),
    toggleJoinRequests: record('toggleJoinRequests'),
    toggleJoinToSend: record('toggleJoinToSend')
  } as unknown as TelegramClient

  return { tg, calls }
}

const YES = { yes: true }
const CHAT = -1001234567890

test('eval-131 every group verb reaches its mtcute method and is logged', async () => {
  await withTempDir(async () => {
    resetRunCounter()
    const { tg, calls } = adminClient()

    await createChannel(tg, 'Ops', { ...YES, description: 'notes' })
    await createSupergroup(tg, 'Ops big', { ...YES, forum: true })
    await createGroup(tg, 'Three of us', [42, 43], YES)
    await setChatTitle(tg, CHAT, 'Renamed', YES)
    await setChatDescription(tg, CHAT, 'What this is for', YES)
    await setChatColor(tg, CHAT, 3, YES)
    await setChatStickerSet(tg, CHAT, 'someset', YES)
    await setChatUsername(tg, CHAT, 'ops_room', YES)
    await setChatUsername(tg, CHAT, null, YES)
    await setSlowMode(tg, CHAT, 30, YES)
    await setContentProtection(tg, CHAT, true, YES)
    await setJoinRequests(tg, CHAT, true, YES)
    await setJoinToSend(tg, CHAT, false, YES)
    await createForumTopic(tg, CHAT, 'Bugs', YES)
    await editForumTopic(tg, CHAT, 7, 'Bugs and crashes', YES)
    await setForumTopicClosed(tg, CHAT, 7, true, YES)
    await setForumTopicPinned(tg, CHAT, 7, true, YES)

    assert.deepEqual(
      calls.map(([name]) => name),
      [
        'createChannel', 'createSupergroup', 'createGroup',
        'setChatTitle', 'setChatDescription', 'setChatColor', 'setChatStickerSet',
        'setChatUsername', 'setChatUsername',
        'setSlowMode', 'toggleContentProtection', 'toggleJoinRequests', 'toggleJoinToSend',
        'createForumTopic', 'editForumTopic', 'toggleForumTopicClosed', 'toggleForumTopicPinned'
      ]
    )

    // mtcute takes a single params object here, not positional arguments.
    assert.deepEqual(calls[14], [
      'editForumTopic',
      [{ chatId: CHAT, topicId: 7, title: 'Bugs and crashes' }]
    ])

    // "Make it private" is an explicit null, not an omitted argument: an
    // omission would leave the username in place and silently do nothing.
    assert.deepEqual(calls[8], ['setChatUsername', [CHAT, null]])
    // The colour is Telegram's palette index, passed through untranslated.
    assert.deepEqual(calls[5], ['setChatColor', [{ peer: CHAT, color: 3 }]])

    const log = readSendLog()
    assert.equal(log.length, 17, 'every attempt appended exactly one line')
    assert.ok(log.every((r) => r.ok && r.size === 0), 'a settings change carries no content')
    assert.equal(sendsToday(log), 0, 'administration costs no send budget')
    // A creation has no target peer yet, so 0 stands in, and the id of the chat
    // that came into existence is what the record reports.
    assert.equal(log[0]?.peerId, 0, 'a creation has no target peer yet')
    assert.equal(log[2]?.messageId, -100999, 'the created chat id is what the record reports')
  })
})

test('eval-132 an invite-link verb returns the link it produced', async () => {
  await withTempDir(async () => {
    resetRunCounter()
    const { tg, calls } = adminClient()

    const primary = await exportInviteLink(tg, CHAT, YES)
    assert.equal(primary.link, 'https://t.me/+abc')
    assert.equal(primary.record.kind, 'invite-link')

    const created = await createInviteLink(tg, CHAT, { ...YES, usageLimit: 5, withApproval: true })
    assert.deepEqual(calls[1], ['createInviteLink', [CHAT, { usageLimit: 5, withApproval: true }]])
    assert.equal(created.link, 'https://t.me/+abc')

    // Only the fields passed are sent: an omitted expiry must not be read as
    // "expire now".
    await editInviteLink(tg, CHAT, 'https://t.me/+old', { ...YES, usageLimit: 1 })
    assert.deepEqual(calls[2], [
      'editInviteLink',
      [{ chatId: CHAT, link: 'https://t.me/+old', usageLimit: 1 }]
    ])

    assert.equal(readSendLog().length, 3)
    // The budget assertion belongs on every batch, not just the first: a
    // regression to units: 1 in one verb must fail something.
    assert.equal(sendsToday(readSendLog()), 0, 'an invite link costs no send budget')
  })
})

test('eval-133 the group verbs refuse bad arguments before touching the network', async () => {
  await withTempDir(async () => {
    resetRunCounter()
    const { tg, calls } = adminClient()

    await assert.rejects(() => setChatTitle(tg, CHAT, '   ', YES), /empty title/)
    await assert.rejects(() => setChatUsername(tg, CHAT, 'ab', YES), /Not a Telegram username/)
    // The boundary: Telegram's minimum is 5 characters, so 4 is refused here
    // rather than by the server after the call has gone out.
    await assert.rejects(() => setChatUsername(tg, CHAT, 'abcd', YES), /Not a Telegram username/)
    await assert.rejects(() => setChatUsername(tg, CHAT, '1abcd', YES), /Not a Telegram username/)
    await assert.rejects(() => setChatColor(tg, CHAT, -1, YES), /Not a colour id/)
    await assert.rejects(() => setSlowMode(tg, CHAT, -5, YES), /Not a slow-mode interval/)
    await assert.rejects(() => setForumTopicClosed(tg, CHAT, 0, true, YES), /Not a topic id/)
    await assert.rejects(() => createGroup(tg, 'Just me', [], YES), /at least one other member/)
    await assert.rejects(() => setChatPhoto(tg, CHAT, '/nope/none.png', YES), /No such file/)
    // A peer that is not numeric never reaches the send module at all.
    await assert.rejects(() => setChatTitle(tg, '@durov', 'x', YES), /Not a numeric peer id/)

    assert.deepEqual(calls, [], 'nothing was attempted')
    assert.deepEqual(readSendLog(), [], 'a refused argument is not an attempt')
  })
})

test('eval-134 a chat photo must be an image or a video, not any file', async () => {
  await withTempDir(async () => {
    resetRunCounter()
    const { tg, calls } = adminClient()

    writeFileSync('notes.md', 'x', 'utf-8')
    writeFileSync('avatar.png', 'x', 'utf-8')

    await assert.rejects(() => setChatPhoto(tg, CHAT, 'notes.md', YES), /Not an image or video/)
    await setChatPhoto(tg, CHAT, 'avatar.png', YES)

    assert.equal(calls.length, 1)
    const [name, args] = calls[0] as [string, [{ type: string }]]
    assert.equal(name, 'setChatPhoto')
    assert.equal(args[0].type, 'photo')
    assert.equal(sendsToday(readSendLog()), 0, 'a chat photo costs no send budget')
  })
})

test('eval-135 the group command layer gates on --yes before opening a session', () => {
  // Same rule eval-97 pins for `tg send`: the gate is knowable from argv, so a
  // run that was always going to be refused must not first take the workspace
  // lock and report "no usable session" instead of the real blocker.
  const source = readFileSync(
    fileURLToPath(new URL('../src/cli/commands/group.ts', import.meta.url)),
    'utf-8'
  )

  const actions = [...source.matchAll(/\.action\(async \([^)]*\) => \{([\s\S]*?)\n {6}\}\)/g)]
    // Group 1 is not optional in the pattern: a match always carries it.
    .map((m) => m[1]!)
    .filter((body) => body.includes('withAuthenticatedClient'))

  const writes = actions.filter((body) => body.includes('assertConfirmed'))
  const reads = actions.filter((body) => !body.includes('assertConfirmed'))

  assert.ok(writes.length >= 20, `expected the write actions, found ${writes.length}`)
  // Three reads, and they are reads BECAUSE they call no write RPC.
  assert.equal(reads.length, 3, 'only invite-list, invite-members and topic-list may skip the gate')
  for (const body of reads) {
    assert.ok(/list(InviteLinks|InviteLinkMembers|ForumTopics)\(/.test(body), 'an ungated action must be a read')
  }

  for (const body of writes) {
    const gate = body.indexOf('assertConfirmed')
    assert.ok(gate < body.indexOf('withAuthenticatedClient'), 'the --yes gate must run first')
    // Resolution happens here, in the command layer, exactly as for `tg send`.
    assert.ok(
      body.includes('resolvePeerRef(') || body.includes('confirmCreate('),
      'a write must resolve and show the chat, unless it is creating one'
    )
  }

  // eval-65's rule, for this file: resolution happening somewhere in the body
  // is not the same as the RESOLVED id being what gets passed on. No admin
  // function may receive the raw typed reference.
  assert.ok(
    !/set[A-Z][A-Za-z]*\(tg,\s*peer\b|(?:create|edit|export)[A-Z][A-Za-z]*\(tg,\s*peer\b/.test(source),
    'group.ts must never pass the raw typed reference to a write function'
  )

  // Every verb, write or read, must be scriptable.
  const verbs = [...source.matchAll(/\.command\('([a-z-]+) [^']*'\)([\s\S]*?)\.action\(/g)]
  assert.ok(verbs.length >= 23, `expected every group verb, found ${verbs.length}`)
  for (const verb of verbs) {
    // Both groups are mandatory in the pattern: a match always carries them.
    assert.match(verb[2]!, /option\('--json'/, `tg group ${verb[1]!} does not accept --json`)
  }
})

test('eval-140 the group command is registered from exactly one entry point', () => {
  // eval-39's rule, for `tg group`: it reaches src/send/, so "only a human
  // typed this" has to stay reviewable by reading one file.
  const src = fileURLToPath(new URL('../src/', import.meta.url))
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return files(path)
    return e.name.endsWith('.ts') ? [path] : []
  })

  const registrations = files(src)
    .filter((file) => /registerGroupCommand\s*\(/.test(readFileSync(file, 'utf-8')))
    .map((file) => file.slice(src.length))
    .sort()

  assert.deepEqual(registrations, ['cli/commands/group.ts', 'index.ts'])
})

test('eval-136 the group read path cannot reach the send module', () => {
  // src/groups/ exists so a future read verb can list invite links and topics
  // without linking the code that can write.
  const source = readFileSync(
    fileURLToPath(new URL('../src/groups/index.ts', import.meta.url)),
    'utf-8'
  )
  assert.ok(!/from '\.\.\/send\//.test(source), 'the read half must not import the send module')
})

test('eval-137 an empty group listing says so rather than printing nothing', () => {
  assert.equal(renderInviteLinks([]), 'no invite links\n')
  assert.equal(renderInviteMembers([]), 'no members joined via this link\n')
  assert.equal(renderForumTopics([]), 'no forum topics\n')

  assert.equal(
    renderInviteLinks([
      { link: 'https://t.me/+a', primary: true, revoked: false, usage: 4, usageLimit: 0, approvalNeeded: false, expires: '' }
    ]),
    'https://t.me/+a  4 joined  primary\n'
  )
  assert.equal(
    renderForumTopics([{ id: 7, title: 'Bugs', closed: true, pinned: false, unread: 2 }]),
    '     7  Bugs  closed 2 unread\n'
  )
})

test('eval-138 listing invite links and topics reads, never writes', async () => {
  const tg = {
    getInviteLinks: () => Promise.resolve([
      {
        link: 'https://t.me/+a', isPrimary: true, isRevoked: false, usage: 1,
        usageLimit: 10, approvalNeeded: true, endDate: new Date('2026-12-31T10:00:00Z')
      }
    ]),
    getForumTopics: () => Promise.resolve([
      { id: 7, title: 'Bugs', isClosed: false, isPinned: true, unreadCount: 0 }
    ])
  } as unknown as TelegramClient

  assert.deepEqual(await listInviteLinks(tg, CHAT), [{
    link: 'https://t.me/+a',
    primary: true,
    revoked: false,
    usage: 1,
    usageLimit: 10,
    approvalNeeded: true,
    expires: '2026-12-31T10:00'
  }])
  assert.deepEqual(await listForumTopics(tg, CHAT), [
    { id: 7, title: 'Bugs', closed: false, pinned: true, unread: 0 }
  ])
})

test('eval-139 a dump surfaces engagement only where Telegram populates it', () => {
  const bare = { id: 1, date: new Date('2026-08-01T10:00:00Z'), text: 'hi' } as unknown as Message
  // A 1:1 chat has no views, forwards or reactions at all - the suffix must be
  // absent rather than a row of zeroes.
  assert.equal(messageStats(bare), '')

  const post = {
    id: 2,
    date: new Date('2026-08-01T10:00:00Z'),
    text: 'post',
    views: 1200,
    forwards: 3,
    editDate: new Date('2026-08-01T11:00:00Z'),
    replies: { count: 7 },
    reactions: {
      reactions: [
        { emoji: '👍', count: 2 },
        { emoji: '❤️', count: 9 },
        { emoji: '🔥', count: 5 },
        { emoji: '🎉', count: 1 }
      ]
    }
  } as unknown as Message

  // Top three reactions by count, biggest first; the fourth is dropped.
  assert.equal(messageStats(post), '1200 views, 3 fwd, ❤️9 🔥5 👍2, 7 replies, edited')

  // Telegram's own clients hide the edit mark when the flag is set, so an
  // editDate alone is not enough to call a message edited.
  const quiet = {
    id: 3, date: new Date('2026-08-01T10:00:00Z'), text: 'x',
    editDate: new Date('2026-08-01T11:00:00Z'), hideEditMark: true
  } as unknown as Message
  assert.equal(messageStats(quiet), '')

  // A zero count is not printed, and the suffix only appears when non-empty.
  assert.equal(
    renderDump([
      { id: 1, at: '2026-08-01T10:00', who: 'Ada', text: 'hi', media: '', refs: [], stats: '' },
      { id: 2, at: '2026-08-01T10:01', who: 'Ada', text: 'post', media: '', refs: [], stats: '9 views' }
    ]),
    '[2026-08-01T10:00] Ada: hi\n[2026-08-01T10:01] Ada: post (9 views)\n'
  )
})
