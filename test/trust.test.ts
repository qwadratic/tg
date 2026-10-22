import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert'
import test from 'node:test'
import { assertPeerId } from '../src/peers/id.js'
import {
  DEFAULT_MAX_MODERATION_PER_DAY,
  MAX_SENDS_PER_DAY,
  MODERATION_KINDS,
  ModerationCapError,
  TTY_ONLY_KINDS,
  assertConfirmed,
  assertInteractive,
  assertUnderCaps,
  assertUnderModerationCap,
  guardedSend,
  maxModerationPerDay,
  moderationToday,
  readSendLog,
  recordSend,
  resetRunCounter,
  sendsToday,
  type SentRecord
} from '../src/send/gate.js'
import { OperatorError } from '../src/errors.js'
import { EXIT } from '../src/exit-codes.js'
import { mediaFilename } from '../src/media/index.js'
import { mediaKindFor } from '../src/send/index.js'
import { seedModerationLog, withTempDir, withTerminal, withTerminalState, withoutTerminal } from './helpers.js'
import {
  aliasViolations,
  clientUses,
  closureOf,
  findRawCalls,
  importEdges,
  importGraph,
  loadSources,
  rawCallViolations,
  rawMethodsNamed,
  unpacedIterators,
  type SourceText
} from './fence-scan.js'
import { clientMethodNames, tlRpcMethods } from './mtcute-api.js'
import { CLIENT_METHODS, RAW_TL_METHODS, UNSUPPORTED_TL_PREFIXES, summarize } from './coverage-manifest.js'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

/**
 * The trust model, made mechanical.
 *
 * backlog/decisions/2026-08-05-consolidate-on-telegram-utils.md declared a
 * "Security boundary (two one-way rules, both mechanically checkable)" and cited
 * evals 30, 31 and 32 as the checks. Those evals were never written: the suite
 * jumped from eval-28 to eval-40, so the credential-holding half of the boundary
 * was enforced by convention only. This file is that missing half.
 *
 * It matters more now than when it was written, because `src/send/` deliberately
 * introduces the write capability the boundary exists to contain.
 */

/** Every .ts file under src/, recursively. */
function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

/** The whole of src/, parsed once: the fence checks below all read the same snapshot. */
const SOURCES = loadSources()
const GRAPH = importGraph(SOURCES)

/**
 * Transitive closure of imports from a set of entry points, as absolute paths.
 *
 * Built from the syntax tree (test/fence-scan.ts), so a side-effect import, an
 * `export * from` and a dynamic `import('...')` are edges like any other. The
 * text pattern this replaced saw only `from '...'`.
 */
function importClosure(entries: string[]): Set<string> {
  return new Set([...closureOf(GRAPH.graph, entries)].map((path) => SRC + path))
}

/** Telegram RPCs that change state on someone else's screen. */
const WRITE_RPCS = [
  'sendText',
  'sendMedia',
  'forwardMessages',
  'deleteMessages',
  // The id-based sibling. `deleteMessages` takes Message objects, so the verb
  // that actually deletes by number would have slipped the fence unnamed.
  'deleteMessagesById',
  // Same shape on the forward side. `forwardMessages` takes Message objects, so
  // the verb that actually forwards by number would have slipped the fence
  // unnamed.
  'forwardMessagesById',
  'editMessage',
  'readHistory',
  // Chat-state verbs (D13b). Private to the account owner, fenced anyway: the
  // property that makes src/send/ reviewable is "every write RPC is here".
  'archiveChats',
  'unarchiveChats',
  'markChatUnread',
  // Group/channel administration (D13c). All high-level mtcute methods, so the
  // call-site regex above catches them; nothing here needs a raw TL literal.
  'createGroup',
  'createChannel',
  'createSupergroup',
  'setChatTitle',
  'setChatDescription',
  'setChatPhoto',
  'setChatColor',
  'setChatStickerSet',
  'setChatUsername',
  'exportInviteLink',
  'createInviteLink',
  'editInviteLink',
  'createForumTopic',
  'editForumTopic',
  'toggleForumTopicClosed',
  'toggleForumTopicPinned',
  'setSlowMode',
  'toggleContentProtection',
  'toggleJoinRequests',
  'toggleJoinToSend',
  // Membership and destruction (D13d).
  'addChatMembers',
  'kickChatMember',
  'deleteChannel',
  // Moderation and admin rights (D13e). Each acts on one PERSON.
  'banChatMember',
  'unbanChatMember',
  'restrictChatMember',
  'editAdminRights',
  // NOT SHIPPED, fenced anyway. This list is a FENCE, not an inventory: a name
  // with no call site costs nothing, and buys a suite failure the moment
  // somebody adds an out-of-scope write outside src/send/. D13e keeps both of
  // these out and says so.
  'deleteGroup',
  'setChatTtl'
] as const

/**
 * Raw TL method names, reached through the generic `tg.call({_: '...'})`.
 *
 * mtcute has no high-level wrapper for dialog pinning or notify settings, so
 * pin/unpin and mute/unmute are written as object literals. A regex looking for
 * a JS call name like `toggleDialogPin(` would find NOTHING and fence nothing -
 * hence this second list, matched as string literals.
 */
const WRITE_TL_METHODS = [
  'messages.toggleDialogPin',
  'account.updateNotifySettings'
] as const

/**
 * The raw TL methods a READ verb may call outside `src/send/` (D13f).
 *
 * Before 0.8 any `tg.call({ _: '...' })` outside the send module was only caught
 * if its method happened to be in `WRITE_TL_METHODS`: a raw twin of a write nobody
 * had listed walked straight past, which D13c admitted. Now the rule runs the
 * other way and denies by default (eval-175): a raw call outside the fence passes
 * only if its method is on this list, and every entry must be a `get*` method of
 * the schema. Adding a raw read means adding it here, in the manifest, and in the
 * verb's tests.
 */
const READ_TL_METHODS: readonly string[] = [
  // `tg account sessions`, `privacy` and `notify` (D13f).
  'account.getAuthorizations',
  'account.getPrivacy',
  'account.getNotifySettings'
]

/**
 * Files permitted to name a write RPC, each with the reason it is fenced.
 *
 * `src/send/index.ts` is the whole point of the module: the single place a write
 * happens. `src/contacts/import.ts` is the older exception the decision log
 * already recorded - reachable only from the human-invoked `check-phones`.
 * `src/cli/commands/send.ts` names them only as imported function names.
 */
const WRITE_ALLOWLIST = new Set([
  'send/index.ts',
  'send/gate.ts',
  'cli/commands/send.ts',
  'contacts/import.ts',
  // D13c: the `tg group` command layer names the same imported function names.
  // The RPCs themselves still happen only in send/index.ts.
  'cli/commands/group.ts'
])

/** The raw TL method name as a string literal, in any of the three quote styles. */
function tlMethodLiteral(method: string): RegExp {
  return new RegExp(`['"\`]${method.replace(/\./g, '\\.')}['"\`]`)
}

test('eval-29 write RPCs appear only in the files fenced to allow them', () => {
  const offenders: string[] = []

  for (const file of sourceFiles()) {
    const relative = file.slice(SRC.length)
    if (WRITE_ALLOWLIST.has(relative)) continue

    const source = readFileSync(file, 'utf-8')
    for (const rpc of WRITE_RPCS) {
      // `tg.sendText(` / `client.sendMedia(` - a call, not a mention in prose.
      if (new RegExp(`\\.\\s*${rpc}\\s*\\(`).test(source)) {
        offenders.push(`${relative} calls ${rpc}`)
      }
    }
    for (const method of WRITE_TL_METHODS) {
      // `_: 'messages.toggleDialogPin'` - the raw-call escape hatch. Any quote
      // style: nothing in eslint.config.js pins quotes, so a double-quoted
      // literal is a legal way to walk straight past a single-quote check.
      if (tlMethodLiteral(method).test(source)) {
        offenders.push(`${relative} calls the raw RPC ${method}`)
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'a write RPC appeared outside the fence. Either route it through src/send/, ' +
    'or add the file to WRITE_ALLOWLIST with the reason it is safe.'
  )
})

test('eval-29b the raw TL write methods are named in exactly one file', () => {
  // The positive half of eval-29: a fence that matches nothing passes for the
  // wrong reason. Each raw method must actually appear, and only in send/.
  for (const method of WRITE_TL_METHODS) {
    const naming = sourceFiles()
      .filter((file) => tlMethodLiteral(method).test(readFileSync(file, 'utf-8')))
      .map((file) => file.slice(SRC.length))

    assert.deepEqual(
      naming,
      ['send/index.ts'],
      `${method} must be called from src/send/index.ts and nowhere else`
    )
  }
})

/**
 * What every command file under src/cli/commands/ is, said out loud (D13f).
 *
 * Until 0.8 eval-31 carried a hand-kept list of read entry points, so a new read
 * verb was checked only if somebody remembered to add it. Now the files on disk
 * are the list and each must be classified here, so a command file that is in no
 * class fails the suite until somebody decides what it is:
 *
 * - `write`        may import the send module; also on WRITE_ALLOWLIST
 * - `legacy-write` writes, but outside the fence (`check-phones`, D13's older exception)
 * - `unattended`   what a cron job or timer runs; must not reach the send module
 * - `read`         a read verb; must not reach the send module
 * - `plumbing`     login, workspace and update commands, and shared helpers; must not
 *                  reach the send module
 *
 * `group.ts` mixes reads and writes, so it is `write`: its reads are checked
 * through the read modules it imports (src/groups/ and the new read modules), which
 * the module-graph rule in eval-31 covers like every other file.
 */
const COMMAND_CLASS: Record<string, 'write' | 'legacy-write' | 'unattended' | 'read' | 'plumbing'> = {
  'send.ts': 'write',
  'group.ts': 'write',
  'check-phones.ts': 'legacy-write',
  'sync.ts': 'unattended',
  'sync-chats.ts': 'unattended',
  'sync-recent.ts': 'unattended',
  'sync-historical.ts': 'unattended',
  'recency-export.ts': 'unattended',
  'folders.ts': 'unattended',
  'ship.ts': 'unattended',
  'dump.ts': 'read',
  'media.ts': 'read',
  'peers.ts': 'read',
  'watch.ts': 'read',
  // The read verbs of 0.8 (D13f).
  'chat.ts': 'read',
  'msg.ts': 'read',
  'user.ts': 'read',
  'contacts.ts': 'read',
  'dialogs.ts': 'read',
  'draft.ts': 'read',
  'scheduled.ts': 'read',
  'reactions.ts': 'read',
  'account.ts': 'read',
  // Stories (0.9.0): reads only, and nothing here may mark one viewed (eval-205).
  'story.ts': 'read',
  'auth.ts': 'plumbing',
  'session.ts': 'plumbing',
  'init.ts': 'plumbing',
  'doctor.ts': 'plumbing',
  'update.ts': 'plumbing',
  'shared.ts': 'plumbing'
}

/** The files allowed to import the send module, directly or through another file. */
const WRITE_CAPABLE = ['cli/commands/group.ts', 'cli/commands/send.ts', 'index.ts', 'send/gate.ts', 'send/index.ts']

const reachesSendModule = (path: string): boolean =>
  [...closureOf(GRAPH.graph, [path])].some((f) => /^send\/(index|gate)\.ts$/.test(f))

const commandPath = (name: string): string => `cli/commands/${name}`

test('eval-30 the unattended paths cannot reach the send module', () => {
  // Everything a cron job, timer or agent invokes without a human present: the
  // commands classified `unattended`, and the two modules they are built on.
  const unattended = [
    ...Object.entries(COMMAND_CLASS).filter(([, kind]) => kind === 'unattended').map(([name]) => commandPath(name)),
    'sync/index.ts',
    'ship/index.ts'
  ]
  assert.ok(unattended.length >= 8, 'the list of unattended entry points came out empty')

  for (const entry of unattended) {
    const closure = importClosure([entry])
    const reachesSend = [...closure].filter((f) => /\/send\/(index|gate)\.ts$/.test(f))

    assert.deepEqual(
      reachesSend.map((f) => f.slice(SRC.length)),
      [],
      `${entry} can reach the send module. An unattended run must not be able ` +
      'to write to Telegram, so the import has to go.'
    )
  }
})

test('eval-31 every file that is not a write verb cannot reach the send module, and every command file is classified', () => {
  // The point of splitting peers/id.ts out of send/: a read verb validates a
  // peer id without linking the code that can write. D13f made the check derive
  // from the module graph instead of a list somebody has to remember to extend.

  // (1) Every command file on disk has a class, and no class names a file that is gone.
  const onDisk = SOURCES.filter((f) => /^cli\/commands\/[^/]+\.ts$/.test(f.path)).map((f) => f.path.slice('cli/commands/'.length)).sort()
  assert.ok(onDisk.length >= 15, `only found ${onDisk.length} command files`)
  assert.deepEqual(
    onDisk.filter((name) => !(name in COMMAND_CLASS)),
    [],
    'a command file has no class. Decide what it is and add it to COMMAND_CLASS: write, unattended, read or plumbing.'
  )
  assert.deepEqual(
    Object.keys(COMMAND_CLASS).filter((name) => !onDisk.includes(name)),
    [],
    'COMMAND_CLASS names a command file that no longer exists'
  )

  // (2) The write class IS the allowlist's command files; nothing is quietly both.
  assert.deepEqual(
    Object.entries(COMMAND_CLASS).filter(([, kind]) => kind === 'write').map(([name]) => commandPath(name)).sort(),
    [...WRITE_ALLOWLIST].filter((f) => f.startsWith('cli/commands/')).sort(),
    'a command classified `write` must be on WRITE_ALLOWLIST with its reason, and the other way round'
  )

  // (3) No dynamic import or require can hide an edge from the walk.
  assert.deepEqual(GRAPH.unfollowable, [], 'a dynamic import or require with a non-literal argument cannot be followed')

  // (4) Exactly the write-capable files reach the send module. Everything else in
  //     src/ - every command, every read module, every helper, today's and
  //     tomorrow's - cannot. A new file that imports the send module, or imports
  //     something that does, appears here.
  const reaching = SOURCES.filter((f) => reachesSendModule(f.path)).map((f) => f.path).sort()
  assert.deepEqual(
    reaching,
    WRITE_CAPABLE,
    'the set of files that can reach the send module changed. A read verb must not import it; ' +
    'a new write verb belongs on WRITE_ALLOWLIST and WRITE_CAPABLE with a decision record.'
  )

  // (5) The same, said per verb, so a failure names the verb and not just a file.
  for (const [name, kind] of Object.entries(COMMAND_CLASS)) {
    if (kind === 'write') continue
    assert.ok(!reachesSendModule(commandPath(name)), `${name} is classified ${kind} and must not reach the send module`)
  }

  // (6) A legacy write is exactly the commands that import the older exception.
  const importers = onDisk.filter((name) => closureOf(GRAPH.graph, [commandPath(name)]).has('contacts/import.ts'))
  assert.deepEqual(
    Object.entries(COMMAND_CLASS).filter(([, kind]) => kind === 'legacy-write').map(([name]) => name).sort(),
    importers.sort(),
    'a command reaches contacts/import.ts without being classified legacy-write (or the other way round)'
  )
})

test('eval-32 nothing holding a Telegram credential imports gbrain or an LLM', () => {
  // Rule 1 of the boundary, from the other direction than eval-48 checks it.
  const credentialHolders = importClosure(['session/index.ts', 'client.ts'])
  const banned = /gbrain|openrouter|anthropic|openai/i

  for (const file of credentialHolders) {
    const source = readFileSync(file, 'utf-8')
    // Strip comments: the decision log is quoted in prose in several of these
    // files, and quoting the rule must not violate it.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

    assert.ok(
      !banned.test(code),
      `${file.slice(SRC.length)} holds a Telegram credential and names an LLM or gbrain`
    )
  }
})

test('eval-33 the send module itself only ever accepts a resolved numeric id', () => {
  // The CLI accepts @usernames and links (D17), but resolution happens in the
  // COMMAND layer, and what reaches src/send/ is always a concrete id that has
  // already been shown to a human. This pins that boundary: the send functions
  // do not resolve names themselves, so there is exactly one place where a
  // reference becomes an identity, and exactly one place that identity is
  // confirmed and logged.
  assert.equal(assertPeerId(108844221), 108844221)
  assert.equal(assertPeerId(-1001234567890), -1001234567890)
  assert.equal(assertPeerId(' 42 '), 42)

  for (const bad of ['@durov', 'Zoe', 'self', '', '0', 'me', '1e999', 'NaN', '12.5']) {
    assert.throws(
      () => assertPeerId(bad),
      /Not a numeric peer id/,
      `${JSON.stringify(bad)} should be refused by the send module's own boundary`
    )
  }
})

test('eval-65 the send commands resolve a peer before calling the send module', () => {
  // The guarantee behind eval-33: no send command may pass raw user input
  // through to sendText/sendMedia. Each one must resolve it first, so the
  // confirmation prompt has a real identity to show.
  const source = readFileSync(
    fileURLToPath(new URL('../src/cli/commands/send.ts', import.meta.url)),
    'utf-8'
  )

  assert.ok(
    source.includes('resolvePeerRef('),
    'send.ts must resolve a reference to an identity before sending'
  )
  assert.ok(
    !/(sendText|sendMedia|deleteMessages|forwardMessage|editMessageText|markRead|markUnread|archiveChat|unarchiveChat|pinChat|unpinChat|muteChat|unmuteChat)\(tg,\s*peer\b/.test(source),
    'send.ts must never pass the raw typed reference to a send function'
  )
  // Every send path shows the resolved identity, or takes --yes on the record.
  assert.ok(
    source.includes('confirmRecipient(target,'),
    'the confirmation must receive the RESOLVED peer, not an id to look up later'
  )
})

test('eval-34 a non-interactive send is refused without --yes', () => {
  const original = process.env.TG_NON_INTERACTIVE
  process.env.TG_NON_INTERACTIVE = '1'

  try {
    assert.throws(
      () => assertConfirmed({}),
      /Refusing to send from a non-interactive run without --yes/
    )
    // --yes is the caller taking responsibility on the record.
    assert.doesNotThrow(() => assertConfirmed({ yes: true }))
  } finally {
    if (original === undefined) delete process.env.TG_NON_INTERACTIVE
    else process.env.TG_NON_INTERACTIVE = original
  }
})

test('eval-35 the send log is append-only, 0600, and never holds message content', async () => {
  await withTempDir(async () => {
    resetRunCounter()

    const secret = 'the actual message body nobody should find in a log'
    const record: SentRecord = {
      at: new Date().toISOString(),
      peerId: 42,
      kind: 'text',
      messageId: 7,
      size: secret.length,
      ok: true
    }
    recordSend(record)
    recordSend({ ...record, messageId: 8 })

    const log = readSendLog()
    assert.equal(log.length, 2, 'each send appends one line')
    assert.deepEqual(log.map((r) => r.messageId), [7, 8], 'append-only, in order')

    const raw = readFileSync('data/sent.jsonl', 'utf-8')
    assert.ok(!raw.includes(secret), 'the log records size, never content')
    assert.equal(statSync('data/sent.jsonl').mode & 0o777, 0o600)
  })
})

test('eval-36 a truncated log line does not block future sends', async () => {
  await withTempDir(async () => {
    recordSend({
      at: new Date().toISOString(),
      peerId: 1,
      kind: 'text',
      messageId: 1,
      size: 3,
      ok: true
    })
    // Exactly what a killed process leaves behind.
    writeFileSync('data/sent.jsonl', `${readFileSync('data/sent.jsonl', 'utf-8')}{"at":"2026`, 'utf-8')

    const log = readSendLog()
    assert.equal(log.length, 1, 'the good line survives and the partial one is skipped')
  })
})

test('eval-37 the daily cap counts a 24h window, and failures count too', () => {
  const now = Date.parse('2026-08-17T12:00:00.000Z')
  const at = (hoursAgo: number) => new Date(now - hoursAgo * 3600_000).toISOString()

  const records: SentRecord[] = [
    { at: at(1), peerId: 1, kind: 'text', messageId: 1, size: 1, ok: true },
    // A rejected send still consumes budget: a retry loop against a peer that
    // refuses is the pattern that draws attention.
    { at: at(2), peerId: 2, kind: 'text', messageId: null, size: 1, ok: false, error: 'PEER_FLOOD' },
    { at: at(23.9), peerId: 3, kind: 'photo', messageId: 3, size: 1, ok: true },
    // Outside the window.
    { at: at(24.1), peerId: 4, kind: 'text', messageId: 4, size: 1, ok: true },
    { at: at(100), peerId: 5, kind: 'text', messageId: 5, size: 1, ok: true }
  ]

  assert.equal(sendsToday(records, now), 3)
  assert.ok(MAX_SENDS_PER_DAY > 0, 'a cap of zero would disable sending entirely')
})

test('eval-38 a downloaded filename cannot escape the destination directory', () => {
  const msg = (fileName?: string, type = 'document') =>
    ({ id: 99, media: { type, fileName } }) as never

  // Traversal, absolute paths and separators all reduce to a basename.
  assert.equal(mediaFilename(msg('../../../etc/passwd')), '99-passwd')
  assert.equal(mediaFilename(msg('/etc/shadow')), '99-shadow')
  assert.equal(mediaFilename(msg('a/b/c.mp4')), '99-c.mp4')

  // A name that is only dots would resolve to a directory.
  assert.equal(mediaFilename(msg('..')), '99.bin')
  assert.equal(mediaFilename(msg('.')), '99.bin')

  // The extension survives, which is the whole reason this does not reuse
  // sanitizeFilename (that helper would produce "report.png_99").
  assert.equal(mediaFilename(msg('report.png', 'photo')), '99-report.png')
  assert.equal(mediaFilename(msg(undefined, 'photo')), '99.jpg')

  for (const name of ['../x', 'a/b', 'a\\b', 'x y']) {
    const produced = mediaFilename(msg(name))
    assert.ok(!produced.includes('/'), `${JSON.stringify(name)} produced a separator`)
    assert.ok(!produced.includes('\\'), `${JSON.stringify(name)} produced a separator`)
    assert.ok(!produced.includes(' '), `${JSON.stringify(name)} produced a space`)
  }
})

test('eval-39 the send module is registered from exactly one entry point', () => {
  // If a second registration site appears, the "only a human typed this" claim
  // in eval-30 stops being reviewable by reading one file.
  const registrations = sourceFiles().filter((file) =>
    /registerSendCommand\s*\(/.test(readFileSync(file, 'utf-8'))
  )

  assert.deepEqual(
    registrations.map((f) => f.slice(SRC.length)).sort(),
    ['cli/commands/send.ts', 'index.ts'],
    'send should be defined in one file and registered in one file'
  )
})

test('eval-97 the send gate is cheap, and refuses before a session is opened', () => {
  // The --yes gate is knowable from argv alone. Running it after the client
  // opens means an unattended send that was always going to be refused still
  // takes the workspace lock and touches the network, and - worse - reports
  // "no usable session" when the real blocker is policy. An agent reading that
  // goes off to fix the session instead of stopping to ask a human.
  const source = readFileSync(
    fileURLToPath(new URL('../src/cli/commands/send.ts', import.meta.url)),
    'utf-8'
  )

  const actions = [...source.matchAll(/\.action\(async \([^)]*\) => \{([\s\S]*?)\n {6}\}\)/g)]
    // Group 1 is not optional in the pattern: a match always carries it.
    .map((m) => m[1]!)
    .filter((body) => body.includes('withAuthenticatedClient'))

  // 7 message verbs + the 7 chat-state verbs of D13b.
  assert.ok(actions.length >= 14, `expected the write actions, found ${actions.length}`)

  for (const body of actions) {
    const gate = body.indexOf('assertConfirmed')
    const client = body.indexOf('withAuthenticatedClient')
    assert.ok(gate !== -1, 'a write action reaches a client without the --yes gate')
    assert.ok(gate < client, 'the --yes gate must run before the session is opened')
  }
})

test('eval-98 refusing an unattended send is exit 3, never exit 4', () => {
  // 4 tells an agent "the hint is the fix; usually no human needed", which is
  // an invitation to retry with --yes bolted on - the one workaround this gate
  // exists to prevent. 3 means stop and ask the operator.
  const source = readFileSync(
    fileURLToPath(new URL('../src/send/gate.ts', import.meta.url)),
    'utf-8'
  )
  const refusal = source.slice(source.indexOf('export function assertConfirmed'))
  const body = refusal.slice(0, refusal.indexOf('\n}'))

  assert.match(body, /EXIT\.needsHuman/, 'the refusal must carry EXIT.needsHuman')
  assert.doesNotMatch(body, /EXIT\.notConfigured/, 'a refusal is not a misconfiguration')
})

test('eval-99 commander usage failures exit 2, not 1', () => {
  // 1 is reserved for "a bug in tg, report it with the stack". Commander exits
  // 1 for unknown options and missing arguments, so without this mapping every
  // agent typo is reported to us as a crash. exitOverride binds to a single
  // command and is not inherited, so it has to be applied down the tree.
  const source = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf-8')

  assert.match(source, /exitOverride/, 'commander exit codes must be mapped')
  assert.match(source, /EXIT\.usage/, 'usage failures must map to the usage code')
  assert.match(
    source,
    /for \(const child of command\.commands\) mapUsageExits\(child\)/,
    'the mapping must recurse, or only the root command is covered'
  )
  assert.match(source, /mapUsageExits\(program\)/, 'the mapping must actually be applied')
})

test('eval-100 every write verb accepts --json', () => {
  // The skill tells an agent to pass --json and read the envelope. When the
  // write verbs did not declare it, commander rejected the flag outright, so
  // the refusal an agent most needs to parse was the one it could not.
  const source = readFileSync(
    fileURLToPath(new URL('../src/cli/commands/send.ts', import.meta.url)),
    'utf-8'
  )

  // 7 message verbs + the 7 chat-state verbs of D13b.
  const verbs = [...source.matchAll(
    /\.command\('((?:text|media|note|rm|forward|edit|read|unarchive|archive|unpin|pin|unmute|mute|unread)[^']*)'\)([\s\S]*?)\.action\(/g
  )]
  assert.equal(verbs.length, 14, `expected 14 write verbs, found ${verbs.length}`)

  for (const verb of verbs) {
    // Both groups are mandatory in the pattern: a match always carries them.
    const name = verb[1]!
    const options = verb[2]!
    assert.match(options, /option\('--json'/, `tg send ${name} does not accept --json`)
  }
})

test('eval-113 an mp4 is sent as a playable video, a gif stays a photo', () => {
  // A document arrives as a file to download; a video gets an inline player.
  // Screen recordings were going out as documents, which is the wrong artefact
  // for the one thing this workspace sends most.
  assert.equal(mediaKindFor('/tmp/demo-a2a.mp4'), 'video')
  assert.equal(mediaKindFor('CLIP.MOV'), 'video')
  assert.equal(mediaKindFor('a.webm'), 'video')

  // .gif is already animated in Telegram as a photo; routing it through the
  // video path would turn it into a silent looping clip instead.
  assert.equal(mediaKindFor('loop.gif'), 'photo')
  assert.equal(mediaKindFor('shot.png'), 'photo')

  // No extension, or one that means nothing here, must not become a video.
  assert.equal(mediaKindFor('notes.md'), 'document')
  assert.equal(mediaKindFor('archive'), 'document')
  assert.equal(mediaKindFor('mp4'), 'document')
  assert.equal(mediaKindFor('sneaky.mp4.zip'), 'document')
})

test('eval-163 the D13e write RPCs are called in src/send/index.ts and nowhere else', () => {
  // The positive half of eval-29 for the moderation verbs: a fence naming a
  // method nobody calls passes for the wrong reason. These four ship, so each
  // must really be called from the send module, and only from there.
  for (const rpc of ['banChatMember', 'unbanChatMember', 'restrictChatMember', 'editAdminRights']) {
    assert.ok((WRITE_RPCS as readonly string[]).includes(rpc), `${rpc} is missing from WRITE_RPCS`)
    const calling = sourceFiles()
      .filter((file) => new RegExp(`\\.\\s*${rpc}\\s*\\(`).test(readFileSync(file, 'utf-8')))
      .map((file) => file.slice(SRC.length))
    assert.deepEqual(calling, ['send/index.ts'], `${rpc} must be called from src/send/index.ts only`)
  }

  // Out of scope in D13e: fenced, and not called anywhere.
  for (const rpc of ['deleteGroup', 'setChatTtl']) {
    assert.ok((WRITE_RPCS as readonly string[]).includes(rpc), `${rpc} must stay fenced`)
    const calling = sourceFiles().filter((file) => new RegExp(`\\.\\s*${rpc}\\s*\\(`).test(readFileSync(file, 'utf-8')))
    assert.deepEqual(calling, [], `${rpc} is out of scope and must not be called`)
  }
})

/**
 * D13e-a: the TTY-only guard class and the daily moderation counter.
 *
 * Both live in `src/send/gate.ts` and both are enforced twice: by the command
 * layer before a session exists, and by `guardedSend` itself, so a verb that
 * forgets to ask is still refused.
 */

const needsHuman = (e: unknown) => e instanceof OperatorError && e.exitCode === EXIT.needsHuman

test('eval-165 a TTY-only action is refused without a terminal, and --yes does not change that', async () => {
  const action = 'grant admin rights'

  // Nobody there: an agent's run, TG_NON_INTERACTIVE=1 as AGENTS.md tells it to set.
  await withoutTerminal(() => {
    assert.throws(() => assertInteractive(action), needsHuman)
    // The whole point: the flag an agent can add does NOT stand in for a human.
    assert.throws(() => assertConfirmed({ yes: true }, { terminalOnly: action }), (e: unknown) =>
      needsHuman(e) && /--yes does NOT bypass/.test((e as Error).message) && /terminal-only/.test((e as Error).message))
    assert.throws(() => assertConfirmed({}, { terminalOnly: action }), (e: unknown) =>
      needsHuman(e) && /terminal-only/.test((e as Error).message), 'and the advice is not "add --yes"')
    // The ordinary gate is untouched: --yes still stands in for a human when no class is named.
    assert.doesNotThrow(() => assertConfirmed({ yes: true }))
  })

  // A pty without TG_NON_INTERACTIVE is a terminal as far as the tool can tell...
  await withTerminal(() => {
    assert.doesNotThrow(() => assertInteractive(action))
    assert.doesNotThrow(() => assertConfirmed({}, { terminalOnly: action }))
    assert.doesNotThrow(() => assertConfirmed({ yes: true }, { terminalOnly: action }))
  })
  // ...which is why setting TG_NON_INTERACTIVE=1 closes it even on a real TTY.
  await withTerminalState({ tty: true, nonInteractive: true }, () => {
    assert.throws(() => assertInteractive(action), needsHuman)
    assert.throws(() => assertConfirmed({ yes: true }, { terminalOnly: action }), needsHuman)
  })
  // And no TTY at all is refused even when nothing set TG_NON_INTERACTIVE.
  await withTerminalState({ tty: false }, () => {
    assert.throws(() => assertConfirmed({ yes: true }, { terminalOnly: action }), needsHuman)
  })

  // The class is opt-in and exactly this long: admin rights, nothing that only removes them.
  assert.deepEqual([...TTY_ONLY_KINDS], ['promote-admin'])
  assert.ok(!(TTY_ONLY_KINDS as readonly string[]).includes('demote-admin'), 'demote only removes rights')
})

test('eval-166 guardedSend refuses a TTY-only kind without a terminal even if the caller forgot to ask', async () => {
  await withTempDir(async () => {
    resetRunCounter()
    let rpcCalls = 0
    const rpc = () => { rpcCalls++; return Promise.resolve({ id: 0 }) }

    await withoutTerminal(async () => {
      // No assertConfirmed anywhere in this call: the backstop is the only guard.
      await assert.rejects(() => guardedSend(-1001234567890, 'promote-admin', 0, rpc, { units: 0, targetUserId: 42 }), needsHuman)
      // Another kind is not in the class and goes through, as before.
      await guardedSend(-1001234567890, 'demote-admin', 0, rpc, { units: 0, targetUserId: 42 })
    })
    assert.equal(rpcCalls, 1, 'the refused write never reached Telegram')
    assert.deepEqual(readSendLog().map((r) => r.kind), ['demote-admin'], 'and left no audit line, as no RPC was tried')

    await withTerminal(() => guardedSend(-1001234567890, 'promote-admin', 0, rpc, { units: 0, targetUserId: 42 }))
    assert.equal(rpcCalls, 2)
  })
})

test('eval-167 the moderation cap counts people, apart from the send caps, and a failed attempt counts too', async () => {
  await withTempDir(async () => {
    resetRunCounter()
    const now = Date.parse('2026-10-17T12:00:00.000Z')
    const at = (hoursAgo: number) => new Date(now - hoursAgo * 3600_000).toISOString()
    const line = (kind: SentRecord['kind'], hoursAgo: number, ok = true): SentRecord => ({
      at: at(hoursAgo), peerId: -1001234567890, kind, targetUserId: 7, messageId: ok ? 0 : null, size: 0, units: 0, ok,
      ...(ok ? {} : { error: 'USER_ADMIN_INVALID' })
    })

    const records: SentRecord[] = [
      line('add-member', 1), line('kick-member', 2), line('ban-member', 3), line('unban-member', 4),
      line('restrict-member', 5), line('promote-admin', 6), line('demote-admin', 7),
      // A refused attempt still consumed a person's worth of budget.
      line('ban-member', 8, false),
      // Outside the 24h window.
      line('ban-member', 24.1), line('ban-member', 100),
      // Not moderation: chat settings and sends are other budgets.
      line('chat-title', 1), line('slow-mode', 1),
      { at: at(1), peerId: 5, kind: 'text', messageId: 1, size: 3, ok: true }
    ]
    assert.equal(moderationToday(records, now), 8)
    assert.equal(sendsToday(records, now), 1, 'moderation lines cost no send units, so they never fill the send budget')
    assert.deepEqual(
      [...MODERATION_KINDS].sort(),
      ['add-member', 'ban-member', 'demote-admin', 'kick-member', 'promote-admin', 'restrict-member', 'unban-member']
    )

    assert.equal(DEFAULT_MAX_MODERATION_PER_DAY, 50)
    assert.equal(maxModerationPerDay({}), 50, 'the default')
    assert.equal(maxModerationPerDay({ TG_MAX_MODERATION_PER_DAY: ' 12 ' }), 12)
    assert.equal(maxModerationPerDay({ TG_MAX_MODERATION_PER_DAY: '0' }), 0, 'zero is a deliberate off switch')
    assert.equal(maxModerationPerDay({ TG_MAX_MODERATION_PER_DAY: '' }), 50, 'an empty value is unset')
    // A value that is not a whole number fails CLOSED: Number("5O") is NaN, and a NaN cap compares false to everything.
    for (const bad of ['5O', '-3', '1.5', 'many', '1e3', '0x10']) {
      assert.equal(maxModerationPerDay({ TG_MAX_MODERATION_PER_DAY: bad }), 0, bad)
    }
  })
})

test('eval-168 over the moderation cap is refused, with the repo exit code for a cap, apart from the send cap', async () => {
  await withTempDir(async () => {
    resetRunCounter()
    const original = process.env.TG_MAX_MODERATION_PER_DAY
    delete process.env.TG_MAX_MODERATION_PER_DAY
    try {
      seedModerationLog(45)
      // Moderation never fills the send budget: 45 bans leave every send slot free.
      assert.doesNotThrow(() => assertUnderCaps(1))
      assert.doesNotThrow(() => assertUnderModerationCap(5), '45 + 5 is exactly the cap')
      // Whole-call arithmetic: six more people do not fit in a budget of five.
      assert.throws(() => assertUnderModerationCap(6), (e: unknown) =>
        e instanceof ModerationCapError && /45\/50/.test(e.message) && /needs 6 more/.test(e.message))

      // The repo's exit code for a cap is the one the send caps already carry.
      for (let i = 0; i < MAX_SENDS_PER_DAY; i++) {
        recordSend({ at: new Date().toISOString(), peerId: 1, kind: 'text', messageId: i, size: 1, ok: true })
      }
      let sendCap: unknown = null
      try { assertUnderCaps(1) } catch (e) { sendCap = e }
      assert.ok(sendCap instanceof OperatorError, 'the send cap is hit too')
      let modCap: unknown = null
      try { assertUnderModerationCap(6) } catch (e) { modCap = e }
      assert.ok(modCap instanceof OperatorError)
      assert.equal(modCap.exitCode, sendCap.exitCode, 'same code as the send caps')
      assert.equal(modCap.exitCode, EXIT.notConfigured)

      // And the other direction: a spent send day leaves the five moderation slots.
      assert.doesNotThrow(() => assertUnderModerationCap(5))
      seedModerationLog(5)
      assert.throws(() => assertUnderModerationCap(1), ModerationCapError)

      // The backstop inside guardedSend refuses the write itself, with no RPC and no audit line.
      let rpcCalls = 0
      const before = readSendLog().length
      await assert.rejects(
        () => guardedSend(-1001234567890, 'ban-member', 0, () => { rpcCalls++; return Promise.resolve({ id: 0 }) }, { units: 0, targetUserId: 9 }),
        ModerationCapError
      )
      assert.equal(rpcCalls, 0)
      assert.equal(readSendLog().length, before, 'a refusal before the RPC is not an attempt')

      // An invalid setting refuses moderation outright instead of switching the guard off.
      process.env.TG_MAX_MODERATION_PER_DAY = '5O'
      assert.throws(() => assertUnderModerationCap(1), (e: unknown) =>
        e instanceof ModerationCapError && /not a whole number/.test(e.message))
      // A raised cap is the operator's to set, and it is read at call time.
      process.env.TG_MAX_MODERATION_PER_DAY = '500'
      assert.doesNotThrow(() => assertUnderModerationCap(20))
    } finally {
      if (original === undefined) delete process.env.TG_MAX_MODERATION_PER_DAY
      else process.env.TG_MAX_MODERATION_PER_DAY = original
    }
  })
})

/**
 * D13f: fence hardening. What the fence enforced by hand-kept lists and text
 * patterns is now enforced from the syntax tree and the installed mtcute, and the
 * rules run deny-by-default. The scanners are in test/fence-scan.ts; each eval
 * below runs them on synthetic files first (the D14 tripwire check: inject a
 * violation, watch the scan fail), then on the real sources.
 */

const tlMethods = tlRpcMethods()
const isTlMethod = (name: string): boolean => tlMethods.has(name)
const rawLists = { readMethods: READ_TL_METHODS, writeMethods: WRITE_TL_METHODS, isMethod: isTlMethod }
const synthetic = (path: string, source: string): SourceText => ({ path, source })

test('eval-175 a raw TL call outside src/send/ passes only if its method is a listed read', () => {
  const outside = (source: string, readMethods: readonly string[] = []) =>
    rawCallViolations([synthetic('cli/commands/x.ts', source)], { ...rawLists, readMethods })

  // A write, a read nobody listed, every quote style: refused.
  assert.equal(outside("await tg.call({ _: 'messages.sendMessage', peer })").length, 1)
  assert.equal(outside('await tg.call({ _: "messages.sendMessage", peer })').length, 1)
  assert.equal(outside('await tg.call({ _: `messages.sendMessage`, peer })').length, 1)
  assert.equal(outside("await tg.call({ _: 'account.getAuthorizations' })").length, 1, 'unlisted, even though it only reads')
  // The same shapes in another spelling of "call".
  assert.equal(outside("await tg['call']({ _: 'messages.sendMessage' })").length, 1)
  assert.equal(outside("await tg._client.call({ _: 'messages.sendMessage' })").length, 1)
  assert.equal(outside("const { call } = tg\nawait call({ _: 'messages.sendMessage' })").length, 1 + 1, 'the alias and the literal')
  // A call whose method cannot be read is refused on its own.
  assert.match(outside('await tg.call(request)')[0] ?? '', /not a string literal/)
  assert.equal(outside("await tg.call({ ...base, _: method })").length, 1)
  // A request built first and passed later is caught by the literal.
  assert.equal(outside("const req = { _: 'messages.sendMessage', peer }\nawait tg.call(req)").length, 2)

  // What must NOT be flagged: a listed read in any quote style, a constructor
  // name (data a read needs to ask its question), prose, and strings.
  const listed = ['account.getAuthorizations']
  assert.deepEqual(outside("await tg.call({ _: 'account.getAuthorizations' })", listed), [])
  assert.deepEqual(outside('await tg.call({ _: "account.getAuthorizations" })', listed), [])
  assert.deepEqual(outside("await tg.call({ _: 'account.getPrivacy', key: { _: 'inputPrivacyKeyStatusTimestamp' } })", ['account.getPrivacy']), [])
  assert.deepEqual(outside("const peer = { _: 'inputPeerEmpty' }"), [])
  assert.deepEqual(outside("// tg.call({ _: 'messages.sendMessage' }) would be refused\nconst text = \"tg.call({ _: 'messages.sendMessage' })\""), [])
  assert.deepEqual(outside("/* await tg.call({ _: 'messages.sendMessage' }) */\nfunction call() {}"), [])

  // Inside the fence a raw call must still be LISTED: eval-29b only checks that
  // listed methods appear, so an unlisted raw write in send/ was invisible.
  const inside = (source: string) => rawCallViolations([synthetic('send/index.ts', source)], rawLists)
  assert.deepEqual(inside("await tg.call({ _: 'messages.toggleDialogPin', peer })"), [])
  assert.equal(inside("await tg.call({ _: 'messages.sendMessage', peer })").length, 1)
  assert.equal(inside('await tg.call(request)').length, 1)

  // The real tree is clean...
  assert.deepEqual(rawCallViolations(SOURCES, rawLists), [])
  assert.ok(SOURCES.flatMap((f) => findRawCalls(f)).length >= 2, 'the scan found no raw call at all, so it passes for the wrong reason')

  // ...and injecting a raw write next to the real files fails it (D14).
  const injected = [...SOURCES, synthetic('peers/sneaky.ts', "export const go = (tg) => tg.call({ _: 'messages.sendMessage', peer: 1 })")]
  assert.equal(rawCallViolations(injected, rawLists).length, 1)
  const edited = SOURCES.map((f) => f.path === 'peers/index.ts'
    ? synthetic(f.path, `${f.source}\nexport const twin = (tg: never) => (tg as { call: (r: object) => void }).call({ _: 'channels.editTitle' })\n`)
    : f)
  assert.equal(rawCallViolations(edited, rawLists).length, 1)
})

test('eval-175b the raw TL lists name real methods, and a raw read is a get', () => {
  for (const method of [...READ_TL_METHODS, ...WRITE_TL_METHODS]) {
    assert.ok(tlMethods.has(method), `${method} is not a method of the installed TL schema: a typo here fences nothing`)
  }
  for (const method of READ_TL_METHODS) {
    // The schema names its reads `get*`. A write on this list would be a hole the
    // whole size of that write, so the list cannot take one by mistake.
    assert.match(method, /^[a-z]+\.get[A-Z]/, `${method} is on READ_TL_METHODS but is not a get*`)
    assert.ok(!(WRITE_TL_METHODS as readonly string[]).includes(method), `${method} is both a read and a write`)
    // The positive half: a listed read that nothing calls is a list that drifted.
    const naming = rawMethodsNamed(SOURCES, isTlMethod).filter((n) => n.method === method).map((n) => n.path)
    assert.ok(naming.length > 0, `${method} is on READ_TL_METHODS and no read verb calls it`)
    assert.ok(naming.every((path) => !path.startsWith('send/')), `${method} is a read and belongs outside src/send/`)
  }
})

test('eval-176 a fenced name is never aliased, destructured or looked up outside the files that may name it', () => {
  const outside = (source: string, path = 'cli/commands/x.ts') =>
    aliasViolations([synthetic(path, source)], WRITE_RPCS, WRITE_ALLOWLIST)

  // Every way to hold a write method without writing `.name(`.
  assert.equal(outside('const f = tg.sendText').length, 1, 'taken without being called')
  assert.equal(outside('run(tg.deleteMessagesById)').length, 1, 'passed as a callback')
  assert.equal(outside("await tg['sendText'](peer, 'x')").length, 1, 'bracket access')
  assert.equal(outside('await tg["banChatMember"](chat, user)').length, 1, 'bracket access, other quotes')
  assert.equal(outside('const { sendText } = tg').length, 1, 'destructured')
  assert.equal(outside('const { sendText: post } = tg').length, 1, 'destructured under another name')
  assert.equal(outside('const { a, editAdminRights } = tg').length, 1, 'destructured among others')
  assert.equal(outside("Reflect.get(tg, 'sendMedia')").length, 1, 'looked up by Reflect')
  assert.equal(outside("Object.getOwnPropertyDescriptor(proto, 'sendText')").length, 1, 'looked up by Object')
  assert.equal(outside("if ('sendText' in tg) {}").length, 1, 'probed with in')
  assert.equal(outside('await tg[method](peer)').length, 1, 'a method picked at run time')
  assert.equal(outside('await client[name](peer)').length, 1, 'same on `client`')

  // What is not an alias: a plain call is eval-29's, a TL flag that shares a
  // spelling is data, and prose is prose.
  assert.deepEqual(outside("await tg.sendText(peer, 'x')"), [], 'plain calls stay eval-29s job')
  assert.deepEqual(outside('const can = rights.deleteMessages && restrictions.sendMedia'), [])
  assert.deepEqual(outside('const flags = { deleteMessages: true, sendMedia: false }'), [])
  assert.deepEqual(outside("const label = 'sendText'"), [], 'a bare string is not a lookup')
  assert.deepEqual(outside("// tg.sendText is fenced; const { sendText } = tg is refused\n/* tg['sendText'] */"), [])
  assert.deepEqual(outside('const row = table[name]'), [], 'indexing something that is not the client')

  // The allowlisted files may name them: that is the allowlist.
  assert.deepEqual(outside('const { sendText } = tg', 'send/index.ts'), [])
  assert.deepEqual(outside('const f = tg.setChatTitle', 'cli/commands/group.ts'), [])

  // The real tree is clean, and injection fails it (D14).
  assert.deepEqual(aliasViolations(SOURCES, WRITE_RPCS, WRITE_ALLOWLIST), [])
  const injected = [...SOURCES, synthetic('groups/sneaky.ts', 'export const { editAdminRights } = (null as never) as { editAdminRights: () => void }')]
  assert.equal(aliasViolations(injected, WRITE_RPCS, WRITE_ALLOWLIST).length, 1)
})

test('eval-177 the import walk sees side-effect, re-export, dynamic and require edges', () => {
  const edges = (source: string, path = 'cli/commands/x.ts') => importEdges(synthetic(path, source))

  const to = ['send/index.ts']
  assert.deepEqual(edges("import { sendText } from '../../send/index.js'").to, to)
  assert.deepEqual(edges("import '../../send/index.js'").to, to, 'a side-effect import has no `from`')
  assert.deepEqual(edges("export * from '../../send/index.js'").to, to)
  assert.deepEqual(edges("export { sendText } from '../../send/index.js'").to, to)
  assert.deepEqual(edges("const m = await import('../../send/index.js')").to, to, 'a dynamic import with a literal')
  assert.deepEqual(edges("const m = require('../../send/index.js')").to, to)
  assert.deepEqual(edges("import x = require('../../send/index.js')").to, to)
  assert.deepEqual(edges("import chalk from 'chalk'\nimport { tl } from '@mtcute/node'").to, [], 'packages are not part of the graph')
  assert.deepEqual(edges("const t = `import('../../send/index.js')` // import '../../send/index.js'").to, [], 'strings and comments are not imports')

  // A dynamic import the walk cannot read is reported, not ignored.
  assert.equal(edges('const m = await import(path)').unfollowable.length, 1)
  assert.equal(edges('const m = require(`../${name}`)').unfollowable.length, 1)

  // Through the whole graph: a file that only touches the send module through
  // another file still reaches it.
  const sources = [
    ...SOURCES,
    synthetic('peers/helper.ts', "import '../send/gate.js'"),
    synthetic('cli/commands/sneaky-read.ts', "import { x } from '../../peers/helper.js'")
  ]
  const { graph } = importGraph(sources)
  assert.ok([...closureOf(graph, ['cli/commands/sneaky-read.ts'])].includes('send/gate.ts'))
  assert.ok(![...closureOf(importGraph(SOURCES).graph, ['cli/commands/peers.ts'])].includes('send/gate.ts'), 'and an honest read verb does not')
})

/** What mtcute declares that this suite has no opinion on yet. */
function unclassified(names: readonly string[], manifest: Record<string, unknown>): string[] {
  return names.filter((name) => !(name in manifest))
}

test('eval-178 every TelegramClient method of the installed mtcute is classified, so an upgrade cannot widen the account silently', () => {
  const names = clientMethodNames()

  assert.deepEqual(
    unclassified(names, CLIENT_METHODS),
    [],
    'mtcute declares a method the coverage manifest (test/coverage-manifest.ts) does not list. ' +
    'Classify it: covered, planned:<release>, defer, never or excluded:<reason>, and read or write.'
  )
  assert.deepEqual(
    Object.keys(CLIENT_METHODS).filter((name) => !names.includes(name)),
    [],
    'the manifest lists a method this mtcute no longer declares: remove it'
  )

  // Deny by default, shown: an upgrade that adds a method makes the check fail.
  assert.deepEqual(unclassified([...names, 'sendWhateverNewInMtcute28'], CLIENT_METHODS), ['sendWhateverNewInMtcute28'])

  // Every entry is well formed: a typo in a status would otherwise read as "planned".
  for (const [name, [status, access]] of Object.entries(CLIENT_METHODS)) {
    assert.match(status, /^(covered|defer|never|planned:\d+\.\d+(\.\d+)?|excluded:(auth|internal|iter|variant|bot))$/, `${name}: bad status ${status}`)
    assert.ok(['read', 'write', 'session'].includes(access), `${name}: bad access ${access}`)
  }

  // The arithmetic TASK-43 counts coverage by.
  const summary = summarize()
  const planned = Object.values(summary.planned).reduce((sum, n) => sum + n, 0)
  assert.equal(summary.total, names.length)
  assert.equal(summary.inScope, summary.covered + planned + summary.defer + summary.never)
  assert.equal(summary.excluded + summary.inScope, summary.total)
  assert.ok(summary.covered >= 47, `coverage went backwards: ${summary.covered}`)
})

/** The methods the older exception in src/contacts/import.ts calls outside the fence (D13). 0.9 moves them into src/send/ (TASK-43 AC 14). */
const LEGACY_WRITES = ['importContacts', 'deleteContacts']

test('eval-179 the manifest agrees with the code: what is covered is used, what is read is the only thing outside the fence, what writes is fenced', () => {
  const known = new Set(Object.keys(CLIENT_METHODS))
  const uses = clientUses(SOURCES, known)
  const usedAnywhere = new Set(uses.map((u) => u.name))
  assert.ok(uses.length > 40, 'the scan found almost no client calls, so it passes for the wrong reason')

  // (1) Covered means reachable: the method, or the iter* twin that walks it, is called.
  const twin = (name: string): string[] => {
    const bare = name.replace(/^get/, '')
    return [name, `iter${bare.charAt(0).toUpperCase()}${bare.slice(1)}`, `iter${name.charAt(0).toUpperCase()}${name.slice(1)}`]
  }
  for (const [name, [status]] of Object.entries(CLIENT_METHODS)) {
    if (status !== 'covered') continue
    assert.ok(twin(name).some((candidate) => usedAnywhere.has(candidate)), `${name} is marked covered and nothing in src/ calls it`)
  }

  // (2) Outside the fence a file may call only reads and the login lifecycle.
  for (const use of uses) {
    if (WRITE_ALLOWLIST.has(use.path)) continue
    const [, access] = CLIENT_METHODS[use.name]!
    assert.ok(access !== 'write', `${use.where} calls ${use.name}, which the manifest classes as a write, outside the fence`)
  }

  // (3) A write that is called anywhere is a fenced write: this is the hole eval-29
  //     could not close, a write method nobody had put on WRITE_RPCS.
  for (const name of usedAnywhere) {
    if (CLIENT_METHODS[name]![1] !== 'write') continue
    assert.ok(
      (WRITE_RPCS as readonly string[]).includes(name) || LEGACY_WRITES.includes(name),
      `${name} is a write that src/ calls and WRITE_RPCS does not name`
    )
  }

  // (4) The fence's own list is made of real writes.
  const names = new Set(clientMethodNames())
  for (const rpc of WRITE_RPCS) {
    assert.ok(names.has(rpc), `WRITE_RPCS names ${rpc}, which mtcute does not declare: a typo fences nothing`)
    assert.equal(CLIENT_METHODS[rpc]?.[1], 'write', `${rpc} is fenced but the manifest does not class it a write`)
  }
  // And every covered write is on it.
  for (const [name, [status, access]] of Object.entries(CLIENT_METHODS)) {
    if (status === 'covered' && access === 'write') {
      assert.ok(
        (WRITE_RPCS as readonly string[]).includes(name) || LEGACY_WRITES.includes(name),
        `${name} is a covered write and is not on WRITE_RPCS`
      )
    }
  }
})

test('eval-180 what is never added is nowhere in src/, client method or raw TL', () => {
  const known = new Set(Object.keys(CLIENT_METHODS))
  for (const use of clientUses(SOURCES, known)) {
    const [status] = CLIENT_METHODS[use.name]!
    assert.notEqual(status, 'never', `${use.where} uses ${use.name}, which TASK-43 section 6 says is never added`)
  }

  // Raw TL: the manifest and the two fence lists say the same thing, both ways.
  for (const method of Object.keys(RAW_TL_METHODS)) {
    assert.ok(tlMethods.has(method), `RAW_TL_METHODS lists ${method}, which the TL schema does not have`)
  }
  const raw = rawMethodsNamed(SOURCES, isTlMethod)
  const covered = Object.entries(RAW_TL_METHODS).filter(([, [status]]) => status === 'covered').map(([name]) => name).sort()
  assert.deepEqual(
    [...new Set(raw.map((n) => n.method))].sort(),
    covered,
    'the raw TL methods written out in src/ are not exactly the ones the manifest calls covered'
  )
  assert.deepEqual(
    [...WRITE_TL_METHODS, ...READ_TL_METHODS].sort(),
    covered,
    'WRITE_TL_METHODS and READ_TL_METHODS together must be exactly the covered raw methods'
  )
  for (const [method, [status, access]] of Object.entries(RAW_TL_METHODS)) {
    if (status !== 'covered') continue
    assert.equal(
      READ_TL_METHODS.includes(method),
      access === 'read',
      `${method}: a covered raw read is on READ_TL_METHODS and a covered raw write on WRITE_TL_METHODS`
    )
  }
  // Unsupported families.
  for (const { method } of raw) {
    assert.ok(!UNSUPPORTED_TL_PREFIXES.some((prefix) => method.startsWith(prefix)), `${method} is unsupported (calls need a media stack)`)
  }
})

test('eval-181 every list read of Telegram goes through the one paced walk', () => {
  // peers/index.ts walks dialogs directly. It predates the helper, it is bounded
  // by --limit, and pacing it would add 1.5s per hundred dialogs to every
  // `peers find`; it is named here so it cannot be copied, not because it is right.
  const exceptions = new Set(['peers/index.ts'])
  const check = (source: string, path = 'cli/commands/x.ts') => unpacedIterators([synthetic(path, source)], exceptions)

  // A second reader, in every spelling.
  assert.equal(check('for await (const m of tg.iterHistory(chat)) use(m)').length, 1)
  assert.equal(check('const walk = tg.iterSearchMessages({ query })\nfor await (const m of walk) use(m)').length, 1)
  assert.equal(check("for await (const m of tg['iterDialogs']({})) use(m)").length, 1)
  assert.equal(check('for await (const m of readingEach(tg.iterChatEventLog(chat))) use(m)').length, 1, 'wrapped, but not paced')
  assert.equal(check('const f = () => paced(x)\nfor await (const m of tg.iterHistory(chat)) use(m)').length, 1, 'a paced call elsewhere is not enough')

  // The only accepted shapes: the iterator is an argument of paced(), at any depth.
  assert.deepEqual(check('for await (const m of paced(tg.iterHistory(chat), { limit: 5 })) use(m)'), [])
  assert.deepEqual(check('for await (const m of paced(readingEach(tg.iterChatEventLog(chat)), {})) use(m)'), [])
  assert.deepEqual(check('yield* paced(a ? tg.iterHistory(chat) : tg.iterSearchMessages({ chatId }), {})'), [])
  assert.deepEqual(check('const x = foo.iterable'), [], 'only iter* CALLS are readers')
  assert.deepEqual(check('for await (const m of tg.iterDialogs({}))', 'peers/index.ts'), [], 'the named exception')

  // The real tree, and an injected second reader.
  assert.deepEqual(unpacedIterators(SOURCES, exceptions), [])
  assert.ok(SOURCES.some((f) => /\.iter[A-Z]\w*\(/.test(f.source)), 'no iterator found at all, so the scan passes for the wrong reason')
  assert.equal(unpacedIterators([...SOURCES, synthetic('messages/second-reader.ts', 'export const go = (tg) => tg.iterHistory(1)')], exceptions).length, 1)
})
