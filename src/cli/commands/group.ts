import { confirm, isCancel } from '@clack/prompts'
import chalk from 'chalk'
import type { Command } from 'commander'
import {
  addChatMembers,
  createChannel,
  createForumTopic,
  createGroup,
  createInviteLink,
  createSupergroup,
  deleteChat,
  editForumTopic,
  editInviteLink,
  exportInviteLink,
  kickChatMember,
  MAX_MEMBERS_PER_CALL,
  setChatColor,
  setChatDescription,
  setChatPhoto,
  setChatStickerSet,
  setChatTitle,
  setChatUsername,
  setContentProtection,
  setForumTopicClosed,
  setForumTopicPinned,
  setJoinRequests,
  setJoinToSend,
  setSlowMode,
  type SentRecord
} from '../../send/index.js'
import { assertConfirmed } from '../../send/gate.js'
import {
  listForumTopics,
  listInviteLinkMembers,
  listInviteLinks,
  renderForumTopics,
  renderInviteLinks,
  renderInviteMembers
} from '../../groups/index.js'
import { describePeer, parsePeerRef, resolvePeerRef, type ResolvedPeer } from '../../peers/ref.js'
import { runCommand } from '../errors.js'
import { OperatorError } from '../../errors.js'
import { EXIT } from '../../exit-codes.js'
import { canPrompt } from '../../session/index.js'
import { logSummary } from '../log.js'
import { withAuthenticatedClient } from './shared.js'

/**
 * `tg group` - chat administration.
 *
 * Semantically distinct from `tg send`: nothing here posts a message. Everything
 * here changes what a chat IS - its name, its picture, who can join it, how it
 * is organised - which is visible to every member and, for a released username
 * or a regenerated primary invite link, not undoable. See
 * backlog/decisions/2026-08-31-widen-the-fenced-write-verbs-to-group-channel-management.md
 *
 * D13d (backlog/decisions/2026-10-05-...) added add-members, kick-member and
 * delete: they act on a person or destroy a chat, so their prompts name them.
 *
 * The write verbs share the send machinery exactly: numeric peer id, the --yes
 * gate before any session is opened, the audit log. They cost zero cap units,
 * because the caps bound delivered messages and these deliver none.
 */

/** Show which chat is about to change, and require a yes. */
async function confirmChat(target: ResolvedPeer, what: string, yes: boolean): Promise<boolean> {
  if (yes || !canPrompt()) return true

  console.log(chalk.yellow(`\nAbout to ${what}`))
  console.log(chalk.yellow(`  chat: ${chalk.bold(describePeer(target))}`))
  if (target.ref.kind === 'username') {
    console.log(chalk.dim(`  resolved from ${target.ref.raw} - check the chat is the one you meant`))
  }

  const ok = await confirm({ message: 'Go ahead?' })
  if (isCancel(ok) || !ok) {
    console.log('Cancelled. Nothing was done.')
    return false
  }
  return true
}

/**
 * No peer to name: creation has no target until it succeeds.
 *
 * `details` is how the people being added get named. A group is created WITH
 * members, and one mistyped digit adds a stranger who cannot be un-shown the
 * group, so the same rule `confirmRecipient` states applies: show the resolved
 * identity in full before doing it, not the count.
 */
async function confirmCreate(what: string, yes: boolean, details: string[] = []): Promise<boolean> {
  if (yes || !canPrompt()) return true
  console.log(chalk.yellow(`\nAbout to ${what}`))
  for (const line of details) console.log(chalk.yellow(`  member: ${chalk.bold(line)}`))
  const ok = await confirm({ message: 'Go ahead?' })
  if (isCancel(ok) || !ok) {
    console.log('Cancelled. Nothing was done.')
    return false
  }
  return true
}

/** Name the people about to be added; the chat is shown too. */
async function confirmAddMembers(target: ResolvedPeer, members: string[], yes: boolean): Promise<boolean> {
  if (yes || !canPrompt()) return true
  console.log(chalk.yellow(`\nAbout to add ${members.length} member(s) to ${describePeer(target)}`))
  for (const line of members) console.log(chalk.yellow(`  member: ${chalk.bold(line)}`))
  const ok = await confirm({ message: 'Go ahead?' })
  if (isCancel(ok) || !ok) {
    console.log('Cancelled. Nothing was done.')
    return false
  }
  return true
}

/** Membership acts on a PERSON, so the prompt names the person, not just the chat (D13d). */
async function confirmKick(target: ResolvedPeer, member: string, yes: boolean): Promise<boolean> {
  if (yes || !canPrompt()) return true
  console.log(chalk.yellow(`\nAbout to remove this person from ${describePeer(target)}`))
  console.log(chalk.yellow(`  member: ${chalk.bold(member)}`))
  const ok = await confirm({ message: 'Go ahead?' })
  if (isCancel(ok) || !ok) {
    console.log('Cancelled. Nothing was done.')
    return false
  }
  return true
}

/** A user to act on: numeric ids only, like create-group, so a typo cannot reach a stranger. */
function parseUserId(raw: string): number {
  const ref = parsePeerRef(raw)
  if (ref.kind !== 'id' || typeof ref.value !== 'number') {
    throw new OperatorError(
      `Give numeric peer ids for people, not ${ref.raw}. Find one with: tg peers find <name> --id-only`,
      EXIT.usage
    )
  }
  return ref.value
}

function report(record: SentRecord, done: string, json = false): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`)
    return
  }
  logSummary(done)
}

/** `on`/`off` as a boolean. Anything else is a usage error, not a silent false. */
function parseOnOff(raw: string): boolean {
  if (raw === 'on') return true
  if (raw === 'off') return false
  throw new OperatorError(`Expected "on" or "off", got: ${raw}`, EXIT.usage)
}

/**
 * A positive-or-zero integer argument.
 *
 * Digits only, deliberately: bare `Number()` accepts `0x10` (16), `1e3` (1000)
 * and `''` (0), so `--limit 1e3` would silently mean a thousand rather than
 * being refused. Same rule `assertPeerId` already applies to a peer.
 */
function parseCount(raw: string, what: string): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new OperatorError(`Not a ${what}: ${raw}. Give a non-negative integer, digits only.`, EXIT.usage)
  }
  return Number(raw.trim())
}

/** Like {@link parseCount}, but zero is not a meaningful value. */
function parsePositive(raw: string, what: string): number {
  const value = parseCount(raw, what)
  if (value === 0) {
    throw new OperatorError(`Not a ${what}: 0. Omit the flag instead - there is no zero here.`, EXIT.usage)
  }
  return value
}

interface GroupFlags { yes?: boolean; json?: boolean }
interface InviteFlags extends GroupFlags {
  expires?: string
  limit?: string
  approval?: boolean
}

/** The shared shape of every invite-link write's options. */
function inviteOptions(options: InviteFlags): {
  expires?: number
  usageLimit?: number
  withApproval?: boolean
  yes?: boolean | undefined
} {
  const expires = options.expires ? Date.parse(options.expires) : undefined
  if (expires !== undefined && Number.isNaN(expires)) {
    throw new OperatorError(`Not a date: ${options.expires}. Use an ISO date, e.g. 2026-12-31.`, EXIT.usage)
  }
  return {
    ...(expires === undefined ? {} : { expires }),
    // Telegram reads usageLimit as [1, 99999]: 0 is not "nobody may join", it
    // is the same as unset, so accepting it would mean the opposite of asked.
    ...(options.limit === undefined ? {} : { usageLimit: parsePositive(options.limit, 'usage limit') }),
    ...(options.approval === undefined ? {} : { withApproval: options.approval }),
    yes: options.yes
  }
}

export function registerGroupCommand(program: Command): void {
  const group = program
    .command('group')
    .description('Administer a group or channel (human-invoked only)')
    .action(() => group.help())

  /* ---------------------------------------------------------------- creating */

  group
    .command('create-group <title> <users...>')
    .description('Create a legacy group with an initial member list (numeric peer ids)')
    .option('--yes', 'Skip the confirmation; required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (title: string, users: string[], options: GroupFlags) => {
      await runCommand(async () => {
        assertConfirmed(options)
        // Members are numeric ids only: a legacy group cannot be un-created,
        // and a mistyped handle would silently add a stranger to it.
        const userIds = users.map((raw) => {
          const ref = parsePeerRef(raw)
          if (ref.kind !== 'id' || typeof ref.value !== 'number') {
            throw new OperatorError(
              `Give numeric peer ids for the members, not ${ref.raw}. ` +
              'Find one with: tg peers find <name> --id-only',
              EXIT.usage
            )
          }
          return ref.value
        })

        await withAuthenticatedClient(async (tg) => {
          const what = `create the group "${title}" with ${userIds.length} member(s)`
          // Resolve each member so the prompt names the PEOPLE, not a count.
          const members: string[] = []
          for (const id of userIds) members.push(describePeer(await resolvePeerRef(tg, String(id))))
          if (!(await confirmCreate(what, Boolean(options.yes), members))) return
          const record = await createGroup(tg, title, userIds, { yes: options.yes })
          report(record, `created group ${record.messageId}`, Boolean(options.json))
        })
      })
    })

  group
    .command('create-channel <title>')
    .description('Create a broadcast channel')
    .option('--description <text>', 'Channel description')
    .option('--yes', 'Skip the confirmation; required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (title: string, options: GroupFlags & { description?: string }) => {
      await runCommand(async () => {
        assertConfirmed(options)
        await withAuthenticatedClient(async (tg) => {
          if (!(await confirmCreate(`create the channel "${title}"`, Boolean(options.yes)))) return
          const record = await createChannel(tg, title, {
            description: options.description,
            yes: options.yes
          })
          report(record, `created channel ${record.messageId}`, Boolean(options.json))
        })
      })
    })

  group
    .command('create-supergroup <title>')
    .description('Create a supergroup, optionally as a forum')
    .option('--description <text>', 'Supergroup description')
    .option('--forum', 'Create it with topics enabled')
    .option('--yes', 'Skip the confirmation; required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (title: string, options: GroupFlags & { description?: string; forum?: boolean }) => {
      await runCommand(async () => {
        assertConfirmed(options)
        await withAuthenticatedClient(async (tg) => {
          if (!(await confirmCreate(`create the supergroup "${title}"`, Boolean(options.yes)))) return
          const record = await createSupergroup(tg, title, {
            description: options.description,
            forum: options.forum,
            yes: options.yes
          })
          report(record, `created supergroup ${record.messageId}`, Boolean(options.json))
        })
      })
    })

  /* ---------------------------------------------------------------- identity */

  group
    .command('title <peer> <title>')
    .description('Rename a chat (id, @username or t.me link)')
    .option('--yes', 'Skip the confirmation; required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, title: string, options: GroupFlags) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        assertConfirmed(options)
        await withAuthenticatedClient(async (tg) => {
          const target = await resolvePeerRef(tg, peer)
          if (!(await confirmChat(target, `rename this chat to "${title}"`, Boolean(options.yes)))) return
          report(
            await setChatTitle(tg, target.id, title, { yes: options.yes }),
            `renamed ${target.id}`,
            Boolean(options.json)
          )
        })
      })
    })

  group
    .command('description <peer> <text>')
    .description('Set a chat description; pass "" to clear it')
    .option('--yes', 'Skip the confirmation; required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, text: string, options: GroupFlags) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        assertConfirmed(options)
        await withAuthenticatedClient(async (tg) => {
          const target = await resolvePeerRef(tg, peer)
          const what = text ? 'change this chat description' : 'clear this chat description'
          if (!(await confirmChat(target, what, Boolean(options.yes)))) return
          report(
            await setChatDescription(tg, target.id, text, { yes: options.yes }),
            `set the description of ${target.id}`,
            Boolean(options.json)
          )
        })
      })
    })

  group
    .command('photo <peer> <file>')
    .description('Set a chat photo or video avatar from a local file')
    .option('--yes', 'Skip the confirmation; required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, file: string, options: GroupFlags) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        assertConfirmed(options)
        await withAuthenticatedClient(async (tg) => {
          const target = await resolvePeerRef(tg, peer)
          if (!(await confirmChat(target, `set the chat photo to ${file}`, Boolean(options.yes)))) return
          report(
            await setChatPhoto(tg, target.id, file, { yes: options.yes }),
            `set the photo of ${target.id}`,
            Boolean(options.json)
          )
        })
      })
    })

  group
    .command('color <peer> <colorId>')
    .description("Set the accent colour by Telegram's palette index (0-6 built in)")
    .option('--profile', 'Set the profile header colour instead of the name/replies colour')
    .option('--yes', 'Skip the confirmation; required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, colorId: string, options: GroupFlags & { profile?: boolean }) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        assertConfirmed(options)
        const color = parseCount(colorId, 'colour id')
        await withAuthenticatedClient(async (tg) => {
          const target = await resolvePeerRef(tg, peer)
          if (!(await confirmChat(target, `set the accent colour to ${color}`, Boolean(options.yes)))) return
          report(
            await setChatColor(tg, target.id, color, { forProfile: options.profile, yes: options.yes }),
            `set the colour of ${target.id}`,
            Boolean(options.json)
          )
        })
      })
    })

  group
    .command('sticker-set <peer> <shortName>')
    .description("Set the sticker set a supergroup uses (the set's short name)")
    .option('--yes', 'Skip the confirmation; required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, shortName: string, options: GroupFlags) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        assertConfirmed(options)
        await withAuthenticatedClient(async (tg) => {
          const target = await resolvePeerRef(tg, peer)
          const what = `set the sticker set to ${shortName}`
          if (!(await confirmChat(target, what, Boolean(options.yes)))) return
          report(
            await setChatStickerSet(tg, target.id, shortName, { yes: options.yes }),
            `set the sticker set of ${target.id}`,
            Boolean(options.json)
          )
        })
      })
    })

  group
    .command('username <peer> <username>')
    .description('Claim a public @username for a supergroup or channel')
    .option('--yes', 'Skip the confirmation; required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, username: string, options: GroupFlags) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        assertConfirmed(options)
        const handle = username.replace(/^@/, '')
        await withAuthenticatedClient(async (tg) => {
          const target = await resolvePeerRef(tg, peer)
          const what = `make this chat public as @${handle}`
          if (!(await confirmChat(target, what, Boolean(options.yes)))) return
          report(
            await setChatUsername(tg, target.id, handle, { yes: options.yes }),
            `set @${handle} on ${target.id}`,
            Boolean(options.json)
          )
        })
      })
    })

  group
    .command('remove-username <peer>')
    .description('Release the public username and make the chat private again')
    .option('--yes', 'Skip the confirmation; required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, options: GroupFlags) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        assertConfirmed(options)
        await withAuthenticatedClient(async (tg) => {
          const target = await resolvePeerRef(tg, peer)
          // Worth spelling out: the handle goes straight back into the global
          // pool, and anyone can take it seconds later.
          const what = 'release this chat\'s public username - anyone may claim it afterwards'
          if (!(await confirmChat(target, what, Boolean(options.yes)))) return
          report(
            await setChatUsername(tg, target.id, null, { yes: options.yes }),
            `made ${target.id} private`,
            Boolean(options.json)
          )
        })
      })
    })

  /* ----------------------------------------------------------- invite links */

  group
    .command('invite-export <peer>')
    .description('Regenerate the primary invite link - REVOKES the old one')
    .option('--yes', 'Skip the confirmation; required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, options: GroupFlags) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        assertConfirmed(options)
        await withAuthenticatedClient(async (tg) => {
          const target = await resolvePeerRef(tg, peer)
          const what = 'regenerate the primary invite link - every copy of the old one stops working'
          if (!(await confirmChat(target, what, Boolean(options.yes)))) return
          const { record, link } = await exportInviteLink(tg, target.id, { yes: options.yes })
          if (options.json) {
            process.stdout.write(`${JSON.stringify({ ...record, link }, null, 2)}\n`)
            return
          }
          logSummary(`new primary invite link: ${link}`)
        })
      })
    })

  group
    .command('invite-new <peer>')
    .description('Create an additional invite link, leaving the primary one alone')
    .option('--expires <date>', 'ISO date when the link stops working')
    .option('--limit <n>', 'Maximum number of people who may join through it')
    .option('--approval', 'Require an admin to approve each join')
    .option('--yes', 'Skip the confirmation; required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, options: InviteFlags) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        assertConfirmed(options)
        const params = inviteOptions(options)
        await withAuthenticatedClient(async (tg) => {
          const target = await resolvePeerRef(tg, peer)
          if (!(await confirmChat(target, 'create a new invite link', Boolean(options.yes)))) return
          const { record, link } = await createInviteLink(tg, target.id, params)
          if (options.json) {
            process.stdout.write(`${JSON.stringify({ ...record, link }, null, 2)}\n`)
            return
          }
          logSummary(`new invite link: ${link}`)
        })
      })
    })

  group
    .command('invite-edit <peer> <link>')
    .description('Edit a non-primary invite link; only the flags you pass change')
    .option('--expires <date>', 'ISO date when the link stops working')
    .option('--limit <n>', 'Maximum number of people who may join through it')
    .option('--approval', 'Require an admin to approve each join')
    .option('--yes', 'Skip the confirmation; required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, link: string, options: InviteFlags) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        assertConfirmed(options)
        const params = inviteOptions(options)
        await withAuthenticatedClient(async (tg) => {
          const target = await resolvePeerRef(tg, peer)
          if (!(await confirmChat(target, `edit the invite link ${link}`, Boolean(options.yes)))) return
          const { record, link: edited } = await editInviteLink(tg, target.id, link, params)
          if (options.json) {
            process.stdout.write(`${JSON.stringify({ ...record, link: edited }, null, 2)}\n`)
            return
          }
          logSummary(`edited invite link: ${edited}`)
        })
      })
    })

  group
    .command('invite-list <peer>')
    .description('List invite links you created for a chat (read-only)')
    .option('--revoked', 'Include revoked links')
    .option('--limit <n>', 'How many to fetch (default 100)')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, options: { revoked?: boolean; limit?: string; json?: boolean }) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        const limit = options.limit === undefined ? undefined : parseCount(options.limit, 'limit')
        await withAuthenticatedClient(async (tg) => {
          const target = await resolvePeerRef(tg, peer)
          const rows = await listInviteLinks(tg, target.id, { revoked: options.revoked, limit })
          if (options.json) {
            process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
            return
          }
          process.stdout.write(renderInviteLinks(rows))
        })
      })
    })

  group
    .command('invite-members <peer>')
    .description('List people who joined through an invite link (read-only)')
    .option('--link <url>', 'Only this link; omit for everyone who joined by any link')
    .option('--limit <n>', 'How many to fetch (default 100)')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, options: { link?: string; limit?: string; json?: boolean }) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        const limit = options.limit === undefined ? undefined : parseCount(options.limit, 'limit')
        await withAuthenticatedClient(async (tg) => {
          const target = await resolvePeerRef(tg, peer)
          const rows = await listInviteLinkMembers(tg, target.id, { link: options.link, limit })
          if (options.json) {
            process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
            return
          }
          process.stdout.write(renderInviteMembers(rows))
        })
      })
    })

  /* ---------------------------------------------------------- forum topics */

  group
    .command('topic-new <peer> <title>')
    .description('Create a topic in a forum supergroup')
    .option('--icon <n>', "Icon colour (RGB int) or custom emoji id, per mtcute's ForumTopic")
    .option('--yes', 'Skip the confirmation; required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, title: string, options: GroupFlags & { icon?: string }) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        assertConfirmed(options)
        const icon = options.icon === undefined ? undefined : parseCount(options.icon, 'icon id')
        await withAuthenticatedClient(async (tg) => {
          const target = await resolvePeerRef(tg, peer)
          if (!(await confirmChat(target, `create the topic "${title}"`, Boolean(options.yes)))) return
          const record = await createForumTopic(tg, target.id, title, { icon, yes: options.yes })
          report(record, `created topic ${record.messageId}`, Boolean(options.json))
        })
      })
    })

  group
    .command('topic-edit <peer> <topicId> <title>')
    .description('Rename a forum topic')
    .option('--yes', 'Skip the confirmation; required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, topicId: string, title: string, options: GroupFlags) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        assertConfirmed(options)
        const id = parseCount(topicId, 'topic id')
        await withAuthenticatedClient(async (tg) => {
          const target = await resolvePeerRef(tg, peer)
          if (!(await confirmChat(target, `rename topic ${id} to "${title}"`, Boolean(options.yes)))) return
          report(
            await editForumTopic(tg, target.id, id, title, { yes: options.yes }),
            `renamed topic ${id}`,
            Boolean(options.json)
          )
        })
      })
    })

  group
    .command('topic-closed <peer> <topicId> <state>')
    .description('Close (on) or reopen (off) a forum topic')
    .option('--yes', 'Skip the confirmation; required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, topicId: string, state: string, options: GroupFlags) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        assertConfirmed(options)
        const id = parseCount(topicId, 'topic id')
        const closed = parseOnOff(state)
        await withAuthenticatedClient(async (tg) => {
          const target = await resolvePeerRef(tg, peer)
          const what = `${closed ? 'close' : 'reopen'} topic ${id}`
          if (!(await confirmChat(target, what, Boolean(options.yes)))) return
          report(
            await setForumTopicClosed(tg, target.id, id, closed, { yes: options.yes }),
            `${closed ? 'closed' : 'reopened'} topic ${id}`,
            Boolean(options.json)
          )
        })
      })
    })

  group
    .command('topic-pinned <peer> <topicId> <state>')
    .description('Pin (on) or unpin (off) a forum topic')
    .option('--yes', 'Skip the confirmation; required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, topicId: string, state: string, options: GroupFlags) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        assertConfirmed(options)
        const id = parseCount(topicId, 'topic id')
        const pinned = parseOnOff(state)
        await withAuthenticatedClient(async (tg) => {
          const target = await resolvePeerRef(tg, peer)
          const what = `${pinned ? 'pin' : 'unpin'} topic ${id}`
          if (!(await confirmChat(target, what, Boolean(options.yes)))) return
          report(
            await setForumTopicPinned(tg, target.id, id, pinned, { yes: options.yes }),
            `${pinned ? 'pinned' : 'unpinned'} topic ${id}`,
            Boolean(options.json)
          )
        })
      })
    })

  group
    .command('topic-list <peer>')
    .description('List a forum supergroup\'s topics (read-only)')
    .option('--limit <n>', 'How many to fetch (default 100)')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, options: { limit?: string; json?: boolean }) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        const limit = options.limit === undefined ? undefined : parseCount(options.limit, 'limit')
        await withAuthenticatedClient(async (tg) => {
          const target = await resolvePeerRef(tg, peer)
          const rows = await listForumTopics(tg, target.id, { limit })
          if (options.json) {
            process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
            return
          }
          process.stdout.write(renderForumTopics(rows))
        })
      })
    })

  /* -------------------------------------------------------------- settings */

  group
    .command('slow-mode <peer> <seconds>')
    .description('Set the slow-mode interval in seconds; 0 disables it')
    .option('--yes', 'Skip the confirmation; required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, seconds: string, options: GroupFlags) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        assertConfirmed(options)
        const interval = parseCount(seconds, 'slow-mode interval')
        await withAuthenticatedClient(async (tg) => {
          const target = await resolvePeerRef(tg, peer)
          const what = interval === 0 ? 'disable slow mode' : `set slow mode to ${interval}s`
          if (!(await confirmChat(target, what, Boolean(options.yes)))) return
          report(
            await setSlowMode(tg, target.id, interval, { yes: options.yes }),
            `slow mode ${interval}s on ${target.id}`,
            Boolean(options.json)
          )
        })
      })
    })

  group
    .command('protect <peer> <state>')
    .description('Restrict saving and forwarding content from the chat')
    .option('--yes', 'Skip the confirmation; required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, state: string, options: GroupFlags) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        assertConfirmed(options)
        const enabled = parseOnOff(state)
        await withAuthenticatedClient(async (tg) => {
          const target = await resolvePeerRef(tg, peer)
          const what = `turn content protection ${enabled ? 'on' : 'off'}`
          if (!(await confirmChat(target, what, Boolean(options.yes)))) return
          report(
            await setContentProtection(tg, target.id, enabled, { yes: options.yes }),
            `content protection ${enabled ? 'on' : 'off'} for ${target.id}`,
            Boolean(options.json)
          )
        })
      })
    })

  group
    .command('join-requests <peer> <state>')
    .description('Require an admin to approve people joining by link')
    .option('--yes', 'Skip the confirmation; required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, state: string, options: GroupFlags) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        assertConfirmed(options)
        const enabled = parseOnOff(state)
        await withAuthenticatedClient(async (tg) => {
          const target = await resolvePeerRef(tg, peer)
          const what = `turn join requests ${enabled ? 'on' : 'off'}`
          if (!(await confirmChat(target, what, Boolean(options.yes)))) return
          report(
            await setJoinRequests(tg, target.id, enabled, { yes: options.yes }),
            `join requests ${enabled ? 'on' : 'off'} for ${target.id}`,
            Boolean(options.json)
          )
        })
      })
    })

  group
    .command('join-to-send <peer> <state>')
    .description('Require joining the group before being able to post in it')
    .option('--yes', 'Skip the confirmation; required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, state: string, options: GroupFlags) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        assertConfirmed(options)
        const enabled = parseOnOff(state)
        await withAuthenticatedClient(async (tg) => {
          const target = await resolvePeerRef(tg, peer)
          const what = `turn join-to-send ${enabled ? 'on' : 'off'}`
          if (!(await confirmChat(target, what, Boolean(options.yes)))) return
          report(
            await setJoinToSend(tg, target.id, enabled, { yes: options.yes }),
            `join-to-send ${enabled ? 'on' : 'off'} for ${target.id}`,
            Boolean(options.json)
          )
        })
      })
    })

  /* -------------------------------------------------- membership, destruction */

  group
    .command('add-members <peer> <users...>')
    .description(`Add people to a chat (numeric user ids, at most ${MAX_MEMBERS_PER_CALL})`)
    .option('--yes', 'Skip the confirmation; required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, users: string[], options: GroupFlags) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        assertConfirmed(options)
        if (users.length > MAX_MEMBERS_PER_CALL) {
          throw new OperatorError(
            `Too many users (${users.length}). Add at most ${MAX_MEMBERS_PER_CALL} per call.`,
            EXIT.usage
          )
        }
        const userIds = users.map((raw) => parseUserId(raw))
        await withAuthenticatedClient(async (tg) => {
          const target = await resolvePeerRef(tg, peer)
          const members: string[] = []
          for (const id of userIds) members.push(describePeer(await resolvePeerRef(tg, String(id))))
          if (!(await confirmAddMembers(target, members, Boolean(options.yes)))) return
          const result = await addChatMembers(tg, target.id, userIds, { yes: options.yes })
          if (options.json) {
            process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`)
            return
          }
          logSummary(`added ${result.added.length} of ${userIds.length} to ${target.id}`)
          for (const f of result.failed) console.error(`  not added ${f.user} (${f.reason}): ${f.message}`)
        })
      })
    })

  group
    .command('kick-member <peer> <user>')
    .description('Remove one person from a chat (numeric user id); they may rejoin')
    .option('--yes', 'Skip the confirmation; required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, user: string, options: GroupFlags) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        assertConfirmed(options)
        const userId = parseUserId(user)
        await withAuthenticatedClient(async (tg) => {
          const target = await resolvePeerRef(tg, peer)
          const member = describePeer(await resolvePeerRef(tg, String(userId)))
          if (!(await confirmKick(target, member, Boolean(options.yes)))) return
          report(
            await kickChatMember(tg, target.id, userId, { yes: options.yes }),
            `removed ${userId} from ${target.id}`,
            Boolean(options.json)
          )
        })
      })
    })

  group
    .command('delete <peer>')
    .description('Delete a supergroup or channel YOU created, for everyone - irreversible')
    .option('--yes', 'Skip the confirmation; required for unattended runs')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, options: GroupFlags) => {
      await runCommand(async () => {
        parsePeerRef(peer)
        assertConfirmed(options)
        await withAuthenticatedClient(async (tg) => {
          const target = await resolvePeerRef(tg, peer)
          const what = 'PERMANENTLY DELETE this chat for every member - messages, media and members are gone'
          if (!(await confirmChat(target, what, Boolean(options.yes)))) return
          report(
            await deleteChat(tg, target.id, { yes: options.yes }),
            `deleted ${target.id}`,
            Boolean(options.json)
          )
        })
      })
    })
}
