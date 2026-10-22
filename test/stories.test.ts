import assert from 'node:assert'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import * as mtcute from '@mtcute/core/methods.js'
import { Long, MtTypeAssertionError, PeersIndex, Story, tl, type TelegramClient } from '@mtcute/node'
import { OperatorError } from '../src/errors.js'
import { EXIT } from '../src/exit-codes.js'
import { resolvePeerRef } from '../src/peers/ref.js'
import { friendlyReadError } from '../src/reads/errors.js'
import {
  MAX_STORY_ID,
  downloadStoryMedia,
  getStory,
  listStories,
  parseStoryLink,
  parseStoryTarget,
  readStory,
  readStoryList,
  renderStory,
  renderStoryList,
  storyFilename,
  storyLink,
  storyRow,
  type StoryOwner
} from '../src/stories/index.js'
import { CLIENT_METHODS } from './coverage-manifest.js'
import { clientUses, loadSources, rawMethodsNamed } from './fence-scan.js'
import { assertGolden, withTempDir } from './helpers.js'
import { rpcError } from './read-mocks.js'
import { tlRpcMethods } from './mtcute-api.js'

/**
 * `tg story` (0.9.0): a story by link or by id, and a peer's active stories.
 *
 * The stories here are real TL objects run through mtcute's own `Story` class, so
 * what is pinned is how tg reads what Telegram sends. The clients are strict
 * fakes: they answer the lookups a story read makes and throw on anything else,
 * which is how eval-205 proves that reading a story never marks it viewed.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf-8')

const OWNER: StoryOwner = { id: -1001234567890, name: 'Cheshire Cat', username: 'cheshire304' }
const PERSON: StoryOwner = { id: 5, name: 'Ada Lovelace', username: null }

const long = (n: number): Long => Long.fromNumber(n)
const at = (iso: string): number => Math.floor(Date.parse(iso) / 1000)

const coordinates: tl.RawMediaAreaCoordinates = { _: 'mediaAreaCoordinates', x: 10, y: 20, w: 30, h: 10, rotation: 0 }
const geo: tl.RawGeoPoint = { _: 'geoPoint', long: 16.3738, lat: 48.2082, accessHash: long(0) }

const photoMedia = (): tl.RawMessageMediaPhoto => ({
  _: 'messageMediaPhoto',
  photo: {
    _: 'photo',
    id: long(1),
    accessHash: long(2),
    fileReference: new Uint8Array([1]),
    date: at('2026-10-22T08:15:00Z'),
    sizes: [
      { _: 'photoSize', type: 'm', w: 320, h: 569, size: 20_000 },
      { _: 'photoSize', type: 'x', w: 1080, h: 1920, size: 212_345 }
    ],
    dcId: 2
  }
})

const videoMedia = (mimeType = 'video/mp4'): tl.RawMessageMediaDocument => ({
  _: 'messageMediaDocument',
  document: {
    _: 'document',
    id: long(3),
    accessHash: long(4),
    fileReference: new Uint8Array([1]),
    date: at('2026-10-22T08:15:00Z'),
    mimeType,
    size: 3_145_728,
    dcId: 2,
    attributes: [{ _: 'documentAttributeVideo', duration: 12.4, w: 720, h: 1280 }]
  }
})

const CAPTION = '@alice see https://example.com/a and the docs, ask Bob about #vienna'
const span = (needle: string): { offset: number; length: number } => ({ offset: CAPTION.indexOf(needle), length: needle.length })

const channel = {
  _: 'channel', id: 1234, accessHash: long(9), title: 'Wien Notes', username: 'wiennotes', date: 0, photo: { _: 'chatPhotoEmpty' }, version: 0
} as unknown as tl.TypeChat

const peers = PeersIndex.from({ users: [], chats: [channel] })

function storyItem(fields: Partial<tl.RawStoryItem> = {}): tl.RawStoryItem {
  return {
    _: 'storyItem',
    id: 885,
    date: at('2026-10-22T08:15:00Z'),
    expireDate: at('2026-10-23T08:15:00Z'),
    public: true,
    media: photoMedia(),
    ...fields
  }
}

const makeStory = (fields: Partial<tl.RawStoryItem> = {}): Story => new Story(storyItem(fields), peers)

/** A story with every kind of thing Telegram can hang on one. */
const fullItem = (): Partial<tl.RawStoryItem> => ({
  pinned: true,
  edited: true,
  noforwards: true,
  caption: CAPTION,
  entities: [
    { _: 'messageEntityMention', ...span('@alice') },
    { _: 'messageEntityUrl', ...span('https://example.com/a') },
    { _: 'messageEntityTextUrl', ...span('the docs'), url: 'https://example.com/docs' },
    { _: 'messageEntityMentionName', ...span('Bob'), userId: 77 },
    { _: 'messageEntityHashtag', ...span('#vienna') }
  ],
  mediaAreas: [
    { _: 'mediaAreaUrl', coordinates, url: 'https://example.com/promo' },
    { _: 'mediaAreaGeoPoint', coordinates, geo, address: { _: 'geoPointAddress', countryIso2: 'AT', city: 'Vienna' } },
    { _: 'mediaAreaVenue', coordinates, geo, title: 'Cafe Central', address: 'Herrengasse 14', provider: 'foursquare', venueId: 'v1', venueType: 'cafe' },
    { _: 'mediaAreaChannelPost', coordinates, channelId: 1234, msgId: 55 },
    { _: 'mediaAreaSuggestedReaction', coordinates, reaction: { _: 'reactionEmoji', emoticon: '❤' } },
    { _: 'mediaAreaWeather', coordinates, emoji: '☀', temperatureC: 21, color: 0 }
  ],
  fwdFrom: { _: 'storyFwdHeader', from: { _: 'peerChannel', channelId: 1234 }, storyId: 12, modified: true },
  views: { _: 'storyViews', viewsCount: 1234, forwardsCount: 3, reactionsCount: 40 }
})

/** Run `fn` with the clock at a chosen moment, so "active" is a fact of the test and not of the day it runs. */
async function atTime<T>(iso: string, fn: () => Promise<T> | T): Promise<T> {
  const real = Date.now
  Date.now = () => Date.parse(iso)
  try {
    return await fn()
  } finally {
    Date.now = real
  }
}

type Handler = (...args: unknown[]) => unknown

/**
 * A client that answers only what it is given and throws the moment anything else
 * is touched, even to look the property up. A viewing method is just a name this
 * fake was never given, so reaching one fails the test where it happens.
 */
function strictClient(handlers: Record<string, Handler>): TelegramClient {
  return new Proxy({}, {
    get(_target, name) {
      if (typeof name === 'symbol' || name === 'then') return undefined
      const handler = handlers[name]
      if (!handler) throw new Error(`the story read touched tg.${name}, which is not a lookup`)
      return handler
    }
  }) as unknown as TelegramClient
}

/* ----------------------------------------------------------------- links */

test('eval-201 a story link is read offline, and everything that is not one is refused as usage (2) before a session', () => {
  const refused = (run: () => unknown): OperatorError => {
    try { run() } catch (e) { return e as OperatorError }
    throw new Error('should have been refused')
  }

  // The forms people paste.
  assert.deepEqual(parseStoryLink('https://t.me/cheshire304/s/885'), { peer: 'cheshire304', id: 885 })
  assert.deepEqual(parseStoryLink('t.me/cheshire304/s/885/'), { peer: 'cheshire304', id: 885 }, 'no scheme, a trailing slash')
  assert.deepEqual(parseStoryLink('http://www.telegram.me/Cheshire304/s/7?single'), { peer: 'Cheshire304', id: 7 }, 'telegram.me, a query')
  assert.deepEqual(parseStoryLink(' https://t.me/durov/s/1#x '), { peer: 'durov', id: 1 }, 'a fragment, padding')
  assert.equal(parseStoryLink('https://t.me/cheshire304/885'), null, 'a message link is not a story link')
  assert.equal(parseStoryLink('https://t.me/cheshire304/s/'), null)
  assert.equal(parseStoryLink('https://t.me/cheshire304/s/12x'), null)
  assert.equal(parseStoryLink('https://example.com/cheshire304/s/885'), null)

  // One argument: a link. Two: a peer and an id.
  assert.deepEqual(parseStoryTarget('https://t.me/cheshire304/s/885'), { peer: 'cheshire304', id: 885 })
  assert.deepEqual(parseStoryTarget('@cheshire304', '885'), { peer: '@cheshire304', id: 885 })
  assert.deepEqual(parseStoryTarget('me', '3'), { peer: 'me', id: 3 })
  assert.deepEqual(parseStoryTarget('904417238', ' 12 '), { peer: '904417238', id: 12 })
  assert.deepEqual(parseStoryTarget('-1001234567890', '2'), { peer: '-1001234567890', id: 2 })
  assert.deepEqual(parseStoryTarget('https://t.me/durov', '9'), { peer: 'https://t.me/durov', id: 9 }, 'a plain peer link plus an id')
  assert.equal(parseStoryTarget('x'.repeat(4), String(MAX_STORY_ID)).id, MAX_STORY_ID)

  const usage = (error: OperatorError, message: RegExp): void => {
    assert.equal(error.exitCode, EXIT.usage)
    assert.match(error.message, message)
  }
  usage(refused(() => parseStoryTarget('https://t.me/cheshire304/885')), /message link: use `tg msg link`/)
  usage(refused(() => parseStoryTarget('https://t.me/c/1234567890/12')), /message link/)
  usage(refused(() => parseStoryTarget('nonsense')), /Accepted forms/)
  usage(refused(() => parseStoryTarget('@cheshire304')), /Cannot use .* as a story/)
  usage(refused(() => parseStoryTarget('https://t.me/+AbCdEf123/s/5')), /Cannot use .* as a chat|invite/)
  usage(refused(() => parseStoryTarget('https://t.me/cheshire304/s/0')), /Not a story id/)
  usage(refused(() => parseStoryTarget('https://t.me/cheshire304/s/2147483648')), /Not a story id/)
  usage(refused(() => parseStoryTarget('https://t.me/cheshire304/s/99999999999999999999')), /Not a story id/)
  usage(refused(() => parseStoryTarget('@cheshire304', 'abc')), /Not a story id/)
  usage(refused(() => parseStoryTarget('@cheshire304', '0')), /Not a story id/)
  usage(refused(() => parseStoryTarget('@cheshire304', '1e3')), /Not a story id/)
  usage(refused(() => parseStoryTarget('@cheshire304', '-4')), /Not a story id/)
  usage(refused(() => parseStoryTarget('@cheshire304', '')), /Not a story id/)
  usage(refused(() => parseStoryTarget('https://t.me/cheshire304/s/5', '7')), /already names the story/)
  usage(refused(() => parseStoryTarget('@durоv', '5')), /non-ASCII/)
  usage(refused(() => parseStoryTarget('https://t.me/dur-ov/s/5')), /not a valid username/)

  assert.equal(storyLink('cheshire304', 885), 'https://t.me/cheshire304/s/885')
  assert.equal(storyLink(null, 885), null, 'a person with no username has no story link')
})

/* ---------------------------------------------------------------- reading */

test('eval-202 a story is fetched by id with one lookup, and a deleted, expired or hidden one is "gone" (exit 2), not a crash', async () => {
  const calls: unknown[][] = []
  const ok = strictClient({
    getStoriesById: (...args) => { calls.push(args); return Promise.resolve([makeStory()]) }
  })
  const found = await getStory(ok, OWNER.id, 885)
  assert.ok(found.story)
  assert.equal(found.story.id, 885)
  assert.deepEqual(calls, [[OWNER.id, [885]]], 'one id, one request, for the resolved owner')

  const gone = async (error: Error): Promise<unknown> =>
    getStory(strictClient({ getStoriesById: () => Promise.reject(error) }), OWNER.id, 885)

  // mtcute 0.27.8 raises a type assertion for the placeholder Telegram sends for a story that is gone.
  assert.deepEqual(await gone(new MtTypeAssertionError('getProfileStories', 'storyItem', 'storyItemDeleted')), { story: null, gone: 'deleted' })
  assert.deepEqual(await gone(new MtTypeAssertionError('getProfileStories', 'storyItem', 'storyItemSkipped')), { story: null, gone: 'hidden' })
  assert.deepEqual(await getStory(strictClient({ getStoriesById: () => Promise.resolve([]) }), OWNER.id, 885), { story: null, gone: 'none' })

  // Anything else is not "gone": a different placeholder stays an error, and Telegram's refusals keep their codes.
  await assert.rejects(() => gone(new MtTypeAssertionError('x', 'storyItem', 'somethingElse')), MtTypeAssertionError)
  await assert.rejects(() => gone(new Error('boom')), /boom/)
  await assert.rejects(
    () => gone(rpcError(420, 'FLOOD_WAIT_30')),
    (e: unknown) => e instanceof OperatorError && e.exitCode === EXIT.upstream && /30s/.test(e.message)
  )
  await assert.rejects(
    () => gone(rpcError(400, 'CHANNEL_PRIVATE')),
    (e: unknown) => e instanceof OperatorError && e.exitCode === EXIT.usage
  )
  for (const text of ['STORY_ID_INVALID', 'STORY_ID_EMPTY', 'PEER_ID_INVALID']) {
    const mapped = friendlyReadError(rpcError(400, text))
    assert.ok(mapped instanceof OperatorError && mapped.exitCode === EXIT.usage, text)
  }
})

test('eval-203 a story is flattened with its caption, links, areas, repost, privacy and counts, and prints the same way every time', async () => {
  const row = await atTime('2026-10-22T12:00:00Z', () => storyRow(makeStory(fullItem()), OWNER))

  assert.equal(row.id, 885)
  assert.equal(row.peerId, OWNER.id)
  assert.equal(row.link, 'https://t.me/cheshire304/s/885')
  assert.equal(row.at, '2026-10-22T08:15')
  assert.equal(row.expires, '2026-10-23T08:15')
  assert.equal(row.active, true)
  assert.equal(row.caption, CAPTION, 'the caption is never clipped')

  // Entities, with the target of a hidden link and the person a text mention points at.
  assert.deepEqual(row.entities.map((e) => [e.kind, e.text]), [
    ['mention', '@alice'], ['url', 'https://example.com/a'], ['text_link', 'the docs'], ['text_mention', 'Bob'], ['hashtag', '#vienna']
  ])
  assert.equal(row.entities.find((e) => e.kind === 'text_link')?.url, 'https://example.com/docs')
  assert.equal(row.entities.find((e) => e.kind === 'text_mention')?.userId, 77)
  assert.deepEqual(row.links, ['https://example.com/a', 'https://example.com/docs', 'https://example.com/promo'], 'caption links first, then the link on the picture, no repeats')
  assert.deepEqual(row.mentions, ['@alice', 'Bob [id 77]'])

  // Media.
  assert.deepEqual(row.media, { type: 'photo', width: 1080, height: 1920, duration: null, bytes: row.media.bytes })

  // The areas laid over the picture.
  assert.deepEqual(row.areas.map((a) => a.type), ['url', 'location', 'venue', 'channel_post', 'reaction', 'weather'])
  const area = (type: string) => row.areas.find((a) => a.type === type)!
  assert.equal(area('url').url, 'https://example.com/promo')
  assert.deepEqual([area('location').latitude, area('location').longitude, area('location').address], [48.2082, 16.3738, 'Vienna, AT'])
  assert.deepEqual([area('venue').address, area('venue').description], ['Herrengasse 14', 'venue Cafe Central, Herrengasse 14 (48.2082, 16.3738)'])
  assert.deepEqual([area('channel_post').channelUsername, area('channel_post').messageId, area('channel_post').link], ['wiennotes', 55, 'https://t.me/wiennotes/55'])
  assert.match(area('reaction').description, /❤/)
  assert.match(area('weather').description, /21°C/)

  // Repost, privacy, counts.
  assert.deepEqual(row.repost, { from: 'Wien Notes', fromId: -1000000001234, storyId: 12, modified: true })
  assert.deepEqual(row.privacy, { visibility: 'public', pinned: true, contentProtected: true, edited: true, mine: false })
  assert.deepEqual(row.counts, { views: 1234, forwards: 3, reactions: 40 })
  assert.equal(row.short, false)
  assert.equal(row.file, null, 'nothing is saved until media is downloaded')

  assertGolden('eval-203-story-full', renderStory({ ...row, file: '/data/media/story-cheshire304-885.jpg', fileBytes: 212_345 }))

  // The clock decides "active", and nothing else does.
  assert.equal(await atTime('2026-10-24T00:00:00Z', () => storyRow(makeStory(), OWNER).active), false)

  // A plain video story, a person with no username (so no link), a hidden reposter, and every privacy bucket.
  const video = storyRow(makeStory({ media: videoMedia(), caption: 'two\nlines', closeFriends: true, public: false, min: true, fwdFrom: { _: 'storyFwdHeader', fromName: 'Someone Private' } }), PERSON)
  assert.deepEqual(video.media, { type: 'video', width: 720, height: 1280, duration: 12.4, bytes: video.media.bytes })
  assert.equal(video.link, null)
  assert.equal(video.privacy.visibility, 'close_friends')
  assert.equal(video.short, true)
  assert.deepEqual(video.repost, { from: 'Someone Private', fromId: null, storyId: null, modified: false })
  assert.equal(video.counts, null, 'no counts, no line')
  for (const [flags, visibility] of [[{ contacts: true }, 'contacts'], [{ selectedContacts: true }, 'selected_contacts'], [{ closeFriends: true }, 'close_friends'], [{}, 'unknown']] as const) {
    assert.equal(storyRow(makeStory({ public: false, ...flags }), PERSON).privacy.visibility, visibility)
  }
  await atTime('2026-10-22T12:00:00Z', () => assertGolden('eval-203-story-video', renderStory(storyRow(makeStory({ media: videoMedia(), caption: 'two\nlines', closeFriends: true, public: false, min: true, fwdFrom: { _: 'storyFwdHeader', fromName: 'Someone Private' } }), PERSON))))

  // One area mtcute cannot parse (a location with no point) costs that area, not the story.
  const brokenArea = storyRow(makeStory({
    mediaAreas: [
      { _: 'mediaAreaGeoPoint', coordinates, geo: { _: 'geoPointEmpty' } },
      { _: 'mediaAreaUrl', coordinates, url: 'https://example.com/ok' }
    ]
  }), PERSON)
  assert.deepEqual(brokenArea.areas.map((a) => a.type), ['unknown', 'url'])
  assert.deepEqual(brokenArea.links, ['https://example.com/ok'])
  assert.match(renderStory(brokenArea), /an element this version cannot read/)

  // A kind mtcute cannot read is reported as such, not as a crash.
  const odd = storyRow(makeStory({ media: { _: 'messageMediaGeo', geo } as tl.TypeMessageMedia }), PERSON)
  assert.equal(odd.media.type, 'unsupported')
  assert.match(renderStory(odd), /media: a kind this version cannot read/)
})

test('eval-203b a peer\'s stories are listed, with the ones Telegram sent without content named and the deleted ones dropped', async () => {
  const peerStories = {
    raw: {
      _: 'peerStories',
      peer: { _: 'peerChannel', channelId: 1234 },
      stories: [
        storyItem({ id: 884, caption: 'older', date: at('2026-10-22T06:00:00Z'), expireDate: at('2026-10-23T06:00:00Z') }),
        { _: 'storyItemDeleted', id: 3 },
        { _: 'storyItemSkipped', id: 886, closeFriends: true, date: at('2026-10-22T09:00:00Z'), expireDate: at('2026-10-23T09:00:00Z') },
        storyItem({ id: 885, caption: 'a '.repeat(80), media: videoMedia() })
      ]
    },
    _peers: peers
  }
  const tg = strictClient({ getPeerStories: (peer) => { assert.equal(peer, OWNER.id); return Promise.resolve(peerStories) } })

  const listed = await listStories(tg, OWNER.id)
  assert.deepEqual(listed.stories.map((s) => s.id), [884, 885], 'full stories only; mtcute\'s own PeerStories#stories would have thrown on the others')
  assert.deepEqual(listed.stubs, [{ id: 886, at: '2026-10-22T09:00', expires: '2026-10-23T09:00', closeFriends: true }])

  const { rows, stubs } = await readStoryList(tg, OWNER)
  assert.equal(rows.every((r) => r.file === null), true, 'a list saves nothing unless asked')
  await atTime('2026-10-22T12:00:00Z', () => assertGolden('eval-203-story-list', renderStoryList(OWNER, rows, stubs)))

  // Nothing active is a legitimately empty listing, said in words.
  const none = strictClient({ getPeerStories: () => Promise.resolve({ raw: { stories: [] }, _peers: peers }) })
  const empty = await readStoryList(none, PERSON)
  assert.equal(renderStoryList(PERSON, empty.rows, empty.stubs), 'no active stories for Ada Lovelace\n')

  await assert.rejects(
    () => listStories(strictClient({ getPeerStories: () => Promise.reject(rpcError(420, 'FLOOD_WAIT_9')) }), OWNER.id),
    (e: unknown) => e instanceof OperatorError && e.exitCode === EXIT.upstream
  )
})

/* ----------------------------------------------------------------- media */

test('eval-204 media is saved like `tg media pull` saves it, under a name that cannot collide or escape, and a story with nothing to save saves nothing', async () => {
  await withTempDir(async (dir) => {
    const downloads: unknown[] = []
    const tg = strictClient({
      downloadAsBuffer: (media) => { downloads.push(media); return Promise.resolve(new Uint8Array([1, 2, 3, 4])) }
    })

    const photo = makeStory()
    const saved = await downloadStoryMedia(tg, photo, OWNER, join(dir, 'media'))
    assert.equal(saved?.path, join(dir, 'media', 'story-cheshire304-885.jpg'))
    assert.equal(saved?.bytes, 4)
    assert.ok(existsSync(join(dir, 'media', 'story-cheshire304-885.jpg')), 'the folder is created')
    assert.equal(statSync(join(dir, 'media', 'story-cheshire304-885.jpg')).size, 4)
    assert.equal(downloads[0], photo.media, 'the photo itself goes to the downloader')

    const video = await downloadStoryMedia(tg, makeStory({ id: 886, media: videoMedia() }), PERSON, join(dir, 'media'))
    assert.equal(video?.path, join(dir, 'media', 'story-5-886.mp4'), 'no username: the number, never a minus sign from a channel id')
    const webm = await downloadStoryMedia(tg, makeStory({ id: 887, media: videoMedia('video/webm') }), OWNER, join(dir, 'media'))
    assert.equal(webm?.path, join(dir, 'media', 'story-cheshire304-887.webm'))

    // Where it goes is the readStory path too: row.file and row.fileBytes say so.
    const read = await readStory(tg, OWNER, 885, { destDir: join(dir, 'media') }).catch((e: unknown) => e)
    assert.ok(read instanceof Error, 'this client has no getStoriesById, and that is what the strict fake says')

    const both = strictClient({
      getStoriesById: () => Promise.resolve([makeStory()]),
      downloadAsBuffer: () => Promise.resolve(new Uint8Array(2048))
    })
    const withFile = await readStory(both, OWNER, 885, { destDir: join(dir, 'out') })
    assert.ok('row' in withFile)
    assert.equal(withFile.row.file, join(dir, 'out', 'story-cheshire304-885.jpg'))
    assert.equal(withFile.row.fileBytes, 2048)
    const noFile = await readStory(both, OWNER, 885)
    assert.ok('row' in noFile)
    assert.equal(noFile.row.file, null, 'no destDir, no download (--no-media)')

    // A kind mtcute cannot read has nothing to download, and no request is made for it.
    const geoOnly = makeStory({ media: { _: 'messageMediaGeo', geo } as tl.TypeMessageMedia })
    assert.equal(await downloadStoryMedia(strictClient({}), geoOnly, OWNER, join(dir, 'x')), null)
    assert.equal(existsSync(join(dir, 'x')), false, 'and no folder')
  })

  // A name that reaches a path is cleaned, and an owner never traverses.
  assert.equal(storyFilename({ id: 1, name: 'x', username: '../../etc/passwd' }, 7, 'jpg'), 'story-etcpasswd-7.jpg')
  assert.equal(storyFilename({ id: -100123, name: 'x', username: null }, 7, 'mp4'), 'story-100123-7.mp4')
  assert.equal(storyFilename({ id: 9, name: 'x', username: '///' }, 7, 'jpg'), 'story-9-7.jpg', 'a name with nothing left falls back to the id')
  assert.doesNotMatch(storyFilename({ id: 1, name: 'x', username: 'a/b\\c' }, 1, 'jpg'), /[/\\]/)
})

/* ------------------------------------------------- nothing marks it viewed */

/** Telegram RPCs and client methods that tell a story's owner something, or change a story. */
const VIEWING_METHODS = ['readStories', 'incrementStoriesViews', 'sendStoryReaction', 'hideMyStoriesViews', 'getStoryViewers', 'iterStoryViewers']
const VIEWING_RPCS = ['stories.readStories', 'stories.incrementStoryViews', 'stories.sendReaction', 'stories.activateStealthMode', 'stories.togglePinned']

test('eval-205 reading a story never marks it viewed: a client that fails on anything but a lookup runs the whole read, down to mtcute\'s own RPCs', async () => {
  // The wire: mtcute's real getStoriesById and getPeerStories, on a client that records every RPC
  // and fails on any it does not know. This is what mtcute really sends for our two reads.
  const rpcs: string[] = []
  const wire = {
    call: (request: { _: string }): Promise<unknown> => {
      rpcs.push(request._)
      if (request._ === 'stories.getStoriesByID') {
        return Promise.resolve({ _: 'stories.stories', count: 1, stories: [storyItem(fullItem())], chats: [channel], users: [] })
      }
      if (request._ === 'stories.getPeerStories') {
        return Promise.resolve({
          _: 'stories.peerStories',
          stories: { _: 'peerStories', peer: { _: 'peerChannel', channelId: 1234 }, stories: [storyItem(), { _: 'storyItemDeleted', id: 3 }] },
          chats: [channel],
          users: []
        })
      }
      return Promise.reject(new Error(`unexpected RPC ${request._}`))
    }
  } as unknown as Parameters<typeof mtcute.getStoriesById>[0]
  const input = { _: 'inputPeerChannel', channelId: 1234, accessHash: long(9) } as tl.TypeInputPeer

  const traffic: string[] = []
  const tg = strictClient({
    getPeer: (ref) => { traffic.push('getPeer'); return Promise.resolve({ id: OWNER.id, displayName: OWNER.name, username: OWNER.username, ref }) },
    getStoriesById: (peer, ids) => { traffic.push('getStoriesById'); assert.equal(peer, OWNER.id); return mtcute.getStoriesById(wire, input, ids as number[]) },
    getPeerStories: (peer) => { traffic.push('getPeerStories'); assert.equal(peer, OWNER.id); return mtcute.getPeerStories(wire, input) },
    downloadAsBuffer: () => { traffic.push('downloadAsBuffer'); return Promise.resolve(new Uint8Array([7])) }
  })

  await withTempDir(async (dir) => {
    // The whole path the command runs: name resolution, the read by id with a download, the list with downloads.
    const owner = await resolvePeerRef(tg, 'https://t.me/cheshire304')
    assert.equal(owner.id, OWNER.id)

    const one = await readStory(tg, owner, 885, { destDir: dir })
    assert.ok('row' in one)
    assert.equal(one.row.caption, CAPTION, 'the real mtcute parsed the real answer')

    const list = await readStoryList(tg, owner, { destDir: dir })
    assert.equal(list.rows.length, 1)
    assert.equal(list.rows[0]?.file !== null, true)
  })

  assert.deepEqual(rpcs, ['stories.getStoriesByID', 'stories.getPeerStories'], 'two reads, two lookups, nothing else on the wire')
  for (const rpc of rpcs) assert.ok(!VIEWING_RPCS.includes(rpc), rpc)
  assert.deepEqual(traffic, ['getPeer', 'getStoriesById', 'downloadAsBuffer', 'getPeerStories', 'downloadAsBuffer'])

  // The real mtcute also turns the "gone" placeholder into the error eval-202 handles: the claim and the library agree.
  const placeholder = {
    call: () => Promise.resolve({ _: 'stories.stories', count: 1, stories: [{ _: 'storyItemDeleted', id: 885 }], chats: [], users: [] })
  } as unknown as Parameters<typeof mtcute.getStoriesById>[0]
  const deleted = strictClient({ getStoriesById: (_peer, ids) => mtcute.getStoriesById(placeholder, input, ids as number[]) })
  assert.deepEqual(await getStory(deleted, OWNER.id, 885), { story: null, gone: 'deleted' })
  assert.deepEqual(await readStory(deleted, OWNER, 885), { gone: 'deleted' })

  // The trap works: the fake is not a fake that cannot fail. Each of these is what a viewing read would do.
  for (const method of VIEWING_METHODS) {
    assert.throws(() => (tg as unknown as Record<string, unknown>)[method], new RegExp(`touched tg\\.${method}`), method)
  }
  await assert.rejects(() => wire.call({ _: 'stories.readStories', peer: input, maxId: 885 } as never), /unexpected RPC stories\.readStories/)
  await assert.rejects(() => wire.call({ _: 'stories.incrementStoryViews', peer: input, id: [885] } as never), /unexpected RPC/)
  assert.deepEqual(rpcs.slice(2), ['stories.readStories', 'stories.incrementStoryViews'], 'and the recorder saw them, so a real call would show in the list above')
})

test('eval-205b nothing in src/ names a viewing method, and the story files call exactly three client methods and no raw RPC', () => {
  const sources = loadSources()
  const known = new Set(Object.keys(CLIENT_METHODS))
  const uses = clientUses(sources, known)

  // Whole tree: no viewing, reacting or viewer-listing method is called anywhere, in or out of the fence.
  assert.deepEqual(uses.filter((use) => VIEWING_METHODS.includes(use.name)).map((use) => use.where), [])
  const tl = tlRpcMethods()
  assert.deepEqual(rawMethodsNamed(sources, (name) => tl.has(name) && VIEWING_RPCS.includes(name)), [])

  // The two the manifest keeps from ever being called by a read.
  for (const name of ['readStories', 'incrementStoriesViews']) {
    assert.deepEqual(CLIENT_METHODS[name], ['defer', 'write'], `${name} stays deferred, and a write`)
  }

  // The story files: the three lookups, and no raw call at all.
  const mine = uses.filter((use) => use.path === 'stories/index.ts' || use.path === 'cli/commands/story.ts')
  assert.deepEqual([...new Set(mine.map((use) => use.name))].sort(), ['downloadAsBuffer', 'getPeerStories', 'getStoriesById'])
  assert.deepEqual(rawMethodsNamed(sources.filter((f) => f.path.includes('stories') || f.path.endsWith('story.ts')), (name) => tl.has(name)), [])
  for (const name of ['getStoriesById', 'getPeerStories']) assert.deepEqual(CLIENT_METHODS[name], ['covered', 'read'])
  assert.ok(sources.some((f) => f.path === 'stories/index.ts'), 'the scan found the module, so it does not pass for the wrong reason')

  // And the module does not import the send module (eval-31 holds the graph; this is the plain reading of it).
  assert.doesNotMatch(read('src', 'stories', 'index.ts') + read('src', 'cli', 'commands', 'story.ts'), /send\/(index|gate)/)
})

/* ------------------------------------------------------------------- cli */

test('eval-206 tg story is refused offline as usage (2) with the JSON envelope, and its help names the list verb', async () => {
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

    const cases: [string[], RegExp][] = [
      [['story', 'https://t.me/cheshire304/885'], /message link: use `tg msg link`/],
      [['story', 'https://t.me/+AbCdEf123'], /Cannot use/],
      [['story', 'https://t.me/cheshire304/s/0'], /Not a story id/],
      [['story', '@cheshire304', 'abc'], /Not a story id/],
      [['story', 'https://t.me/cheshire304/s/5', '7'], /already names the story/],
      [['story', '@durоv', '5'], /non-ASCII/],
      [['story', 'list', '@durоv'], /non-ASCII/],
      [['story', 'list', 'x'], /not a numeric id and not a valid username/]
    ]
    const results = await Promise.all(cases.map(([args]) => run([...args, '--json'])))
    results.forEach((result, i) => {
      const [args, message] = cases[i]!
      assert.equal(result.code, EXIT.usage, `tg ${args.join(' ')} exited ${result.code}`)
      const envelope = JSON.parse(result.stdout) as { ok: boolean; error: { code: string; exit: number; detail: string } }
      assert.equal(envelope.ok, false)
      assert.equal(envelope.error.code, 'usage')
      assert.match(envelope.error.detail, message, `tg ${args.join(' ')}`)
    })

    // Missing arguments are commander's usage failures, which this CLI maps to 2.
    assert.equal((await run(['story'])).code, EXIT.usage)
    assert.equal((await run(['story', 'list'])).code, EXIT.usage)

    const help = await run(['story', '--help'])
    assert.equal(help.code, 0)
    assert.match(help.stdout, /list \[options\] <peer>/)
    assert.match(help.stdout, /--no-media/)
    assert.match(help.stdout, /never marks\s+a story viewed/)
  })
})
