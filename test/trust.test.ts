import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert'
import test from 'node:test'
import { assertPeerId } from '../src/peers/id.js'
import {
  MAX_SENDS_PER_DAY,
  assertConfirmed,
  readSendLog,
  recordSend,
  resetRunCounter,
  sendsToday,
  type SentRecord
} from '../src/send/gate.js'
import { mediaFilename } from '../src/media/index.js'
import { mediaKindFor } from '../src/send/index.js'
import { withTempDir } from './helpers.js'

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

/** Transitive closure of relative imports from a set of entry points. */
function importClosure(entries: string[]): Set<string> {
  const seen = new Set<string>()
  const queue = entries.map((e) => resolve(SRC, e))

  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)

    let source: string
    try {
      source = readFileSync(file, 'utf-8')
    } catch {
      // A path that does not resolve to a file is a broken import, which tsc
      // already fails on; nothing for this walk to add.
      continue
    }

    for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
      // Group 1 is not optional in the pattern: a match always carries it.
      const spec = match[1]!
      if (!spec.startsWith('.')) continue
      queue.push(resolve(dirname(file), spec.replace(/\.js$/, '.ts')))
    }
  }

  return seen
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
  'markChatUnread'
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
  'contacts/import.ts'
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

test('eval-30 the unattended paths cannot reach the send module', () => {
  // Everything a cron job, timer or agent invokes without a human present.
  const unattended = [
    'cli/commands/export-sync.ts',
    'cli/commands/export-recent.ts',
    'cli/commands/export-historical.ts',
    'cli/commands/folders.ts',
    'cli/commands/ship.ts',
    'cli/commands/sync.ts',
    'sync/index.ts',
    'ship/index.ts'
  ]

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

test('eval-31 the read verbs cannot reach the send module either', () => {
  // The point of splitting peers/id.ts out of send/: a read verb validates a
  // peer id without linking the code that can write.
  for (const entry of ['cli/commands/dump.ts', 'cli/commands/media.ts', 'cli/commands/peers.ts', 'cli/commands/watch.ts']) {
    const closure = importClosure([entry])
    assert.deepEqual(
      [...closure].filter((f) => /\/send\/(index|gate)\.ts$/.test(f)).map((f) => f.slice(SRC.length)),
      [],
      `${entry} is a read verb and must not import the send module`
    )
  }
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
