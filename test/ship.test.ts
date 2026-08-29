/**
 * `tg ship` - the gbrain side of the security boundary.
 *
 * Two things are being defended here. First, that the loop is idempotent:
 * gbrain enforces UNIQUE (source_id, slug), so a stable slug is the whole
 * dedup mechanism and a drifting one would silently fork every page. Second,
 * that this code path never learns anything about Telegram - asserted by
 * walking the real import graph, not by reading the file and hoping.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseBrainMap, planShip, readFolderIds, ship, slugForFile, ShipError, unroutableError } from '../src/ship/index.js'
import { withTempDir } from './helpers.js'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

// Every test writes into its own temp dir, but the heartbeat path defaults to
// the real ~/.gbrain. Redirect it once, here, so the suite never appends a
// line to a human's actual brain.
process.env.TG_HEARTBEAT_PATH = join(mkdtempSync(join(tmpdir(), 'tg-beat-')), 'heartbeat.jsonl')

function page(folderIds: string, body = 'hello'): string {
  return `---\ntype: note\ntitle: "T"\nchat_id: 1\nfolder_ids: ${folderIds}\n---\n\n${body}\n`
}

/**
 * Write an archive page dated two seconds ago.
 *
 * The ingester exits before the shipper starts, so in production every file
 * predates the run. Writing one in the same millisecond as `Date.now()` would
 * exercise the deliberate re-ship at the rounding edge, not the normal path.
 */
function writePage(path: string, folderIds: string, body = 'hello'): void {
  writeFileSync(path, page(folderIds, body))
  const twoSecondsAgo = Date.now() / 1000 - 2
  utimesSync(path, twoSecondsAgo, twoSecondsAgo)
}

/**
 * A gbrain stand-in that records argv and stdin.
 *
 * Recording rather than asserting inline: what matters is that the SAME slug
 * comes back on a second run, which can only be checked by comparing two runs.
 */
function fakeGbrain(dir: string, exitCode = 0): string {
  const bin = join(dir, 'fake-gbrain')
  const log = join(dir, 'calls.jsonl')
  writeFileSync(bin, [
    '#!/usr/bin/env node',
    "const { appendFileSync, readFileSync } = require('node:fs')",
    `appendFileSync(${JSON.stringify(log)}, JSON.stringify({`,
    '  argv: process.argv.slice(2),',
    "  stdin: readFileSync(0, 'utf-8')",
    "}) + '\\n')",
    `process.exit(${exitCode})`
  ].join('\n'))
  chmodSync(bin, 0o755)
  return bin
}

function calls(dir: string): { argv: string[]; stdin: string }[] {
  const log = join(dir, 'calls.jsonl')
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { argv: string[]; stdin: string })
}

test('eval-40 the slug is derived from the archive filename and is byte-stable', () => {
  const names = [
    'simple-chat_1.md',
    'project-ada-notes_2.md',
    'привет-мир-🌍_8.md',
    'chat_7.md',
    `${'x'.repeat(190)}_9.md`
  ]
  assert.deepEqual(
    names.map(slugForFile),
    [
      'tg/chat/simple-chat_1',
      'tg/chat/project-ada-notes_2',
      'tg/chat/привет-мир-🌍_8',
      'tg/chat/chat_7',
      `tg/chat/${'x'.repeat(190)}_9`
    ]
  )
  // Same name, different chat id: the id suffix keeps the slugs distinct.
  assert.notEqual(slugForFile('ada_1.md'), slugForFile('ada_2.md'))
})

test('eval-41 folder_ids is read out of frontmatter, absent means empty', () => {
  assert.deepEqual(readFolderIds(page('[7, 12]')), [7, 12])
  assert.deepEqual(readFolderIds(page('[7]')), [7])
  assert.deepEqual(readFolderIds(page('[]')), [])
  assert.deepEqual(readFolderIds('---\nchat_id: 1\n---\n'), [])
})

test('eval-42 the brain map parses and rejects junk loudly', () => {
  assert.deepEqual([...parseBrainMap('7=personal,12=proximata')], [[7, 'personal'], [12, 'proximata']])
  assert.deepEqual([...parseBrainMap(undefined)], [])
  assert.throws(() => parseBrainMap('personal'), ShipError)
})

test('eval-43 routing: one folder one brain, two folders two brains', async () => {
  await withTempDir(async () => {
    mkdirSync('archive', { recursive: true })
    writeFileSync(join('archive', 'a_1.md'), page('[7]'))
    writeFileSync(join('archive', 'b_2.md'), page('[12]'))
    writeFileSync(join('archive', 'c_3.md'), page('[7, 12]'))

    const { entries: plan } = planShip({
      archiveDir: 'archive',
      since: 0,
      brainMap: parseBrainMap('7=personal,12=proximata')
    })
    assert.deepEqual(plan.map((p) => [p.slug, p.sources]), [
      ['tg/chat/a_1', ['personal']],
      ['tg/chat/b_2', ['proximata']],
      ['tg/chat/c_3', ['personal', 'proximata']]
    ])
  })
})

test('eval-44 an unroutable file fails loudly instead of defaulting to a brain', async () => {
  await withTempDir(async () => {
    mkdirSync('archive', { recursive: true })
    // A chat in no tracked folder.
    writeFileSync(join('archive', 'orphan_9.md'), page('[]'))
    let plan = planShip({ archiveDir: 'archive', since: 0, brainMap: parseBrainMap('7=personal') })
    assert.deepEqual(plan.entries, [], 'nothing is routed')
    assert.equal(plan.skipped.length, 1)
    assert.equal(plan.skipped[0].reason, 'no-folder')
    // The DEFAULT is still a loud failure: only an explicit flag proceeds.
    assert.throws(() => { throw unroutableError(plan.skipped) }, /in no tracked folder/)
    assert.throws(
      () => ship({ archiveDir: 'archive', brainMap: parseBrainMap('7=personal'), dryRun: true }),
      /cannot be routed/
    )

    // A chat whose folder is not in the map.
    writeFileSync(join('archive', 'orphan_9.md'), page('[99]'))
    plan = planShip({ archiveDir: 'archive', since: 0, brainMap: parseBrainMap('7=personal') })
    assert.equal(plan.skipped[0].reason, 'unmapped-folder')
    assert.throws(() => { throw unroutableError(plan.skipped) }, /TG_BRAIN_MAP/)
    // The message must name the fix, not just the problem.
    assert.match(unroutableError(plan.skipped).message, /99=<source>/)
  })
})

test('eval-45 shipping twice is a no-op: same slug, same stdin, nothing re-sent', async () => {
  await withTempDir(async (dir) => {
    mkdirSync('archive', { recursive: true })
    writePage(join('archive', 'a_1.md'), '[7]')
    const opts = {
      archiveDir: 'archive',
      brainMap: parseBrainMap('7=personal'),
      gbrainBin: fakeGbrain(dir)
    }

    const first = ship(opts)
    assert.deepEqual(first, { shipped: 1, captures: 1, skipped: 0 })
    assert.equal(calls(dir).length, 1)
    assert.deepEqual(calls(dir)[0].argv, [
      'capture', '--stdin', '--slug', 'tg/chat/a_1', '--source', 'personal', '--quiet'
    ])

    // Second run: the watermark has moved past the file, so nothing is sent.
    assert.deepEqual(ship(opts), { shipped: 0, captures: 0, skipped: 0 })
    assert.equal(calls(dir).length, 1)

    // --all re-sends it, and byte-for-byte the same payload under the same
    // slug: gbrain's UNIQUE (source_id, slug) turns that into an update.
    assert.deepEqual(ship({ ...opts, all: true }), { shipped: 1, captures: 1, skipped: 0 })
    const [before, after] = calls(dir)
    assert.deepEqual(before, after)
  })
})

test('eval-46 a non-zero gbrain exit aborts the run and leaves the watermark alone', async () => {
  await withTempDir(async (dir) => {
    mkdirSync('archive', { recursive: true })
    writeFileSync(join('archive', 'a_1.md'), page('[7]'))
    const stamp = join('archive', '.last-ship')
    writeFileSync(stamp, '')
    // Watermark deliberately in the past so the file is in scope.
    utimesSync(stamp, 1, 1)

    assert.throws(
      () => ship({
        archiveDir: 'archive',
        brainMap: parseBrainMap('7=personal'),
        gbrainBin: fakeGbrain(dir, 3)
      }),
      /exited 3/
    )
    assert.equal(statSync(stamp).mtimeMs, 1000, 'a failed run must not advance the watermark')
  })
})

test('eval-47 --dry-run execs nothing and moves no watermark', async () => {
  await withTempDir(async (dir) => {
    mkdirSync('archive', { recursive: true })
    writeFileSync(join('archive', 'a_1.md'), page('[7]'))

    const result = ship({
      archiveDir: 'archive',
      dryRun: true,
      brainMap: parseBrainMap('7=personal'),
      gbrainBin: fakeGbrain(dir)
    })
    assert.deepEqual(result, { shipped: 1, captures: 1, skipped: 0 })
    assert.equal(calls(dir).length, 0)
    assert.equal(existsSync(join('archive', '.last-ship')), false)
  })
})

/**
 * The mechanical half of security rule 2: nothing talking to gbrain may hold
 * a Telegram credential. A grep of one file would miss a credential reached
 * three imports deep, so this walks the whole closure.
 */
/**
 * The Telegram secret names, read out of the one module that defines them.
 *
 * Derived rather than hardcoded: a new secret added to src/session/psst.ts is
 * covered by eval-48 the moment it exists, with nobody having to remember.
 */
const SECRET_NAMES = (() => {
  const psst = readFileSync(resolve(SRC, 'session/psst.ts'), 'utf-8')
  const block = psst.slice(psst.indexOf('export const SECRETS'), psst.indexOf('} as const'))
  const names = [...block.matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1])
  if (names.length < 4) throw new Error(`could not read SECRETS from psst.ts, got ${names.length}`)
  return names
})()

test('eval-48 the ship import graph contains no session, client or mtcute module', () => {
  const seen = new Set<string>()
  const queue = [resolve(SRC, 'ship/index.ts'), resolve(SRC, 'cli/commands/ship.ts')]

  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)

    const source = readFileSync(file, 'utf-8')
    for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
      const spec = match[1]
      if (!spec.startsWith('.')) {
        assert.ok(
          !spec.includes('mtcute'),
          `${file} imports ${spec}: the gbrain path must not link the Telegram client`
        )
        continue
      }
      queue.push(resolve(dirname(file), spec.replace(/\.js$/, '.ts')))
    }
  }

  for (const file of seen) {
    assert.ok(
      !/\/(session|client\.ts|storage)/.test(file.slice(SRC.length - 1)),
      `${file} is reachable from ship: the gbrain path must not import the session layer`
    )
    // Checks the SECRET NAMES, not the TG_ prefix. The prefix was a proxy that
    // stopped working the day settings moved to TG_ too: TG_BRAIN_MAP is ship's
    // own configuration, not a credential, and a prefix test flagged it. The
    // list is derived from src/session/psst.ts so adding a secret there extends
    // this gate automatically instead of silently leaving a hole.
    const source = readFileSync(file, 'utf-8')
    for (const secret of SECRET_NAMES) {
      assert.ok(
        !source.includes(secret),
        `${file} is reachable from ship and names the Telegram secret ${secret}`
      )
    }
    assert.ok(
      !/readSecret|SESSION_DB_PATH/.test(source),
      `${file} is reachable from ship and reaches for the credential store`
    )
  }
})

test('eval-49 every run appends exactly one heartbeat line, success or failure', async () => {
  await withTempDir(async (dir) => {
    mkdirSync('archive', { recursive: true })
    writePage(join('archive', 'a_1.md'), '[7]')
    const beat = join(dir, 'heartbeat.jsonl')
    const previous = process.env.TG_HEARTBEAT_PATH
    process.env.TG_HEARTBEAT_PATH = beat

    try {
      ship({ archiveDir: 'archive', brainMap: parseBrainMap('7=personal'), gbrainBin: fakeGbrain(dir) })
      writePage(join('archive', 'b_2.md'), '[99]')
      assert.throws(() => ship({
        archiveDir: 'archive',
        all: true,
        brainMap: parseBrainMap('7=personal'),
        gbrainBin: fakeGbrain(dir)
      }))
    } finally {
      process.env.TG_HEARTBEAT_PATH = previous
    }

    const lines = readFileSync(beat, 'utf-8').trim().split('\n')
      .map((l) => JSON.parse(l) as { ts: string; event: string; status: string; source_version?: string; details?: unknown })
    assert.equal(lines.length, 2)
    assert.deepEqual(lines.map((l) => l.status), ['ok', 'error'])
    for (const line of lines) {
      assert.match(line.ts, /^\d{4}-\d{2}-\d{2}T/)
      assert.equal(line.event, 'ship')
      assert.ok(line.source_version, 'a heartbeat with no version cannot be traced to a build')
      assert.ok(line.details, 'a heartbeat with no details says nothing')
    }
  })
})

test('eval-84 the gbrain child never inherits a Telegram credential', async () => {
  // The decision log states the boundary as a PROCESS boundary and enforces it
  // with an import-graph eval. The import graph was clean and the boundary still
  // leaked: spawnSync with no `env` hands the child the parent's WHOLE
  // environment, and under `psst run` that contains TG_SESSION_STRING. gbrain
  // was receiving a full Telegram credential on every capture. An import graph
  // cannot see that; only an allowlist can.
  const source = readFileSync(resolve(SRC, 'ship/index.ts'), 'utf-8')

  // Every spawn on this path must pass an explicit env.
  const spawns = [...source.matchAll(/spawnSync\s*\(/g)]
  assert.ok(spawns.length > 0, 'expected at least one spawn to guard')
  assert.ok(
    !/stdio:\s*\[[^\]]*\]\s*\}/.test(source.replace(/env:\s*childEnv\(\)/g, 'ENVOK')),
    'a spawn on the gbrain path has no explicit env: it would inherit the credential'
  )

  // And the allowlist must not contain anything from the secret namespace.
  const allowlist = source.slice(source.indexOf('const allowed = ['), source.indexOf('  ]', source.indexOf('const allowed = [')))
  for (const secret of SECRET_NAMES) {
    assert.ok(!allowlist.includes(secret), `${secret} is on the gbrain env allowlist`)
  }
  assert.ok(!/TG_SESSION|API_HASH|API_ID/.test(allowlist), 'no Telegram credential may be forwarded')
})

test('eval-92 unroutable files cost one file each, not the whole run', async () => {
  // On the real archive 38 of 130 chats belong to no tracked folder - exported
  // directly, or the folder changed later. Failing the run on the first one
  // meant those 38 blocked the other 92 from ever reaching the brain. Refusing
  // to GUESS is the invariant; refusing to ship anything is not.
  await withTempDir(async (_dir) => {
    mkdirSync('archive', { recursive: true })
    writeFileSync(join('archive', 'good_1.md'), page('[7]'))
    writeFileSync(join('archive', 'orphan_2.md'), page('[]'))
    writeFileSync(join('archive', 'elsewhere_3.md'), page('[99]'))

    const brainMap = parseBrainMap('7=personal')

    // Default: nothing ships, and the error names both causes and both fixes.
    assert.throws(
      () => ship({ archiveDir: 'archive', brainMap, dryRun: true }),
      (e: Error) =>
        /cannot be routed/.test(e.message) &&
        /no tracked folder/.test(e.message) &&
        /TG_BRAIN_MAP/.test(e.message)
    )

    // With the flag: the routable file ships, the other two are reported.
    const result = ship({
      archiveDir: 'archive',
      brainMap,
      dryRun: true,
      skipUnroutable: true
    })
    assert.equal(result.shipped, 1, 'the routable file still ships')
    assert.equal(result.skipped, 2, 'and both unroutable ones are counted')

    // Still never guesses: the skipped files went to NO source.
    const plan = planShip({ archiveDir: 'archive', since: 0, brainMap })
    assert.deepEqual(plan.entries.map((e) => e.sources), [['personal']])
  })
})
