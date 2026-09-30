import assert from 'node:assert'
import test from 'node:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { cacheOpensWith, quarantineCache } from '../src/session/cache.js'
import { classifyPsstFailure, getOrCreateDbKey, lastVaultProblem, vaultProblemFix, vaultProblemHint } from '../src/session/psst.js'
import { OperatorError } from '../src/errors.js'

/**
 * A locked or mis-keyed psst vault used to look exactly like an empty one:
 * "API_ID and API_HASH are not set", and getOrCreateDbKey() minted a new cache
 * key over the unreadable one, after which every run died with "Invalid session
 * password" because data/session.db was encrypted with the old key.
 */

test('classifyPsstFailure: only unlock/decrypt failures are problems', () => {
  assert.strictEqual(classifyPsstFailure(2), null, 'not_found is just "no value"')
  assert.strictEqual(classifyPsstFailure(3), null, 'no_vault is just "no value"')
  assert.strictEqual(classifyPsstFailure(null), null, 'no exit status: psst not installed')
  assert.strictEqual(classifyPsstFailure(undefined), null)
  assert.strictEqual(classifyPsstFailure(5), 'unlock_failed')
  assert.strictEqual(classifyPsstFailure(1), 'decrypt_failed', 'wrong password: "Fatal error: The operation failed ..."')
  // `#!/usr/bin/env bun` with no bun on PATH: env exits 127. Not a wrong password.
  assert.strictEqual(classifyPsstFailure(127), 'psst_unrunnable')
  assert.strictEqual(classifyPsstFailure(126), 'psst_unrunnable')
})

test('vaultProblemHint/Fix: says which problem it is, and the fix matches', () => {
  assert.match(vaultProblemHint('unlock_failed'), /PSST_PASSWORD/)
  assert.match(vaultProblemHint('decrypt_failed'), /not this vault's password/)
  assert.match(vaultProblemHint('psst_unrunnable'), /bun, is not on PATH/)
  assert.match(vaultProblemFix('decrypt_failed'), /PSST_PASSWORD/)
  assert.match(vaultProblemFix('psst_unrunnable'), /PATH=/)
  assert.doesNotMatch(vaultProblemFix('psst_unrunnable'), /PSST_PASSWORD/, 'a password will not start psst')
})

function makeCache(path: string, key: string) {
  const db = new Database(path)
  db.pragma(`key='${key}'`)
  db.exec('CREATE TABLE t (x INTEGER)')
  db.close()
}

test('cacheOpensWith: its own key opens, another key does not, no file is fine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-cache-'))
  try {
    const path = join(dir, 'session.db')
    assert.strictEqual(cacheOpensWith('any', path), true, 'nothing to open is not a failure')
    makeCache(path, 'key-a')
    assert.strictEqual(cacheOpensWith('key-a', path), true)
    assert.strictEqual(cacheOpensWith('key-b', path), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('quarantineCache: moves the cache and its -wal aside, deletes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-cache-'))
  try {
    const path = join(dir, 'session.db')
    makeCache(path, 'key-a')
    writeFileSync(`${path}-wal`, 'wal')
    const target = quarantineCache(path, new Date('2026-09-30T21:00:00.000Z'))
    assert.strictEqual(target, `${path}.orphaned-2026-09-30T21-00-00-000Z`)
    assert.strictEqual(existsSync(path), false)
    assert.strictEqual(existsSync(`${path}-wal`), false)
    assert.strictEqual(existsSync(target), true)
    assert.strictEqual(readFileSync(`${target}-wal`, 'utf-8'), 'wal')
    assert.strictEqual(cacheOpensWith('key-a', target), true, 'the moved file is intact')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('getOrCreateDbKey: a vault that will not decrypt is not treated as "no key"', () => {
  // A fake psst on PATH: `get` fails the way a wrong PSST_PASSWORD does, and
  // every call is logged so we can prove no `set` overwrote anything.
  const dir = mkdtempSync(join(tmpdir(), 'tg-fake-psst-'))
  const log = join(dir, 'calls.log')
  writeFileSync(
    join(dir, 'psst'),
    `#!/bin/sh\necho "$@" >> "${log}"\ncase "$1" in\n  get) echo "Fatal error: The operation failed for an operation-specific reason" >&2; exit 1;;\nesac\nexit 0\n`
  )
  chmodSync(join(dir, 'psst'), 0o755)
  const before = { path: process.env.PATH, key: process.env.TG_SESSION_DB_KEY }
  process.env.PATH = `${dir}:${before.path ?? ''}`
  delete process.env.TG_SESSION_DB_KEY
  try {
    assert.throws(() => getOrCreateDbKey(), (error: unknown) =>
      error instanceof OperatorError && /Not creating a new cache key/.test(error.message) && /PSST_PASSWORD/.test(error.message)
    )
    assert.strictEqual(lastVaultProblem(), 'decrypt_failed')
    const calls = readFileSync(log, 'utf-8')
    assert.doesNotMatch(calls, /^set /m, 'the unreadable key must not be overwritten')
  } finally {
    process.env.PATH = before.path
    if (before.key !== undefined) process.env.TG_SESSION_DB_KEY = before.key
    rmSync(dir, { recursive: true, force: true })
  }
})
