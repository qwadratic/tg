import { isCancel, select } from '@clack/prompts'
import chalk from 'chalk'
import type { Command } from 'commander'
import { folderStatuses, relativeTime, type FolderStatus } from '../../folders/status.js'
import { loadState } from '../../sync/state.js'
import { loadConfig } from '../../config/index.js'
import { syncChats } from '../../sync/index.js'
import { canPrompt } from '../../session/index.js'
import { runCommand } from '../errors.js'
import { OperatorError } from '../../errors.js'
import { logSummary, logWarning } from '../log.js'
import { formatDuration, withAuthenticatedClient } from './shared.js'

function renderTable(statuses: FolderStatus[], now: number): void {
  const width = Math.max(6, ...statuses.map((f) => f.title.length))
  console.log(chalk.dim('folder'.padEnd(width) + '  chats   synced  last updated'))
  for (const folder of statuses) {
    const stale = folder.lastUpdated === null
    const when = relativeTime(folder.lastUpdated, now)
    console.log(
      `${folder.title.padEnd(width)}  ${String(folder.chatCount).padStart(5)}  ` +
      `${String(folder.syncedChatCount).padStart(6)}  ` +
      (stale ? chalk.yellow(when) : when)
    )
  }
}

export function registerFoldersCommand(program: Command): void {
  const folders = program
    .command('folders')
    .description('Inspect and update the folders already synced')
    .action(() => folders.help())

  folders
    .command('list')
    .description('List synced folders, most recently updated first')
    .option('--json', 'Machine-readable output')
    .action(async (options: { json?: boolean }) => {
      // No client needed: everything shown here is already on disk.
      await runCommand(async () => {
        const statuses = folderStatuses(loadState())

        if (options.json) {
          console.log(JSON.stringify(statuses, null, 2))
          return
        }
        if (statuses.length === 0) {
          logWarning('No folders tracked yet. Add folder ids to data/config.json (trackedFolderIds).')
          return
        }
        renderTable(statuses, Date.now())
      })
    })

  folders
    .command('update')
    .description('Re-export one folder, or every folder oldest-first')
    .option('--folder <id>', 'Folder id to update')
    .option('--all', 'Update every tracked folder, stalest first')
    .action(async (options: { folder?: string; all?: boolean }) => {
      await runCommand(async () => {
        const statuses = folderStatuses(loadState())
        if (statuses.length === 0) {
          logWarning('No folders tracked yet. Add folder ids to data/config.json (trackedFolderIds).')
          return
        }

        const targets = await resolveTargets(statuses, options)
        if (!targets) return

        await withAuthenticatedClient(async (tg) => {
          for (const folder of targets) {
            console.log(chalk.cyan(`\nUpdating ${folder.title} (${folder.chatCount} chats)`))

            // Narrow the config to this folder: syncChats already does correct
            // incremental fetching, it just needs a smaller chat list.
            // excludeChatIds/privateOnly carry over: selectChatIds is the only
            // gate, so a chat excluded in config must stay excluded here too.
            const chatIds = loadState().folders[folder.id]?.chatIds ?? []
            const result = await syncChats(tg, {
              ...loadConfig(),
              trackedFolderIds: [folder.id],
              trackedChatIds: chatIds
            })

            logSummary(
              `${folder.title}: ${result.chatsProcessed} chats, ${result.messagesAppended} messages, ` +
              `${result.filesUpdated} files in ${formatDuration(result.durationMs)}`
            )
          }
        })
      })
    })
}

/** Decide which folders to update: explicit id, all of them, or ask. */
async function resolveTargets(
  statuses: FolderStatus[],
  options: { folder?: string; all?: boolean }
): Promise<FolderStatus[] | null> {
  if (options.all) {
    // Stalest first, so an interrupted run has still refreshed what lagged most.
    return [...statuses].reverse()
  }

  if (options.folder !== undefined) {
    const id = Number.parseInt(options.folder, 10)
    const match = statuses.find((f) => f.id === id)
    if (!match) {
      throw new OperatorError(
        `Folder ${options.folder} is not tracked. Known: ${statuses.map((f) => f.id).join(', ') || 'none'}`
      )
    }
    return [match]
  }

  if (!canPrompt()) {
    throw new OperatorError('Non-interactive run needs --folder <id> or --all')
  }

  const now = Date.now()
  const choice = await select({
    message: 'Which folder should be updated?',
    options: statuses.map((f) => ({
      value: f.id,
      label: f.title,
      hint: `${f.chatCount} chats, updated ${relativeTime(f.lastUpdated, now)}`
    }))
  })
  if (isCancel(choice)) {
    logWarning('Cancelled')
    return null
  }
  return statuses.filter((f) => f.id === choice)
}
