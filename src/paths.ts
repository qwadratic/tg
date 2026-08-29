import { homedir } from 'node:os'
import { join } from 'node:path'
import { setting } from './env.js'

/**
 * Every path this tool reads or writes, derived from one root.
 *
 * WHY one module: a workspace is a directory. `tg` in ~/project-a and `tg` in
 * ~/project-b must not see each other's session, config, watermarks or archive,
 * because each workspace holds its OWN Telegram authorisation (see
 * "Workspaces" in README.md). Before this module the root was spelled out four
 * separate times as a literal, so "point this run somewhere else" was not
 * expressible - which is exactly the ceiling the decision log flagged:
 *
 *   backlog/decisions/2026-08-05-consolidate-on-telegram-utils.md, D6:
 *   "the data root is a hard-coded relative path. Ceiling: it breaks when two
 *    things on one host need different roots. Upgrade path: TG_DATA_DIR in
 *    src/utils/archive-path.ts plus the three other path consts."
 *
 * WHY the default stays RELATIVE: `data` (not an absolute path) means every
 * path resolves against the current directory at the moment of the fs call, so
 * `cd`-ing into a workspace selects it with no flag and no config. Making the
 * default absolute would silently merge every workspace into one.
 *
 * Read once at module load, on purpose: a single run must not change roots
 * halfway through and leave a watermark in one tree and an archive in another.
 */
export const DATA_DIR = setting('DATA_DIR')?.trim() || 'data'

/** Local encrypted cache: auth key plus the resolved peer table. */
export const SESSION_DB_PATH = join(DATA_DIR, 'session.db')

/** Single-instance lock. Workspace-relative, so it cannot see another workspace. */
export const LOCK_PATH = join(DATA_DIR, 'session.lock')

/**
 * When THIS workspace's session was established, and how long it may live.
 *
 * Workspace-scoped like the session it describes, never stateDir(): a TTL that
 * expired one workspace's auth key on behalf of another would be a footgun.
 */
export const SESSION_META_PATH = join(DATA_DIR, 'session-meta.json')

/** Tracked folder and chat selection. */
export const CONFIG_PATH = join(DATA_DIR, 'config.json')

/** One markdown file per chat. */
export const ARCHIVE_DIR = join(DATA_DIR, 'archive')

/** Per-chat watermarks. Lives beside the archive it describes. */
export const STATE_PATH = join(ARCHIVE_DIR, 'sync-state.json')

/** Append-only record of every message this workspace has sent. */
export const SEND_LOG_PATH = join(DATA_DIR, 'sent.jsonl')

/**
 * Per-USER state, shared by every workspace on this machine.
 *
 * The opposite of DATA_DIR on purpose. DATA_DIR holds one workspace's Telegram
 * authorisation and must never be shared; this holds facts about the person and
 * the install - which npm version was last checked, which numbers this human
 * logs in with. Keeping the phone list per workspace would make it empty in
 * every new workspace, which is exactly when a suggestion is worth the most.
 *
 * A function rather than a const because the update evals point TG_STATE_DIR at
 * a temp directory per test, so it has to be read at call time.
 */
export function stateDir(): string {
  return process.env.TG_STATE_DIR?.trim() || join(homedir(), '.tg')
}
