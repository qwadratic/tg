import chalk from 'chalk'
import type { Command } from 'commander'
import { MEDIA_KINDS } from '../../media/index.js'
import { watchForMedia } from '../../watch/index.js'
import { runCommand } from '../errors.js'
import { OperatorError } from '../../errors.js'
import { parsePeerRef } from '../../peers/ref.js'
import { resolveTarget, withAuthenticatedClient } from './shared.js'

/**
 * `tg watch` - wait for media that has not been sent yet.
 *
 * Holds the single-instance lock for its whole run, which can be 45 minutes, so
 * no export can run concurrently. That is the correct trade: two clients on one
 * auth key is the failure this lock exists to prevent.
 */
export function registerWatchCommand(program: Command): void {
  program
    .command('watch [peer]')
    .description('Wait for new media in a chat (default: your Saved Messages) and download it')
    .option('--to <dir>', 'Destination directory', 'media')
    .option('--kind <kinds>', `Comma-separated: ${MEDIA_KINDS.join(', ')}`)
    .option('--minutes <n>', 'Give up after this long', '45')
    .option('--interval <seconds>', 'Seconds between polls', '15')
    .option('--max <n>', 'Stop after this many files', '1')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string | undefined, options: { to: string; kind?: string; minutes: string; interval: string; max: string; json?: boolean }) => {
      await runCommand(async () => {
        const minutes = Number.parseInt(options.minutes, 10)
        const interval = Number.parseInt(options.interval, 10)
        if (!Number.isFinite(minutes) || minutes <= 0) {
          throw new OperatorError(`--minutes must be a positive number, got ${options.minutes}`)
        }
        if (!Number.isFinite(interval) || interval < 5) {
          throw new OperatorError('--interval must be at least 5 seconds; polling faster than that is what draws rate limits')
        }

        const kinds = options.kind
          ? options.kind.split(',').map((k: string) => k.trim().toLowerCase()).filter(Boolean)
          : []

        // Shape-checked before the session: this command then holds the lock for
        // up to 45 minutes, so failing on a typo afterwards would be expensive.
        if (peer) parsePeerRef(peer)

        const files = await withAuthenticatedClient(async (tg) => {
          const id = await resolveTarget(tg, peer, 'watching')

          // Progress goes to stderr so --json stdout stays a clean payload.
          // resolveTarget already named the chat; this adds the terms of the wait.
          console.error(
            chalk.cyan(`waiting for new media -> ${options.to} (giving up in ${minutes}m)`)
          )
          console.error(
            chalk.dim(`only messages posted after ${new Date().toISOString()} are eligible`)
          )

          return watchForMedia(tg, id, {
            destDir: options.to,
            kinds,
            timeoutMinutes: minutes,
            intervalSeconds: interval,
            max: Number.parseInt(options.max, 10),
            onFile: (file) => console.error(chalk.green(`  got ${file.path}`)),
            onPoll: (attempt) => {
              if (attempt % 4 === 0) console.error(chalk.dim(`  still waiting (poll ${attempt})`))
            }
          })
        })

        if (options.json) {
          process.stdout.write(`${JSON.stringify(files, null, 2)}\n`)
          return
        }

        if (files.length === 0) {
          // Exit 1: a timeout is a failed wait, and a script needs to know.
          throw new OperatorError('Timed out with no new media.')
        }
        for (const file of files) process.stdout.write(`${file.path}\n`)
      })
    })
}
