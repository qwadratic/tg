import assert from 'node:assert'
import test from 'node:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Message, TelegramClient } from '@mtcute/node'
import { dumpThread, messageRefs, renderDump } from '../src/dump/index.js'
import { foldAccents, listPeers, matchPeers, renderPeers } from '../src/peers/index.js'
import { mediaMatches, pullMedia, renderPulled } from '../src/media/index.js'
import { parsePeerRef } from '../src/peers/ref.js'
import { EXIT } from '../src/exit-codes.js'
import { assertGolden, withTempDir } from './helpers.js'

/**
 * The verbs promoted out of throwaway scripts.
 *
 * Each of these replaced a file in the repo root that had no test at all, so
 * these are the first assertions any of this behaviour has ever had.
 */

/** A message shaped enough for the dump and media paths. */
function msg(params: {
  id: number
  date: string
  who?: string
  text?: string
  media?: Record<string, unknown>
  entities?: Record<string, unknown>[]
}): Message {
  return {
    id: params.id,
    date: new Date(params.date),
    sender: { firstName: params.who ?? 'Ada' },
    text: params.text ?? '',
    media: params.media,
    entities: params.entities
  } as unknown as Message
}

/** A client that yields fixed history, newest-first, like iterHistory does. */
function historyClient(messages: Message[], downloads: Record<number, Uint8Array> = {}): TelegramClient {
  return {
    async *iterHistory() {
      for (const m of messages) yield m
    },
    async downloadAsBuffer(media: unknown) {
      const id = (media as { __id?: number }).__id ?? 0
      return downloads[id] ?? new Uint8Array([1, 2, 3])
    }
  } as unknown as TelegramClient
}

/** A client that yields fixed dialogs. */
function dialogClient(dialogs: unknown[]): TelegramClient {
  return {
    async *iterDialogs() {
      for (const d of dialogs) yield d
    }
  } as unknown as TelegramClient
}

test('eval-50 a transcript reads oldest-first and drops service messages', async () => {
  // iterHistory yields newest-first; a transcript has to invert that.
  const lines = await dumpThread(
    historyClient([
      msg({ id: 3, date: '2026-08-03T10:00:00Z', who: 'Bo', text: 'third' }),
      msg({ id: 2, date: '2026-08-02T10:00:00Z', who: 'Ada', text: '' }), // service: no text, no media
      msg({ id: 1, date: '2026-08-01T10:00:00Z', who: 'Ada', text: 'first' })
    ]),
    42
  )

  assert.deepEqual(lines.map((l) => l.id), [1, 3], 'oldest first, service message dropped')
  assertGolden('eval-50-dump-transcript', renderDump(lines))
})

test('eval-51 a dump captures URLs that never appear in the message text', () => {
  // A text_link entity hides its target behind a label, so a transcript that
  // only keeps `text` loses the reference entirely.
  const refs = messageRefs(
    msg({
      id: 1,
      date: '2026-08-01T10:00:00Z',
      text: 'see the docs and https://plain.example/x',
      entities: [
        { kind: 'text_link', url: 'https://hidden.example/deep' },
        { kind: 'url', offset: 17, length: 24 }
      ]
    })
  )

  assert.ok(refs.includes('https://hidden.example/deep'), 'label-hidden URL captured')
  assert.ok(refs.includes('https://plain.example/x'), 'plain URL captured')
})

test('eval-52 a dump captures link previews and file names, without duplicates', () => {
  const refs = messageRefs(
    msg({
      id: 1,
      date: '2026-08-01T10:00:00Z',
      text: '',
      media: { type: 'document', fileName: 'build.apk', url: 'https://p.example/a', title: 'Build' }
    })
  )

  assert.deepEqual(refs, ['preview:https://p.example/a', 'file:build.apk', 'title:Build'])

  // The same URL arriving as both an entity and a preview must appear once.
  const deduped = messageRefs(
    msg({
      id: 2,
      date: '2026-08-01T10:00:00Z',
      text: 'https://same.example/x',
      entities: [{ kind: 'url', offset: 0, length: 22 }, { kind: 'text_link', url: 'https://same.example/x' }]
    })
  )
  assert.deepEqual(deduped, ['https://same.example/x'])
})

test('eval-53 a dump stops at --since instead of walking the whole history', async () => {
  const lines = await dumpThread(
    historyClient([
      msg({ id: 3, date: '2026-08-10T10:00:00Z', text: 'inside' }),
      msg({ id: 2, date: '2026-08-05T10:00:00Z', text: 'inside' }),
      msg({ id: 1, date: '2026-01-01T10:00:00Z', text: 'ancient' })
    ]),
    42,
    { since: new Date('2026-08-01T00:00:00Z') }
  )

  assert.deepEqual(lines.map((l) => l.id), [2, 3], 'the pre-cutoff message ended the walk')
})

test('eval-54 a dump honours --limit', async () => {
  const many = Array.from({ length: 20 }, (_, i) =>
    msg({ id: 20 - i, date: `2026-08-${String(20 - i).padStart(2, '0')}T10:00:00Z`, text: 'x' })
  )
  const lines = await dumpThread(historyClient(many), 42, { limit: 5 })
  assert.equal(lines.length, 5)
})

test('eval-55 peers list is newest-first and filters type, bots and date', async () => {
  const dialogs = [
    { peer: { id: 1, type: 'user', displayName: 'Ada L', username: 'ada' }, lastMessage: { text: 'hi', date: new Date('2026-08-10T09:00:00Z') } },
    { peer: { id: 2, type: 'user', displayName: 'Bo T', isBot: true }, lastMessage: { text: 'beep', date: new Date('2026-08-15T09:00:00Z') } },
    { peer: { id: -100, type: 'channel', title: 'News' }, lastMessage: { text: 'post', date: new Date('2026-08-16T09:00:00Z') } },
    { peer: { id: 3, type: 'user', displayName: 'Cy R' }, lastMessage: { text: 'old', date: new Date('2026-01-01T09:00:00Z') } }
  ]

  const all = await listPeers(dialogClient(dialogs))
  assert.deepEqual(all.map((p) => p.id), [-100, 2, 1, 3], 'newest activity first')

  const users = await listPeers(dialogClient(dialogs), { type: 'user' })
  assert.deepEqual(users.map((p) => p.id), [2, 1, 3], 'channel excluded')

  const humans = await listPeers(dialogClient(dialogs), { type: 'user', excludeBots: true })
  assert.deepEqual(humans.map((p) => p.id), [1, 3], 'bot excluded')

  const recent = await listPeers(dialogClient(dialogs), {
    type: 'user',
    since: new Date('2026-08-01T00:00:00Z')
  })
  assert.deepEqual(recent.map((p) => p.id), [2, 1], 'stale chat excluded')

  assertGolden('eval-55-peers-table', renderPeers(users))
})

test('eval-56 an empty chat sorts last instead of crashing the comparator', async () => {
  const peers = await listPeers(
    dialogClient([
      { peer: { id: 1, type: 'user', displayName: 'No Messages' }, lastMessage: undefined },
      { peer: { id: 2, type: 'user', displayName: 'Has One' }, lastMessage: { text: 'hi', date: new Date('2026-08-10T09:00:00Z') } }
    ])
  )

  assert.deepEqual(peers.map((p) => p.id), [2, 1])
  // The deepEqual above pins the length at 2.
  assert.equal(peers[1]!.lastMessageAt, null)
})

test('eval-57 an ASCII needle finds an accented name', () => {
  assert.equal(foldAccents('Zoë'), 'zoe')
  assert.equal(foldAccents('Ünïcödé'), 'unicode')

  const peers = [
    { id: 1, type: 'user', name: 'Zoë Ünal', username: null, bot: false, lastMessageAt: null, lastMessage: '' },
    { id: 2, type: 'user', name: 'Someone Else', username: 'zoe_fan', bot: false, lastMessageAt: null, lastMessage: '' },
    { id: 3, type: 'user', name: 'Nobody', username: null, bot: false, lastMessageAt: null, lastMessage: '' }
  ]

  assert.deepEqual(matchPeers(peers, 'zoe').map((p) => p.id), [1, 2], 'name and username both match')
  assert.deepEqual(matchPeers(peers, 'ZOË').map((p) => p.id), [1, 2], 'needle is folded too')
  assert.deepEqual(matchPeers(peers, 'zzz'), [])
})

test('eval-58 a video sent as a document still matches --kind video', () => {
  const asVideo = msg({ id: 1, date: '2026-08-01T10:00:00Z', media: { type: 'video' } })
  const asDoc = msg({ id: 2, date: '2026-08-01T10:00:00Z', media: { type: 'document', fileName: 'clip.MOV' } })
  const pdf = msg({ id: 3, date: '2026-08-01T10:00:00Z', media: { type: 'document', fileName: 'cv.pdf' } })
  const none = msg({ id: 4, date: '2026-08-01T10:00:00Z', text: 'no media' })

  assert.equal(mediaMatches(asVideo, ['video']), true)
  assert.equal(mediaMatches(asDoc, ['video']), true, 'a .MOV document is a video')
  assert.equal(mediaMatches(pdf, ['video']), false)
  assert.equal(mediaMatches(none, ['video']), false)
  assert.equal(mediaMatches(pdf, []), true, 'no kinds means any media')
  assert.equal(mediaMatches(none, []), false, 'but a message with no media never matches')
})

test('eval-59 media pull scans past non-matches and stops at --max', async () => {
  await withTempDir(async () => {
    const messages = [
      msg({ id: 5, date: '2026-08-05T10:00:00Z', media: { type: 'photo' } }),
      msg({ id: 4, date: '2026-08-04T10:00:00Z', text: 'chatter' }),
      msg({ id: 3, date: '2026-08-03T10:00:00Z', media: { type: 'photo' } }),
      msg({ id: 2, date: '2026-08-02T10:00:00Z', media: { type: 'document', fileName: 'cv.pdf' } }),
      msg({ id: 1, date: '2026-08-01T10:00:00Z', media: { type: 'photo' } })
    ]

    const files = await pullMedia(historyClient(messages), 42, {
      destDir: 'out',
      kinds: ['photo'],
      max: 2
    })

    assert.deepEqual(files.map((f) => f.messageId), [5, 3], 'scanned past the text and the pdf, stopped at 2')
    for (const file of files) {
      assert.ok(existsSync(file.path), `${file.path} was written`)
      assert.equal(readFileSync(file.path).length, 3)
    }
    assert.equal(existsSync(join('out', '1.jpg')), false, 'the third photo was never downloaded')
    assertGolden('eval-59-media-report', renderPulled(files))
  })
})

test('eval-60 rendering an empty result says so rather than printing nothing', () => {
  assert.equal(renderDump([]), 'no messages\n')
  assert.equal(renderPeers([]), 'no matching chats\n')
  assert.equal(renderPulled([]), 'no matching media\n')
})

test('eval-61 arguments are validated before a session is opened', () => {
  // A typo in --since used to cost a connection and the single-instance lock
  // before being noticed, and then reported "no session" instead of the bad
  // date. Every verb that both parses arguments and opens a session must do the
  // parsing first. Static, because the alternative is a live Telegram client.
  const verbs = ['dump.ts', 'media.ts', 'watch.ts', 'peers.ts']

  for (const verb of verbs) {
    const source = readFileSync(
      fileURLToPath(new URL(`../src/cli/commands/${verb}`, import.meta.url)),
      'utf-8'
    )

    // The CALL, not the import: `withAuthenticatedClient(` never matches
    // `import { withAuthenticatedClient } from ...`, which has no paren.
    const opensSession = source.indexOf('withAuthenticatedClient(')
    if (opensSession === -1) continue

    for (const parser of ['parseSince(', 'parsePeerRef(', 'parseKinds(']) {
      const parses = source.indexOf(parser)
      if (parses === -1) continue
      assert.ok(
        parses < opensSession,
        `${verb} calls ${parser} after withAuthenticatedClient: validate arguments ` +
        'before taking the lock and connecting'
      )
    }
  }
})

test('eval-62 a chat can be named by id, @username, link or me', () => {
  // The four ways a Telegram chat is actually written down and pasted around.
  assert.deepEqual(parsePeerRef('108844221'), { value: 108844221, raw: '108844221', kind: 'id' })
  assert.deepEqual(parsePeerRef('-1001234567890'), {
    value: -1001234567890,
    raw: '-1001234567890',
    kind: 'id'
  })
  assert.deepEqual(parsePeerRef('@durov'), { value: 'durov', raw: '@durov', kind: 'username' })
  assert.deepEqual(parsePeerRef('durov'), { value: 'durov', raw: 'durov', kind: 'username' })
  assert.equal(parsePeerRef('me').kind, 'self')
  assert.equal(parsePeerRef('self').kind, 'self')

  for (const link of [
    't.me/durov',
    'https://t.me/durov',
    'http://t.me/durov',
    'https://www.t.me/durov',
    'https://telegram.me/durov',
    'https://t.me/durov/'
  ]) {
    assert.deepEqual(parsePeerRef(link).value, 'durov', `${link} should resolve to the handle`)
  }
})

test('eval-63 a homoglyph username is refused, not resolved', () => {
  // Telegram usernames are ASCII by definition, so a Cyrillic "о" pasted from a
  // message is not a lookalike of a valid username - it is not one at all. The
  // parser rejects it before it can reach the network and become a real
  // stranger's account. This is the one homoglyph defence that works, because
  // the confirmation prompt would show a name that looks equally correct.
  assert.throws(() => parsePeerRef('@durоv'), /non-ASCII/, 'Cyrillic o refused')
  assert.throws(() => parsePeerRef('@durоv'), /non-ASCII/)
  assert.throws(() => parsePeerRef('@durаv'), /non-ASCII/, 'Cyrillic a refused')
  assert.throws(() => parsePeerRef('Zoë'), /non-ASCII/)
})

test('eval-64 malformed and unusable references are refused offline', () => {
  for (const bad of ['', '   ', '0', 'ab', 'a'.repeat(33), '12.5', 'NaN', 'has space', '@@durov']) {
    assert.throws(
      () => parsePeerRef(bad),
      /Cannot use/,
      `${JSON.stringify(bad)} should be refused`
    )
  }

  // An invite link names a join flow, not a peer, and says so specifically.
  assert.throws(() => parsePeerRef('https://t.me/+AbCdEf'), /private invite link/)
  assert.throws(() => parsePeerRef('https://t.me/joinchat'), /private invite link/)

  // 1e999 parses as Infinity, which is not a safe integer.
  assert.throws(() => parsePeerRef('1e999'), /Cannot use/)
})

test('eval-96 the shipped agent skill stays in step with the CLI', () => {
  // skill/SKILL.md is the orientation an agent reads before it touches this
  // tool. A skill citing a command the binary does not have is worse than no
  // skill at all: it sends the agent confidently in the wrong direction, and
  // nothing else in this repo would notice the drift.
  const root = fileURLToPath(new URL('../', import.meta.url))
  const skill = readFileSync(join(root, 'skill', 'SKILL.md'), 'utf-8')

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
    files: string[]
    name: string
  }
  assert.ok(pkg.files.includes('skill'), 'skill/ must be in the published files')
  assert.ok(skill.includes(pkg.name), 'the skill must name the package it documents')

  // The real command tree, read from the files that build it. Top-level verbs
  // are the ones hung off `program`; the sync subcommands take a parameter
  // named `syncCommand`, which is what keeps them out of this set.
  const sources = [
    readFileSync(join(root, 'src', 'index.ts'), 'utf-8'),
    ...readdirSync(join(root, 'src', 'cli', 'commands'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(join(root, 'src', 'cli', 'commands', f), 'utf-8'))
  ]
  const names = (re: RegExp, text: string) => [...text.matchAll(re)].map((m) => m[1])
  const topLevel = new Set(sources.flatMap((s) => names(/program\s*\.command\('([^' ]+)/g, s)))
  const every = new Set(sources.flatMap((s) => names(/\.command\('([^' ]+)/g, s)))

  // Both halves of this eval are greps. If either finds nothing it passes for
  // the wrong reason, so assert the extraction itself worked.
  assert.ok(topLevel.size >= 10, `only found ${topLevel.size} top-level commands`)

  // Every `tg ...` inside a code span - fenced or inline - is a command the
  // skill is telling an agent to run. Prose is excluded: "tg is a CLI" is not
  // a citation of a command named `is`.
  const code = [
    ...[...skill.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]),
    ...[...skill.matchAll(/`([^`\n]+)`/g)].map((m) => m[1])
  ].join('\n')
  const cited = [...code.matchAll(/(?:^|\s)tg ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/gm)]
  assert.ok(cited.length >= 10, `only found ${cited.length} cited commands`)

  for (const [, verb, sub] of cited) {
    assert.ok(topLevel.has(verb), `the skill runs "tg ${verb}", which no .command() registers`)
    if (sub) {
      assert.ok(every.has(sub), `the skill runs "tg ${verb} ${sub}", and ${sub} is not a subcommand`)
    }
  }

  // Every exit code it publishes must be one this CLI can actually return.
  const codes = [...skill.matchAll(/^\| (\d) \|/gm)]
  assert.ok(codes.length >= 5, `only found ${codes.length} documented exit codes`)
  for (const m of codes) {
    const code = Number(m[1])
    assert.ok(
      (Object.values(EXIT) as number[]).includes(code),
      `the skill documents exit code ${code}, which is not in the taxonomy`
    )
  }
})

test('eval-114 sync loops once per --once, floors the interval, and holds one session', () => {
  // `tg sync` is the only verb that keeps the workspace lock indefinitely, so
  // its three behavioural claims are pinned statically: one pass under --once,
  // a 30s floor on --interval, and a single session for the whole run.
  const source = readFileSync(
    fileURLToPath(new URL('../src/cli/commands/sync-chats.ts', import.meta.url)),
    'utf-8'
  )

  // One session: exactly one CALL to withAuthenticatedClient, with the loop inside it.
  const opens = [...source.matchAll(/withAuthenticatedClient\(/g)]
  assert.equal(opens.length, 1, 'sync must open exactly one session for the whole run')
  const loop = source.indexOf('while (true)')
  // The assertion above pins opens.length at 1, so index 0 exists.
  assert.ok(loop > opens[0]!.index, 'the polling loop must live inside the session')

  // --once exits after exactly one pass: the break precedes the sleep.
  const breaksOnce = source.indexOf('if (opts.once) break')
  const sleeps = source.indexOf('await sleep(')
  assert.ok(breaksOnce !== -1 && sleeps > breaksOnce, '--once must break before sleeping')

  // The floor, and its exit code: a bad flag is usage, not notConfigured.
  assert.match(source, /interval < 30/)
  assert.match(source, /EXIT\.usage/)

  // Arguments are parsed before the lock is taken (eval-61's rule, for --chats).
  const parsesChats = source.indexOf('opts.chats\n')
  assert.ok(parsesChats !== -1 && parsesChats < opens[0]!.index, '--chats must be parsed before connecting')

  // stdout is NDJSON only: no console.log anywhere on the sync path.
  for (const file of ['cli/commands/sync-chats.ts', 'sync/index.ts']) {
    const text = readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), 'utf-8')
    assert.ok(!/console\.log\(/.test(text), `${file} writes to stdout; --json output must stay parseable`)
  }
})

test('eval-115 --qr is wired end to end and can never hand rememberPhone a null', () => {
  // The live signInQr flow needs a real connection and a human holding a phone,
  // so what is pinned here is the wiring: the flag reaches openSession, the QR
  // path exists, and the one type-unsafe seam (User.phoneNumber is nullable,
  // rememberPhone takes a string) stays guarded.
  const read = (p: string) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), 'utf-8')

  const auth = read('auth.ts')
  assert.match(auth, /export async function ensureAuthenticatedQr\(/)
  assert.match(auth, /tg\.signInQr\(/)
  // Without this, a 2FA account gets a raw SESSION_PASSWORD_NEEDED throw instead of a prompt.
  assert.match(auth, /password: ask2FaPassword/, 'signInQr must hand mtcute the 2FA prompt')

  // Guarded: an `if (...)` or `?.` immediately around the call site.
  const call = auth.indexOf('rememberPhone(user.phoneNumber)')
  assert.ok(call !== -1, 'the QR path must remember the number it logged in with')
  const before = auth.slice(Math.max(0, call - 60), call)
  assert.match(before, /if \(user\.phoneNumber\)|user\.phoneNumber\?\./, 'rememberPhone must not be reachable with a null phoneNumber')

  const helpTexts = ['cli/commands/auth.ts', 'cli/commands/session.ts'].map((file) => {
    const source = read(file)
    assert.match(source, /\.option\('--qr'/, `${file} must offer --qr`)
    assert.match(source, /qr: options\.qr/, `${file} must thread --qr into openSession`)
    return source.match(/\.option\('--qr', '([^']*)'\)/)?.[1]
  })
  // One flag, one description: the two verbs must not drift apart in --help.
  assert.ok(helpTexts[0], 'auth.ts --qr must have a description')
  assert.equal(helpTexts[0], helpTexts[1], '--qr help text must be identical in both commands')

  // The branch itself, plus the option on the interface behind it.
  assert.match(read('session/index.ts'), /options\.qr \? await ensureAuthenticatedQr\(tg\)/)
})
