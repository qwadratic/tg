import { execFileSync } from 'node:child_process'

/**
 * Display size and length of a video, for `tg send media`.
 *
 * A video sent without width/height reaches Telegram with a 0x0 video
 * attribute, and clients then draw the player SQUARE and stretch the frame into
 * it: a 1440x900 screen recording arrived with visibly widened text. Reading the
 * real size from the file and passing it along is what the old ponytail comment
 * in src/send/index.ts named as the upgrade path.
 *
 * ffprobe is optional, never a dependency of sending: no ffprobe, an unreadable
 * file or unparseable output all give null, and the send goes out exactly as it
 * did before. Read-only - this module calls no Telegram RPC.
 */

export interface VideoMeta {
  width: number
  height: number
  /** Whole seconds; absent when the container does not say. */
  duration?: number
}

/** Runs ffprobe and returns its stdout; injectable so tests need no binary. */
export type ProbeRunner = (file: string, args: string[]) => string

const PROBE_ARGS = [
  '-v', 'error',
  '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height:stream_tags=rotate:stream_side_data=rotation:format=duration',
  '-of', 'json'
]

const runFfprobe: ProbeRunner = (file, args) =>
  execFileSync('ffprobe', [...args, file], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] })

/**
 * Parse `ffprobe -of json` output into the size a viewer sees.
 *
 * A phone records portrait video as a landscape stream plus a rotation (the
 * legacy `rotate` tag or a display-matrix side datum); width and height are
 * swapped for a quarter turn, or a portrait clip would be sent as landscape and
 * squashed. Pure; exported for tests.
 */
export function parseProbe(json: string): VideoMeta | null {
  let data: {
    streams?: { width?: number; height?: number; tags?: { rotate?: string }; side_data_list?: { rotation?: number }[] }[]
    format?: { duration?: string }
  }
  try {
    data = JSON.parse(json) as typeof data
  } catch {
    return null
  }
  const stream = data.streams?.[0]
  const w = Number(stream?.width)
  const h = Number(stream?.height)
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return null

  const rotation = Number(stream?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? stream?.tags?.rotate ?? 0)
  const quarterTurn = Math.abs(Math.round(rotation)) % 180 === 90
  const seconds = Math.round(Number(data.format?.duration))

  return {
    width: quarterTurn ? h : w,
    height: quarterTurn ? w : h,
    ...(Number.isFinite(seconds) && seconds > 0 ? { duration: seconds } : {})
  }
}

/** Probe a video file; null whenever ffprobe cannot answer. Never throws. */
export function probeVideo(file: string, run: ProbeRunner = runFfprobe): VideoMeta | null {
  try {
    return parseProbe(run(file, PROBE_ARGS))
  } catch {
    return null
  }
}
