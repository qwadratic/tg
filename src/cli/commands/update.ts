import chalk from 'chalk'
import type { Command } from 'commander'
import { runUpdateCheck } from '../../update/index.js'
import { runCommand } from '../errors.js'

/**
 * `tg update` - check the registry and install a newer version.
 *
 * Also the worker the background check runs as. The hidden
 * `--background-update-check` flag is what the detached child passes; in that
 * mode the command is silent, because nobody is attached to read it.
 */
export function registerUpdateCommand(program: Command, currentVersion: string): void {
  program
    .command('update')
    .description('Check for a newer version of tg and install it')
    .option('--check', 'Report whether an update exists; install nothing')
    .option('--background-update-check', 'Internal: run silently as the detached checker', false)
    .action(async (options: { check?: boolean; backgroundUpdateCheck: boolean }) => {
      const background = Boolean(options.backgroundUpdateCheck)

      await runCommand(async () => {
        const outcome = await runUpdateCheck(currentVersion, {
          // An explicit `tg update` should not wait for the daily interval.
          force: !background,
          install: !options.check
        })

        if (background) return

        if (outcome.skipped === 'not-a-global-install') {
          console.log(
            'Not a global install, so there is nothing to update.\n' +
            '  This looks like a git checkout; update it with git.'
          )
          return
        }
        if (outcome.skipped === 'disabled') {
          console.log('Updates are disabled here (TG_NO_UPDATE=1).')
          return
        }
        if (outcome.skipped === 'ci') {
          console.log('Updates are skipped in CI, so builds stay reproducible.')
          return
        }

        if (!outcome.latest) {
          console.log('Could not reach the npm registry. Nothing changed.')
          return
        }
        if (outcome.latest === outcome.current) {
          console.log(chalk.green(`tg ${outcome.current} is the latest version.`))
          return
        }
        if (options.check) {
          console.log(`tg ${outcome.latest} is available (you have ${outcome.current}).`)
          return
        }
        if (outcome.updated) {
          // Naming the prefix is not decoration. An update that silently landed
          // in a DIFFERENT npm prefix is the bug this feature shipped with:
          // npm exited 0, the CLI said "Updated", and the binary on PATH never
          // moved. Printing the directory makes that visible at a glance.
          const where = outcome.prefix ? ` in ${outcome.prefix}` : ''
          console.log(
            chalk.green(`Updated to tg ${outcome.latest}${where}.`) +
            ' It applies to the next command.'
          )
          return
        }

        console.log(
          chalk.yellow(`Could not install tg ${outcome.latest} automatically.`) +
          '\n  Run it yourself:  npm install -g @qwadratic/tg@latest' +
          '\n  A global install often needs elevated permissions.'
        )
      })
    })
}
