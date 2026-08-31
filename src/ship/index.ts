/**
 * Ship archive files into gbrain. A SEPARATE PROCESS from the ingester.
 *
 * SECURITY BOUNDARY (binding, decision doc D7 / "two one-way rules"):
 *   1. Nothing holding a Telegram credential may call an LLM or gbrain.
 *   2. Nothing talking to gbrain may hold a Telegram credential.
 *
 * `tg ship` is a subcommand of the same binary for the human's convenience,
 * but it is its own process and this module imports NOTHING from src/session,
 * src/client.ts or @mtcute. It reads finished markdown off disk and execs the
 * gbrain CLI. The eval in test/ship.test.ts walks this file's transitive
 * import graph and fails if that ever stops being true.
 *
 * It shells out - one gbrain process per file, exit code checked - rather than
 * linking a library, so a gbrain crash cannot take the archive with it and
 * the credential separation is enforced by the process boundary, not by care.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { OperatorError } from '../errors.js'
import { EXIT } from '../exit-codes.js'

/**
 * The environment handed to gbrain, built by allowlist.
 *
 * The security boundary in the decision log is stated as a PROCESS boundary:
 * "nothing talking to gbrain may hold a Telegram credential", enforced by an
 * import-graph eval. The import graph was clean and the boundary still leaked,
 * because `spawnSync` with no `env` hands the child the parent's entire
 * environment. Under `psst run`, or with a .env loaded by src/index.ts, that
 * environment contains the session string - so gbrain was receiving a full
 * Telegram credential it has no use for, on every single capture.
 *
 * An import graph cannot see this. Only an allowlist can, so the child gets the
 * variables it actually needs and nothing else. Pinned by eval-84.
 */
function childEnv(): NodeJS.ProcessEnv {
  const allowed = [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL',
    'TZ', 'TERM',
    // gbrain's own configuration and credentials, which are not ours.
    'GBRAIN_HOME', 'GBRAIN_SOURCE', 'GBRAIN_DATABASE_URL', 'GBRAIN_API_KEY',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    // Proxy settings, or a captive network breaks the capture with no clue why.
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'
  ]

  const env: NodeJS.ProcessEnv = {}
  for (const key of allowed) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

/** Written after a fully successful run; its mtime is the ship watermark. */
export const SHIP_STAMP_PATH = 'data/archive/.last-ship'

/**
 * One JSONL line per run, so a timer that stopped firing is distinguishable
 * from a timer that fires and finds nothing to do. Overridable so a test - or
 * a second archive on the same host - never writes into the real brain.
 */
function heartbeatPath(): string {
  return process.env.TG_HEARTBEAT_PATH
    ?? join(homedir(), '.gbrain', 'integrations', '@qwadratic/tg', 'heartbeat.jsonl')
}

export interface ShipPlanEntry {
  file: string
  slug: string
  /** One entry per destination brain: a chat in two folders ships to both. */
  sources: string[]
}

/**
 * An OperatorError, so the CLI prints the instruction bare. Every ShipError
 * is something the human must fix in config or in a file - a stack trace on
 * top would only bury the sentence that says which file and which folder.
 */
export class ShipError extends OperatorError {
  override name = 'ShipError'

  /**
   * Defaults to `upstream`, not the OperatorError default of `not-configured`.
   *
   * A gbrain crash, a network failure or an unroutable archive is not a broken
   * workspace: retrying later is a reasonable response, where retrying a missing
   * API key is not. A cron wrapper needs to tell those apart to decide whether
   * to alert or to back off.
   */
  constructor(message: string, exitCode = EXIT.upstream) {
    super(message, exitCode)
  }
}

/**
 * Parse `TG_BRAIN_MAP` - `"7=personal,12=proximata"`.
 *
 * `ponytail:` deploy config in one env var rather than a new persisted file.
 * Ceiling: unreadable past ~10 folders, and it cannot be edited by the CLI.
 * Upgrade path: a `folderBrains` object in data/config.json.
 */
export function parseBrainMap(raw: string | undefined): Map<number, string> {
  const map = new Map<number, string>()
  for (const pair of (raw ?? '').split(',')) {
    const trimmed = pair.trim()
    if (!trimmed) continue
    const [rawId, source] = trimmed.split('=')
    const id = Number(rawId)
    if (!Number.isInteger(id) || !source) {
      throw new ShipError(`TG_BRAIN_MAP entry is not <folderId>=<source>: "${trimmed}"`)
    }
    map.set(id, source.trim())
  }
  return map
}

/** `folder_ids: [7, 12]` out of a file's frontmatter. */
export function readFolderIds(content: string): number[] {
  const match = /^folder_ids:\s*\[([^\]]*)\]\s*$/m.exec(content)
  if (!match) return []
  return (match[1] ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)   // `[]` must be empty, not [NaN] and not [0]
    .map(Number)
    .filter((id) => Number.isInteger(id))
}

/**
 * The slug IS the dedup key: gbrain enforces UNIQUE (source_id, slug), so a
 * stable slug is what makes running this loop twice a no-op. The archive
 * filename is already `<sanitized-name>_<chat_id>.md`, so deriving the slug
 * from it costs nothing and cannot drift from the file it names.
 */
export function slugForFile(file: string): string {
  return `tg/chat/${basename(file, '.md')}`
}

function archiveFiles(archiveDir: string, since: number): string[] {
  if (!existsSync(archiveDir)) return []
  return readdirSync(archiveDir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => join(archiveDir, name))
    .filter((file) => statSync(file).mtimeMs > since)
    .sort()
}

/**
 * Decide what would be shipped where. Pure enough to test: no gbrain, no exec.
 *
 * A file with no routable folder FAILS the whole run. Defaulting it to some
 * brain would put private chats in the wrong one silently, which is the one
 * failure mode nobody would notice.
 */
/** A file that cannot be routed, and the reason, so the report can say both. */
export interface UnroutableFile {
  file: string
  reason: 'no-folder' | 'unmapped-folder'
  detail: string
}

export interface ShipPlan {
  entries: ShipPlanEntry[]
  skipped: UnroutableFile[]
}

/**
 * Decide what goes where.
 *
 * Refusing to guess a destination brain is deliberate and tested (eval-44): a
 * file whose folder is unknown must never be silently filed somewhere. But
 * failing the WHOLE RUN on the first such file was too blunt - on this operator's
 * archive, 38 chats belong to no tracked folder (exported directly, or the
 * folder changed later), and those 38 blocked the other 92 from ever reaching
 * the brain. One unroutable file should cost one file, not the run.
 *
 * So unroutable files are now COLLECTED rather than thrown on, and the caller
 * decides: `--skip-unroutable` proceeds with the rest and reports the skips,
 * the default still fails loudly. Neither path ever guesses.
 */
export function planShip(options: {
  archiveDir: string
  since: number
  brainMap: Map<number, string>
}): ShipPlan {
  const entries: ShipPlanEntry[] = []
  const skipped: UnroutableFile[] = []

  for (const file of archiveFiles(options.archiveDir, options.since)) {
    const folderIds = readFolderIds(readFileSync(file, 'utf-8'))

    if (folderIds.length === 0) {
      skipped.push({
        file,
        reason: 'no-folder',
        detail: 'this chat is in no tracked folder, so nothing says which brain owns it'
      })
      continue
    }

    const unmapped = folderIds.filter((id) => !options.brainMap.get(id))
    if (unmapped.length > 0) {
      skipped.push({
        file,
        reason: 'unmapped-folder',
        detail: `folder ${unmapped.join(', ')} is not in TG_BRAIN_MAP`
      })
      continue
    }

    const sources = folderIds.map((id) => options.brainMap.get(id) as string)
    entries.push({ file, slug: slugForFile(file), sources: [...new Set(sources)] })
  }

  return { entries, skipped }
}

/**
 * The message shown when unroutable files are NOT being skipped.
 *
 * Says what to do, not just what is wrong: the old text ("nothing says which
 * brain owns it") named the problem and left the operator to work out that
 * either a folder mapping or --skip-unroutable was the answer.
 */
export function unroutableError(skipped: UnroutableFile[]): ShipError {
  const byReason = {
    'no-folder': skipped.filter((s) => s.reason === 'no-folder'),
    'unmapped-folder': skipped.filter((s) => s.reason === 'unmapped-folder')
  }

  const lines = [`${skipped.length} file(s) cannot be routed to a brain:`]

  const firstNoFolder = byReason['no-folder'][0]
  if (firstNoFolder) {
    lines.push(
      `  ${byReason['no-folder'].length} in no tracked folder, e.g. ${basename(firstNoFolder.file)}`,
      '    Track the folder they live in (data/config.json), or pass --skip-unroutable.'
    )
  }
  if (byReason['unmapped-folder'].length > 0) {
    const ids = [...new Set(byReason['unmapped-folder'].flatMap((s) => s.detail.match(/\d+/g) ?? []))]
    lines.push(
      `  ${byReason['unmapped-folder'].length} in folder(s) missing from TG_BRAIN_MAP: ${ids.join(', ')}`,
      `    Add them:  TG_BRAIN_MAP="${ids.map((i) => `${i}=<source>`).join(',')}"`
    )
  }

  lines.push('  Nothing was shipped. No file is ever filed into a guessed brain.')
  return new ShipError(lines.join('\n'))
}

function capture(gbrainBin: string, file: string, slug: string, source: string): void {
  const result = spawnSync(
    gbrainBin,
    ['capture', '--stdin', '--slug', slug, '--source', source, '--quiet'],
    { input: readFileSync(file), stdio: ['pipe', 'pipe', 'inherit'], env: childEnv() }
  )
  if (result.error) throw new ShipError(`${gbrainBin} could not be run: ${result.error.message}`)
  if (result.status !== 0) {
    throw new ShipError(`gbrain capture ${slug} -> ${source} exited ${result.status}`)
  }
}

function heartbeat(status: string, details: Record<string, unknown>): void {
  try {
    const path = heartbeatPath()
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify({
      ts: new Date().toISOString(),
      event: 'ship',
      source_version: process.env.npm_package_version ?? '0.2.0',
      status,
      details
    })}\n`)
  } catch {
    // A missing heartbeat must never fail a successful ship: it is telemetry,
    // not the job. The exit code is still the verdict.
  }
}

/**
 * Ship every archive file newer than the stamp, then advance the stamp.
 *
 * The stamp is touched ONLY on a clean run. Any non-zero gbrain exit aborts
 * and leaves it untouched, so the next run retries the same set - which is
 * safe precisely because the slug makes each capture idempotent.
 */
export function ship(options: {
  archiveDir?: string | undefined
  dryRun?: boolean | undefined
  brainMap?: Map<number, string> | undefined
  gbrainBin?: string | undefined
  all?: boolean | undefined
  /** Ship what CAN be routed; report the rest instead of failing the run. */
  skipUnroutable?: boolean | undefined
} = {}): { shipped: number; captures: number; skipped: number } {
  const archiveDir = options.archiveDir ?? join('data', 'archive')
  const stamp = join(archiveDir, '.last-ship')
  const since = options.all || !existsSync(stamp) ? 0 : statSync(stamp).mtimeMs
  const brainMap = options.brainMap ?? parseBrainMap(process.env.TG_BRAIN_MAP)
  const gbrainBin = options.gbrainBin ?? process.env.GBRAIN_BIN ?? 'gbrain'

  const startedAt = Date.now()
  let captures = 0
  let entries: ShipPlanEntry[]
  let skipped: UnroutableFile[] = []

  try {
    const plan = planShip({ archiveDir, since, brainMap })
    entries = plan.entries
    skipped = plan.skipped

    // Refusing to guess is the invariant; failing the whole run is not. Without
    // --skip-unroutable one unroutable file still stops everything, loudly and
    // with the fix in the message.
    if (skipped.length > 0 && !options.skipUnroutable) throw unroutableError(skipped)

    for (const entry of entries) {
      for (const source of entry.sources) {
        if (options.dryRun) {
          console.log(`would capture ${entry.slug} -> ${source} (${entry.file})`)
        } else {
          capture(gbrainBin, entry.file, entry.slug, source)
        }
        captures++
      }
    }
  } catch (error) {
    // One heartbeat per run either way: a run that fails silently looks
    // exactly like a run that never fired.
    if (!options.dryRun) {
      heartbeat('error', {
        captures,
        skipped: skipped.length,
        error: error instanceof Error ? error.message : String(error)
      })
    }
    throw error
  }

  if (!options.dryRun) {
    // Stamped with the run's START time, floored to the millisecond by
    // Date.now(): a file modified while the run was in flight must not be
    // skipped by the next one. The floor can re-ship a file written in the
    // same millisecond the run started, which is harmless - the slug makes a
    // repeat capture an update - and is the right way to round.
    const startSeconds = startedAt / 1000
    appendFileSync(stamp, '')
    utimesSync(stamp, startSeconds, startSeconds)
    heartbeat('ok', { files: entries.length, captures, skipped: skipped.length })
  }

  if (skipped.length > 0) {
    console.error(
      `skipped ${skipped.length} unroutable file(s); nothing was guessed. ` +
      'Run with no --skip-unroutable to see the full list and the fix.'
    )
  }

  return { shipped: entries.length, captures, skipped: skipped.length }
}
