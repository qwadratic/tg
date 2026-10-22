import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MtTypeAssertionError, Story, parsePeer, type TelegramClient } from '@mtcute/node'
import { OperatorError } from '../errors.js'
import { EXIT } from '../exit-codes.js'
import { parsePeerRef } from '../peers/ref.js'
import { reading } from '../reads/errors.js'

/**
 * Stories: `tg story <link>`, `tg story <peer> <id>` and `tg story list <peer>`.
 *
 * Reads only, and the one rule that matters here is the one Telegram itself makes
 * easy to break: a story shows its owner who looked at it. Opening a story in the
 * app sends `stories.readStories`, and the app also counts a view. Nothing here
 * sends either. A story is fetched by id (`stories.getStoriesByID`) or listed
 * (`stories.getPeerStories`), both plain lookups that leave no trace, and its
 * media is downloaded like any file. `readStories` and `incrementStoriesViews`
 * are classed `defer`, write, in the coverage manifest, and eval-205 fails the
 * suite if this module could reach either (README: "Nothing marks a message read,
 * a reaction read or a story viewed").
 *
 * No viewer lists, no reactions, no stealth mode: only counts when Telegram sends
 * them. Who looked at a story is its owner's business.
 */

const minute = (date: Date | null | undefined): string => (date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 16) : '')

/** Telegram story ids are 32-bit. */
export const MAX_STORY_ID = 2_147_483_647

/* ------------------------------------------------------------------ rows */

/** One piece of the caption that is more than text. */
export interface StoryEntityRow {
  kind: string
  /** The text it covers, as written in the caption. */
  text: string
  offset: number
  length: number
  /** The target of a hidden link (`text_link`). A plain URL has none: the text is the URL. */
  url?: string
  /** The person a `text_mention` points at. */
  userId?: number
}

/** A sticker-like element laid over the picture: a link, a place, a post, a reaction. */
export interface StoryAreaRow {
  type: 'url' | 'location' | 'venue' | 'channel_post' | 'reaction' | 'weather' | 'star_gift' | 'unknown'
  /** One line saying what it is, ready to print. */
  description: string
  url?: string
  latitude?: number
  longitude?: number
  address?: string
  /** For a channel post: the channel's name and username, when Telegram sent them. */
  channel?: string | null
  channelUsername?: string | null
  messageId?: number
  link?: string
}

export interface StoryMediaRow {
  /** `photo`, `video`, or `unsupported` for a kind mtcute cannot read. */
  type: 'photo' | 'video' | 'unsupported'
  width: number | null
  height: number | null
  /** Seconds, for a video. */
  duration: number | null
  bytes: number | null
}

export interface StoryRepostRow {
  /** Who posted the original: a name, or null when Telegram hid it. */
  from: string | null
  fromId: number | null
  storyId: number | null
  /** The media was changed before reposting (a reaction laid over a round video, for one). */
  modified: boolean
}

/** One story, flattened. */
export interface StoryRow {
  id: number
  /** The owner, as resolved by the command. */
  peerId: number
  peer: string
  username: string | null
  /** `https://t.me/<username>/s/<id>`, or null when the owner has no username. */
  link: string | null
  /** ISO to the minute. */
  at: string
  expires: string
  /** Not expired yet. A pinned story outlives its 24 hours; this is about the clock, not the profile. */
  active: boolean
  /** The whole caption, never clipped. */
  caption: string
  entities: StoryEntityRow[]
  /** URLs in the caption and on the picture, no repeats. */
  links: string[]
  /** `@name` mentions and text mentions in the caption. */
  mentions: string[]
  media: StoryMediaRow
  areas: StoryAreaRow[]
  repost: StoryRepostRow | null
  privacy: {
    /** `public`, `contacts`, `close_friends`, `selected_contacts`, or `unknown`. */
    visibility: string
    pinned: boolean
    contentProtected: boolean
    edited: boolean
    /** Posted by this account. */
    mine: boolean
  }
  /** Telegram sent a reduced version, so the privacy flags and areas may be incomplete. Read it by id. */
  short: boolean
  /** Counts only, when Telegram sends them. Never who. */
  counts: { views: number; forwards: number | null; reactions: number } | null
  /** Where the media was saved, once downloaded. */
  file: string | null
  fileBytes: number | null
}

/** Who owns the story, as the command resolved it. */
export interface StoryOwner {
  id: number
  name: string
  username: string | null
}

/** A story Telegram listed without its content: only when and for whom. */
export interface StoryStubRow {
  id: number
  at: string
  expires: string
  closeFriends: boolean
}

function safely<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

/** The link to a story, which exists only for an owner with a username. */
export function storyLink(username: string | null | undefined, id: number): string | null {
  return username ? `https://t.me/${username}/s/${id}` : null
}

function entityRows(story: Story): StoryEntityRow[] {
  return safely(() => story.entities, []).map((entity) => {
    const params = safely(() => entity.params as { kind: string; url?: string; userId?: number }, { kind: 'unknown' })
    return {
      kind: params.kind,
      text: safely(() => entity.text, ''),
      offset: entity.offset,
      length: entity.length,
      ...(typeof params.url === 'string' ? { url: params.url } : {}),
      ...(typeof params.userId === 'number' ? { userId: params.userId } : {})
    }
  })
}

function areaRows(story: Story): StoryAreaRow[] {
  const elements = safely(() => story.interactiveElements, [])
  const unreadable: StoryAreaRow = { type: 'unknown', description: 'an element this version cannot read' }
  return elements.map((element): StoryAreaRow => {
    // One odd element (a location mtcute cannot parse) must not cost the whole story.
    try {
      return areaRow(element)
    } catch {
      return unreadable
    }
  })
}

function areaRow(element: Story['interactiveElements'][number]): StoryAreaRow {
  switch (element.type) {
    case 'url':
      return { type: 'url', description: `link ${element.url}`, url: element.url }
    case 'location': {
      const { latitude, longitude } = element.location
      const address = placeOf(element.raw)
      return {
        type: 'location',
        description: `location ${latitude}, ${longitude}${address ? ` (${address})` : ''}`,
        latitude,
        longitude,
        ...(address ? { address } : {})
      }
    }
    case 'venue': {
      const { latitude, longitude } = element.location
      return {
        type: 'venue',
        description: `venue ${element.title}, ${element.address} (${latitude}, ${longitude})`,
        latitude,
        longitude,
        address: element.address
      }
    }
    case 'channel_post': {
      const chat = safely(() => element.chat, null)
      const username = chat?.username ?? null
      const name = chat?.displayName ?? null
      const link = username
        ? `https://t.me/${username}/${element.messageId}`
        : `https://t.me/c/${element.raw.channelId}/${element.messageId}`
      return {
        type: 'channel_post',
        description: `channel post ${name ?? `channel ${element.raw.channelId}`}${username ? ` (@${username})` : ''} #${element.messageId} ${link}`,
        channel: name,
        channelUsername: username,
        messageId: element.messageId,
        link
      }
    }
    case 'reaction':
      return { type: 'reaction', description: `suggested reaction ${safely(() => String(element.emoji), '?')}` }
    case 'weather':
      return { type: 'weather', description: `weather ${element.emoji} ${element.temperature}°C` }
    case 'star_gift':
      return { type: 'star_gift', description: `star gift ${element.slug}` }
    default:
      return { type: 'unknown', description: 'an element this version cannot read' }
  }
}

/** "Vienna, AT" from the address Telegram attaches to a location sticker, when it does. */
function placeOf(raw: { address?: { city?: string; state?: string; street?: string; countryIso2: string } }): string {
  const address = raw.address
  if (!address) return ''
  return [address.street, address.city, address.state, address.countryIso2].filter(Boolean).join(', ')
}

function mediaRow(story: Story): StoryMediaRow {
  const unsupported: StoryMediaRow = { type: 'unsupported', width: null, height: null, duration: null, bytes: null }
  try {
    const media = story.media
    const bytes = (media as unknown as { fileSize?: number | null }).fileSize ?? null
    if (media.type === 'photo') return { type: 'photo', width: media.width, height: media.height, duration: null, bytes }
    return { type: 'video', width: media.width, height: media.height, duration: media.duration, bytes }
  } catch {
    return unsupported
  }
}

function repostRow(story: Story): StoryRepostRow | null {
  const header = story.raw.fwdFrom
  if (!header) return null

  const from = header.from ? safely(() => parsePeer(header.from!, story._peers), null) : null
  return {
    from: from?.displayName ?? header.fromName ?? null,
    fromId: from?.id ?? null,
    storyId: header.storyId ?? null,
    modified: Boolean(header.modified)
  }
}

/** One story, flattened. `owner` is who the command asked for: a story does not carry its own owner. */
export function storyRow(story: Story, owner: StoryOwner): StoryRow {
  const entities = entityRows(story)
  const areas = areaRows(story)

  const links = [
    ...entities.flatMap((entity) => {
      if (entity.kind === 'url') return [entity.text]
      return entity.url ? [entity.url] : []
    }),
    ...areas.flatMap((area) => (area.url ? [area.url] : []))
  ]
  const mentions = entities.flatMap((entity) => {
    if (entity.kind === 'mention') return [entity.text]
    if (entity.kind === 'text_mention') return [`${entity.text} [id ${entity.userId ?? '?'}]`]
    return []
  })

  const views = story.raw.views
  return {
    id: story.id,
    peerId: owner.id,
    peer: owner.name,
    username: owner.username,
    link: storyLink(owner.username, story.id),
    at: minute(story.date),
    expires: minute(story.expireDate),
    active: story.isActive,
    caption: story.caption ?? '',
    entities,
    links: [...new Set(links)],
    mentions: [...new Set(mentions)],
    media: mediaRow(story),
    areas,
    repost: repostRow(story),
    privacy: {
      visibility: safely(() => story.visibility, 'unknown'),
      pinned: Boolean(story.isPinned),
      contentProtected: Boolean(story.isContentProtected),
      edited: Boolean(story.isEdited),
      mine: Boolean(story.isMy)
    },
    short: Boolean(story.isShort),
    counts: views ? { views: views.viewsCount, forwards: views.forwardsCount ?? null, reactions: views.reactionsCount ?? 0 } : null,
    file: null,
    fileBytes: null
  }
}

/* ------------------------------------------------------------- reading */

/** Why a story could not be read. */
export type StoryGone = 'deleted' | 'hidden' | 'none'

export type StoryLookup = { story: Story } | { story: null; gone: StoryGone }

/**
 * One story by id.
 *
 * `stories.getStoriesByID` answers a story that is deleted or expired with a
 * placeholder, and mtcute 0.27.8 turns the placeholder into a type-assertion
 * error. That is the ordinary "this story is not there any more", not a bug in
 * either, so it comes back as `gone` (the command exits 2). A placeholder of any
 * other kind is not read; an error that is not about a story placeholder stays
 * what it was.
 */
export async function getStory(tg: TelegramClient, peerId: number, id: number): Promise<StoryLookup> {
  let found: Story[]
  try {
    found = await reading(() => tg.getStoriesById(peerId, [id]))
  } catch (error) {
    if (error instanceof MtTypeAssertionError) {
      if (error.actual === 'storyItemDeleted') return { story: null, gone: 'deleted' }
      if (error.actual === 'storyItemSkipped') return { story: null, gone: 'hidden' }
    }
    throw error
  }

  const story = found.find((candidate) => candidate.id === id) ?? found[0]
  return story ? { story } : { story: null, gone: 'none' }
}

export interface StoryList {
  stories: Story[]
  /** Listed by Telegram without content (a story visible to close friends, or one it left out for size). */
  stubs: StoryStubRow[]
}

/**
 * The active stories of one peer, oldest first as Telegram sends them.
 *
 * `PeerStories#stories` in mtcute throws on any item that is not a full story, so
 * the raw items are sorted here: full ones become `Story`, the others are counted
 * and listed as stubs, and `tg story <peer> <id>` reads them one by one.
 */
export async function listStories(tg: TelegramClient, peerId: number): Promise<StoryList> {
  const peerStories = await reading(() => tg.getPeerStories(peerId))

  const stories: Story[] = []
  const stubs: StoryStubRow[] = []
  for (const item of peerStories.raw.stories) {
    if (item._ === 'storyItem') stories.push(new Story(item, peerStories._peers))
    else if (item._ === 'storyItemSkipped') {
      stubs.push({
        id: item.id,
        at: minute(new Date(item.date * 1000)),
        expires: minute(new Date(item.expireDate * 1000)),
        closeFriends: Boolean(item.closeFriends)
      })
    }
    // storyItemDeleted: gone, nothing to show.
  }
  return { stories, stubs }
}

/* ---------------------------------------------------------------- media */

/**
 * Where a story's media goes: `<dir>/story-<owner>-<id>.<ext>`.
 *
 * The owner leads the id because story ids are per owner, so two people's story
 * 885 must not meet in one folder. The owner is a username (ASCII by Telegram's
 * own rule) or a number, and is still cleaned, because a name that reaches a
 * path is never trusted.
 */
export function storyFilename(owner: StoryOwner, id: number, extension: string): string {
  const who = (owner.username ?? String(Math.abs(owner.id))).replace(/[^A-Za-z0-9_-]/g, '')
  return `story-${who || Math.abs(owner.id)}-${id}.${extension}`
}

function extensionOf(media: { type: string; mimeType?: string }): string {
  if (media.type === 'photo') return 'jpg'
  switch (media.mimeType) {
    case 'video/webm': return 'webm'
    case 'video/quicktime': return 'mov'
    default: return 'mp4'
  }
}

/** Download a story's photo or video into `destDir`, like `tg media pull`. Null when the media is a kind mtcute cannot read. */
export async function downloadStoryMedia(
  tg: TelegramClient,
  story: Story,
  owner: StoryOwner,
  destDir: string
): Promise<{ path: string; bytes: number } | null> {
  let media: Story['media']
  try {
    media = story.media
  } catch {
    return null
  }

  mkdirSync(destDir, { recursive: true })
  const path = join(destDir, storyFilename(owner, story.id, extensionOf(media)))
  const buffer = await reading(() => tg.downloadAsBuffer(media))
  await writeFile(path, buffer)
  return { path, bytes: buffer.length }
}

/* --------------------------------------------------------------- reads */

/**
 * What `tg story <target>` does once the owner is known: look the story up, flatten
 * it and, when `destDir` is given, save its media. The command adds only argument
 * checks, the session and the printing, so a test can run exactly this against a
 * client that fails on anything that is not a lookup (eval-205).
 */
export async function readStory(
  tg: TelegramClient,
  owner: StoryOwner,
  id: number,
  options: { destDir?: string | undefined } = {}
): Promise<{ row: StoryRow } | { gone: StoryGone }> {
  const lookup = await getStory(tg, owner.id, id)
  if (!lookup.story) return { gone: lookup.gone }

  const row = storyRow(lookup.story, owner)
  if (options.destDir !== undefined) await saveMedia(tg, lookup.story, owner, row, options.destDir)
  return { row }
}

/** What `tg story list <peer>` does once the owner is known. `destDir` set means `--download`. */
export async function readStoryList(
  tg: TelegramClient,
  owner: StoryOwner,
  options: { destDir?: string | undefined } = {}
): Promise<{ rows: StoryRow[]; stubs: StoryStubRow[] }> {
  const listed = await listStories(tg, owner.id)

  const rows: StoryRow[] = []
  for (const item of listed.stories) {
    const row = storyRow(item, owner)
    if (options.destDir !== undefined) await saveMedia(tg, item, owner, row, options.destDir)
    rows.push(row)
  }
  return { rows, stubs: listed.stubs }
}

/** Download one story's media and record where it went. */
async function saveMedia(tg: TelegramClient, story: Story, owner: StoryOwner, row: StoryRow, destDir: string): Promise<void> {
  const saved = await downloadStoryMedia(tg, story, owner, destDir)
  if (!saved) return
  row.file = saved.path
  row.fileBytes = saved.bytes
}

/* ---------------------------------------------------------------- links */

export interface StoryRef {
  /** What to resolve: a username from a link, or the peer as typed. */
  peer: string
  id: number
}

const STORY_LINK = /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/([^/?#]+)\/s\/(\d+)\/?(?:[?#].*)?$/i

/** The owner and id in a story link, or null when the text is not one. Offline. */
export function parseStoryLink(raw: string): StoryRef | null {
  const match = STORY_LINK.exec(String(raw ?? '').trim())
  if (!match) return null
  return { peer: match[1] ?? '', id: Number(match[2]) }
}

function badStoryId(raw: string): OperatorError {
  return new OperatorError(
    `Not a story id: ${JSON.stringify(raw)}. A story id is a positive whole number up to ${MAX_STORY_ID}.`,
    EXIT.usage
  )
}

/**
 * What the command line named, checked before a session is opened.
 *
 * One argument is a story link; two are a peer and a story id. A message link is
 * refused by name (it is `tg msg link`), and an invite link like every peer
 * reference (`parsePeerRef`).
 */
export function parseStoryTarget(target: string, id?: string): StoryRef {
  const link = parseStoryLink(target)

  if (id === undefined) {
    if (!link) {
      const hint = /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/[^/?#]+\/\d/i.test(target.trim())
        ? ' That looks like a message link: use `tg msg link`.'
        : ''
      throw new OperatorError(
        `Cannot use ${JSON.stringify(target)} as a story.${hint}\n` +
        '  Accepted forms:\n' +
        '    https://t.me/durov/s/123   a story link\n' +
        '    tg story <peer> <id>       a peer (id, @username, t.me link or me) and the story id',
        EXIT.usage
      )
    }
    return validated(link)
  }

  if (link) {
    throw new OperatorError(
      `${JSON.stringify(target)} is a story link and already names the story. Give either the link, or a peer and an id.`,
      EXIT.usage
    )
  }
  if (!/^\d+$/.test(id.trim())) throw badStoryId(id)
  return validated({ peer: target.trim(), id: Number(id.trim()) })
}

function validated(ref: StoryRef): StoryRef {
  parsePeerRef(ref.peer)
  if (!Number.isSafeInteger(ref.id) || ref.id < 1 || ref.id > MAX_STORY_ID) throw badStoryId(String(ref.id))
  return ref
}

/* --------------------------------------------------------------- render */

/** Indent every line after the first, so a multi-line caption stays one block. */
const block = (text: string): string => text.replace(/\n/g, '\n    ')

const kb = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024))} KB`

function mediaLine(row: StoryRow): string {
  const { media } = row
  if (media.type === 'unsupported') return 'media: a kind this version cannot read'
  const size = media.width && media.height ? ` ${media.width}x${media.height}` : ''
  const length = media.duration ? ` ${Math.round(media.duration)}s` : ''
  const bytes = row.fileBytes ?? media.bytes
  return `media: ${media.type}${size}${length}${bytes ? ` (${kb(bytes)})` : ''}`
}

function privacyLine(row: StoryRow): string {
  const { privacy } = row
  return [
    privacy.visibility,
    privacy.pinned ? 'pinned' : null,
    privacy.edited ? 'edited' : null,
    privacy.contentProtected ? 'content-protected' : null,
    privacy.mine ? 'posted by this account' : null
  ].filter((part): part is string => part !== null).join(', ')
}

function repostLine(repost: StoryRepostRow): string {
  const who = repost.from ? `${repost.from}${repost.fromId === null ? '' : ` [id ${repost.fromId}]`}` : 'someone who hides it'
  return `reposted from: ${who}${repost.storyId === null ? '' : `, story ${repost.storyId}`}${repost.modified ? ' (modified)' : ''}`
}

/**
 * One story as text. Pure, so a golden can pin it.
 *
 * Every line has a label and none is skipped when empty except the optional ones
 * (caption, links, mentions, areas, repost, counts), so a story with no caption
 * says nothing about one rather than printing an empty block.
 */
export function renderStory(row: StoryRow): string {
  const handle = row.username ? ` (@${row.username})` : ''
  const lines = [
    `story ${row.id} of ${row.peer}${handle} [id ${row.peerId}]`,
    `posted ${row.at}, expires ${row.expires} (${row.active ? 'active' : 'expired'})`,
    ...(row.link ? [`link: ${row.link}`] : []),
    mediaLine(row),
    ...(row.file ? [`file: ${row.file}`] : []),
    `privacy: ${privacyLine(row)}`,
    ...(row.short ? ['note: Telegram sent a reduced version of this story; read it by id for the full one'] : []),
    ...(row.repost ? [repostLine(row.repost)] : []),
    ...(row.caption ? [`caption:\n    ${block(row.caption)}`] : []),
    ...(row.links.length > 0 ? [`links: ${row.links.join(' ')}`] : []),
    ...(row.mentions.length > 0 ? [`mentions: ${row.mentions.join(' ')}`] : []),
    ...(row.areas.length > 0 ? ['areas:', ...row.areas.map((area) => `  ${area.description}`)] : []),
    ...(row.counts
      ? [`counts: ${row.counts.views} views${row.counts.forwards === null ? '' : `, ${row.counts.forwards} forwards`}, ${row.counts.reactions} reactions`]
      : [])
  ]
  return `${lines.join('\n')}\n`
}

/** `tg story list`: one compact block per story, then the ones Telegram left out. Pure. */
export function renderStoryList(owner: StoryOwner, rows: StoryRow[], stubs: StoryStubRow[]): string {
  const handle = owner.username ? ` (@${owner.username})` : ''
  if (rows.length === 0 && stubs.length === 0) return `no active stories for ${owner.name}${handle}\n`

  const head = `${rows.length + stubs.length} active ${rows.length + stubs.length === 1 ? 'story' : 'stories'} of ${owner.name}${handle} [id ${owner.id}]`
  const body = rows.map((row) => {
    const caption = row.caption.replace(/\s+/g, ' ').trim()
    const clipped = caption.length > 100 ? `${caption.slice(0, 99)}…` : caption
    return [
      `#${row.id} [${row.at} -> ${row.expires}] ${row.media.type}, ${row.privacy.visibility}${row.privacy.pinned ? ', pinned' : ''}${clipped ? `: ${clipped}` : ''}`,
      ...(row.link ? [`    ${row.link}`] : []),
      ...(row.file ? [`    file: ${row.file}`] : [])
    ].join('\n')
  })
  const left = stubs.map(
    (stub) => `#${stub.id} [${stub.at} -> ${stub.expires}] content not sent${stub.closeFriends ? ', close friends' : ''}: read it with tg story ${owner.username ? `@${owner.username}` : owner.id} ${stub.id}`
  )
  return `${[head, ...body, ...left].join('\n')}\n`
}
