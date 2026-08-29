import chalk from 'chalk'
import type { Command } from 'commander'
import {
  offlineChecks,
  renderReport,
  summarise,
  workspaceLabel,
  type Check
} from '../../doctor/index.js'
import { withAuthenticatedClient } from './shared.js'
import { runCommand } from '../errors.js'

/**
 * `tg doctor` - will an unattended run work right now?
 *
 * Runs the offline checks, then ONE authenticated round trip to ask the server
 * whether the auth key is still valid. That last part is the whole point: a
 * session can look perfect on disk and have been revoked from another device.
 * `--offline` skips it for a fast, socket-free answer.
 */
export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check whether unattended runs will work, and say what to fix')
    .option('--offline', 'Skip the liveness probe; touch no network')
    .option('--json', 'Machine-readable output')
    .action(async (options: { offline?: boolean; json?: boolean }) => {
      await runCommand(async () => {
        const checks: Check[] = offlineChecks()

        // Only probe when the offline checks found a session to probe WITH.
        const haveSession = checks.some((c) => c.name === 'session' && c.status === 'ok')
        if (!options.offline && haveSession) {
          try {
            const me = await withAuthenticatedClient(async (tg) => tg.getMe())
            checks.push({
              name: 'liveness',
              status: 'ok',
              detail: `authorised as ${me.displayName ?? me.id}`
            })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            // A held lock is not a dead session; it is another run working, and
            // saying "log in again" there would send the operator to fix a
            // thing that is not broken.
            const busy = /already running/i.test(message)
            checks.push({
              name: busy ? 'lock' : 'liveness',
              status: busy ? 'warn' : 'fail',
              detail: busy ? 'another run holds the lock, so liveness went unchecked' : message,
              fix: busy ? undefined : 'tg session login'
            })
          }
        } else if (!options.offline) {
          checks.push({
            name: 'liveness',
            status: 'fail',
            detail: 'not checked: there is no session to check',
            fix: 'tg session login'
          })
        }

        const report = summarise(checks, workspaceLabel())

        if (options.json) {
          process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
        } else {
          const text = renderReport(report)
          process.stdout.write(report.ok ? text : chalk.yellow(text))
        }

        // The exit code IS the answer for a caller that is not a person.
        if (report.exitCode !== 0) process.exit(report.exitCode)
      })
    })
}
