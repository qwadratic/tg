import assert from 'node:assert'
import test from 'node:test'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_SESSION_TTL_DAYS,
  effectiveTtlDays,
  isExpired,
  metaForReuse,
  readSessionMeta,
  writeSessionMeta,
  type SessionMeta
} from '../src/session/ttl.js'
import { OperatorError } from '../src/errors.js'
import { EXIT } from '../src/exit-codes.js'
import { withTempDir } from './helpers.js'

/**
 * Per-workspace session expiry.
 *
 * What this policy decides is whether a live account credential gets destroyed,
 * so both directions are dangerous: expiring too eagerly logs an operator out
 * of a working setup with no warning, and never expiring leaves an abandoned
 * workspace holding a full authorisation forever. Every eval below pins one of
 * those two edges.
 */

const DAY = 86_400_000
const meta = (createdAt: Date, ttlDays: number): SessionMeta => ({
  createdAt: createdAt.toISOString(),
  ttlDays
})

/** No TG_/TGU_ SESSION_TTL_DAYS leaking in from the ambient environment. */
function withEnv<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.TG_SESSION_TTL_DAYS
  const previousLegacy = process.env.TGU_SESSION_TTL_DAYS
  delete process.env.TGU_SESSION_TTL_DAYS
  if (value === undefined) delete process.env.TG_SESSION_TTL_DAYS
  else process.env.TG_SESSION_TTL_DAYS = value

  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env.TG_SESSION_TTL_DAYS
    else process.env.TG_SESSION_TTL_DAYS = previous
    if (previousLegacy !== undefined) process.env.TGU_SESSION_TTL_DAYS = previousLegacy
  }
}

test('eval-116 with no env and no record, the default TTL applies', () => {
  withEnv(undefined, () => {
    assert.equal(effectiveTtlDays(null), DEFAULT_SESSION_TTL_DAYS)
    assert.equal(DEFAULT_SESSION_TTL_DAYS, 3, 'the documented default is 3 days')
  })
})

test('eval-117 a recorded TTL is used, and the environment overrides it', () => {
  const recorded = meta(new Date('2026-01-01T00:00:00Z'), 10)

  withEnv(undefined, () => {
    assert.equal(effectiveTtlDays(recorded), 10, 'the value written at login wins over the default')
  })
  withEnv('1', () => {
    // The escape hatch has to work without a re-login, or an operator locked
    // into a bad TTL has no way out except deleting files by hand.
    assert.equal(effectiveTtlDays(recorded), 1, 'the environment overrides the recorded value')
  })
})

test('eval-118 TG_SESSION_TTL_DAYS=0 disables expiry rather than expiring everything', () => {
  // The dangerous misreading: 0 days means "expired the instant it was made".
  // It means OFF, deliberately, so a long-running deployment has a switch.
  const ancient = meta(new Date('2020-01-01T00:00:00Z'), 3)
  const now = new Date('2026-01-01T00:00:00Z')

  for (const value of ['0', '-1']) {
    withEnv(value, () => {
      assert.equal(effectiveTtlDays(ancient), Number.parseInt(value, 10))
      assert.equal(isExpired(ancient, now), false, `TG_SESSION_TTL_DAYS=${value} means no expiry`)
    })
  }
})

test('eval-119 an unparseable env value falls back instead of disabling expiry', () => {
  // "off" is not 0. Silently treating junk as "disabled" would turn a typo into
  // a session that never expires, which is the failure this feature exists for.
  withEnv('soon', () => {
    assert.equal(effectiveTtlDays(null), DEFAULT_SESSION_TTL_DAYS)
    assert.equal(effectiveTtlDays(meta(new Date(), 7)), 7)
  })
})

test('eval-120 a workspace with no recorded creation time is never expired', () => {
  // Null meta is a workspace that predates this feature, not an infinitely old
  // one. Expiring it would log someone out on the first run after a version
  // bump, which is exactly the surprise this rule forbids.
  withEnv(undefined, () => {
    assert.equal(isExpired(null, new Date('2099-01-01T00:00:00Z')), false)
  })
})

test('eval-121 expiry is at the boundary: exactly at the TTL still counts as live', () => {
  withEnv(undefined, () => {
    const createdAt = new Date('2026-01-01T00:00:00Z')
    const record = meta(createdAt, 3)
    const at = (ms: number) => new Date(createdAt.getTime() + ms)

    assert.equal(isExpired(record, at(0)), false, 'a session made this instant is live')
    assert.equal(isExpired(record, at(3 * DAY - 1)), false, 'a millisecond short of the TTL')
    assert.equal(isExpired(record, at(3 * DAY)), false, 'exactly at the TTL is not yet past it')
    assert.equal(isExpired(record, at(3 * DAY + 1)), true, 'a millisecond over the TTL')
    assert.equal(isExpired(record, at(4 * DAY)), true, 'one day over')
  })
})

test('eval-122 a corrupt creation time reads as absent, never as expired', () => {
  withEnv(undefined, () => {
    const broken = { createdAt: 'last tuesday', ttlDays: 3 } satisfies SessionMeta
    assert.equal(isExpired(broken, new Date('2099-01-01T00:00:00Z')), false)
  })
})

test('eval-123 a round trip preserves the record, and the file is 0600', async () => {
  await withTempDir(() => {
    const path = join(process.cwd(), 'session-meta.json')
    const record = meta(new Date('2026-02-03T04:05:06Z'), 5)

    writeSessionMeta(record, path)
    assert.deepEqual(readSessionMeta(path), record)

    // It sits beside an auth key and says when that key was created; a
    // world-readable copy is a needless hint about this account.
    assert.equal(statSync(path).mode & 0o777, 0o600)
  })
})

test('eval-124 writeSessionMeta re-tightens a file that already existed with a loose mode', async () => {
  await withTempDir(() => {
    const path = join(process.cwd(), 'session-meta.json')
    writeFileSync(path, '{}\n', { encoding: 'utf-8', mode: 0o644 })

    // writeFileSync's mode applies only on CREATE, so without the explicit
    // chmod an existing 0644 file would silently stay 0644.
    writeSessionMeta(meta(new Date(), 3), path)
    assert.equal(statSync(path).mode & 0o777, 0o600)
  })
})

test('eval-125 missing, truncated or malformed records read as null and never throw', async () => {
  await withTempDir(() => {
    const path = join(process.cwd(), 'session-meta.json')
    assert.equal(readSessionMeta(path), null, 'a workspace that never logged in')

    for (const contents of [
      '',
      '{"createdAt": "2026-01-01T00:00:00Z", "ttlDa',
      '[]',
      'null',
      '{"ttlDays": 3}',
      '{"createdAt": "not a date", "ttlDays": 3}',
      '{"createdAt": "2026-01-01T00:00:00Z"}',
      '{"createdAt": "2026-01-01T00:00:00Z", "ttlDays": "3"}'
    ]) {
      writeFileSync(path, contents, 'utf-8')
      assert.equal(readSessionMeta(path), null, `read as null: ${contents || '(empty)'}`)
    }

    // A null read is what triggers a backfill, and a backfill restarts the
    // clock - so a corrupt file costs a few days of TTL, never a logout.
    writeSessionMeta(meta(new Date('2026-01-01T00:00:00Z'), 3), path)
    assert.equal(readSessionMeta(path)?.ttlDays, 3)
    assert.match(readFileSync(path, 'utf-8'), /"ttlDays": 3/)
  })
})

test('eval-126 a failed logout deletes nothing locally', async () => {
  // The session string is the only handle this tool has on a live
  // authorisation. Dropping it before Telegram confirmed the logout would
  // leave an authorisation nobody can name or terminate.
  const { expireSession } = await import('../src/session/index.js')
  const touched: string[] = []
  const effects = {
    resetCache: () => touched.push('resetCache'),
    forgetSecret: () => touched.push('forgetSecret'),
    removeMeta: () => touched.push('removeMeta')
  }

  await assert.rejects(
    () => expireSession(() => Promise.reject(new Error('NETWORK_MIGRATE')), effects),
    (error: unknown) => {
      assert.ok(error instanceof OperatorError)
      assert.equal(error.exitCode, EXIT.upstream, 'an unreachable Telegram is upstream, not a bug')
      assert.match(error.message, /Nothing was deleted locally/)
      return true
    }
  )
  assert.deepEqual(touched, [], 'no local trace may be removed before the server confirms')

  await expireSession(() => Promise.resolve(), effects)
  assert.deepEqual(touched, ['resetCache', 'forgetSecret', 'removeMeta'], 'and all of it goes after')
})

test('eval-127 a workspace with no record backfills instead of expiring', () => {
  // The first run after upgrading has no createdAt. Treating that as
  // infinitely old would log every existing workspace out on a version bump.
  const now = new Date('2026-05-05T00:00:00Z')
  assert.equal(isExpired(null, now), false)

  const next = metaForReuse(null, undefined, now)
  assert.deepEqual(next, { createdAt: now.toISOString(), ttlDays: DEFAULT_SESSION_TTL_DAYS })
})

test('eval-128 --ttl-days on a reused session changes the length, never the clock', () => {
  const createdAt = new Date('2026-01-01T00:00:00Z')
  const now = new Date('2026-01-02T00:00:00Z')
  const record = meta(createdAt, 3)

  const relengthened = metaForReuse(record, 30, now)
  assert.deepEqual(relengthened, { createdAt: record.createdAt, ttlDays: 30 })

  // Without --ttl-days there is nothing to record, so the file is left alone -
  // a rewrite would be a chance to lose the clock for no gain.
  assert.equal(metaForReuse(record, undefined, now), null)

  // A backfill takes the asked-for length too.
  assert.deepEqual(metaForReuse(null, 10, now), { createdAt: now.toISOString(), ttlDays: 10 })
})
