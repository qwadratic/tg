import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { SearchFilters, MtArgumentError, MtPeerNotFoundError, MtTimeoutError, type TelegramClient } from '@mtcute/node'
import { dumpThread } from '../src/dump/index.js'
import { OperatorError } from '../src/errors.js'
import { EXIT } from '../src/exit-codes.js'
import { PAGE_SIZE, fetchMessages, paced, pageSizeFor } from '../src/messages/fetch.js'
import { friendlyReadError, reading, readingEach } from '../src/reads/errors.js'
import { assertGolden } from './helpers.js'
import { each, message, peer, rpcError, withInstantTimers } from './read-mocks.js'
import { CHAT_EVENT_TYPES, chatInfo, chatLog, describeChatAction, renderChatInfo, renderChatLog } from '../src/chats/index.js'
import { getChatMemberDetail, renderChatMember } from '../src/groups/index.js'
import { restrictionNames } from '../src/groups/rights.js'
import {
  assertMessageLink,
  getMessageRows,
  listScheduled,
  messageFromLink,
  messageRow,
  messageThread,
  renderMessages,
  renderThread
} from '../src/messages/read.js'
import { SEARCH_FILTERS, isSearchFilter, normalizeHashtag, searchLive } from '../src/messages/search.js'
import { contactsList, renderContacts, renderUserInfo, userInfo } from '../src/users/index.js'
import { DEFAULT_DRAFT_SCAN, listDrafts, renderDialogs, renderDrafts, showDialogs } from '../src/dialogs/index.js'
import { renderReactions, showReactions } from '../src/messages/reactions.js'
import {
  PRIVACY_KEYS,
  isPrivacyKey,
  listSessions,
  readNotify,
  readPrivacy,
  renderNotify,
  renderPrivacy,
  renderSessions,
  type PrivacyKeyName
} from '../src/account/index.js'
import { tlRpcMethods } from './mtcute-api.js'

/**
 * The read verbs of 0.8 (D13f), against a mocked client. Nothing here opens a
 * session or touches the network: each mock records the method it is asked for and
 * the arguments it gets, so what is pinned is what tg SENDS to Telegram and how it
 * reads the answer.
 */

const CHAT = -1001234567890

test('eval-182 the paced walk limits, stops at --since, reports progress and breathes every page', async () => {
  await withInstantTimers(async (delays) => {
    const items = Array.from({ length: 250 }, (_, i) => ({ id: i + 1, date: new Date(Date.UTC(2026, 0, 1, 0, 0, 250 - i)) }))
    const progress: number[] = []

    // Whole source: a pause after each full page of a hundred, never after the last item.
    const all: number[] = []
    for await (const item of paced(each(items), { onProgress: (n) => progress.push(n) })) all.push(item.id)
    assert.equal(all.length, 250)
    assert.deepEqual(delays, [1500, 1500], 'two full pages of 100, each followed by a pause of 1.5s plus jitter')
    assert.deepEqual(progress, [100, 200, 250], 'a page boundary each, then the final count')

    // limit stops early, and the item that reaches it is not followed by a pause.
    delays.length = 0
    const some: number[] = []
    for await (const item of paced(each(items), { limit: 100 })) some.push(item.id)
    assert.equal(some.length, 100)
    assert.deepEqual(delays, [], 'reaching the limit ends the walk before any pause')

    // since: newest first, so the first item older than the cutoff ends it.
    const recent: number[] = []
    for await (const item of paced(each(items), { since: new Date(Date.UTC(2026, 0, 1, 0, 0, 200)), dateOf: (i) => i.date })) recent.push(item.id)
    assert.equal(recent.length, 51, 'items dated 00:03:20 and newer, 250 down to 200 seconds')

    // The source is abandoned, not drained: a generator that would throw on a
    // later page is never asked for it.
    let pagesAsked = 0
    async function* pages(): AsyncGenerator<number> {
      pagesAsked++
      yield 1
      pagesAsked++
      yield 2
      pagesAsked++
      throw new Error('a third page must not be requested')
    }
    for await (const _ of paced(pages(), { limit: 2 })) { /* consume */ }
    assert.equal(pagesAsked, 2)
  })

  // A small read asks for a small page.
  assert.equal(pageSizeFor(undefined), PAGE_SIZE)
  assert.equal(pageSizeFor(5), 5)
  assert.equal(pageSizeFor(100), 100)
  assert.equal(pageSizeFor(5000), PAGE_SIZE)
  assert.equal(pageSizeFor(0), 1, 'never a page of zero')
})

test('eval-182b a thread is read through search, history through history, both newest first and through the same walk', async () => {
  await withInstantTimers(async () => {
    const calls: [string, unknown][] = []
    const newest = [message({ id: 3 }), message({ id: 2 }), message({ id: 1 })]
    const tg = {
      iterHistory: (chat: number, params: unknown) => { calls.push(['iterHistory', [chat, params]]); return each(newest) },
      iterSearchMessages: (params: unknown) => { calls.push(['iterSearchMessages', params]); return each(newest) }
    } as unknown as TelegramClient

    const history: number[] = []
    for await (const m of fetchMessages(tg, CHAT, { limit: 2, minId: 1 })) history.push(m.id)
    assert.deepEqual(history, [3, 2])
    assert.deepEqual(calls[0], ['iterHistory', [CHAT, { chunkSize: 2, minId: 1 }]], 'a limit of 2 asks for a page of 2, and minId is passed only when given')

    const thread: number[] = []
    for await (const m of fetchMessages(tg, CHAT, { threadId: 77 })) thread.push(m.id)
    assert.deepEqual(thread, [3, 2, 1])
    assert.deepEqual(calls[1], ['iterSearchMessages', { chatId: CHAT, threadId: 77, query: '', chunkSize: 100 }], 'a thread is a search with an empty query and a top message')

    // And through dump: oldest first, from the thread, mapped errors.
    const lines = await dumpThread(
      { iterSearchMessages: () => each([message({ id: 3, text: 'c' }), message({ id: 2, text: 'b' })]) } as unknown as TelegramClient,
      CHAT,
      { threadId: 77 }
    )
    assert.deepEqual(lines.map((l) => l.text), ['b', 'c'])

    const refused = {
      iterSearchMessages: async function* () { throw rpcError(400, 'TOPIC_ID_INVALID'); yield message({ id: 1 }) }
    } as unknown as TelegramClient
    await assert.rejects(
      () => dumpThread(refused, CHAT, { threadId: 5 }),
      (e: unknown) => e instanceof OperatorError && e.exitCode === EXIT.usage && /topic-list/.test(e.message)
    )
  })
})

test('eval-183 Telegram refusals of a read map to the contract exit codes, and anything unknown stays a bug', async () => {
  const exit = (error: unknown): number | 'bug' => {
    const mapped = friendlyReadError(error)
    return mapped instanceof OperatorError ? mapped.exitCode : 'bug'
  }

  // 3: only a human with the right can fix it.
  assert.equal(exit(rpcError(400, 'CHAT_ADMIN_REQUIRED')), EXIT.needsHuman)

  // 6: Telegram's side, retry later. A flood says how long.
  assert.equal(exit(rpcError(420, 'FLOOD_WAIT_30')), EXIT.upstream)
  assert.match((friendlyReadError(rpcError(420, 'FLOOD_WAIT_30')) as Error).message, /30s/)
  assert.equal(exit(rpcError(420, 'PEER_FLOOD')), EXIT.upstream)
  assert.equal(exit(rpcError(500, 'RPC_CALL_FAIL')), EXIT.upstream, 'any 5xx is Telegram failing')
  assert.equal(exit(new MtTimeoutError(30_000)), EXIT.upstream)
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']) {
    assert.equal(exit(Object.assign(new Error('socket'), { code })), EXIT.upstream, code)
  }

  // 2: what was asked for is not there or not reachable; retrying cannot help.
  for (const text of [
    'CHANNEL_PRIVATE', 'CHANNEL_INVALID', 'CHAT_ID_INVALID', 'PEER_ID_INVALID', 'USER_ID_INVALID', 'FROM_PEER_INVALID',
    'MSG_ID_INVALID', 'MESSAGE_ID_INVALID', 'MESSAGE_IDS_EMPTY', 'TOPIC_ID_INVALID', 'USER_NOT_PARTICIPANT',
    'USER_BANNED_IN_CHANNEL', 'BROADCAST_FORBIDDEN', 'SEARCH_QUERY_EMPTY', 'INPUT_FILTER_INVALID', 'PRIVACY_KEY_INVALID'
  ]) {
    assert.equal(exit(rpcError(400, text)), EXIT.usage, text)
  }
  assert.equal(exit(new MtPeerNotFoundError('Peer not found')), EXIT.usage)
  assert.equal(exit(new MtArgumentError('Invalid link')), EXIT.usage)

  // Unknown stays what it was: a bug, with its stack.
  assert.equal(exit(rpcError(400, 'SOMETHING_NEW')), 'bug')
  assert.equal(exit(new Error('boom')), 'bug')
  assert.equal(exit('not even an error'), 'bug')
  // An OperatorError that is already one is not rewritten.
  const mine = new OperatorError('mine', EXIT.needsHuman)
  assert.equal(friendlyReadError(mine), mine)

  // The helpers apply it: to a call, and to a walk that fails on a later page.
  await assert.rejects(() => reading(() => Promise.reject(rpcError(400, 'CHAT_ADMIN_REQUIRED'))), (e: unknown) => e instanceof OperatorError && e.exitCode === 3)
  assert.equal(await reading(() => Promise.resolve(5)), 5)
  const seen: number[] = []
  await assert.rejects(
    async () => {
      async function* failing(): AsyncGenerator<number> { yield 1; throw rpcError(420, 'FLOOD_WAIT_9') }
      for await (const n of readingEach(failing())) seen.push(n)
    },
    (e: unknown) => e instanceof OperatorError && e.exitCode === EXIT.upstream
  )
  assert.deepEqual(seen, [1], 'what came before the refusal was delivered')

  // Not a coincidence of spelling: each filter below is a real constant of mtcute.
  assert.ok(SearchFilters.Photo)
  assertGolden('eval-183-read-error-messages', [
    'CHAT_ADMIN_REQUIRED', 'CHANNEL_PRIVATE', 'PEER_ID_INVALID', 'TOPIC_ID_INVALID', 'BROADCAST_FORBIDDEN', 'PEER_FLOOD'
  ].map((text) => `${text} -> ${(friendlyReadError(rpcError(400, text)) as Error).message}`).join('\n') + '\n')
})

/* ------------------------------------------------------------------ chats */


const basicChat = {
  id: CHAT,
  chatType: 'supergroup',
  title: 'Team chat',
  username: 'teamchat',
  usernames: [{ _: 'username', active: true, username: 'teamchat' }, { _: 'username', active: true, username: 'team_old' }, { _: 'username', active: false, username: 'retired' }],
  isVerified: false, isScam: false, isFake: false, isRestricted: false, isForum: true,
  isCreator: false, isAdmin: true, isMember: true,
  hasContentProtection: true, hasJoinRequests: false, hasJoinToSend: true,
  membersCount: 1204,
  creationDate: new Date('2024-02-03T10:00:00Z'),
  joinDate: new Date('2024-02-04T09:00:00Z')
}
const fullChat = Object.defineProperty({
  ...basicChat,
  bio: 'Where the work happens.\nBe kind.',
  adminsCount: 6, bannedCount: 3, kickedCount: null, onlineCount: 87,
  slowmodeSeconds: 30, ttlPeriod: 86400, linkedChat: { id: -1009999 }, pinnedMsgId: 12,
  pendingJoinRequests: 2, unreadCount: 14, isArchived: false
}, 'inviteLink', {
  // A full profile carries the chat's invite link. It must never be read. Not
  // enumerable, so the copies below that spread this object do not trip it.
  get(): never { throw new Error('chat info must not read the invite link') },
  enumerable: false
})

test('eval-184 chat info reads one full profile, or one cheap basic request, and never the invite link', async () => {
  const calls: [string, unknown[]][] = []
  const tg = {
    getFullChat: (...args: unknown[]) => { calls.push(['getFullChat', args]); return Promise.resolve(fullChat) },
    getChat: (...args: unknown[]) => { calls.push(['getChat', args]); return Promise.resolve(basicChat) }
  } as unknown as TelegramClient

  const full = await chatInfo(tg, CHAT)
  assert.deepEqual(calls, [['getFullChat', [CHAT]]], 'one request')
  assert.deepEqual(full, {
    id: CHAT, kind: 'supergroup', title: 'Team chat', username: 'teamchat', usernames: ['teamchat', 'team_old'],
    verified: false, scam: false, fake: false, restricted: false, forum: true,
    creator: false, admin: true, member: true, protectedContent: true, joinRequests: false, joinToSend: true,
    members: 1204, created: '2024-02-03T10:00', joined: '2024-02-04T09:00',
    description: 'Where the work happens.\nBe kind.', admins: 6, banned: 3, online: 87,
    slowModeSeconds: 30, autoDeleteSeconds: 86400, linkedChatId: -1009999, pinnedMessageId: 12,
    pendingJoinRequests: 2, unread: 14, archived: false
  })
  assert.ok(!JSON.stringify(full).includes('inviteLink'))

  const basic = await chatInfo(tg, CHAT, { basic: true })
  assert.deepEqual(calls[1], ['getChat', [CHAT]], '--basic asks getChat and nothing else')
  assert.equal(basic.description, undefined, 'the full-profile fields are absent, not empty')
  assert.equal(basic.admins, undefined)
  assert.equal(basic.members, 1204)

  assertGolden('eval-184-chat-info-full', renderChatInfo(full))
  assertGolden('eval-184-chat-info-basic', renderChatInfo(basic))

  // A full profile of a basic group reads 0 members; the count on the chat itself is the one to use.
  const basicGroup = { ...fullChat, chatType: 'group', membersCount: 0, raw: { _: 'chat', participantsCount: 12 } }
  const group = await chatInfo({ getFullChat: () => Promise.resolve(basicGroup) } as unknown as TelegramClient, -4242)
  assert.equal(group.members, 12)
  // And Telegram giving no count at all is null, not zero; a linked chat that did not arrive is null too.
  const countless = { ...fullChat, membersCount: null, raw: { _: 'channelForbidden' }, get linkedChat(): never { throw new Error('not in the batch') } }
  const unknown = await chatInfo({ getFullChat: () => Promise.resolve(countless) } as unknown as TelegramClient, CHAT)
  assert.equal(unknown.members, null)
  assert.equal(unknown.linkedChatId, null)

  // A refusal comes back as the contract exit code.
  const refused = { getFullChat: () => Promise.reject(rpcError(400, 'CHANNEL_PRIVATE')) } as unknown as TelegramClient
  await assert.rejects(() => chatInfo(refused, CHAT), (e: unknown) => e instanceof OperatorError && e.exitCode === EXIT.usage)
})

/** The mtcute ChatEvent the log read looks at. */
function event(id: string, at: string, action: unknown, actor: unknown = peer(7, 'Ada')): unknown {
  return { id, date: new Date(at), raw: { userId: (actor as { id: number }).id }, actor, action }
}
const member = (status: string, rights: Record<string, boolean> | null = null) => ({ user: peer(42, 'Bo'), status, permissions: rights })

test('eval-185 chat log pages the admin log, filters only when told to, and tells the actions apart', async () => {
  const seen: unknown[] = []
  const events = [
    event('105', '2026-10-01T10:05:00Z', { type: 'title_changed', old: 'Team', new: 'Team chat' }),
    event('104', '2026-10-01T10:04:00Z', { type: 'user_admin_perms_changed', old: member('admin', { deleteMessages: true, pinMessages: true }), new: member('admin', { deleteMessages: true, banUsers: true }) }),
    event('103', '2026-10-01T10:03:00Z', { type: 'msg_deleted', message: message({ id: 31, text: 'a long message '.repeat(10) }) }),
    event('102', '2026-10-01T10:02:00Z', { type: 'user_joined_invite', link: { link: 'https://t.me/+SECRETLINK' } }),
    event('101', '2026-10-01T10:01:00Z', { type: 'slow_mode_changed', old: 0, new: 30 }),
    event('100', '2026-10-01T10:00:00Z', { type: 'user_perms_changed', old: member('member'), new: member('restricted') }),
    event('99', '2026-10-01T09:59:00Z', null),
    event('98', '2026-10-01T09:58:00Z', { type: 'a_kind_mtcute_learns_later' }, { id: 9, get displayName(): string { throw new Error('actor not in the batch') } })
  ]
  const tg = {
    iterChatEventLog: (chat: number, params: unknown) => { seen.push([chat, params]); return each(events) }
  } as unknown as TelegramClient

  const rows = await chatLog(tg, CHAT, { limit: 100 })
  assert.deepEqual(seen[0], [CHAT, { chunkSize: 100 }], 'no filter, user or query unless asked: an omitted option is not sent as undefined')
  assert.equal(rows.length, 8)
  assert.deepEqual(rows[0], { id: '105', at: '2026-10-01T10:05', actor: { id: 7, name: 'Ada' }, action: 'title_changed', detail: 'Team -> Team chat' })
  assert.equal(rows[1]?.detail, 'Bo [id 42]: admin -> admin (+ban-users -pin-messages)', 'what an admin gained and lost')
  assert.match(rows[2]?.detail ?? '', /^message #31: a long message/)
  assert.ok((rows[2]?.detail.length ?? 0) < 100, 'a deleted message is clipped')
  assert.equal(rows[3]?.detail, 'through an invite link')
  assert.ok(!JSON.stringify(rows).includes('SECRETLINK'), 'an invite link is a credential and is never reported')
  assert.equal(rows[6]?.action, 'unknown', 'an action mtcute could not parse')
  assert.deepEqual(rows[7], { id: '98', at: '2026-10-01T09:58', actor: { id: 9, name: 'someone Telegram did not name' }, action: 'a_kind_mtcute_learns_later', detail: '' })

  assertGolden('eval-185-chat-log', renderChatLog(rows))
  assert.equal(renderChatLog([]), 'no events\n')

  // Filters, users and query go through when given, and the limit bounds the walk.
  await chatLog(tg, CHAT, { limit: 3, types: ['title_changed', 'user_left'], users: [7, 8], query: 'hello' })
  assert.deepEqual(seen[1], [CHAT, { chunkSize: 3, filters: ['title_changed', 'user_left'], users: [7, 8], query: 'hello' }])
  assert.equal((await chatLog(tg, CHAT, { limit: 3 })).length, 3)

  // Every action type this CLI accepts is one mtcute declares: that is a compile-time
  // fact (`satisfies` in the list), and the log's own vocabulary is not shortened silently.
  assert.ok(CHAT_EVENT_TYPES.length >= 45)
  assert.equal(new Set(CHAT_EVENT_TYPES).size, CHAT_EVENT_TYPES.length, 'no repeated type')
  assert.equal(describeChatAction(null), '')

  // Exit 3 when this account is not an admin: Telegram answers on the first page.
  const notAdmin = {
    iterChatEventLog: async function* () { throw rpcError(400, 'CHAT_ADMIN_REQUIRED'); yield events[0] }
  } as unknown as TelegramClient
  await assert.rejects(() => chatLog(notAdmin, CHAT, { limit: 10 }), (e: unknown) => e instanceof OperatorError && e.exitCode === EXIT.needsHuman)

  // A refusal on a later page is mapped as well, and the walk is the paced one.
  await withInstantTimers(async (delays) => {
    const many = Array.from({ length: 150 }, (_, i) => event(String(1000 - i), '2026-10-01T10:00:00Z', { type: 'user_left' }))
    const long = { iterChatEventLog: () => each(many) } as unknown as TelegramClient
    assert.equal((await chatLog(long, CHAT, { limit: 150 })).length, 150)
    assert.deepEqual(delays, [1500], 'one pause, after the first full page')
  })
})

/* ---------------------------------------------------------- group member */

import { listChatMembers, listForumTopics, listInviteLinkMembers, listInviteLinks } from '../src/groups/index.js'

test('eval-185b the older group reads report a refusal as the contract exit code too', async () => {
  const refuses = (method: string, text: string) => ({ [method]: () => Promise.reject(rpcError(400, text)) }) as unknown as TelegramClient
  const exit = async (run: () => Promise<unknown>): Promise<number | 'bug'> => {
    try { await run() } catch (e) { return e instanceof OperatorError ? e.exitCode : 'bug' }
    return 0
  }

  assert.equal(await exit(() => listChatMembers(refuses('getChatMembers', 'CHAT_ADMIN_REQUIRED'), CHAT)), EXIT.needsHuman)
  assert.equal(await exit(() => listInviteLinks(refuses('getInviteLinks', 'CHAT_ADMIN_REQUIRED'), CHAT)), EXIT.needsHuman)
  assert.equal(await exit(() => listInviteLinkMembers(refuses('getInviteLinkMembers', 'CHANNEL_PRIVATE'), CHAT)), EXIT.usage)
  assert.equal(await exit(() => listForumTopics(refuses('getForumTopics', 'CHANNEL_INVALID'), CHAT)), EXIT.usage)
  assert.equal(await exit(() => listChatMembers(refuses('getChatMembers', 'FLOOD_WAIT_5'), CHAT)), EXIT.upstream)
  assert.equal(await exit(() => listChatMembers(refuses('getChatMembers', 'SOMETHING_NEW'), CHAT)), 'bug', 'unknown stays a bug')
})


test('eval-186 group member answers one person from one request, and says so when they are not in the chat', async () => {
  const seen: unknown[] = []
  const restricted = {
    user: peer(42, 'Bo Li', { username: 'boli' }),
    status: 'restricted', title: null, joinedDate: new Date('2026-08-01T10:00:00Z'), permissions: null,
    invitedBy: peer(7, 'Ada'), promotedBy: null, restrictedBy: peer(8, 'Cy'),
    restrictions: { raw: { _: 'chatBannedRights', sendMessages: true, sendMedia: true, viewMessages: false, untilDate: 0 }, untilDate: new Date('2026-12-31T00:00:00Z') }
  }
  const admin = {
    user: peer(9, 'Di'), status: 'admin', title: 'Mod', joinedDate: null,
    permissions: { _: 'chatAdminRights', deleteMessages: true, banUsers: true },
    invitedBy: null, promotedBy: peer(7, 'Ada'), restrictedBy: null, restrictions: null
  }
  const tg = {
    getChatMember: (params: { userId: number }) => {
      seen.push(params)
      return Promise.resolve(params.userId === 42 ? restricted : params.userId === 9 ? admin : null)
    }
  } as unknown as TelegramClient

  const r = await getChatMemberDetail(tg, CHAT, 42)
  assert.deepEqual(seen[0], { chatId: CHAT, userId: 42 }, 'one request, named')
  assert.deepEqual(r, {
    userId: 42, name: 'Bo Li', username: 'boli', status: 'restricted', rank: '', rights: [], joined: '2026-08-01T10:00',
    invitedBy: 'Ada [id 7]', promotedBy: null, restrictedBy: 'Cy [id 8]',
    restrictions: ['send-messages', 'send-media'], until: '2026-12-31T00:00'
  }, 'what they may not do, in the restriction vocabulary; viewMessages false is not a restriction')

  const a = await getChatMemberDetail(tg, CHAT, 9)
  assert.deepEqual(a?.rights, ['delete-messages', 'ban-users'])
  assert.equal(a?.promotedBy, 'Ada [id 7]')

  assert.equal(await getChatMemberDetail(tg, CHAT, 1), null, 'not in the chat is null, not an error')

  assertGolden('eval-186-group-member', `${renderChatMember(r!)}\n${renderChatMember(a!)}`)

  assert.deepEqual(restrictionNames(null), [])
  assert.deepEqual(restrictionNames({ sendMessages: true, sendMedia: false }), ['send-messages'])

  const refused = { getChatMember: () => Promise.reject(rpcError(400, 'USER_NOT_PARTICIPANT')) } as unknown as TelegramClient
  await assert.rejects(() => getChatMemberDetail(refused, CHAT, 5), (e: unknown) => e instanceof OperatorError && e.exitCode === EXIT.usage)
  const noAdmin = { getChatMember: () => Promise.reject(rpcError(400, 'CHAT_ADMIN_REQUIRED')) } as unknown as TelegramClient
  await assert.rejects(() => getChatMemberDetail(noAdmin, CHAT, 5), (e: unknown) => e instanceof OperatorError && e.exitCode === EXIT.needsHuman)
})

/* -------------------------------------------------------------- messages */


test('eval-187 msg get returns messages whole, in the order asked, and reports the ids that are not there', async () => {
  const seen: unknown[] = []
  const reply = message({
    id: 12, text: 'line one\nline two', replyToMessage: { id: 10, threadId: 8 }, isPinned: true,
    editDate: new Date('2026-10-01T10:00:00Z'), forward: { sender: { displayName: 'News Desk' } },
    views: 1200, entities: [{ kind: 'url', offset: 0, length: 8 }]
  })
  const photo = message({ id: 10, media: { type: 'photo' }, text: 'look', sender: peer(8, 'Cy'), link: undefined })
  const tg = {
    getMessages: (chat: number, ids: number[]) => { seen.push([chat, ids]); return Promise.resolve([reply, null, photo]) }
  } as unknown as TelegramClient

  const { rows, missing } = await getMessageRows(tg, CHAT, [12, 11, 10])
  assert.deepEqual(seen[0], [CHAT, [12, 11, 10]])
  assert.deepEqual(missing, [11], 'a null is the id Telegram has no message for, at its position')
  assert.deepEqual(rows[0], {
    id: 12, chatId: CHAT, chat: 'Team chat', at: '2026-10-01T09:30', from: 'Ada', fromId: 7,
    text: 'line one\nline two', media: '', refs: ['line one'], stats: '1200 views, edited',
    replyTo: 10, threadId: 8, forwardedFrom: 'News Desk', pinned: true, outgoing: false, edited: true, scheduled: false,
    link: 'https://t.me/c/1234567890/12'
  })
  assert.equal(rows[1]?.media, 'photo')
  assert.equal(rows[1]?.link, null, 'a chat with no permalink is null, not a crash')

  assertGolden('eval-187-msg-get', renderMessages(rows) + `not found: ${missing.join(', ')}\n`)
  assert.equal(renderMessages([]), 'no messages\n')

  // A message whose sender Telegram did not send still reads.
  const anonymous = messageRow(message({ id: 1, get sender(): never { throw new Error('not in the batch') } }))
  assert.equal(anonymous.from, '?')
  assert.equal(anonymous.fromId, null)

  const refused = { getMessages: () => Promise.reject(rpcError(400, 'CHANNEL_PRIVATE')) } as unknown as TelegramClient
  await assert.rejects(() => getMessageRows(refused, CHAT, [1]), (e: unknown) => e instanceof OperatorError && e.exitCode === EXIT.usage)
})

test('eval-188 msg link checks the link offline, refuses an invite link by name, and reads the message it points at', async () => {
  for (const good of [
    'https://t.me/durov/123', 'http://t.me/durov/123', 't.me/durov/123', 'https://telegram.me/durov/123',
    'https://t.me/durov/45/123', 'https://t.me/c/1234567890/123', 'https://t.me/c/1234567890/45/123',
    'https://t.me/durov/123?single', ' https://t.me/durov/123 '
  ]) {
    assert.equal(assertMessageLink(good), good.trim(), good)
  }
  // A trailing slash would read as message id 0, so it is dropped; a query stays.
  assert.equal(assertMessageLink('https://t.me/durov/123/'), 'https://t.me/durov/123')
  assert.equal(assertMessageLink('https://t.me/durov/123/?comment=7'), 'https://t.me/durov/123?comment=7')

  const refused = (link: string): OperatorError => {
    try { assertMessageLink(link) } catch (e) { return e as OperatorError }
    throw new Error(`${link} should have been refused`)
  }
  // An invite link points at a join flow: refused by name, never reaches the network.
  for (const invite of ['https://t.me/+AbCdEf123', 't.me/joinchat/AbCdEf123', 'https://telegram.me/+xyz']) {
    const e = refused(invite)
    assert.equal(e.exitCode, EXIT.usage)
    assert.match(e.message, /invite link/)
  }
  for (const bad of ['', 'durov/123', 'https://t.me/durov', 'https://t.me/durov/abc', 'https://example.com/durov/123', 'https://t.me/c/123', 'https://t.me/dur/1', 'https://t.me/a b/1', '123']) {
    assert.equal(refused(bad).exitCode, EXIT.usage, bad)
  }

  const asked: string[] = []
  const tg = {
    getMessageByLink: (link: string) => { asked.push(link); return Promise.resolve(link.includes('/9') ? null : message({ id: 123, text: 'hi' })) }
  } as unknown as TelegramClient
  assert.equal((await messageFromLink(tg, ' https://t.me/durov/123 '))?.id, 123)
  assert.deepEqual(asked, ['https://t.me/durov/123'], 'the trimmed link, once')
  assert.equal(await messageFromLink(tg, 'https://t.me/durov/9'), null)
  await assert.rejects(() => messageFromLink(tg, 'https://t.me/+secret'), (e: unknown) => e instanceof OperatorError && e.exitCode === EXIT.usage)
  assert.equal(asked.length, 2, 'the invite link never reached Telegram')
})

test('eval-189 msg thread climbs a bounded reply chain, finds an album and a discussion, and asks only for what exists', async () => {
  const calls: string[] = []
  const chain: Record<number, unknown> = {
    30: message({ id: 30, text: 'newest', replyToMessage: { id: 20 } }),
    20: message({ id: 20, text: 'middle', replyToMessage: { id: 10 } }),
    10: message({ id: 10, text: 'oldest', replyToMessage: { id: 5 } })
  }
  const tg = {
    getMessages: (_chat: number, id: number) => { calls.push(`getMessages ${id}`); return Promise.resolve([chain[id] ?? null]) },
    getReplyTo: (m: { replyToMessage: { id: number } }) => { calls.push(`getReplyTo ${m.replyToMessage.id}`); return Promise.resolve(chain[m.replyToMessage.id] ?? null) },
    getMessageGroup: () => { calls.push('getMessageGroup'); return Promise.resolve([]) },
    getDiscussionMessage: () => { calls.push('getDiscussionMessage'); return Promise.resolve(null) }
  } as unknown as TelegramClient

  const view = await messageThread(tg, CHAT, 30)
  assert.deepEqual(view?.parents.map((p) => p.id), [20, 10], 'nearest first; the chain ends at a parent Telegram no longer has')
  assert.equal(view?.moreAbove, false)
  assert.deepEqual(calls, ['getMessages 30', 'getReplyTo 20', 'getReplyTo 10', 'getReplyTo 5'], 'no album or discussion request for a message with neither')

  // depth bounds the climb, and says the chain goes on.
  calls.length = 0
  const bounded = await messageThread(tg, CHAT, 30, { depth: 1 })
  assert.deepEqual(bounded?.parents.map((p) => p.id), [20])
  assert.equal(bounded?.moreAbove, true)

  // An album and a post with comments are looked up, once each.
  calls.length = 0
  const post = message({ id: 50, text: 'a post', groupedId: '123', replies: { hasComments: true, count: 3 } })
  const sibling = message({ id: 51, text: 'second photo', media: { type: 'photo' } })
  const rich = {
    getMessages: () => Promise.resolve([post]),
    getMessageGroup: (p: unknown) => { calls.push(`getMessageGroup ${JSON.stringify(p)}`); return Promise.resolve([post, sibling]) },
    getDiscussionMessage: (p: unknown) => { calls.push(`getDiscussionMessage ${JSON.stringify(p)}`); return Promise.resolve(message({ id: 77, chat: peer(-1009876543210, 'Discussion') })) }
  } as unknown as TelegramClient
  const full = await messageThread(rich, CHAT, 50)
  assert.deepEqual(calls, [`getMessageGroup {"chatId":${CHAT},"message":50}`, `getDiscussionMessage {"chatId":${CHAT},"message":50}`])
  assert.deepEqual(full?.album.map((m) => m.id), [51], 'the album without the message itself')
  assert.deepEqual(full?.discussion, { chatId: -1009876543210, messageId: 77 })
  assertGolden('eval-189-msg-thread', `${renderThread(view!)}\n${renderThread(full!)}`)

  assert.equal(await messageThread({ getMessages: () => Promise.resolve([null]) } as unknown as TelegramClient, CHAT, 1), null, 'no such message is null')
})

test('eval-190 scheduled list reads what is waiting, soonest first, or just the ids asked for', async () => {
  const later = message({ id: 8, text: 'later', isScheduled: true, date: new Date('2026-12-01T09:00:00Z') })
  const sooner = message({ id: 9, text: 'sooner', isScheduled: true, date: new Date('2026-11-01T09:00:00Z') })
  const calls: unknown[] = []
  const tg = {
    getAllScheduledMessages: (chat: number) => { calls.push(['all', chat]); return Promise.resolve([later, sooner]) },
    getScheduledMessages: (chat: number, ids: number[]) => { calls.push(['some', chat, ids]); return Promise.resolve([later, null]) }
  } as unknown as TelegramClient

  const all = await listScheduled(tg, CHAT)
  assert.deepEqual(all.rows.map((r) => r.id), [9, 8], 'soonest first')
  assert.ok(all.rows.every((r) => r.scheduled))
  assert.deepEqual(calls[0], ['all', CHAT])

  const some = await listScheduled(tg, CHAT, [8, 99])
  assert.deepEqual(calls[1], ['some', CHAT, [8, 99]])
  assert.deepEqual(some.missing, [99])
  assertGolden('eval-190-scheduled-list', renderMessages(all.rows))

  const noAccess = { getAllScheduledMessages: () => Promise.reject(rpcError(400, 'CHAT_ADMIN_REQUIRED')) } as unknown as TelegramClient
  await assert.rejects(() => listScheduled(noAccess, CHAT), (e: unknown) => e instanceof OperatorError && e.exitCode === EXIT.needsHuman)
})

/* ---------------------------------------------------------------- search */


test('eval-191 live search sends the right request for each scope, never a scope-less one, and never pays', async () => {
  await withInstantTimers(async () => {
    const seen: [string, unknown][] = []
    const hit = (id: number) => message({ id, text: `hit ${id}` })
    const tg = {
      iterSearchMessages: (params: unknown) => { seen.push(['chat', params]); return each([hit(3), hit(2), hit(1)]) },
      iterSearchGlobal: (params: unknown) => { seen.push(['global', params]); return each([hit(3), hit(2)]) },
      iterSearchHashtag: (tag: string, params: unknown) => { seen.push(['hashtag', [tag, params]]); return each([hit(9)]) }
    } as unknown as TelegramClient

    // In one chat: the filter object is mtcute's own, the date range and sender go through, limit sets the page.
    const since = new Date('2026-09-01T00:00:00Z')
    const until = new Date('2026-10-01T00:00:00Z')
    const chat = await searchLive(tg, { kind: 'chat', chatId: CHAT }, 'invoice', { limit: 2, filter: 'photo', from: 42, since, until })
    assert.deepEqual(seen[0], ['chat', {
      query: 'invoice', chatId: CHAT, limit: 2, chunkSize: 2, filter: SearchFilters.Photo, minDate: since, maxDate: until, fromUser: 42
    }])
    assert.deepEqual(chat.rows.map((r) => r.id), [3, 2], 'limit bounds the result as well as the request')

    // Bare: nothing is sent that was not asked for.
    await searchLive(tg, { kind: 'chat', chatId: CHAT }, 'x', { limit: 500 })
    assert.deepEqual(seen[1], ['chat', { query: 'x', chatId: CHAT, limit: 500, chunkSize: 100 }])

    await searchLive(tg, { kind: 'global' }, 'invoice', { limit: 10, filter: 'document', since })
    assert.deepEqual(seen[2], ['global', { query: 'invoice', limit: 10, chunkSize: 10, filter: SearchFilters.Document, minDate: since }])

    await searchLive(tg, { kind: 'hashtag' }, '#mtcute', { limit: 5 })
    assert.deepEqual(seen[3], ['hashtag', ['mtcute', { limit: 5, chunkSize: 5 }]], 'the # is dropped')
  })

  assert.equal(normalizeHashtag('#mtcute'), 'mtcute')
  assert.equal(normalizeHashtag(' mtcute '), 'mtcute')
  for (const bad of ['', '#', 'two words', '# x']) {
    assert.throws(() => normalizeHashtag(bad), (e: unknown) => e instanceof OperatorError && e.exitCode === EXIT.usage, JSON.stringify(bad))
  }

  // Every filter mtcute knows (but Empty) has a name here, and a name that is not ours is not a filter.
  const ours = new Set<string>(Object.values(SEARCH_FILTERS).map((f) => f._))
  for (const [name, filter] of Object.entries(SearchFilters)) {
    if (name === 'Empty') continue
    assert.ok(ours.has(filter._), `mtcute has a ${name} filter that no --filter name reaches`)
  }
  assert.ok(isSearchFilter('photo') && isSearchFilter('round-voice'))
  assert.ok(!isSearchFilter('toString') && !isSearchFilter('__proto__') && !isSearchFilter('Photo'))
})

test('eval-191b public-post search pages by what Telegram returns, never passes Stars, and reports an exhausted allowance as exit 3', async () => {
  await withInstantTimers(async () => {
    const asked: unknown[] = []
    const page = (ids: number[], extra: Record<string, unknown>) => Object.assign(ids.map((id) => message({ id })), extra)
    const first = page([5, 4], { next: { rate: 1, peer: 'p', id: 4 }, limits: { _: 'searchPostsFlood', queryIsFree: true, totalDaily: 10, remains: 7, waitTill: undefined, starsAmount: 0 } })
    const second = page([3], { limits: undefined })
    const tg = {
      searchPostsGlobal: (query: string, params: unknown) => { asked.push([query, params]); return Promise.resolve(asked.length === 1 ? first : second) }
    } as unknown as TelegramClient

    const result = await searchLive(tg, { kind: 'posts' }, 'mtcute release', { limit: 3 })
    assert.deepEqual(result.rows.map((r) => r.id), [5, 4, 3])
    assert.deepEqual(asked, [
      ['mtcute release', { limit: 3 }],
      ['mtcute release', { limit: 1, offset: { rate: 1, peer: 'p', id: 4 } }]
    ], 'the second page continues where the first stopped and asks for what is still missing')
    assert.ok(!JSON.stringify(asked).toLowerCase().includes('stars'), 'payStars is never passed: tg does not spend money')
    assert.deepEqual(result.quota, { free: true, remaining: 7, daily: 10, nextFreeAt: '' })

    // Allowance gone: Telegram answers empty and says the search would cost Stars. That is a human's decision.
    const exhausted = {
      searchPostsGlobal: () => Promise.resolve(page([], { limits: { _: 'searchPostsFlood', queryIsFree: false, totalDaily: 10, remains: 0, waitTill: 1_790_000_000, starsAmount: 5 } }))
    } as unknown as TelegramClient
    await assert.rejects(
      () => searchLive(exhausted, { kind: 'posts' }, 'x', { limit: 10 }),
      (e: unknown) => e instanceof OperatorError && e.exitCode === EXIT.needsHuman && /never spends Stars/.test(e.message) && /0 of 10/.test(e.message)
    )

    // Plainly nothing found, with the allowance intact, is an empty result, which the command turns into exit 2.
    const none = { searchPostsGlobal: () => Promise.resolve(page([], { limits: { _: 'searchPostsFlood', queryIsFree: true, totalDaily: 10, remains: 9, starsAmount: 0 } })) } as unknown as TelegramClient
    assert.deepEqual((await searchLive(none, { kind: 'posts' }, 'x', { limit: 10 })).rows, [])
  })

  // The source never names the payment parameter at all.
  const source = readFileSync(new URL('../src/messages/search.ts', import.meta.url), 'utf-8')
  assert.ok(!/payStars\s*[:,}]/.test(source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')), 'search.ts must not pass payStars')
})

/* ---------------------------------------------------------------- people */


test('eval-192 user info reads a person from one request, adds the shared chats on request, and carries no phone number', async () => {
  const calls: [string, unknown[]][] = []
  const base = {
    id: 42, displayName: 'Bo Li', username: 'boli', usernames: [{ username: 'boli', active: true }, { username: 'bo_work', active: true }],
    isSelf: false, isBot: false, isVerified: false, isPremium: true, isScam: false, isFake: false, isRestricted: false, isDeleted: false,
    isContact: true, isMutualContact: true, isCloseFriend: false, status: 'recently', lastOnline: null, language: 'de',
    // Another person's number. It must not travel into any row.
    phoneNumber: '+436641234567'
  }
  const tg = {
    getFullUser: (...a: unknown[]) => { calls.push(['getFullUser', a]); return Promise.resolve({ ...base, bio: 'Builds things.', isBlocked: false, commonChatsCount: 2, pinnedMsgId: null }) },
    getUser: (...a: unknown[]) => { calls.push(['getUser', a]); return Promise.resolve(base) },
    getCommonChats: (...a: unknown[]) => { calls.push(['getCommonChats', a]); return Promise.resolve([{ id: -1001, title: 'Team chat', chatType: 'supergroup' }]) }
  } as unknown as TelegramClient

  const full = await userInfo(tg, 42)
  assert.deepEqual(calls, [['getFullUser', [42]]])
  assert.equal(full.bio, 'Builds things.')
  assert.equal(full.mutualContact, true)
  assert.ok(!JSON.stringify(full).includes('+4366') && !('phoneNumber' in full) && !('phone' in full), 'no phone number in the row')

  const basic = await userInfo(tg, 42, { basic: true })
  assert.deepEqual(calls[1], ['getUser', [42]])
  assert.equal(basic.bio, undefined)

  const withChats = await userInfo(tg, 42, { common: true })
  assert.deepEqual(withChats.commonChats, [{ id: -1001, title: 'Team chat', kind: 'supergroup' }])
  assert.deepEqual(calls[3], ['getCommonChats', [42]])

  assertGolden('eval-192-user-info', `${renderUserInfo(withChats)}\n${renderUserInfo(basic)}`)
  assert.ok(!renderUserInfo(full).includes('+4366'))

  const gone = { getFullUser: () => Promise.reject(rpcError(400, 'USER_ID_INVALID')) } as unknown as TelegramClient
  await assert.rejects(() => userInfo(gone, 1), (e: unknown) => e instanceof OperatorError && e.exitCode === EXIT.usage)
})

test('eval-193 contacts list is the address book by name, filtered accent-blind, cut by limit, with no numbers', async () => {
  const person = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
    id, displayName: name, username: null, isMutualContact: false, isCloseFriend: false, isBot: false, isPremium: false,
    phoneNumber: `+4366400000${id}`, ...extra
  })
  const tg = {
    getContacts: () => Promise.resolve([
      person(3, 'Zoë Ünal', { username: 'zoe_unal', isMutualContact: true }),
      person(1, 'ada'), person(2, 'Bo', { isCloseFriend: true, isPremium: true }), person(4, 'Helper Bot', { isBot: true })
    ])
  } as unknown as TelegramClient

  const all = await contactsList(tg)
  assert.deepEqual(all.map((r) => r.name), ['ada', 'Bo', 'Helper Bot', 'Zoë Ünal'], 'by name, case-blind')
  assert.ok(!JSON.stringify(all).includes('+4366') && all.every((r) => !('phone' in r)))

  assert.deepEqual((await contactsList(tg, { query: 'zoe' })).map((r) => r.id), [3], 'an ASCII needle finds an accented name')
  assert.deepEqual((await contactsList(tg, { query: 'ZOE_UNAL' })).map((r) => r.id), [3], 'and the handle')
  assert.deepEqual((await contactsList(tg, { limit: 2 })).map((r) => r.id), [1, 2])
  assert.deepEqual(await contactsList(tg, { query: 'nobody' }), [])

  assertGolden('eval-193-contacts-list', renderContacts(all))
  assert.equal(renderContacts([]), 'no contacts\n')
})

/* -------------------------------------------------- dialogs, drafts, reactions */


/** A dialog as mtcute hands it back. */
function dialog(id: number, name: string, extra: Record<string, unknown> = {}): unknown {
  return {
    peer: peer(id, name, { type: id > 0 ? 'user' : 'chat' }),
    unreadCount: 0, unreadMentionsCount: 0, unreadReactionsCount: 0,
    isPinned: false, isMuted: null, isArchived: false, isManuallyUnread: false,
    lastMessage: null, draftMessage: null, ttlPeriod: null,
    ...extra
  }
}

test('eval-194 dialogs show reads the state of the chats asked for, in order, and names the ones with no dialog', async () => {
  const seen: unknown[] = []
  const tg = {
    getPeerDialogs: (ids: number[]) => {
      seen.push(ids)
      return Promise.resolve([
        dialog(7, 'Ada', { unreadCount: 3, isPinned: true, lastMessage: { date: new Date('2026-10-01T09:30:00Z'), text: 'see you\n  tomorrow' } }),
        null,
        dialog(CHAT, 'Team chat', { isMuted: true, isArchived: true, unreadMentionsCount: 1, draftMessage: { text: 'x' }, ttlPeriod: 604800 })
      ])
    }
  } as unknown as TelegramClient

  const { rows, missing } = await showDialogs(tg, [7, 99, CHAT])
  assert.deepEqual(seen[0], [7, 99, CHAT])
  assert.deepEqual(missing, [99])
  assert.equal(rows[0]?.lastMessage, 'see you tomorrow', 'one line')
  assert.equal(rows[1]?.hasDraft, true)
  assert.equal(rows[1]?.lastMessageAt, null)
  assertGolden('eval-194-dialogs-show', renderDialogs(rows))
  assert.equal(renderDialogs([]), 'no dialogs\n')

  const refused = { getPeerDialogs: () => Promise.reject(rpcError(400, 'PEER_ID_INVALID')) } as unknown as TelegramClient
  await assert.rejects(() => showDialogs(refused, [1]), (e: unknown) => e instanceof OperatorError && e.exitCode === EXIT.usage)
})

test('eval-195 draft list walks dialogs through the paced walk, keeps only the drafts, and prints them whole', async () => {
  await withInstantTimers(async (delays) => {
    const seen: unknown[] = []
    const withDraft = (id: number, name: string, text: string, at: string, reply?: number) => dialog(id, name, {
      draftMessage: { text, date: new Date(at), disableWebPreview: reply === undefined, replyToMessage: reply === undefined ? null : { replyToMsgId: reply } }
    })
    const dialogs = [
      dialog(1, 'Quiet'), withDraft(7, 'Ada', 'Thanks, see you\nat nine', '2026-10-01T09:00:00Z', 55),
      dialog(2, 'Also quiet'), withDraft(CHAT, 'Team chat', 'ship it', '2026-10-02T09:00:00Z')
    ]
    const tg = { iterDialogs: (params: unknown) => { seen.push(params); return each(dialogs) } } as unknown as TelegramClient

    const rows = await listDrafts(tg)
    assert.deepEqual(seen[0], { limit: DEFAULT_DRAFT_SCAN, chunkSize: 100, archived: 'keep' }, 'looks through the 200 most recent chats, archived ones too, a page at a time')
    assert.deepEqual(rows.map((r) => r.chat), ['Team chat', 'Ada'], 'newest draft first')
    assert.deepEqual(rows[1], { chatId: 7, chat: 'Ada', at: '2026-10-01T09:00', text: 'Thanks, see you\nat nine', replyTo: 55, noPreview: false })
    assertGolden('eval-195-draft-list', renderDrafts(rows))
    assert.equal(renderDrafts([]), 'no drafts\n')

    await listDrafts(tg, { scan: 30 })
    assert.deepEqual(seen[1], { limit: 30, chunkSize: 30, archived: 'keep' })

    // A scan that crosses a page boundary breathes, like every other walk.
    const many = Array.from({ length: 150 }, (_, i) => dialog(i + 1, `Chat ${i + 1}`))
    const big = { iterDialogs: () => each(many) } as unknown as TelegramClient
    assert.deepEqual(await listDrafts(big, { scan: 150 }), [])
    assert.deepEqual(delays, [1500])
  })
})

test('eval-196 reactions show gives the counts, the recent reactors, and with --users everyone; a channel keeps its voters anonymous', async () => {
  await withInstantTimers(async () => {
    const seen: unknown[] = []
    const reactor = (id: number, name: string, emoji: unknown, unread = false) => ({ userId: id, user: peer(id, name), emoji, unread })
    const target = message({ id: 31, text: 'ship it' })
    const tg = {
      getMessages: (chat: number, id: number) => { seen.push(['getMessages', chat, id]); return Promise.resolve([id === 31 ? target : null]) },
      getMessageReactions: (messages: unknown[]) => {
        seen.push(['getMessageReactions', messages.length])
        return Promise.resolve([{
          usersVisible: true,
          reactions: [{ emoji: '👍', count: 5, isPaid: false }, { emoji: { toString: (): string => '5368324170671202286' }, count: 2, isPaid: false }, { emoji: '⭐', count: 1, isPaid: true }],
          recentReactions: [reactor(7, 'Ada', '👍', true)]
        }])
      },
      // Two pages: Telegram says where the second starts, and that there is no third.
      getReactionUsers: (params: { offset?: unknown }) => {
        seen.push(['getReactionUsers', params])
        return Promise.resolve(params.offset === undefined
          ? Object.assign([reactor(7, 'Ada', '👍', true), reactor(8, 'Cy', '👍')], { next: 'offset-2' })
          : Object.assign([reactor(9, 'Di', '⭐')], { next: undefined }))
      }
    } as unknown as TelegramClient

    const quick = await showReactions(tg, CHAT, 31)
    assert.deepEqual(seen, [['getMessages', CHAT, 31], ['getMessageReactions', 1]], 'two requests, no reactor walk unless asked')
    assert.equal(quick?.total, 8)
    assert.deepEqual(quick?.counts.map((c) => c.emoji), ['👍', 'custom:5368324170671202286', '⭐'])
    assert.equal(quick?.users, undefined)

    seen.length = 0
    const everyone = await showReactions(tg, CHAT, 31, { users: true, limit: 50 })
    assert.deepEqual(seen.slice(2), [
      ['getReactionUsers', { chatId: CHAT, message: 31, limit: 50 }],
      ['getReactionUsers', { chatId: CHAT, message: 31, limit: 48, offset: 'offset-2' }]
    ], 'the second page continues where Telegram said and asks for what is still wanted')
    assert.deepEqual(everyone?.users?.map((u) => u.name), ['Ada', 'Cy', 'Di'], 'each person once')
    assertGolden('eval-196-reactions-show', `${renderReactions(quick!)}\n${renderReactions(everyone!)}`)

    assert.equal(await showReactions(tg, CHAT, 999), null, 'no such message is null')

    // A message nobody reacted to.
    const bare = { getMessages: () => Promise.resolve([target]), getMessageReactions: () => Promise.resolve([null]) } as unknown as TelegramClient
    const none = await showReactions(bare, CHAT, 31)
    assert.equal(none?.total, 0)
    assert.equal(renderReactions(none!), 'no reactions on message #31\n')

    // Channels do not say who: Telegram refuses, and the refusal is exit 2 with the reason.
    const channel = {
      ...tg,
      getMessages: () => Promise.resolve([target]),
      getMessageReactions: () => Promise.resolve([null]),
      getReactionUsers: () => Promise.reject(rpcError(400, 'BROADCAST_FORBIDDEN'))
    } as unknown as TelegramClient
    await assert.rejects(
      () => showReactions(channel, CHAT, 31, { users: true }),
      (e: unknown) => e instanceof OperatorError && e.exitCode === EXIT.usage && /anonymous/.test(e.message)
    )
  })
})

test('eval-196b who reacted is read once: the walk stops when Telegram has no next page, where mtcute 0.27.8 would repeat it', async () => {
  await withInstantTimers(async () => {
    let requests = 0
    const reactor = (id: number) => ({ userId: id, user: peer(id, `User ${id}`), emoji: '👍', unread: false })
    const tg = {
      getMessages: () => Promise.resolve([message({ id: 31 })]),
      getMessageReactions: () => Promise.resolve([null]),
      // Always the same single page with no next offset: what a message with two reactors looks like.
      // iterReactionUsers would ask again from the top, and yield these two until the limit.
      getReactionUsers: () => { requests++; return Promise.resolve(Object.assign([reactor(1), reactor(2)], { next: undefined })) },
      iterReactionUsers: () => { throw new Error('iterReactionUsers never ends in mtcute 0.27.8') }
    } as unknown as TelegramClient

    const row = await showReactions(tg, CHAT, 31, { users: true, limit: 100 })
    assert.deepEqual(row?.users?.map((u) => u.userId), [1, 2])
    assert.equal(requests, 1, 'one request, not fifty')

    // An empty page ends the walk too, even if Telegram still offers a next offset.
    const empty = {
      ...tg,
      getReactionUsers: () => { requests++; return Promise.resolve(Object.assign([], { next: 'more' })) }
    } as unknown as TelegramClient
    requests = 0
    assert.deepEqual((await showReactions(empty, CHAT, 31, { users: true }))?.users, [])
    assert.equal(requests, 1)
  })
})

/* --------------------------------------------------------------- account */


test('eval-197 account sessions, privacy and notify send exactly the raw reads they claim, and read the answers', async () => {
  const requests: unknown[] = []
  const auth = (hash: string, extra: Record<string, unknown>) => ({
    _: 'authorization', hash: { toString: (): string => hash }, deviceModel: 'laptop', platform: 'Linux', systemVersion: '6.1', apiId: 1,
    appName: 'tg', appVersion: '0.8.0', dateCreated: 1_790_000_000, dateActive: 1_790_100_000, ip: '203.0.113.9', country: 'AT', region: 'Vienna',
    ...extra
  })
  const rules: Record<string, unknown[]> = {
    inputPrivacyKeyStatusTimestamp: [{ _: 'privacyValueAllowContacts' }, { _: 'privacyValueDisallowUsers', users: [5, 6] }],
    inputPrivacyKeyPhoneNumber: [{ _: 'privacyValueDisallowAll' }],
    inputPrivacyKeyChatInvite: []
  }
  const tg = {
    call: (request: { _: string; key?: { _: string }; peer?: { _: string } }) => {
      requests.push(request)
      switch (request._) {
        case 'account.getAuthorizations':
          return Promise.resolve({
            authorizationTtlDays: 183,
            authorizations: [
              auth('111', { deviceModel: 'phone', dateActive: 1_780_000_000 }),
              auth('222', { current: true, deviceModel: '2026-10-17/work@vm', appName: 'mtcute', officialApp: false }),
              auth('333', { unconfirmed: true, passwordPending: true, officialApp: true, ip: '', region: '', country: '' })
            ]
          })
        case 'account.getPrivacy':
          return Promise.resolve({ rules: rules[request.key?._ ?? ''] ?? [{ _: 'privacyValueAllowAll' }] })
        case 'account.getNotifySettings': {
          const kind = request.peer?._
          return Promise.resolve(
            kind === 'inputNotifyUsers' ? { _: 'peerNotifySettings', showPreviews: false, muteUntil: 0 }
              : kind === 'inputNotifyChats' ? { _: 'peerNotifySettings', muteUntil: 1_790_500_000, silent: true }
                : kind === 'inputNotifyBroadcasts' ? { _: 'peerNotifySettings', muteUntil: 2147483647, storiesMuted: true }
                  : { _: 'peerNotifySettings', showPreviews: true, muteUntil: 1_790_000_000 }
          )
        }
        default:
          return Promise.reject(new Error(`unexpected raw call ${request._}`))
      }
    },
    resolvePeer: (id: number) => { requests.push(['resolvePeer', id]); return Promise.resolve({ _: 'inputPeerChannel', channelId: 1234567890 }) }
  } as unknown as TelegramClient

  // Sessions: this one first, then the most recently active.
  const sessions = await listSessions(tg)
  assert.deepEqual(requests[0], { _: 'account.getAuthorizations' })
  assert.deepEqual(sessions.sessions.map((s) => s.hash), ['222', '333', '111'], 'this session first, then the most recently active')
  assert.equal(sessions.sessions[0]?.current, true)
  assert.equal(sessions.autoTerminateDays, 183)
  assertGolden('eval-197-account-sessions', renderSessions(sessions))
  assert.equal(renderSessions({ sessions: [], autoTerminateDays: null }), 'no sessions\n')

  // Privacy: one request per key, the key spelled as Telegram's constructor, rules in the order sent.
  requests.length = 0
  const one = await readPrivacy(tg, ['last-seen'])
  assert.deepEqual(requests, [{ _: 'account.getPrivacy', key: { _: 'inputPrivacyKeyStatusTimestamp' } }])
  assert.deepEqual(one[0]?.rules, [{ rule: 'allow-contacts', ids: [] }, { rule: 'deny-users', ids: [5, 6] }])
  requests.length = 0
  const every = await readPrivacy(tg, Object.keys(PRIVACY_KEYS) as PrivacyKeyName[])
  assert.equal(requests.length, Object.keys(PRIVACY_KEYS).length)
  assertGolden('eval-197-account-privacy', renderPrivacy(every.filter((r) => ['last-seen', 'phone-number', 'groups', 'about'].includes(r.key))))
  assert.ok(isPrivacyKey('last-seen') && !isPrivacyKey('toString') && !isPrivacyKey('__proto__'))

  // Every privacy key Telegram's schema defines has a name here, so a new one is noticed.
  const fromCore = createRequire(join(dirname(fileURLToPath(import.meta.resolve('@mtcute/core'))), 'package.json'))
  const schema = JSON.parse(readFileSync(fromCore.resolve('@mtcute/tl/api-schema.json'), 'utf-8')) as { e: { kind: string; name: string }[] }
  const keysInSchema = schema.e.filter((e) => e.kind === 'class' && e.name.startsWith('inputPrivacyKey')).map((e) => e.name).sort()
  assert.deepEqual([...Object.values(PRIVACY_KEYS)].sort(), keysInSchema, 'PRIVACY_KEYS must cover every inputPrivacyKey* the schema has')
  assert.ok(tlRpcMethods().has('account.getPrivacy'))

  // Notify: the three defaults, or one chat through its resolved input peer.
  requests.length = 0
  const now = 1_790_100_000
  const defaults = await readNotify(tg, [{ kind: 'users' }, { kind: 'chats' }, { kind: 'channels' }], now)
  assert.deepEqual(requests, [
    { _: 'account.getNotifySettings', peer: { _: 'inputNotifyUsers' } },
    { _: 'account.getNotifySettings', peer: { _: 'inputNotifyChats' } },
    { _: 'account.getNotifySettings', peer: { _: 'inputNotifyBroadcasts' } }
  ])
  assert.deepEqual(defaults.map((d) => d.muted), ['no', 'until 2026-09-27T09:06', 'forever'])
  requests.length = 0
  const chatOne = await readNotify(tg, [{ kind: 'peer', peerId: CHAT }], now)
  assert.deepEqual(requests, [['resolvePeer', CHAT], { _: 'account.getNotifySettings', peer: { _: 'inputNotifyPeer', peer: { _: 'inputPeerChannel', channelId: 1234567890 } } }])
  assert.equal(chatOne[0]?.muted, 'no', 'a mute that has already ended is not muted')
  assertGolden('eval-197-account-notify', renderNotify([...defaults, ...chatOne]))

  // Refusals map; and nothing the account does here is a write.
  const refused = { call: () => Promise.reject(rpcError(400, 'PRIVACY_KEY_INVALID')) } as unknown as TelegramClient
  await assert.rejects(() => readPrivacy(refused, ['last-seen']), (e: unknown) => e instanceof OperatorError && e.exitCode === EXIT.usage)
  const sent = new Set(requests.flatMap((r) => (Array.isArray(r) ? [] : [(r as { _: string })._])))
  assert.ok([...sent].every((method) => /^account\.get/.test(method)), 'only get* methods were called')
})
