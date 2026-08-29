import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import chalk from 'chalk'
import type { Command } from 'commander'
import { openSession, resetLocalCache } from '../../session/index.js'
import { peerCacheStats, SESSION_DB_PATH } from '../../session/cache.js'
import { getOrCreateDbKey, readSecret, SECRETS } from '../../session/psst.js'
import { LOCK_PATH } from '../../session/lock.js'
import { loadConfig } from '../../config/index.js'
import { parseTtlDays } from './auth.js'
import { effectiveTtlDays, readSessionMeta } from '../../session/ttl.js'
import { OperatorError } from '../../errors.js'
import { runCommand, handlePlainError } from '../errors.js'
import { EXIT } from '../../exit-codes.js'
import { logSummary } from '../log.js'
import { canPrompt } from '../../session/index.js'
import {
  describeAge,
  forgetPhone,
  historyEnabled,
  maskPhone,
  phonesPath,
  readPhones
} from '../../phones/index.js'

/**
 * Short, non-reversible identifier for a session string.
 *
 * Printing the session itself would defeat the vault; a fingerprint still
 * answers the question that matters during a deploy - "is the session on this
 * machine the same one I exported from that machine?"
 */
function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

/**
 * Re-run this same CLI as a child process, carrying any tsx loader flags.
 *
 * A genuinely separate process is the point: it is the only way to show that
 * the peer cache outlives one client rather than one object in memory.
 */
function respawn(args: string[]): string {
  const entry = process.argv[1]
  if (entry === undefined) {
    throw new Error('cannot respawn: process.argv[1] is missing')
  }
  try {
    return execFileSync(process.execPath, [...process.execArgv, entry, ...args], {
      encoding: 'utf-8',
      // stderr inherited so the child's own diagnosis reaches the user directly.
      stdio: ['ignore', 'pipe', 'inherit']
    })
  } catch {
    // The child already explained itself above; repeating its full argv here
    // would bury that explanation under a wall of loader flags.
    throw new OperatorError(`Child run failed: ${args.join(' ')} (see the error above)`)
  }
}

interface ProbeReport {
  user: string
  source: string
  peersBefore: number
  peersAfter: number
  resolved: number
}

export function registerSessionCommand(program: Command): void {
  const session = program
    .command('session')
    .description('Manage the Telegram session stored in psst')
    .action(() => session.help())

  session
    .command('login')
    .description('Authenticate by hand and store the session string in psst')
    .option('--force', 'Discard the local cache and log in again')
    .option('--qr', 'Log in by scanning a QR code instead of typing a phone number, like linking a desktop device')
    .option('--ttl-days <n>', "Days before this workspace's session auto-expires (default 3; 0 disables)")
    .action(async (options: { force?: boolean; qr?: boolean; ttlDays?: string }) => {
      await runCommand(async () => {
        const ttlDays = parseTtlDays(options.ttlDays)

        if (options.force) resetLocalCache()

        const handle = await openSession({
          interactive: true,
          forceImport: options.force,
          qr: options.qr,
          ttlDays
        })
        try {
          const label = `${handle.user.firstName} ${handle.user.lastName ?? ''}`.trim()
          console.log(chalk.green(`\nLogged in as ${label} (@${handle.user.username ?? 'no username'})`))
          console.log(
            handle.source === 'login'
              ? `Session stored in psst as ${SECRETS.session}.`
              : `Existing session reused (source: ${handle.source}). Use --force to re-authenticate.`
          )
          console.log(chalk.dim('Deploy it elsewhere:  psst get TG_SESSION_STRING | psst set TG_SESSION_STRING --stdin'))
        } finally {
          await handle.close()
        }
      })
    })

  session
    .command('phones')
    .description('Numbers offered at login on this machine')
    .option('--forget <phone>', 'Remove one number, or "all"')
    .option('--reveal', 'Print numbers in full (requires a terminal)')
    .option('--json', 'Machine-readable output')
    .action(async (options: { forget?: string; reveal?: boolean; json?: boolean }) => {
      await runCommand(async () => {
        if (options.forget) {
          const removed = forgetPhone(options.forget)
          logSummary(
            removed === 0
              ? 'No stored number matched; nothing removed.'
              : `Forgot ${removed} number${removed === 1 ? '' : 's'}.`
          )
          return
        }

        // Masked unless a human explicitly asks and is there to read it. An
        // agent piping --json into a transcript should not be the way an
        // operator's phone numbers escape this machine.
        const reveal = Boolean(options.reveal) && canPrompt()
        if (options.reveal && !reveal) {
          throw new OperatorError(
            '--reveal needs an interactive terminal.\n' +
            '  These are personal numbers; an unattended run has no one to show them to.',
            EXIT.needsHuman
          )
        }

        const records = readPhones()
        const shown = records.map((record) => ({
          phone: reveal ? record.phone : maskPhone(record.phone),
          lastUsedAt: record.lastUsedAt,
          useCount: record.useCount
        }))

        if (options.json) {
          process.stdout.write(`${JSON.stringify(shown, null, 2)}\n`)
          return
        }

        if (!historyEnabled()) {
          console.log('Phone history is off (TG_NO_PHONE_HISTORY).')
          return
        }
        if (shown.length === 0) {
          console.log('No numbers remembered yet. The first login here will add one.')
          return
        }

        for (const record of shown) {
          console.log(
            `${record.phone.padEnd(18)}  last used ${describeAge(record.lastUsedAt).padEnd(10)}` +
            `  ${record.useCount} login${record.useCount === 1 ? '' : 's'}`
          )
        }
        console.log(
          chalk.dim(
            `\nStored at ${phonesPath()}, 0600.` +
            `${reveal ? '' : '  Use --reveal to see them in full.'}` +
            '\nForget one:  tg session phones --forget <number>   (or --forget all)'
          )
        )
      })
    })

  session
    .command('status')
    .description('Show session, peer cache and lock state without connecting')
    .option('--json', 'Machine-readable output')
    .action(async (options: { json?: boolean }) => {
      await runCommand(async () => {
        const vaultSession = readSecret(SECRETS.session)
        const cacheKey = readSecret(SECRETS.dbKey)
        const peers = cacheKey ? peerCacheStats(cacheKey) : { count: 0, lastUpdated: null }
        const config = loadConfig()
        const lockPid = existsSync(LOCK_PATH) ? readFileSync(LOCK_PATH, 'utf-8').trim() : null

        // No meta yet means this workspace has not logged in since TTLs shipped;
        // the next run backfills it rather than expiring anything.
        const meta = readSessionMeta()
        const ttlDays = meta ? effectiveTtlDays(meta) : null
        const expiresAt =
          meta && ttlDays !== null && ttlDays > 0
            ? new Date(Date.parse(meta.createdAt) + ttlDays * 86_400_000).toISOString()
            : null

        const report = {
          vaultSession: vaultSession ? fingerprint(vaultSession) : null,
          cacheKeyPresent: Boolean(cacheKey),
          apiCredentials: Boolean(readSecret(SECRETS.apiId) && readSecret(SECRETS.apiHash)),
          localCache: existsSync(SESSION_DB_PATH) ? SESSION_DB_PATH : null,
          peers: peers.count,
          peersLastUpdated: peers.lastUpdated,
          trackedFolders: config.trackedFolderIds.length,
          trackedChats: config.trackedChatIds.length,
          lockedByPid: lockPid,
          sessionCreatedAt: meta?.createdAt ?? null,
          sessionTtlDays: ttlDays,
          sessionExpiresAt: expiresAt
        }

        if (options.json) {
          console.log(JSON.stringify(report, null, 2))
          return
        }

        const yes = (v: boolean) => (v ? chalk.green('yes') : chalk.red('no'))
        console.log(chalk.cyan('Session'))
        console.log(`  vault session      ${report.vaultSession ? chalk.green(report.vaultSession) : chalk.red('absent')}`)
        console.log(`  cache key in vault ${yes(report.cacheKeyPresent)}`)
        console.log(`  api credentials    ${yes(report.apiCredentials)}`)
        console.log(`  session created    ${report.sessionCreatedAt ?? chalk.dim('unrecorded (set on next run)')}`)
        console.log(
          `  session ttl        ${
            report.sessionTtlDays === null
              ? chalk.dim('unset (default 3 days)')
              : report.sessionTtlDays <= 0
                ? chalk.yellow('disabled (no auto-expiry)')
                : `${report.sessionTtlDays} day${report.sessionTtlDays === 1 ? '' : 's'}`
          }`
        )
        console.log(`  session expires    ${report.sessionExpiresAt ?? chalk.dim('never')}`)
        console.log(chalk.cyan('Local cache'))
        console.log(`  file               ${report.localCache ?? chalk.dim('none')}`)
        console.log(`  cached peers       ${report.peers}`)
        console.log(`  peers updated      ${report.peersLastUpdated ?? chalk.dim('never')}`)
        console.log(chalk.cyan('Export config'))
        console.log(`  tracked folders    ${report.trackedFolders}`)
        console.log(`  tracked chats      ${report.trackedChats}`)
        console.log(`  lock               ${report.lockedByPid ? chalk.yellow(`held by pid ${report.lockedByPid}`) : chalk.dim('free')}`)
      })
    })

  session
    .command('probe')
    .description('One authenticated run that reports peer cache counts as JSON')
    .option('--resolve <n>', 'How many tracked chats to resolve', '5')
    .action(async (options: { resolve: string }) => {
      // handlePlainError: stdout must stay parseable JSON for `session verify`.
      await runCommand(async () => {
        const limit = Number.parseInt(options.resolve, 10)
        if (!Number.isFinite(limit) || limit < 0) {
          throw new Error('--resolve must be a non-negative integer')
        }

        // Counted before openSession connects, so this reflects only what an
        // earlier, already-finished process left behind.
        const peersBefore = peerCacheStats(getOrCreateDbKey()).count

        const handle = await openSession({ interactive: false })
        let resolved = 0
        try {
          const config = loadConfig()
          for (const chatId of config.trackedChatIds.slice(0, limit)) {
            try {
              await handle.tg.getPeer(chatId)
              resolved++
            } catch {
              // A chat we can no longer see must not fail the probe.
            }
          }
        } finally {
          await handle.close()
        }

        const report: ProbeReport = {
          user: handle.user.username ?? String(handle.user.id),
          source: handle.source,
          peersBefore,
          peersAfter: peerCacheStats(getOrCreateDbKey()).count,
          resolved
        }
        console.log(JSON.stringify(report))
      }, handlePlainError)
    })

  session
    .command('verify')
    .description('Prove the peer cache survives across independent client runs')
    .action(async () => {
      await runCommand(async () => {
        console.log(chalk.cyan('Verifying peer persistence across independent runs\n'))

        // This command holds no lock of its own: each child takes and releases
        // it in turn, which also demonstrates the lock does not deadlock a
        // sequence of runs.
        console.log(chalk.dim('run 1: connecting and resolving peers...'))
        const first = JSON.parse(respawn(['session', 'probe']).trim()) as ProbeReport
        console.log(`  peers ${first.peersBefore} -> ${first.peersAfter} (resolved ${first.resolved})`)

        console.log(chalk.dim('run 2: fresh process, reading cache before connecting...'))
        const second = JSON.parse(respawn(['session', 'probe']).trim()) as ProbeReport
        console.log(`  peers ${second.peersBefore} -> ${second.peersAfter} (source: ${second.source})`)

        const checks: [string, boolean, string][] = [
          [
            'run 2 saw run 1\'s peers before opening a connection',
            second.peersBefore >= first.peersAfter && second.peersBefore > 0,
            `expected >= ${first.peersAfter} and > 0, got ${second.peersBefore}`
          ],
          [
            'run 2 reused the cached session rather than re-importing',
            second.source === 'cache',
            `source was ${second.source}`
          ],
          [
            'both runs authenticated as the same user',
            first.user === second.user,
            `${first.user} vs ${second.user}`
          ]
        ]

        console.log('')
        let failed = 0
        for (const [name, ok, detail] of checks) {
          console.log(`  ${ok ? chalk.green('PASS') : chalk.red('FAIL')}  ${name}`)
          if (!ok) {
            console.log(chalk.red(`        ${detail}`))
            failed++
          }
        }

        if (failed > 0) {
          throw new OperatorError(`${failed} of ${checks.length} peer-persistence checks failed`)
        }
        console.log(chalk.green('\nPeer list is maintained across client-independent runs.'))
      })
    })
}
