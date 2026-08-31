import { intro } from '@clack/prompts'
import chalk from 'chalk'
import { exportRecencyChats } from '../../messages/recency.js'
import { logSummary } from '../log.js'
import { formatDuration, resolveExportConfig, withAuthenticatedClient } from './shared.js'

type RecencyMode = 'recent' | 'historical'

export async function runRecencyExport(options: {
  mode: RecencyMode
  cutoffDate: Date | null
  cutoffLabel: string | null
  introTitle: string
}): Promise<void> {
  intro(chalk.cyan(options.introTitle))
  await withAuthenticatedClient(
    async (tg) => {
      const config = await resolveExportConfig(tg)

      const result = await exportRecencyChats(
        tg,
        config,
        options.cutoffDate,
        options.mode,
        options.cutoffLabel
      )
      const duration = formatDuration(result.durationMs)
      logSummary(
        `${result.messagesExported} ${options.mode} messages exported to ${result.outputPath} in ${duration}`,
        { leadingNewline: true }
      )
    }
  )
}
