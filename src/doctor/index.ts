import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { ARCHIVE_DIR, DATA_DIR, LOCK_PATH, SESSION_DB_PATH } from '../paths.js'
import { peerCacheStats } from '../session/cache.js'
import { lastVaultProblem, psstAvailable, readSecret, SECRETS, vaultProblemHint } from '../session/psst.js'
import { EXIT } from '../exit-codes.js'

/**
 * Answer one question: will an unattended run work right now?
 *
 * This is the most-evidenced pain in the whole corpus. Auth failing mid-task
 * appears 15 times across 5 separate days spanning four months, and every
 * occurrence ends the same way - the agent stalls and a human has to notice:
 *
 *   "if you cannot login to telegram, let me know. I will rerun the
 *    authorization."                                          2026-08-17
 *   "tg unblocked, lets replan wf accordingly."                2026-08-17
 *   "try telegram again?"                                      2026-08-13
 *
 * `session status` already reports what is ON DISK. That is not the same
 * question. A cache can exist, a vault entry can exist, and the auth key can
 * still have been revoked from another device an hour ago. Only the server
 * knows, so the liveness check costs one authenticated round trip - and it is
 * the whole point, so it is not optional unless the caller says `--offline`.
 *
 * The output is built for the caller who is not a person: a stable JSON
 * envelope and an exit code that says what to DO, so an orchestrator can
 * surface one actionable request instead of a stack trace.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail'

export interface Check {
  name: string
  status: CheckStatus
  detail: string
  /** What to run, when there is something to run. */
  fix?: string | undefined
}

export interface DoctorReport {
  ok: boolean
  /** Machine-readable outcome, stable across versions. */
  status: 'ready' | 'needs_human_login' | 'not_configured' | 'busy' | 'unknown'
  workspace: string
  checks: Check[]
  /** The single next action, when there is one. */
  hint?: string | undefined
  exitCode: number
}

/** Everything answerable without opening a socket. */
export function offlineChecks(): Check[] {
  const checks: Check[] = []

  checks.push(
    psstAvailable()
      ? { name: 'psst', status: 'ok', detail: 'on PATH' }
      : {
          name: 'psst',
          status: 'warn',
          detail: 'not installed; secrets must come from the environment',
          fix: 'https://github.com/vpetrigo/psst'
        }
  )

  const apiId = readSecret(SECRETS.apiId)
  const apiHash = readSecret(SECRETS.apiHash)
  checks.push(
    apiId && apiHash
      ? { name: 'api-credentials', status: 'ok', detail: 'API_ID and API_HASH resolve' }
      : lastVaultProblem()
        ? {
            // The names may well be in the vault; it just would not open.
            name: 'api-credentials',
            status: 'fail',
            detail: `not readable: ${vaultProblemHint(lastVaultProblem()!)}`,
            fix: 'export PSST_PASSWORD=... (this vault\'s password), or run under: psst run tg ...'
          }
        : {
            name: 'api-credentials',
            status: 'fail',
            detail: `missing ${!apiId ? 'API_ID' : ''}${!apiId && !apiHash ? ' and ' : ''}${!apiHash ? 'API_HASH' : ''}`,
            fix: 'psst set API_ID && psst set API_HASH, or pass them in the environment'
          }
  )

  const vaultSession = readSecret(SECRETS.session)
  const hasCache = existsSync(SESSION_DB_PATH)
  checks.push(
    vaultSession || hasCache
      ? {
          name: 'session',
          status: 'ok',
          detail: [vaultSession ? 'vault' : null, hasCache ? 'local cache' : null]
            .filter(Boolean)
            .join(' + ')
        }
      : {
          name: 'session',
          status: 'fail',
          detail: 'no session in the vault and no local cache',
          fix: 'tg session login'
        }
  )

  // Peers are why the cache exists. An empty one is not broken, but it does
  // mean the next run re-resolves every chat and burns rate limit doing it.
  if (hasCache) {
    try {
      const dbKey = readSecret(SECRETS.dbKey)
      const stats = dbKey ? peerCacheStats(dbKey) : { count: 0, lastUpdated: null }
      checks.push({
        name: 'peer-cache',
        status: stats.count > 0 ? 'ok' : 'warn',
        detail: stats.count > 0
          ? `${stats.count} peers, newest ${stats.lastUpdated ?? 'unknown'}`
          : 'empty; the next run re-resolves every chat'
      })
    } catch (error) {
      checks.push({
        name: 'peer-cache',
        status: 'warn',
        detail: `unreadable (${error instanceof Error ? error.message : String(error)})`
      })
    }
  }

  // A lock held by a live process is not a fault; it is another run working.
  if (existsSync(LOCK_PATH)) {
    let pid: number
    try {
      pid = Number(readFileSync(LOCK_PATH, 'utf-8').trim())
    } catch {
      pid = 0
    }
    let alive = false
    if (pid) {
      try {
        process.kill(pid, 0)
        alive = true
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code === 'EPERM'
      }
    }
    checks.push(
      alive
        ? { name: 'lock', status: 'warn', detail: `held by pid ${pid}; another run is working` }
        : { name: 'lock', status: 'ok', detail: 'stale lock present; the next run reclaims it' }
    )
  } else {
    checks.push({ name: 'lock', status: 'ok', detail: 'free' })
  }

  // The archive is real private messages. If it is group- or world-readable,
  // say so here rather than letting it sit unnoticed for months, which is
  // exactly what happened before 0.3.7.
  for (const [name, path] of [['data-dir', DATA_DIR], ['archive', ARCHIVE_DIR]] as const) {
    if (!existsSync(path)) continue
    const mode = statSync(path).mode & 0o777
    checks.push(
      mode === 0o700
        ? { name: `${name}-permissions`, status: 'ok', detail: '0700' }
        : {
            name: `${name}-permissions`,
            status: 'warn',
            detail: `${mode.toString(8).padStart(3, '0')}, readable beyond you`,
            fix: `chmod 700 ${path}`
          }
    )
  }

  return checks
}

/** Turn the check list into the one thing the caller must do. */
export function summarise(checks: Check[], workspace: string): DoctorReport {
  const failed = checks.filter((c) => c.status === 'fail')
  const sessionFailed = failed.some((c) => c.name === 'session' || c.name === 'liveness')
  const busy = checks.some((c) => c.name === 'lock' && c.status === 'warn' && c.detail.includes('pid'))

  if (sessionFailed) {
    return {
      ok: false,
      status: 'needs_human_login',
      workspace,
      checks,
      hint: 'tg session login',
      exitCode: EXIT.needsHuman
    }
  }
  const [firstFailed] = failed
  if (firstFailed) {
    return {
      ok: false,
      status: 'not_configured',
      workspace,
      checks,
      hint: firstFailed.fix,
      exitCode: EXIT.notConfigured
    }
  }
  if (busy) {
    return { ok: true, status: 'busy', workspace, checks, exitCode: EXIT.ok }
  }
  return { ok: true, status: 'ready', workspace, checks, exitCode: EXIT.ok }
}

/** Render for a human. Pure, so a golden pins it. */
export function renderReport(report: DoctorReport): string {
  const glyph = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' } as const
  const width = Math.max(...report.checks.map((c) => c.name.length))

  const lines = report.checks.map(
    (c) => `  ${glyph[c.status]}  ${c.name.padEnd(width)}  ${c.detail}` +
      (c.fix && c.status !== 'ok' ? `\n        -> ${c.fix}` : '')
  )

  const verdict = report.ok
    ? report.status === 'busy'
      ? 'Ready, but another run holds the lock.'
      : 'Ready. Unattended runs will work.'
    : report.status === 'needs_human_login'
      ? 'NOT ready: a human has to log in at a terminal.'
      : 'NOT ready: configuration is missing.'

  return `${report.workspace}\n${lines.join('\n')}\n\n${verdict}\n` +
    (report.hint ? `Next:  ${report.hint}\n` : '')
}

export function workspaceLabel(): string {
  return resolve(DATA_DIR)
}
