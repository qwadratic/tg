import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { OperatorError } from '../errors.js'

/**
 * Secret names in the psst vault.
 *
 * - `session`  portable Telegram auth (auth key + DC + self). Deploy this to another machine.
 * - `dbKey`    encrypts the LOCAL cache at data/session.db. Machine-local, regenerable.
 * - `apiId` / `apiHash`  Telegram app credentials.
 */
export const SECRETS = {
  session: 'TG_SESSION_STRING',
  dbKey: 'TG_SESSION_DB_KEY',
  apiId: 'API_ID',
  apiHash: 'API_HASH'
} as const

/**
 * Alternative names accepted for a secret.
 *
 * Telegram app credentials are commonly kept under a TG_ prefix in a shared
 * global vault. Reading that name directly beats copying the value into this
 * project's vault, because a duplicated secret is one that rotation forgets.
 */
const ALIASES: Record<string, string[]> = {
  [SECRETS.apiId]: ['TG_API_ID'],
  [SECRETS.apiHash]: ['TG_API_HASH']
}

/**
 * Per-process memo. Resolving one secret can cost up to four `psst`
 * subprocesses (two names x local/global), and a single command resolves four
 * secrets, so without this every run pays seconds of pure process spawn.
 */
const cache = new Map<string, string | null>()

function psstGet(name: string, global: boolean): string | null {
  try {
    const out = execFileSync('psst', global ? ['-g', 'get', name] : ['get', name], {
      encoding: 'utf-8',
      // stderr silenced: `psst get` prints "not found" there and exits 2, which
      // is a normal "no secret yet" outcome rather than an error worth showing.
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return out.trim() || null
  } catch {
    // Missing secret, missing vault, or psst not installed - all mean "no value".
    return null
  }
}

/**
 * Is the `psst` binary on PATH?
 *
 * Memoised: this is asked on an error path that may run after several failed
 * lookups, and each check costs a process spawn.
 *
 * Matters because `tg` is installed globally with npm, and psst is a separate
 * Rust binary npm knows nothing about. Distinguishing "no secret" from "no
 * secret store" is the difference between an actionable message and a wrong one.
 */
let psstPresent: boolean | null = null

export function psstAvailable(): boolean {
  if (psstPresent !== null) return psstPresent

  try {
    execFileSync('psst', ['--version'], { stdio: 'ignore' })
    psstPresent = true
  } catch {
    psstPresent = false
  }
  return psstPresent
}

/**
 * Read a secret. Precedence, first hit wins:
 *   1. process.env  - injected by `psst run`, `psst NAME -- cmd`, a .env file, or CI
 *   2. the local vault (./.psst)   - project-specific values
 *   3. the global vault (~/.psst)  - shared values such as API credentials
 *
 * Returns null when unavailable anywhere; callers decide whether that is fatal.
 */
export function readSecret(name: string): string | null {
  const cached = cache.get(name)
  if (cached !== undefined) return cached

  const candidates = [name, ...(ALIASES[name] ?? [])]

  let value: string | null = null
  for (const candidate of candidates) {
    const injected = process.env[candidate]
    if (injected && injected.trim()) {
      value = injected.trim()
      break
    }
  }

  if (value === null) {
    outer: for (const global of [false, true]) {
      for (const candidate of candidates) {
        const found = psstGet(candidate, global)
        if (found) {
          value = found
          break outer
        }
      }
    }
  }

  cache.set(name, value)
  return value
}

/**
 * Write a secret to the local psst vault.
 *
 * The value is piped over stdin rather than passed as an argv element, so it
 * never appears in `ps` output or a shell history file.
 */
export function writeSecret(name: string, value: string): void {
  try {
    execFileSync('psst', ['set', name, '--stdin'], {
      input: value,
      stdio: ['pipe', 'ignore', 'inherit']
    })
    cache.set(name, value)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new OperatorError(
      `Could not store ${name} in psst (${detail}).\n` +
      `  Initialise a vault in this directory:  psst init\n` +
      `  Or inject the value directly:  ${name}=... tg ...`
    )
  }
}

/**
 * Remove a secret from the local vault. Best effort, and deliberately so.
 *
 * The only caller has already ended the session server-side, so the value here
 * is dead either way; failing the run because a vault write did not take would
 * leave the operator with an error and nothing to do about it.
 *
 * The in-memory memo is cleared too, or a later readSecret() in this same
 * process would hand back the credential that was just deleted.
 */
export function deleteSecret(name: string): void {
  try {
    execFileSync('psst', ['rm', name], { stdio: 'ignore' })
  } catch {
    // No vault, no such secret, no psst - all mean "it is not there", which is
    // the outcome asked for.
  }
  cache.delete(name)
}

/**
 * Encryption key for the local peer cache, created on first use.
 *
 * A random key stored in the vault replaces the old interactive password
 * prompt: the cache stays encrypted at rest, but no human has to type anything,
 * which is what makes unattended and agent-driven runs possible.
 */
export function getOrCreateDbKey(): string {
  const existing = readSecret(SECRETS.dbKey)
  if (existing) return existing

  const key = randomBytes(32).toString('base64url')
  writeSecret(SECRETS.dbKey, key)
  return key
}
