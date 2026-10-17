import assert from 'node:assert'
import test from 'node:test'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tl, type Message, type TelegramClient } from '@mtcute/node'
import {
  addChatMembers,
  banMembers,
  classifyMemberFailure,
  createChannel,
  createForumTopic,
  createGroup,
  createInviteLink,
  createSupergroup,
  deleteChat,
  demoteAdmin,
  editForumTopic,
  editInviteLink,
  exportInviteLink,
  friendlyTelegramError,
  kickChatMember,
  memberBatchExit,
  parseAdminRightNames,
  promoteAdmin,
  restrictMember,
  sendMedia,
  sendText,
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
  setSlowMode,
  unbanMembers
} from '../src/send/index.js'
import { EXIT } from '../src/exit-codes.js'
import { OperatorError } from '../src/errors.js'
import { ModerationCapError, readSendLog, resetRunCounter, sendsToday } from '../src/send/gate.js'
import {
  listChatMembers,
  listForumTopics,
  listInviteLinks,
  renderChatMembers,
  renderForumTopics,
  renderInviteLinks,
  renderInviteMembers
} from '../src/groups/index.js'
import { ADMIN_RIGHTS, RESTRICTIONS } from '../src/groups/rights.js'
import { messageStats, renderDump } from '../src/dump/index.js'
import { seedModerationLog, withTempDir, withTerminal, withoutTerminal } from './helpers.js'

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

  assert.ok(writes.length >= 25, `expected the write actions, found ${writes.length}`)
  // Four reads, and they are reads BECAUSE they call no write RPC.
  assert.equal(reads.length, 4, 'only invite-list, invite-members, members and topic-list may skip the gate')
  for (const body of reads) {
    assert.ok(/list(InviteLinks|InviteLinkMembers|ChatMembers|ForumTopics)\(/.test(body), 'an ungated action must be a read')
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
    !/set[A-Z][A-Za-z]*\(tg,\s*peer\b|(?:create|edit|export|ban|unban|restrict|promote|demote)[A-Z][A-Za-z]*\(tg,\s*peer\b/.test(source),
    'group.ts must never pass the raw typed reference to a write function'
  )

  // Every verb, write or read, must be scriptable.
  const verbs = [...source.matchAll(/\.command\('([a-z-]+) [^']*'\)([\s\S]*?)\.action\(/g)]
  assert.ok(verbs.length >= 33, `expected every group verb, found ${verbs.length}`)
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

/** Membership, deletion and topic posting (D13d): mocked client, never the network. */
function rpc(text: string, code = 400): Error {
  return tl.RpcError.fromTl({ errorCode: code, errorMessage: text })
}

test('eval-142 add-members reports each user separately with a stable reason', async () => {
  await withTempDir(async () => {
    resetRunCounter()
    const outcomes: Record<number, () => unknown> = {
      1: () => [],
      2: () => { throw rpc('USER_PRIVACY_RESTRICTED', 403) },
      3: () => { throw rpc('USER_NOT_MUTUAL_CONTACT') },
      4: () => { throw rpc('USER_CHANNELS_TOO_MUCH') },
      5: () => { throw rpc('USER_ALREADY_PARTICIPANT') },
      6: () => [{ _: 'missingInvitee', userId: 6 }],
      7: () => { throw new Error('socket hang up') }
    }
    const tg = {
      addChatMembers: (_chat: number, users: number[]) => Promise.resolve().then(() => outcomes[users[0]!]!())
    } as unknown as TelegramClient

    const result = await addChatMembers(tg, CHAT, [1, 2, 3, 4, 5, 6, 7], YES)
    assert.deepEqual(result.added, [1])
    assert.deepEqual(result.failed.map((f) => [f.user, f.reason]), [
      [2, 'privacy'], [3, 'not_mutual'], [4, 'too_many_channels'],
      [5, 'already_member'], [6, 'privacy'], [7, 'other']
    ])
    assert.match(result.failed[0]!.message, /tg group invite-new/, 'a privacy block points at invite links')
    assert.equal(sendsToday(readSendLog()), 0, 'membership costs no send budget')
    assert.equal(readSendLog().length, 7, 'one audit line per user')
  })
})

test('eval-143 a flood limit stops the batch and the rest are reported, not retried', async () => {
  await withTempDir(async () => {
    resetRunCounter()
    const tried: number[] = []
    const tg = {
      addChatMembers: (_chat: number, users: number[]) => {
        tried.push(users[0]!)
        return users[0] === 2 ? Promise.reject(rpc('FLOOD_WAIT_30', 420)) : Promise.resolve([])
      }
    } as unknown as TelegramClient

    const result = await addChatMembers(tg, CHAT, [1, 2, 3, 4], YES)
    assert.deepEqual(tried, [1, 2], 'nothing is attempted after the flood')
    assert.deepEqual(result.added, [1])
    assert.deepEqual(result.failed.map((f) => [f.user, f.reason]), [[2, 'flood'], [3, 'flood'], [4, 'flood']])
  })
})

test('eval-144 add-members caps a call at 20 users and refuses before the network', async () => {
  await withTempDir(async () => {
    resetRunCounter()
    const calls: unknown[] = []
    const tg = { addChatMembers: (...a: unknown[]) => { calls.push(a); return Promise.resolve([]) } } as unknown as TelegramClient
    const ids = Array.from({ length: 21 }, (_, i) => i + 1)

    await assert.rejects(() => addChatMembers(tg, CHAT, ids, YES), (e: unknown) =>
      e instanceof OperatorError && e.exitCode === EXIT.usage && /at most 20/.test(e.message))
    await assert.rejects(() => addChatMembers(tg, CHAT, [], YES), /at least one/)
    await assert.rejects(() => addChatMembers(tg, CHAT, ['@durov' as unknown as number], YES), /Not a numeric peer id/)
    assert.deepEqual(calls, [])

    await addChatMembers(tg, CHAT, ids.slice(0, 20), YES)
    assert.equal(calls.length, 20)
  })
})

test('eval-145 kick-member and delete go through the gate, and delete only for an owner', async () => {
  await withTempDir(async () => {
    resetRunCounter()
    const calls: [string, unknown][] = []
    let creator = false
    const tg = {
      kickChatMember: (p: unknown) => { calls.push(['kick', p]); return Promise.resolve(null) },
      getChat: () => Promise.resolve({ isCreator: creator }),
      deleteChannel: (id: number) => { calls.push(['delete', id]); return Promise.resolve() }
    } as unknown as TelegramClient

    const kicked = await kickChatMember(tg, CHAT, 42, YES)
    assert.deepEqual(calls[0], ['kick', { chatId: CHAT, userId: 42 }])
    assert.equal(kicked.kind, 'kick-member')
    await assert.rejects(() => kickChatMember(tg, CHAT, '@durov', YES), /Not a numeric peer id/)

    await assert.rejects(() => deleteChat(tg, CHAT, YES), (e: unknown) =>
      e instanceof OperatorError && e.exitCode === EXIT.usage && /did not create/.test(e.message))
    assert.equal(calls.length, 1, 'a chat you do not own is never deleted')

    creator = true
    const deleted = await deleteChat(tg, CHAT, YES)
    assert.deepEqual(calls[1], ['delete', CHAT])
    assert.equal(deleted.kind, 'delete-chat')
    assert.equal(sendsToday(readSendLog()), 0)
  })
})

test('eval-146 without --yes and without a terminal, membership verbs refuse with exit 3', async () => {
  const original = process.env.TG_NON_INTERACTIVE
  process.env.TG_NON_INTERACTIVE = '1'
  try {
    const tg = {} as unknown as TelegramClient
    const needsHuman = (e: unknown) => e instanceof OperatorError && e.exitCode === EXIT.needsHuman
    await assert.rejects(() => addChatMembers(tg, CHAT, [1], {}), needsHuman)
    await assert.rejects(() => kickChatMember(tg, CHAT, 1, {}), needsHuman)
    await assert.rejects(() => deleteChat(tg, CHAT, {}), needsHuman)
  } finally {
    if (original === undefined) delete process.env.TG_NON_INTERACTIVE
    else process.env.TG_NON_INTERACTIVE = original
  }
})

test('eval-147 Telegram errors map to readable messages and the repo exit codes', () => {
  const cases: [string, number, RegExp][] = [
    ['CHAT_ADMIN_REQUIRED', EXIT.needsHuman, /not an admin/],
    ['CHANNEL_FORUM_MISSING', EXIT.usage, /not a forum/],
    ['TOPIC_CLOSED', EXIT.usage, /topic is closed/],
    ['FLOOD_WAIT_12', EXIT.upstream, /wait 12s/],
    ['PEER_FLOOD', EXIT.upstream, /throttling/]
  ]
  for (const [text, exit, message] of cases) {
    const mapped = friendlyTelegramError(rpc(text, text.startsWith('FLOOD') ? 420 : 400))
    assert.ok(mapped instanceof OperatorError, text)
    assert.equal(mapped.exitCode, exit, text)
    assert.match(mapped.message, message)
  }
  const unknown = new Error('boom')
  assert.equal(friendlyTelegramError(unknown), unknown, 'anything unknown stays a bug with its stack')
})

test('eval-148 --topic posts as a reply to the topic and is logged', async () => {
  await withTempDir(async () => {
    resetRunCounter()
    writeFileSync('a.png', 'x', 'utf-8')
    const calls: [string, unknown][] = []
    let failWith: Error | null = null
    const tg = {
      resolvePeer: () => Promise.resolve({}),
      sendText: (_p: unknown, _t: string, params: unknown) => {
        calls.push(['text', params])
        return failWith ? Promise.reject(failWith) : Promise.resolve({ id: 9 })
      },
      sendMedia: (_p: unknown, _m: unknown, params: unknown) => {
        calls.push(['media', params])
        return Promise.resolve({ id: 10 })
      }
    } as unknown as TelegramClient

    const record = await sendText(tg, CHAT, 'hi', { ...YES, topicId: 77 })
    assert.deepEqual(calls[0], ['text', { replyTo: 77 }])
    assert.equal(record.topicId, 77)
    await sendMedia(tg, CHAT, 'a.png', { ...YES, topicId: 77 })
    assert.deepEqual(calls[1], ['media', { replyTo: 77 }])

    // Without --topic nothing changes: no replyTo, no topicId in the log.
    const plain = await sendText(tg, CHAT, 'hi', YES)
    assert.deepEqual(calls[2], ['text', {}])
    assert.equal('topicId' in plain, false)

    await assert.rejects(() => sendText(tg, CHAT, 'hi', { ...YES, topicId: 0 }), /Not a topic id/)

    failWith = rpc('CHANNEL_FORUM_MISSING')
    await assert.rejects(() => sendText(tg, CHAT, 'hi', { ...YES, topicId: 77 }), (e: unknown) =>
      e instanceof OperatorError && e.exitCode === EXIT.usage && /not a forum/.test(e.message))
    failWith = rpc('TOPIC_CLOSED')
    await assert.rejects(() => sendText(tg, CHAT, 'hi', { ...YES, topicId: 77 }), /topic is closed/)
  })
})

test('eval-149 the send command exposes --topic on text and media only', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/cli/commands/send.ts', import.meta.url)),
    'utf-8'
  )
  assert.equal([...source.matchAll(/--topic <topicId>/g)].length, 2)
  assert.ok(!/(sendText|sendMedia)\(tg,\s*peer\b/.test(source))
})

/**
 * Moderation and admin rights (D13e): mocked client, never the network.
 *
 * Every verb here acts on one PERSON, so what these pin is the handling of
 * people: numeric positive ids only, one RPC and one named audit line per
 * person, stop at a wall without retrying, Telegram's refusals as the repo's
 * exit codes, and a prompt gate that fires before any session exists.
 */

/** A client whose four moderation methods record what they were asked and answer per `behaviour`. */
function memberClient(behaviour: Record<string, (params: unknown) => unknown> = {}): {
  tg: TelegramClient
  calls: [string, unknown][]
} {
  const calls: [string, unknown][] = []
  const make = (name: string, fallback: unknown) => (params: unknown) => {
    calls.push([name, params])
    return Promise.resolve().then(() => (behaviour[name] ? behaviour[name](params) : fallback))
  }
  const tg = {
    banChatMember: make('ban', { id: 31 }),
    unbanChatMember: make('unban', undefined),
    restrictChatMember: make('restrict', undefined),
    editAdminRights: make('rights', undefined)
  } as unknown as TelegramClient
  return { tg, calls }
}

const DAY = 24 * 60 * 60 * 1000

test('eval-150 ban and unban reach Telegram once per person, and the log names each person', async () => {
  await withTempDir(async () => {
    resetRunCounter()
    const { tg, calls } = memberClient()
    const until = Date.now() + 3 * DAY

    const forever = await banMembers(tg, CHAT, [11, '12', 11], YES)
    assert.deepEqual(forever, { done: [11, 12], failed: [] }, 'a duplicate is one person, not two attempts')
    // Forever is the ABSENCE of untilDate, not a zero or a far date.
    assert.deepEqual(calls[0], ['ban', { chatId: CHAT, participantId: 11 }])
    assert.deepEqual(calls[1], ['ban', { chatId: CHAT, participantId: 12 }])

    await banMembers(tg, CHAT, [13], { ...YES, until })
    assert.deepEqual(calls[2], ['ban', { chatId: CHAT, participantId: 13, untilDate: until }])

    const lifted = await unbanMembers(tg, CHAT, [11, 12], YES)
    assert.deepEqual(lifted, { done: [11, 12], failed: [] })
    assert.deepEqual(calls[3], ['unban', { chatId: CHAT, participantId: 11 }])
    assert.equal(calls.length, 5)

    const log = readSendLog()
    assert.deepEqual(
      log.map((r) => [r.kind, r.peerId, r.targetUserId]),
      [
        ['ban-member', CHAT, 11], ['ban-member', CHAT, 12], ['ban-member', CHAT, 13],
        ['unban-member', CHAT, 11], ['unban-member', CHAT, 12]
      ],
      'one audit line per person, naming the person and not only the chat'
    )
    assert.ok(log.every((r) => r.ok && r.size === 0 && r.units === 0), 'zero cap units, recorded')
    assert.equal(log[0]?.detail, 'until=forever')
    assert.equal(log[2]?.detail, `until=${new Date(until).toISOString()}`)
    assert.equal(log[0]?.messageId, 31, 'the service message id Telegram returned is what the record reports')
    assert.equal(log[3]?.messageId, 0, 'an unban has no message')
    assert.equal(sendsToday(log), 0, 'moderation costs no send budget')
  })
})

test('eval-151 a batch stops at a wall, never retries, and exits with the first refusal', async () => {
  await withTempDir(async () => {
    resetRunCounter()
    const outcomes: Record<number, () => unknown> = {
      1: () => ({ id: 1 }),
      2: () => { throw rpc('USER_ADMIN_INVALID') },
      3: () => { throw rpc('USER_NOT_PARTICIPANT') },
      4: () => { throw rpc('FLOOD_WAIT_30', 420) },
      5: () => ({ id: 5 }),
      6: () => ({ id: 6 })
    }
    const { tg, calls } = memberClient({
      ban: (p) => outcomes[(p as { participantId: number }).participantId]!()
    })

    const result = await banMembers(tg, CHAT, [1, 2, 3, 4, 5, 6], YES)
    assert.deepEqual(calls.map(([, p]) => (p as { participantId: number }).participantId), [1, 2, 3, 4],
      'a refusal about one person goes on; a flood stops the batch and nothing is retried')
    assert.deepEqual(result.done, [1])
    assert.deepEqual(result.failed.map((f) => [f.user, f.reason, f.exit]), [
      [2, 'target_is_admin', EXIT.needsHuman],
      [3, 'not_member', EXIT.usage],
      [4, 'flood', EXIT.upstream],
      [5, 'skipped', EXIT.upstream],
      [6, 'skipped', EXIT.upstream]
    ])
    assert.equal(memberBatchExit(result), EXIT.needsHuman, 'the code of the FIRST refusal')
    assert.equal(memberBatchExit({ done: [1], failed: [] }), EXIT.ok)
    assert.equal(
      readSendLog().map((r) => r.ok).join(','), 'true,false,false,false',
      'only attempts are logged; a skipped person was never tried'
    )
    assert.equal(sendsToday(readSendLog()), 0)
  })

  await withTempDir(async () => {
    resetRunCounter()
    const { tg, calls } = memberClient({ unban: () => { throw rpc('CHAT_ADMIN_REQUIRED', 403) } })
    const result = await unbanMembers(tg, CHAT, [1, 2, 3], YES)
    assert.equal(calls.length, 1, 'no rights means every next person would fail the same way')
    assert.deepEqual(result.failed.map((f) => f.reason), ['not_admin', 'skipped', 'skipped'])
    assert.equal(memberBatchExit(result), EXIT.needsHuman)
  })

  await withTempDir(async () => {
    resetRunCounter()
    const { tg } = memberClient({ ban: () => { throw new Error('socket hang up') } })
    const result = await banMembers(tg, CHAT, [1], YES)
    assert.equal(result.failed[0]?.reason, 'other')
    assert.equal(result.failed[0]?.message, 'socket hang up')
    assert.equal(memberBatchExit(result), EXIT.bug, 'an unknown failure stays a bug')
  })
})

test('eval-152 Telegram refusals about a person map to stable reasons and the repo exit codes', () => {
  const cases: [string, number, string, number][] = [
    ['CHAT_ADMIN_REQUIRED', 400, 'not_admin', EXIT.needsHuman],
    ['RIGHT_FORBIDDEN', 403, 'not_admin', EXIT.needsHuman],
    ['USER_ADMIN_INVALID', 400, 'target_is_admin', EXIT.needsHuman],
    ['USER_CREATOR', 400, 'target_is_creator', EXIT.usage],
    ['USER_NOT_PARTICIPANT', 400, 'not_member', EXIT.usage],
    ['USER_ID_INVALID', 400, 'invalid_user', EXIT.usage],
    ['PARTICIPANT_ID_INVALID', 400, 'invalid_user', EXIT.usage],
    ['CHANNEL_INVALID', 400, 'invalid_chat', EXIT.usage],
    ['CHANNEL_PRIVATE', 400, 'invalid_chat', EXIT.usage],
    ['ADMINS_TOO_MUCH', 400, 'too_many_admins', EXIT.needsHuman],
    ['ADMIN_RANK_INVALID', 400, 'invalid_rank', EXIT.usage],
    ['ADMIN_RANK_EMOJI_NOT_ALLOWED', 400, 'invalid_rank', EXIT.usage],
    ['FLOOD_WAIT_12', 420, 'flood', EXIT.upstream],
    ['PEER_FLOOD', 400, 'flood', EXIT.upstream]
  ]
  for (const [text, code, reason, exit] of cases) {
    const known = classifyMemberFailure(rpc(text, code))
    assert.equal(known.reason, reason, text)
    assert.equal(known.exit, exit, text)
  }
  assert.equal(classifyMemberFailure(rpc('FLOOD_WAIT_12', 420)).stop, true)
  assert.equal(classifyMemberFailure(rpc('CHAT_ADMIN_REQUIRED')).stop, true)
  assert.equal(classifyMemberFailure(rpc('USER_ADMIN_INVALID')).stop, false, 'one person\'s refusal is theirs alone')

  const unknown = classifyMemberFailure(new Error('boom'))
  assert.equal(unknown.reason, 'other')
  assert.equal(unknown.exit, EXIT.bug)
})

test('eval-153 restrict passes Telegram\'s own restriction sense through, and refuses what is not one', async () => {
  await withTempDir(async () => {
    resetRunCounter()
    const { tg, calls } = memberClient()
    const until = Date.now() + 2 * DAY

    const record = await restrictMember(tg, CHAT, 42, 'send-media, send-polls,send-media', { ...YES, until })
    // true means DISALLOWED, exactly as chatBannedRights spells it; nothing is set to false.
    assert.deepEqual(calls[0], ['restrict', {
      chatId: CHAT, userId: 42, restrictions: { sendMedia: true, sendPolls: true }, until
    }])
    assert.equal(record.kind, 'restrict-member')
    assert.equal(record.targetUserId, 42)
    assert.equal(record.detail, `deny=send-media,send-polls until=${new Date(until).toISOString()}`)

    await restrictMember(tg, CHAT, 42, ['send-messages'], YES)
    assert.deepEqual(calls[1], ['restrict', { chatId: CHAT, userId: 42, restrictions: { sendMessages: true } }])

    const usage = (e: unknown) => e instanceof OperatorError && e.exitCode === EXIT.usage
    await assert.rejects(() => restrictMember(tg, CHAT, 42, '', YES), (e: unknown) =>
      usage(e) && /tg group unban/.test((e as Error).message))
    // view-messages is a ban in disguise; it has its own verb and prompt.
    await assert.rejects(() => restrictMember(tg, CHAT, 42, 'view-messages', YES), (e: unknown) =>
      usage(e) && /tg group ban/.test((e as Error).message))
    for (const bad of ['nope', '__proto__', 'constructor', 'toString', 'sendMessages']) {
      await assert.rejects(() => restrictMember(tg, CHAT, 42, bad, YES), usage, bad)
    }
    // An end date Telegram would read as FOREVER is refused rather than passed on.
    for (const bad of [Date.now() + 5_000, Date.now() + 400 * DAY, Number.NaN]) {
      await assert.rejects(() => restrictMember(tg, CHAT, 42, 'send-media', { ...YES, until: bad }), usage, String(bad))
    }

    assert.equal(calls.length, 2, 'every refusal happened before the network')
    assert.equal(readSendLog().length, 2, 'a refused argument is not an attempt')
  })
})

test('eval-154 the restriction and admin-right vocabularies cover Telegram\'s flags exactly', () => {
  // Hard-coded from tl.RawChatBannedRights / tl.RawChatAdminRights in the pinned
  // @mtcute/tl. If mtcute adds a flag this fails, which is the point: a right
  // nobody can name is a right nobody can take away or grant on purpose.
  const bannedFields = [
    'viewMessages', 'sendMessages', 'sendMedia', 'sendStickers', 'sendGifs', 'sendGames', 'sendInline',
    'embedLinks', 'sendPolls', 'changeInfo', 'inviteUsers', 'pinMessages', 'manageTopics', 'sendPhotos',
    'sendVideos', 'sendRoundvideos', 'sendAudios', 'sendVoices', 'sendDocs', 'sendPlain'
  ]
  assert.deepEqual([...Object.values(RESTRICTIONS), 'viewMessages'].sort(), [...bannedFields].sort())

  const adminFields = [
    'changeInfo', 'postMessages', 'editMessages', 'deleteMessages', 'banUsers', 'inviteUsers', 'pinMessages',
    'addAdmins', 'anonymous', 'manageCall', 'other', 'manageTopics', 'postStories', 'editStories',
    'deleteStories', 'manageDirectMessages'
  ]
  assert.deepEqual([...Object.values(ADMIN_RIGHTS)].sort(), [...adminFields].sort())
})

test('eval-155 promote grants exactly the rights named, and demote is empty rights', async () => {
  await withTerminal(() => withTempDir(async () => {
    resetRunCounter()
    const { tg, calls } = memberClient()

    const promoted = await promoteAdmin(tg, CHAT, 42, 'delete-messages, ban-users,pin-messages', { ...YES, rank: ' Mod ' })
    assert.deepEqual(calls[0], ['rights', {
      chatId: CHAT, userId: 42,
      rights: { deleteMessages: true, banUsers: true, pinMessages: true },
      rank: 'Mod'
    }])
    assert.equal(promoted.kind, 'promote-admin')
    assert.equal(promoted.targetUserId, 42)
    assert.equal(promoted.detail, 'rights=delete-messages,ban-users,pin-messages rank="Mod"')

    await promoteAdmin(tg, CHAT, 42, ['other'], YES)
    assert.deepEqual(calls[1], ['rights', { chatId: CHAT, userId: 42, rights: { other: true } }], 'no rank key unless one was given')

    const demoted = await demoteAdmin(tg, CHAT, 42, YES)
    assert.deepEqual(calls[2], ['rights', { chatId: CHAT, userId: 42, rights: {} }])
    assert.equal(demoted.kind, 'demote-admin')
    assert.equal(demoted.detail, 'rights=none')

    const log = readSendLog()
    assert.deepEqual(log.map((r) => r.kind), ['promote-admin', 'promote-admin', 'demote-admin'])
    assert.equal(sendsToday(log), 0, 'admin rights cost no send budget')
  }))
})

test('eval-156 promote refuses "all rights", ownership and anything it cannot name, before the network', async () => {
  await withTerminal(() => withTempDir(async () => {
    resetRunCounter()
    const { tg, calls } = memberClient()
    const usage = (e: unknown) => e instanceof OperatorError && e.exitCode === EXIT.usage

    for (const sweeping of ['all', 'ALL', '*', 'everything', 'full', 'owner', 'creator', 'founder', 'transfer', 'ban-users,all']) {
      await assert.rejects(() => promoteAdmin(tg, CHAT, 42, sweeping, YES), (e: unknown) =>
        usage(e) && /no "all"/.test((e as Error).message), sweeping)
    }
    // Every right spelled out is the same grant as "all".
    const everyRight = Object.keys(ADMIN_RIGHTS).join(',')
    await assert.rejects(() => promoteAdmin(tg, CHAT, 42, everyRight, YES), (e: unknown) =>
      usage(e) && /all-rights grant/.test((e as Error).message))
    // ...but all but one is an explicit choice, and goes through.
    const allButOne = Object.keys(ADMIN_RIGHTS).filter((name) => name !== 'add-admins')
    assert.doesNotThrow(() => parseAdminRightNames(allButOne))

    for (const bad of ['', ' , ', 'nope', '__proto__', 'constructor', 'deleteMessages']) {
      await assert.rejects(() => promoteAdmin(tg, CHAT, 42, bad, YES), usage, JSON.stringify(bad))
    }
    for (const rank of ['', '   ', 'x'.repeat(17), 'bad\ntitle']) {
      await assert.rejects(() => promoteAdmin(tg, CHAT, 42, 'other', { ...YES, rank }), usage, JSON.stringify(rank))
    }
    await promoteAdmin(tg, CHAT, 42, 'other', { ...YES, rank: 'x'.repeat(16) })

    assert.equal(calls.length, 1, 'only the final, valid call reached Telegram')
    assert.equal(readSendLog().length, 1)
  }))
})

test('eval-157 single-person verbs map Telegram refusals to exit codes and keep unknown ones as bugs', async () => {
  await withTerminal(() => withTempDir(async () => {
    resetRunCounter()
    const failing = (text: string, code = 400) => memberClient({
      restrict: () => { throw rpc(text, code) },
      rights: () => { throw rpc(text, code) }
    }).tg
    const exits: [string, number][] = [
      ['CHAT_ADMIN_REQUIRED', EXIT.needsHuman],
      ['USER_ADMIN_INVALID', EXIT.needsHuman],
      ['ADMINS_TOO_MUCH', EXIT.needsHuman],
      ['USER_CREATOR', EXIT.usage],
      ['USER_NOT_PARTICIPANT', EXIT.usage],
      ['ADMIN_RANK_INVALID', EXIT.usage],
      ['FLOOD_WAIT_9', EXIT.upstream]
    ]
    for (const [text, exit] of exits) {
      const tg = failing(text, text.startsWith('FLOOD') ? 420 : 400)
      for (const run of [
        () => restrictMember(tg, CHAT, 42, 'send-media', YES),
        () => promoteAdmin(tg, CHAT, 42, 'other', YES),
        () => demoteAdmin(tg, CHAT, 42, YES)
      ]) {
        await assert.rejects(run, (e: unknown) => e instanceof OperatorError && e.exitCode === exit, text)
      }
    }

    const boom = new Error('boom')
    const tg = memberClient({ rights: () => { throw boom } }).tg
    await assert.rejects(() => demoteAdmin(tg, CHAT, 42, YES), (e: unknown) => e === boom, 'unknown stays a bug with its stack')

    const log = readSendLog()
    assert.equal(log.length, 7 * 3 + 1, 'a refused attempt is still on the record')
    assert.ok(log.every((r) => !r.ok && typeof r.error === 'string'))
  }))
})

test('eval-158 moderation verbs take people as positive numeric ids, and only supergroups or channels', async () => {
  await withTerminal(() => withTempDir(async () => {
    resetRunCounter()
    const { tg, calls } = memberClient()
    const usage = (e: unknown) => e instanceof OperatorError && e.exitCode === EXIT.usage
    const LEGACY = -4242424242
    const PRIVATE_CHAT = 4242424242

    // Handles are refused: @durov and @durvo are different real people.
    await assert.rejects(() => banMembers(tg, CHAT, ['@durov'], YES), /Not a numeric peer id/)
    await assert.rejects(() => unbanMembers(tg, CHAT, ['durov'], YES), /Not a numeric peer id/)
    await assert.rejects(() => restrictMember(tg, CHAT, '@durov', 'send-media', YES), /Not a numeric peer id/)
    await assert.rejects(() => promoteAdmin(tg, CHAT, '@durov', 'other', YES), /Not a numeric peer id/)
    await assert.rejects(() => demoteAdmin(tg, CHAT, '@durov', YES), /Not a numeric peer id/)
    await assert.rejects(() => banMembers(tg, '@somechat', [1], YES), /Not a numeric peer id/)

    // A chat or channel id is never somebody to ban or promote.
    for (const run of [
      () => banMembers(tg, CHAT, [-1009999999999], YES),
      () => unbanMembers(tg, CHAT, [-5], YES),
      () => restrictMember(tg, CHAT, -5, 'send-media', YES),
      () => promoteAdmin(tg, CHAT, -5, 'other', YES),
      () => demoteAdmin(tg, CHAT, -5, YES)
    ]) {
      await assert.rejects(run, (e: unknown) => usage(e) && /not a person/.test((e as Error).message))
    }

    // A legacy group or a private chat has no ban, restriction or admin rights.
    for (const chat of [LEGACY, PRIVATE_CHAT]) {
      for (const run of [
        () => banMembers(tg, chat, [1], YES),
        () => unbanMembers(tg, chat, [1], YES),
        () => restrictMember(tg, chat, 1, 'send-media', YES),
        () => promoteAdmin(tg, chat, 1, 'other', YES),
        () => demoteAdmin(tg, chat, 1, YES)
      ]) {
        await assert.rejects(run, (e: unknown) => usage(e) && /supergroup or channel/.test((e as Error).message))
      }
    }
    await assert.rejects(() => banMembers(tg, LEGACY, [1], YES), /kick-member/, 'a legacy group points at the verb that exists')

    // The per-call cap, before any network.
    const ids = Array.from({ length: 21 }, (_, i) => i + 1)
    await assert.rejects(() => banMembers(tg, CHAT, ids, YES), (e: unknown) => usage(e) && /at most 20/.test((e as Error).message))
    await assert.rejects(() => unbanMembers(tg, CHAT, ids, YES), /at most 20/)
    await assert.rejects(() => banMembers(tg, CHAT, [], YES), /at least one/)
    await banMembers(tg, CHAT, ids.slice(0, 20), YES)

    assert.equal(calls.length, 20, 'only the final, valid batch reached Telegram')
    assert.equal(readSendLog().length, 20)
  }))
})

test('eval-159 without --yes and without a terminal, every moderation verb refuses with exit 3', async () => {
  const original = process.env.TG_NON_INTERACTIVE
  process.env.TG_NON_INTERACTIVE = '1'
  try {
    // No methods at all: if a verb got past the gate it would throw a TypeError, not exit 3.
    const tg = {} as unknown as TelegramClient
    const needsHuman = (e: unknown) => e instanceof OperatorError && e.exitCode === EXIT.needsHuman
    await assert.rejects(() => banMembers(tg, CHAT, [1], {}), needsHuman)
    await assert.rejects(() => unbanMembers(tg, CHAT, [1], {}), needsHuman)
    await assert.rejects(() => restrictMember(tg, CHAT, 1, 'send-media', {}), needsHuman)
    await assert.rejects(() => promoteAdmin(tg, CHAT, 1, 'other', {}), needsHuman)
    await assert.rejects(() => demoteAdmin(tg, CHAT, 1, {}), needsHuman)
  } finally {
    if (original === undefined) delete process.env.TG_NON_INTERACTIVE
    else process.env.TG_NON_INTERACTIVE = original
  }
})

test('eval-160 members lists id, name, handle and role, and reads without any write method', async () => {
  const seen: unknown[] = []
  const tg = {
    getChatMembers: (chat: number, params: unknown) => {
      seen.push([chat, params])
      return Promise.resolve([
        {
          user: { id: 1, displayName: 'Ada L', username: 'ada' },
          status: 'creator', title: null, joinedDate: null,
          permissions: { _: 'chatAdminRights', changeInfo: true, banUsers: true, addAdmins: true, anonymous: false }
        },
        {
          user: { id: 2, displayName: 'Bo', username: null },
          status: 'admin', title: 'Mod', joinedDate: new Date('2026-08-01T10:00:00Z'),
          permissions: { _: 'chatAdminRights', deleteMessages: true, pinMessages: true }
        },
        {
          user: { id: 3, displayName: 'Cy', username: 'cy' },
          status: 'member', title: null, joinedDate: new Date('2026-09-02T08:30:00Z'), permissions: null
        },
        {
          user: { id: 4, displayName: 'Di', username: null },
          status: 'banned', title: null, joinedDate: null, permissions: null
        }
      ])
    }
  } as unknown as TelegramClient

  const rows = await listChatMembers(tg, CHAT, { limit: 50, type: 'admins', query: 'a' })
  assert.deepEqual(seen[0], [CHAT, { limit: 50, type: 'admins', query: 'a' }])
  assert.deepEqual(rows, [
    { userId: 1, name: 'Ada L', username: 'ada', status: 'creator', rank: '', rights: ['change-info', 'ban-users', 'add-admins'], joined: '' },
    { userId: 2, name: 'Bo', username: null, status: 'admin', rank: 'Mod', rights: ['delete-messages', 'pin-messages'], joined: '2026-08-01T10:00' },
    { userId: 3, name: 'Cy', username: 'cy', status: 'member', rank: '', rights: [], joined: '2026-09-02T08:30' },
    { userId: 4, name: 'Di', username: null, status: 'banned', rank: '', rights: [], joined: '' }
  ])

  // No option given means no key sent: an omitted limit must not become limit 0.
  await listChatMembers(tg, CHAT)
  assert.deepEqual(seen[1], [CHAT, {}])

  assert.equal(
    renderChatMembers(rows),
    '           1  Ada L (@ada)  creator  rights change-info,ban-users,add-admins\n' +
    '           2  Bo  admin  "Mod" rights delete-messages,pin-messages joined 2026-08-01T10:00\n' +
    '           3  Cy (@cy)  member  joined 2026-09-02T08:30\n' +
    '           4  Di  banned\n'
  )
  assert.equal(renderChatMembers([]), 'no members\n')
})

test('eval-161 the moderation verbs name every person in the prompt and pass only resolved ids on', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/cli/commands/group.ts', import.meta.url)),
    'utf-8'
  )

  // The five D13e writes, each handed the RESOLVED chat id and the parsed
  // person ids - never the raw typed reference (eval-65's rule, for these).
  const calls = [...source.matchAll(/\b(banMembers|unbanMembers|restrictMember|promoteAdmin|demoteAdmin)\(tg,\s*([\w.]+),\s*(\w+)/g)]
  assert.deepEqual(calls.map((m) => m[1]).sort(), ['banMembers', 'demoteAdmin', 'promoteAdmin', 'restrictMember', 'unbanMembers'])
  for (const call of calls) {
    assert.equal(call[2], 'target.id', `${call[1]!} must receive the resolved chat id`)
    assert.ok(/^(userId|userIds)$/.test(call[3]!), `${call[1]!} must receive parsed person ids`)
  }

  // Every one of them shows the PEOPLE, by name, handle and id, before acting.
  assert.equal([...source.matchAll(/confirmPeople\(target,/g)].length, 5)
  assert.equal([...source.matchAll(/await describePeople\(tg, userIds\)/g)].length, 2, 'the batch verbs resolve every person')
  // restrict, promote and demote resolve their one person (kick-member does too).
  assert.ok([...source.matchAll(/describePeer\(await resolvePeerRef\(tg, String\(userId\)\)\)/g)].length >= 4)

  // People are numeric ids, parsed once, in one place.
  assert.ok(source.includes('parsePersonId('))
  assert.ok(!/parsePeerRef\(user\b/.test(source), 'a person is never parsed as a chat reference')
})

test('eval-162 the moderation verbs work through the real CLI: usage and gate refusals exit with the contract codes', async () => {
  const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url))
  const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/esm/index.mjs', import.meta.url))

  await withTempDir(async () => {
    const run = (args: string[]) => new Promise<{ code: number | null; stdout: string }>((done) => {
      execFile(
        process.execPath,
        ['--import', tsx, entry, ...args],
        { env: { ...process.env, TG_NON_INTERACTIVE: '1', TG_NO_UPDATE: '1' }, cwd: process.cwd() },
        (error, stdout) => done({ code: error ? (error as { code?: number }).code ?? 1 : 0, stdout })
      )
    })

    const chat = String(CHAT)
    const cases: [string[], number, RegExp][] = [
      // The gate fires first, before any session is looked for.
      [['group', 'ban', chat, '42'], EXIT.needsHuman, /without --yes/],
      [['group', 'unban', chat, '42'], EXIT.needsHuman, /without --yes/],
      [['group', 'restrict', chat, '42', '--deny', 'send-media'], EXIT.needsHuman, /without --yes/],
      // promote is terminal-only (D13e-a): its refusal is a different one, pinned in eval-171.
      [['group', 'promote', chat, '42', '--rights', 'other'], EXIT.needsHuman, /terminal-only/],
      [['group', 'demote', chat, '42'], EXIT.needsHuman, /without --yes/],
      // Usage errors, offline.
      [['group', 'ban', chat, '@durov', '--yes'], EXIT.usage, /numeric peer ids/],
      [['group', 'ban', chat, '-1009999999999', '--yes'], EXIT.usage, /not a person/],
      [['group', 'ban', chat, '42', '--until', '5', '--yes'], EXIT.usage, /FOREVER/],
      [['group', 'restrict', chat, '42', '--yes'], EXIT.usage, /at least one restriction/],
      [['group', 'restrict', chat, '42', '--deny', 'view-messages', '--yes'], EXIT.usage, /tg group ban/],
      // promote's own usage refusals (all, no rights, a long rank) need a terminal to be
      // reached at all now; eval-156 covers them at the library layer.
    ]

    const results = await Promise.all(cases.map(([args]) => run([...args, '--json'])))
    results.forEach((result, i) => {
      const [args, code, message] = cases[i]!
      assert.equal(result.code, code, `tg ${args.join(' ')} exited ${result.code}`)
      const envelope = JSON.parse(result.stdout) as { ok: boolean; error: { exit: number; message: string } }
      assert.equal(envelope.ok, false)
      assert.equal(envelope.error.exit, code)
      assert.match(envelope.error.message + JSON.stringify(envelope), message)
    })
  })
})

/**
 * D13e-a: `promote` is TTY-only, and the person-directed verbs share a daily
 * moderation cap. Mocked client throughout; the real CLI is driven only for
 * refusals that happen before a session is looked for.
 */

const terminalOnly = (e: unknown) =>
  e instanceof OperatorError && e.exitCode === EXIT.needsHuman && /terminal-only/.test(e.message)

test('eval-169 promote needs a terminal even with --yes, before any network; demote and the other verbs do not', async () => {
  await withTempDir(async () => {
    resetRunCounter()
    const { tg, calls } = memberClient()

    await withoutTerminal(async () => {
      await assert.rejects(() => promoteAdmin(tg, CHAT, 42, 'other', YES), terminalOnly)
      await assert.rejects(() => promoteAdmin(tg, CHAT, 42, 'other', {}), terminalOnly)
      // The terminal rule is checked before the arguments, so an agent that cannot run this verb
      // is told so, rather than being walked through its usage errors one by one.
      await assert.rejects(() => promoteAdmin(tg, CHAT, 42, 'all', YES), terminalOnly)
      await assert.rejects(() => promoteAdmin(tg, CHAT, 42, '', { ...YES, rank: 'x'.repeat(40) }), terminalOnly)
      assert.deepEqual(calls, [], 'nothing reached Telegram')
      assert.deepEqual(readSendLog(), [], 'and nothing was logged: there was no attempt')

      // Taking rights away, and the rest, stay behind the ordinary --yes gate.
      await demoteAdmin(tg, CHAT, 42, YES)
      await restrictMember(tg, CHAT, 42, 'send-media', YES)
      await banMembers(tg, CHAT, [43], YES)
      await unbanMembers(tg, CHAT, [43], YES)
      assert.deepEqual(calls.map(([name]) => name), ['rights', 'restrict', 'ban', 'unban'])
    })

    await withTerminal(async () => {
      const promoted = await promoteAdmin(tg, CHAT, 42, 'delete-messages', YES)
      assert.equal(promoted.kind, 'promote-admin')
      assert.deepEqual(calls[4], ['rights', { chatId: CHAT, userId: 42, rights: { deleteMessages: true } }])
    })
  })
})

/** A client with every person-directed method, recording the order they were reached in. */
function personClient(behaviour: Record<string, (params: unknown) => unknown> = {}): { tg: TelegramClient; calls: string[] } {
  const calls: string[] = []
  const make = (name: string, fallback: unknown) => (...args: unknown[]) => {
    calls.push(name)
    return Promise.resolve().then(() => (behaviour[name] ? behaviour[name](args[0]) : fallback))
  }
  const tg = {
    banChatMember: make('ban', { id: 31 }),
    unbanChatMember: make('unban', undefined),
    restrictChatMember: make('restrict', undefined),
    editAdminRights: make('rights', undefined),
    addChatMembers: make('add', []),
    kickChatMember: make('kick', { id: 5 }),
    resolvePeer: () => Promise.resolve({}),
    sendText: make('text', { id: 9 })
  } as unknown as TelegramClient
  return { tg, calls }
}

test('eval-170 every person-directed verb counts against the moderation cap and is refused whole, before Telegram', async () => {
  await withTempDir(() => withTerminal(async () => {
    resetRunCounter()
    const { tg, calls } = personClient()
    const capped = (e: unknown) =>
      e instanceof ModerationCapError && e.exitCode === EXIT.notConfigured && /Daily moderation cap/.test(e.message)

    seedModerationLog(45)
    // Six people do not fit in the five slots that are left: the call is refused as a whole, not half done.
    await assert.rejects(() => banMembers(tg, CHAT, [1, 2, 3, 4, 5, 6], YES), capped)
    await assert.rejects(() => unbanMembers(tg, CHAT, [1, 2, 3, 4, 5, 6], YES), capped)
    await assert.rejects(() => addChatMembers(tg, CHAT, [1, 2, 3, 4, 5, 6], YES), capped)
    assert.deepEqual(calls, [], 'a refused call never reaches Telegram')

    // Five do fit, and take the last of the day's budget. One audit line per person, as ever.
    const result = await banMembers(tg, CHAT, [1, 2, 3, 4, 5], YES)
    assert.deepEqual(result.done, [1, 2, 3, 4, 5])
    assert.equal(readSendLog().length, 50)

    // Now every verb is refused, for one person, whatever it does to them.
    const refused: [string, () => Promise<unknown>][] = [
      ['ban', () => banMembers(tg, CHAT, [9], YES)],
      ['unban', () => unbanMembers(tg, CHAT, [9], YES)],
      ['add-members', () => addChatMembers(tg, CHAT, [9], YES)],
      ['kick-member', () => kickChatMember(tg, CHAT, 9, YES)],
      ['restrict', () => restrictMember(tg, CHAT, 9, 'send-media', YES)],
      ['promote', () => promoteAdmin(tg, CHAT, 9, 'other', YES)],
      ['demote', () => demoteAdmin(tg, CHAT, 9, YES)]
    ]
    for (const [verb, run] of refused) {
      await assert.rejects(run, capped, verb)
    }
    assert.deepEqual(calls, ['ban', 'ban', 'ban', 'ban', 'ban'], 'only the five that fit ever reached Telegram')
    assert.equal(readSendLog().length, 50, 'a refusal is not an attempt and adds no line')

    // The cap is moderation's own: a full moderation day does not stop a message.
    await sendText(tg, CHAT, 'still allowed', YES)
    assert.equal(sendsToday(readSendLog()), 1)

    // The per-call limit of 20 is unchanged, and checked first (it is a usage error, not a cap).
    const many = Array.from({ length: 21 }, (_, i) => i + 1)
    await assert.rejects(() => banMembers(tg, CHAT, many, YES), (e: unknown) =>
      e instanceof OperatorError && e.exitCode === EXIT.usage && /at most 20/.test(e.message))
  }))
})

test('eval-171 a cap reached mid-call stops the batch: the rest are cap and skipped, exit 4, nothing retried', async () => {
  // Another process logs 20 people while this call is running: the up-front check cannot see that,
  // so the per-person backstop in guardedSend has to hold the line.
  await withTempDir(async () => {
    resetRunCounter()
    const { tg, calls } = personClient({ ban: () => { seedModerationLog(20); return { id: 1 } } })
    seedModerationLog(40)

    const banned = await banMembers(tg, CHAT, [1, 2, 3], YES)
    assert.deepEqual(banned.done, [1])
    assert.deepEqual(banned.failed.map((f) => [f.user, f.reason, f.exit]), [
      [2, 'cap', EXIT.notConfigured],
      [3, 'skipped', EXIT.notConfigured]
    ])
    assert.equal(memberBatchExit(banned), EXIT.notConfigured)
    assert.deepEqual(calls, ['ban'], 'nothing was attempted after the cap, and nothing retried')
  })

  // add-members reports the same wall in its own vocabulary, and still never goes on.
  await withTempDir(async () => {
    resetRunCounter()
    const { tg, calls } = personClient({ add: () => { seedModerationLog(20); return [] } })
    seedModerationLog(40)

    const added = await addChatMembers(tg, CHAT, [1, 2, 3], YES)
    assert.deepEqual(added.added, [1])
    assert.deepEqual(added.failed.map((f) => [f.user, f.reason]), [[2, 'cap'], [3, 'cap']])
    assert.deepEqual(calls, ['add'])
  })
})

test('eval-172 promote through the real CLI: refused without a terminal in every shape, before a session, with --yes too', async () => {
  const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url))
  const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/esm/index.mjs', import.meta.url))

  await withTempDir(async () => {
    // The child's stdin is a pipe, never a terminal, whether or not TG_NON_INTERACTIVE is set.
    const run = (args: string[], env: Record<string, string>) => new Promise<{ code: number | null; stdout: string }>((done) => {
      const clean = { ...process.env }
      delete clean.TG_NON_INTERACTIVE
      delete clean.TGU_NON_INTERACTIVE
      execFile(
        process.execPath,
        ['--import', tsx, entry, ...args, '--json'],
        { env: { ...clean, TG_NO_UPDATE: '1', ...env }, cwd: process.cwd() },
        (error, stdout) => done({ code: error ? (error as { code?: number }).code ?? 1 : 0, stdout })
      )
    })

    const chat = String(CHAT)
    const shapes: string[][] = [
      ['group', 'promote', chat, '42', '--rights', 'other'],
      ['group', 'promote', chat, '42', '--rights', 'other', '--yes'],
      // Checked before the arguments: a verb that cannot run says so, whatever else is wrong with the line.
      ['group', 'promote', chat, '42', '--rights', 'all', '--yes'],
      ['group', 'promote', chat, '42', '--yes']
    ]
    const runs = shapes.flatMap((args) => [
      { args, env: { TG_NON_INTERACTIVE: '1' } },
      { args, env: {} }
    ])
    const results = await Promise.all(runs.map(({ args, env }) => run(args, env)))

    results.forEach((result, i) => {
      const { args, env } = runs[i]!
      const label = `tg ${args.join(' ')} ${JSON.stringify(env)}`
      assert.equal(result.code, EXIT.needsHuman, `${label} exited ${result.code}`)
      const envelope = JSON.parse(result.stdout) as { ok: boolean; error: { code: string; exit: number; message: string; detail: string } }
      assert.equal(envelope.ok, false)
      assert.equal(envelope.error.exit, EXIT.needsHuman)
      assert.match(envelope.error.detail, /terminal-only/, label)
      assert.match(envelope.error.detail, /--yes does NOT bypass/, label)
      assert.doesNotMatch(envelope.error.detail, /No usable Telegram session/, 'it was refused before a session was looked for')
    })

    // demote only takes rights away: it is NOT terminal-only, so --yes gets it past the gate.
    // (Driven only as far as the gate: without --yes it still stops there, with the ordinary message.)
    const demote = await run(['group', 'demote', chat, '42'], { TG_NON_INTERACTIVE: '1' })
    assert.equal(demote.code, EXIT.needsHuman)
    assert.match(demote.stdout, /without --yes/)
    assert.doesNotMatch(demote.stdout, /terminal-only/)
  })
})

test('eval-173 the moderation cap refuses through the real CLI, offline, before a session, with the cap exit code', async () => {
  const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url))
  const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/esm/index.mjs', import.meta.url))

  await withTempDir(async () => {
    seedModerationLog(50)
    const run = (args: string[], env: Record<string, string> = {}) => new Promise<{ code: number | null; stdout: string }>((done) => {
      execFile(
        process.execPath,
        ['--import', tsx, entry, ...args],
        { env: { ...process.env, TG_NON_INTERACTIVE: '1', TG_NO_UPDATE: '1', ...env }, cwd: process.cwd() },
        (error, stdout) => done({ code: error ? (error as { code?: number }).code ?? 1 : 0, stdout })
      )
    })

    const chat = String(CHAT)
    const verbs: string[][] = [
      ['group', 'ban', chat, '42', '--yes'],
      ['group', 'unban', chat, '42', '--yes'],
      ['group', 'restrict', chat, '42', '--deny', 'send-media', '--yes'],
      ['group', 'demote', chat, '42', '--yes'],
      ['group', 'kick-member', chat, '42', '--yes'],
      ['group', 'add-members', chat, '42', '--yes']
    ]
    const results = await Promise.all(verbs.map((args) => run([...args, '--json'])))
    results.forEach((result, i) => {
      const label = `tg ${verbs[i]!.join(' ')}`
      assert.equal(result.code, EXIT.notConfigured, `${label} exited ${result.code}`)
      const envelope = JSON.parse(result.stdout) as { ok: boolean; error: { exit: number; detail: string } }
      assert.equal(envelope.ok, false)
      assert.match(envelope.error.detail, /Daily moderation cap reached \(50\/50/, label)
      assert.doesNotMatch(envelope.error.detail, /No usable Telegram session/, 'refused before a session was looked for')
    })

    // A malformed cap refuses instead of silently turning the guard off.
    const broken = await run(['group', 'ban', chat, '42', '--yes', '--json'], { TG_MAX_MODERATION_PER_DAY: '5O' })
    assert.equal(broken.code, EXIT.notConfigured)
    assert.match(broken.stdout, /not a whole number/)

    // send log shows the budget, so an operator can see where they stand.
    const log = await run(['send', 'log'])
    assert.equal(log.code, 0)
    assert.match(log.stdout, /50\/50 people moderated in the last 24h/)
  })
})

test('eval-174 the command layer asks for a terminal on promote only, always prompts there, and checks the cap before a session', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/cli/commands/group.ts', import.meta.url)),
    'utf-8'
  )
  const actions = [...source.matchAll(/\.command\('([a-z-]+) [^']*'\)([\s\S]*?)\.action\(async \([^)]*\) => \{([\s\S]*?)\n {6}\}\)/g)]
  const body = (verb: string): string => {
    const found = actions.find((m) => m[1] === verb)
    assert.ok(found, `no ${verb} action found`)
    return found[3]!
  }

  // promote: the terminal rule is the first gate, ahead of the session, and --yes is not what the prompt keys on.
  const promote = body('promote')
  assert.match(promote, /assertConfirmed\(options, \{ terminalOnly: /)
  assert.ok(promote.indexOf('terminalOnly') < promote.indexOf('withAuthenticatedClient'))
  assert.match(promote, /confirmPeople\(target, 'make this person an ADMIN', \[person\], false, notes\)/, 'always asks')

  // Nothing else is terminal-only: the class is exactly the verbs that are listed in gate.ts.
  assert.equal([...source.matchAll(/terminalOnly:/g)].length, 1)
  assert.ok(!body('demote').includes('terminalOnly'), 'demote only takes rights away')

  // Every person-directed verb checks the moderation cap before it opens a session.
  for (const verb of ['add-members', 'kick-member', 'ban', 'unban', 'restrict', 'promote', 'demote']) {
    const text = body(verb)
    const cap = text.indexOf('assertUnderModerationCap(')
    assert.ok(cap !== -1, `${verb} does not check the moderation cap`)
    assert.ok(cap < text.indexOf('withAuthenticatedClient'), `${verb} must check the cap before a session opens`)
  }
})
