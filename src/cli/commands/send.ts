import { confirm, isCancel } from '@clack/prompts'
import chalk from 'chalk'
import type { Command } from 'commander'
import type { TelegramClient } from '@mtcute/node'
import {
  deleteMessages,
  editMessageText,
  forwardMessage,
  markRead,
  sendMedia,
  sendNote,
  sendText,
  type SentRecord
} from '../../send/index.js'
import {
  assertConfirmed,
  MAX_SENDS_PER_DAY,
  MAX_SENDS_PER_RUN,
  readSendLog,
  sendsToday
} from '../../send/gate.js'
import { describePeer, parsePeerRef, resolvePeerRef, type ResolvedPeer } from '../../peers/ref.js'
import { runCommand } from '../errors.js'
import { OperatorError } from '../../errors.js'
import { canPrompt } from '../../session/index.js'
import { logSummary } from '../log.js'
import { withAuthenticatedClient } from './shared.js'

/**
 * `tg send` - the only commands that write to Telegram.
 *
 * Every one of them is human-invoked. Nothing in the export, folders, ship or
 * read-verb import graphs reaches this file, and `test/trust.test.ts` fails the
 * suite if that ever stops being true.
 */

/**
 * Show exactly who the message is going to, and require a yes.
 *
 * This is now the PRIMARY guard, not a courtesy. Sends accept an @username as
 * well as an id (D17), which means a mistyped or lookalike handle resolves to a
 * real stranger rather than failing. Nothing downstream can catch that - so the
 * defence is showing the resolved identity, in full, before anything is sent:
 * display name, @handle and numeric id together.
 *
 * Skipped by `--yes`, which is the caller taking that responsibility on the
 * record, and unavailable to a run with nobody to ask.
 */
async function confirmRecipient(
  target: ResolvedPeer,
  what: string,
  yes: boolean
): Promise<boolean> {
  if (yes || !canPrompt()) return true

  console.log(chalk.yellow(`\nAbout to send ${what} to ${chalk.bold(describePeer(target))}`))

  // Typing an id and typing a handle carry different risks, so say which one
  // this was: a handle was resolved by Telegram, an id was taken at face value.
  if (target.ref.kind === 'username') {
    console.log(
      chalk.dim(`  resolved from ${target.ref.raw} - check the name is who you meant`)
    )
  }

  const ok = await confirm({ message: 'Send it?' })
  if (isCancel(ok) || !ok) {
    console.log('Cancelled. Nothing was sent.')
    return false
  }
  return true
}

function report(record: SentRecord, json = false): void {
  // --json writes only the payload to stdout; the human lines are the else.
  if (json) {
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`)
    return
  }
  if (record.kind === 'delete') {
    logSummary(`deleted ${record.size} message(s) in ${record.peerId}`)
    return
  }
  if (record.kind === 'read') {
    logSummary(`marked ${record.peerId} as read`)
    return
  }
  logSummary(`sent ${record.kind} to ${record.peerId} as message ${record.messageId}`)
}

export function registerSendCommand(program: Command): void {
  const send = program
    .command('send')
    .description('Send a message or file to a chat (human-invoked only)')
    .action(() => send.help())

  send
    .command('text <peer> <text>')
    .description('Send a text message (id, @username or t.me link)')
    .option('--yes', 'Skip the recipient confirmation; required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, text: string, options) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        assertConfirmed(options)
        await withAuthenticatedClient(async (tg) => {
          const target = await resolvePeerRef(tg, peer)
          if (!(await confirmRecipient(target, 'a text message', Boolean(options.yes)))) return
          report(await sendText(tg, target.id, text, { yes: options.yes }), Boolean(options.json))
        })
      })
    })

  send
    .command('media <peer> <file>')
    .description('Send a file (id, @username or t.me link)')
    .option('--caption <text>', 'Caption for the file')
    .option('--mime <type>', 'Override the detected mime type')
    .option('--yes', 'Skip the recipient confirmation; required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, file: string, options) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        assertConfirmed(options)
        await withAuthenticatedClient(async (tg) => {
          const target = await resolvePeerRef(tg, peer)
          if (!(await confirmRecipient(target, `the file ${file}`, Boolean(options.yes)))) return
          report(
            await sendMedia(tg, target.id, file, {
              caption: options.caption,
              mime: options.mime,
              yes: options.yes
            }),
            Boolean(options.json)
          )
        })
      })
    })

  send
    .command('rm <peer> <ids...>')
    .description('Delete messages you sent, for everyone (id, @username or t.me link)')
    .option('--yes', 'Skip the confirmation; required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, ids: string[], options) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        assertConfirmed(options)

        const messageIds = ids.map((raw) => {
          const id = Number(raw)
          if (!Number.isInteger(id) || id <= 0) {
            throw new OperatorError(`Not a message id: ${raw}. Ids are positive integers.`)
          }
          return id
        })

        await withAuthenticatedClient(async (tg) => {
          const target = await resolvePeerRef(tg, peer)
          // Deleting is irreversible and ids are per-chat, so name the chat.
          const what = `a delete of ${messageIds.length} message(s) (${messageIds.join(', ')})`
          if (!(await confirmRecipient(target, what, Boolean(options.yes)))) return
          report(
            await deleteMessages(tg, target.id, messageIds, { yes: options.yes }),
            Boolean(options.json)
          )
        })
      })
    })

  send
    .command('forward <peer> <ids...>')
    .description('Forward messages you can see into another chat (id, @username or t.me link)')
    .requiredOption('--to <target>', 'Destination chat (id, @username or t.me link)')
    .option('--yes', 'Skip the confirmation; required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, ids: string[], options) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        parsePeerRef(options.to)
        assertConfirmed(options)

        const messageIds = ids.map((raw) => {
          const id = Number(raw)
          if (!Number.isInteger(id) || id <= 0) {
            throw new OperatorError(`Not a message id: ${raw}. Ids are positive integers.`)
          }
          return id
        })
        // Telegram forwards at most 100 at once; refuse before the network.
        if (messageIds.length > 100) {
          throw new OperatorError(
            `Too many messages to forward (${messageIds.length}). ` +
            'Telegram allows at most 100 at once.'
          )
        }

        await withAuthenticatedClient(async (tg) => {
          const source = await resolvePeerRef(tg, peer)
          const target = await resolvePeerRef(tg, options.to)
          // The confirmation names the destination - that is who gains a copy.
          const what =
            `a forward of ${messageIds.length} message(s) (${messageIds.join(', ')}) ` +
            `from ${describePeer(source)}`
          if (!(await confirmRecipient(target, what, Boolean(options.yes)))) return
          report(
            await forwardMessage(tg, source.id, target.id, messageIds, { yes: options.yes }),
            Boolean(options.json)
          )
        })
      })
    })

  send
    .command('edit <peer> <id> <text>')
    .description('Edit the text of a message you sent (id, @username or t.me link)')
    .option('--yes', 'Skip the confirmation; required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, id: string, text: string, options) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        assertConfirmed(options)

        const messageId = Number(id)
        if (!Number.isInteger(messageId) || messageId <= 0) {
          throw new OperatorError(`Not a message id: ${id}. Ids are positive integers.`)
        }

        await withAuthenticatedClient(async (tg) => {
          const target = await resolvePeerRef(tg, peer)
          const what = `an edit to message ${messageId}`
          if (!(await confirmRecipient(target, what, Boolean(options.yes)))) return
          report(
            await editMessageText(tg, target.id, messageId, text, { yes: options.yes }),
            Boolean(options.json)
          )
        })
      })
    })

  send
    .command('read <peer>')
    .description('Mark a chat as read, up to its latest message (id, @username or t.me link)')
    .option('--yes', 'Skip the confirmation; required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, options) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        assertConfirmed(options)
        await withAuthenticatedClient(async (tg) => {
          const target = await resolvePeerRef(tg, peer)
          if (!(await confirmRecipient(target, 'a read receipt', Boolean(options.yes)))) return
          report(await markRead(tg, target.id, { yes: options.yes }), Boolean(options.json))
        })
      })
    })

  send
    .command('log')
    .description('Show what this workspace has sent')
    .option('--json', 'Machine-readable output')
    .action(async (options) => {
      // Reads a local file; no client, no lock, no network.
      await runCommand(async () => {
        const records = readSendLog()

        if (options.json) {
          process.stdout.write(`${JSON.stringify(records, null, 2)}\n`)
          return
        }

        if (records.length === 0) {
          console.log('Nothing sent from this workspace.')
          return
        }

        for (const r of records) {
          const status = r.ok ? 'ok  ' : 'FAIL'
          console.log(
            `${r.at.slice(0, 16)}  ${status}  ${r.kind.padEnd(8)}  peer ${r.peerId}` +
            `${r.error ? `  ${r.error}` : ''}`
          )
        }
        console.log(
          chalk.dim(
            `\n${sendsToday(records)}/${MAX_SENDS_PER_DAY} in the last 24h; ` +
            `${MAX_SENDS_PER_RUN} allowed per run`
          )
        )
      })
    })

  program
    .command('note <text>')
    .description('Send a note to your own Saved Messages')
    .option('--yes', 'Required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (text: string, options) => {
      await runCommand(async () => {
        if (!text.trim()) throw new OperatorError('Give some text to save.')
        assertConfirmed(options)
        await withAuthenticatedClient(async (tg) => {
          // No recipient confirmation: the only possible target is yourself.
          report(await sendNote(tg, text, { yes: options.yes }), Boolean(options.json))
        })
      })
    })
}
