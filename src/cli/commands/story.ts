import type { Command } from 'commander'
import {
  parseStoryTarget,
  readStory,
  readStoryList,
  renderStory,
  renderStoryList,
  type StoryGone,
  type StoryOwner
} from '../../stories/index.js'
import { parsePeerRef } from '../../peers/ref.js'
import { runCommand } from '../errors.js'
import { notFound, printResult, resolveReadPeer, withAuthenticatedClient } from './shared.js'

/**
 * `tg story` - read a story. Read-only, and it never marks one viewed: see the
 * note at the top of `src/stories/index.ts`.
 *
 *   tg story https://t.me/durov/s/123      a story by its link
 *   tg story @durov 123                    the same, by peer and id
 *   tg story list @durov                   the peer's active stories
 */
export function registerStoryCommand(program: Command): void {
  const story = program
    .command('story')
    .description('Read a story by link, or by peer and id, with its media. Read-only: never marks a story viewed')
    .argument('<target>', 'A story link (https://t.me/name/s/123), or a peer: id, @username, t.me link or me')
    .argument('[id]', 'The story id, when the first argument is a peer')
    .option('--to <dir>', 'Where the media is saved', 'media')
    .option('--no-media', 'Do not download the photo or video')
    .option('--json', 'Machine-readable output')
    .action(async (target: string, id: string | undefined, options: { to: string; media: boolean; json?: boolean }) => {
      await runCommand(async () => {
        // Checked before a session is opened: a mistyped or message link costs nothing.
        const wanted = parseStoryTarget(target, id)

        const found = await withAuthenticatedClient(async (tg) => {
          const owner = await resolveReadPeer(tg, wanted.peer, 'reading story of')
          return { owner, read: await readStory(tg, owner, wanted.id, { destDir: options.media ? options.to : undefined }) }
        })

        if ('gone' in found.read) throw notFound(goneMessage(wanted.id, found.owner, found.read.gone))
        const { row } = found.read
        printResult(options.json, row, () => renderStory(row))
      })
    })

  story
    .command('list <peer>')
    .description('List the active stories of a person or channel (id, @username, t.me link or me)')
    .option('--download', 'Also save every story\'s media')
    .option('--to <dir>', 'Where the media is saved with --download', 'media')
    .option('--json', 'Machine-readable output')
    .action(async (peer: string, options: { download?: boolean; to: string; json?: boolean }) => {
      await runCommand(async () => {
        parsePeerRef(peer)

        const result = await withAuthenticatedClient(async (tg) => {
          const owner = await resolveReadPeer(tg, peer, 'reading stories of')
          return { owner, ...(await readStoryList(tg, owner, { destDir: options.download ? options.to : undefined })) }
        })

        // A person with no stories is a legitimately empty listing: said, and exit 0.
        printResult(
          options.json,
          { peer: { id: result.owner.id, name: result.owner.name, username: result.owner.username }, stories: result.rows, notSent: result.stubs },
          () => renderStoryList(result.owner, result.rows, result.stubs)
        )
      })
    })
}

function goneMessage(id: number, owner: StoryOwner, why: StoryGone): string {
  const whose = `story ${id} of ${owner.name}${owner.username ? ` (@${owner.username})` : ''}`
  if (why === 'hidden') {
    return `Telegram does not show ${whose} to this account (it is limited to close friends or a chosen list).`
  }
  return (
    `${whose} is gone: deleted, or expired. Telegram keeps a story for 24 hours unless its owner pinned it to the profile, ` +
    'and answers the same way when the account cannot see it. To see what is up now: tg story list ' +
    (owner.username ? `@${owner.username}` : String(owner.id))
  )
}
