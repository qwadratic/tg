import assert from 'node:assert'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OperatorError } from '../src/errors.js'
import { EXIT } from '../src/exit-codes.js'
import { parseChoice, parseChoices, parseCount, parseLimit, parseMessageIds, parseUserIds } from '../src/cli/args.js'
import { withTempDir } from './helpers.js'

/**
 * The read verbs of 0.8 as a user meets them: through the real binary, and as
 * static facts about how the command layer is built. Nothing here has a session,
 * so every case that drives the binary is refused BEFORE one is looked for, which
 * is also what these evals pin: argument mistakes cost no connection.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf-8')

const CHAT = '-1001234567890'

test('eval-198a the argument parsers refuse what Number() would quietly accept', () => {
  const refused = (run: () => unknown): OperatorError => {
    try { run() } catch (e) { return e as OperatorError }
    throw new Error('should have been refused')
  }

  assert.equal(parseCount(' 42 ', 'x'), 42)
  for (const bad of ['1e3', '0x10', '', ' ', '-1', '1.5', '+3', 'ten', '٣']) {
    assert.equal(refused(() => parseCount(bad, 'x')).exitCode, EXIT.usage, JSON.stringify(bad))
  }

  assert.equal(parseLimit(undefined, 50, 500), 50, 'absent is the default')
  assert.equal(parseLimit('500', 50, 500), 500)
  for (const bad of ['0', '501', '1e2', 'many', '']) assert.equal(refused(() => parseLimit(bad, 50, 500)).exitCode, EXIT.usage, bad)

  assert.deepEqual(parseMessageIds(['12', '13,14', '12'], 10), [12, 13, 14], 'order kept, repeats dropped, commas split')
  assert.equal(refused(() => parseMessageIds([], 10)).exitCode, EXIT.usage)
  assert.equal(refused(() => parseMessageIds(['0'], 10)).exitCode, EXIT.usage, 'ids are positive')
  assert.equal(refused(() => parseMessageIds(['1', '2', '3'], 2)).exitCode, EXIT.usage, 'over the cap')
  assert.match(refused(() => parseMessageIds(['abc'], 1, '--topic')).message, /--topic/, 'the flag is named')
  assert.equal(refused(() => parseMessageIds(['99999999999999999999'], 1)).exitCode, EXIT.usage, 'beyond a safe integer')

  assert.deepEqual(parseUserIds(['5,6', '7'], '--user', 10), [5, 6, 7])
  assert.equal(refused(() => parseUserIds(['@durov'], '--user', 10)).exitCode, EXIT.usage, 'a person is an id here')
  assert.equal(refused(() => parseUserIds(['1', '2', '3'], '--user', 2)).exitCode, EXIT.usage)

  assert.equal(parseChoice('a', '--x', ['a', 'b']), 'a')
  assert.equal(refused(() => parseChoice('c', '--x', ['a', 'b'])).exitCode, EXIT.usage)
  assert.equal(refused(() => parseChoice('toString', '--x', ['a', 'b'])).exitCode, EXIT.usage, 'not an inherited member')
  assert.deepEqual(parseChoices('a, b,a', '--x', ['a', 'b']), ['a', 'b'])
  assert.equal(refused(() => parseChoices(' , ', '--x', ['a', 'b'])).exitCode, EXIT.usage)
  assert.equal(refused(() => parseChoices('a,z', '--x', ['a', 'b'])).exitCode, EXIT.usage)
})

test('eval-198 a bad argument to a read verb is refused offline, as usage (2), with the JSON envelope', async () => {
  const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url))
  const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/esm/index.mjs', import.meta.url))

  await withTempDir(async () => {
    const run = (args: string[]) => new Promise<{ code: number | null; stdout: string }>((done) => {
      execFile(
        process.execPath,
        ['--import', tsx, entry, ...args, '--json'],
        { env: { ...process.env, TG_NON_INTERACTIVE: '1', TG_NO_UPDATE: '1' }, cwd: process.cwd() },
        (error, stdout) => done({ code: error ? (error as { code?: number }).code ?? 1 : 0, stdout })
      )
    })

    const manyPeers = Array.from({ length: 21 }, (_, i) => String(100 + i))
    const manyIds = Array.from({ length: 101 }, (_, i) => String(i + 1))
    // One or two per verb: the arithmetic of each parser is pinned in-process by eval-198a, so
    // what these prove is the wiring, that the check runs before a session and exits 2.
    const cases: [string[], RegExp][] = [
      [['msg', 'get', CHAT, 'abc'], /Not a message id/],
      [['msg', 'get', CHAT, ...manyIds], /At most 100/],
      [['msg', 'get', '@durоv', '1'], /non-ASCII/],
      [['msg', 'link', 'https://t.me/+AbCdEf123'], /invite link/],
      [['msg', 'link', 'nonsense'], /not a t\.me message link/],
      [['msg', 'thread', CHAT, '5', '--depth', '99'], /between 1 and 20/],
      [['msg', 'search', 'hello'], /Pick exactly one scope/],
      [['msg', 'search', 'hello', '--chat', CHAT, '--global'], /Pick exactly one scope/],
      [['msg', 'search', 'hello', '--hashtag', '--filter', 'photo'], /--filter works with --chat and --global/],
      [['msg', 'search', 'hello', '--global', '--from', '5'], /--from works with --chat only/],
      [['msg', 'search', 'hello', '--global', '--filter', 'nope'], /--filter must be one of/],
      [['msg', 'search', 'hello', '--global', '--limit', '501'], /between 1 and 500/],
      [['msg', 'search', 'two words', '--hashtag'], /Not a hashtag/],
      [['chat', 'log', CHAT, '--type', 'nope'], /--type must be one of/],
      [['chat', 'info', '@durоv'], /non-ASCII/],
      [['user', 'info', 'x'], /not a numeric id and not a valid username/],
      [['dump', CHAT, '--topic', '3', '--thread', '4'], /not both/],
      [['dump', CHAT, '--thread', '0'], /positive/],
      [['account', 'privacy', 'nope'], /Not a privacy setting/],
      [['dialogs', 'show', ...manyPeers], /At most 20/],
      [['reactions', 'show', CHAT, '1', '--users', '--limit', '1001'], /between 1 and 1000/],
      [['scheduled', 'list', CHAT, 'abc'], /Not a message id/],
      [['draft', 'list', '--scan', '0'], /between 1 and 2000/],
      [['contacts', 'list', '--limit', '5001'], /between 1 and 5000/],
      [['group', 'member', CHAT, 'not a user!!'], /Cannot use/]
    ]

    // A few at a time: each is a fresh process, and the point is the answer, not the speed.
    const results: { code: number | null; stdout: string }[] = []
    for (let i = 0; i < cases.length; i += 12) {
      results.push(...(await Promise.all(cases.slice(i, i + 12).map(([args]) => run(args)))))
    }

    results.forEach((result, i) => {
      const [args, message] = cases[i]!
      assert.equal(result.code, EXIT.usage, `tg ${args.join(' ').slice(0, 80)} exited ${result.code}`)
      const envelope = JSON.parse(result.stdout) as { ok: boolean; error: { code: string; exit: number; message: string; detail: string } }
      assert.equal(envelope.ok, false)
      assert.equal(envelope.error.exit, EXIT.usage)
      assert.equal(envelope.error.code, 'usage')
      assert.match(envelope.error.detail, message, `tg ${args.join(' ').slice(0, 80)}`)
    })
  })
})

/** The read verbs of 0.8, as `[command file, leaf command]`. */
const READ_VERBS: [string, string][] = [
  ['chat.ts', 'info'], ['chat.ts', 'log'],
  ['msg.ts', 'get'], ['msg.ts', 'link'], ['msg.ts', 'thread'], ['msg.ts', 'search'],
  ['user.ts', 'info'], ['contacts.ts', 'list'], ['dialogs.ts', 'show'], ['draft.ts', 'list'],
  ['scheduled.ts', 'list'], ['reactions.ts', 'show'],
  ['account.ts', 'sessions'], ['account.ts', 'privacy'], ['account.ts', 'notify'],
  ['group.ts', 'member']
]

/** The source of one `.command('<name> ...')` up to its `.action(`. */
function commandSource(file: string, name: string): string {
  const source = read('src', 'cli', 'commands', file)
  const match = new RegExp(`\\.command\\('${name}(?: [^']*)?'\\)([\\s\\S]*?)\\.action\\(`).exec(source)
  assert.ok(match, `${file} has no .command('${name}')`)
  return match[1] ?? ''
}

test('eval-199 every read verb takes --json, lists take --limit, and none of them has a gate or a way to confirm', () => {
  for (const [file, name] of READ_VERBS) {
    assert.match(commandSource(file, name), /\.option\('--json'/, `tg ... ${name} (${file}) does not accept --json`)
  }

  // --limit where a list can be long. (`dialogs show` and `scheduled list` take explicit chats or are
  // capped by Telegram itself; the account verbs read a fixed set.)
  for (const [file, name] of [['chat.ts', 'log'], ['msg.ts', 'search'], ['contacts.ts', 'list'], ['draft.ts', 'list'], ['reactions.ts', 'show']] as const) {
    assert.match(commandSource(file, name), /\.option\('--limit /, `${file} ${name} has no --limit`)
  }
  assert.match(read('src', 'cli', 'commands', 'dump.ts'), /\.option\('--limit /)

  // Read verbs have no gate: no --yes, no confirmation, no send log. They cannot even name them.
  for (const file of ['chat.ts', 'msg.ts', 'user.ts', 'contacts.ts', 'dialogs.ts', 'draft.ts', 'scheduled.ts', 'reactions.ts', 'account.ts']) {
    const source = read('src', 'cli', 'commands', file)
    assert.doesNotMatch(source, /--yes|assertConfirmed|guardedSend|confirmChat|canPrompt|sent\.jsonl/, `${file} is a read verb and must have no gate`)
  }

  // Registered above the write verbs, where a reviewer looks for them.
  const index = read('src', 'index.ts')
  const writeStart = index.indexOf('Write verbs last')
  assert.ok(writeStart > 0)
  for (const register of ['Chat', 'Msg', 'User', 'Contacts', 'Dialogs', 'Draft', 'Scheduled', 'Reactions', 'Account']) {
    const at = index.indexOf(`register${register}Command(program)`)
    assert.ok(at > 0 && at < writeStart, `register${register}Command must be called above the write verbs`)
  }
})
