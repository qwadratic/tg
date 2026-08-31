import dotenv from 'dotenv'
// quiet: the startup banner would otherwise land on stdout and break
// `... --json | jq` for anything scripting this CLI.
dotenv.config({ override: true, quiet: true })

import { Command } from 'commander'
import { registerAuthCommand } from './cli/commands/auth.js'
import { registerSessionCommand } from './cli/commands/session.js'
import { registerFoldersCommand } from './cli/commands/folders.js'
import { registerInitCommand } from './cli/commands/init.js'
import { registerCheckPhonesCommand } from './cli/commands/check-phones.js'
import { registerSyncCommand } from './cli/commands/sync.js'
import { registerShipCommand } from './cli/commands/ship.js'
import { registerPeersCommand } from './cli/commands/peers.js'
import { registerDumpCommand } from './cli/commands/dump.js'
import { registerMediaCommand } from './cli/commands/media.js'
import { registerWatchCommand } from './cli/commands/watch.js'
import { registerSendCommand } from './cli/commands/send.js'
import { registerUpdateCommand } from './cli/commands/update.js'
import { registerDoctorCommand } from './cli/commands/doctor.js'
import { scheduleUpdateCheck } from './update/index.js'
import { EXIT } from './exit-codes.js'

const VERSION = '0.6.0'

const program = new Command()
  .name('tg')
  .description('Read, archive and send Telegram from the command line')
  .version(VERSION)

registerInitCommand(program)
registerDoctorCommand(program)
registerAuthCommand(program)
registerSessionCommand(program)
registerFoldersCommand(program)

// Read verbs: discovery, transcripts, media, waiting for media.
registerPeersCommand(program)
registerDumpCommand(program)
registerMediaCommand(program)
registerWatchCommand(program)

// Archiving: `sync chats`, `sync recent`, `sync historical`.
registerSyncCommand(program)

registerCheckPhonesCommand(program)
registerShipCommand(program)

// Write verbs last, and registered from one place, so the only path into
// `src/send/` is a command a human typed. See test/trust.test.ts.
registerSendCommand(program)
registerUpdateCommand(program, VERSION)

// One synchronous file read, then a detached child if the cache is stale. This
// deliberately runs before parse() and adds no measurable time to any command.
scheduleUpdateCheck(VERSION)

// Commander exits 1 for its own usage failures - unknown option, missing
// argument, bad choice. This CLI reserves 1 for "a bug in tg, report it", so
// left alone every agent typo is reported as our crash. Map them to 2 (usage)
// and leave commander's own 0-exits (--help, --version) alone.
// exitOverride binds to one command and is NOT inherited, so the root alone
// would leave every subcommand still exiting 1.
function mapUsageExits(command: Command): void {
  command.exitOverride((error) => {
    const usage = /^commander\.(unknown|missing|invalid|excess|conflicting)/.test(error.code)
    process.exit(usage ? EXIT.usage : error.exitCode)
  })
  for (const child of command.commands) mapUsageExits(child)
}

mapUsageExits(program)

program.parse()
