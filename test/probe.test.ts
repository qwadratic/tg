import assert from 'node:assert'
import test from 'node:test'
import { parseProbe, probeVideo } from '../src/media/probe.js'
import { mediaInput } from '../src/send/index.js'

/**
 * `tg send media` with a video: Telegram needs the display size, or clients draw
 * a square player and stretch the frame into it (a 1440x900 screen recording
 * arrived with widened text). None of these tests needs an ffprobe binary.
 */

const probeJson = (stream: Record<string, unknown>, duration?: string) =>
  JSON.stringify({ streams: [stream], format: duration === undefined ? {} : { duration } })

test('parseProbe: a landscape recording keeps its size and whole-second duration', () => {
  assert.deepStrictEqual(parseProbe(probeJson({ width: 1440, height: 900 }, '1114.334')), { width: 1440, height: 900, duration: 1114 })
})

test('parseProbe: a phone clip rotated by the legacy tag is sent portrait', () => {
  assert.deepStrictEqual(parseProbe(probeJson({ width: 1920, height: 1080, tags: { rotate: '90' } }, '12.4')), { width: 1080, height: 1920, duration: 12 })
})

test('parseProbe: a display-matrix rotation of -90 also swaps; 180 does not', () => {
  assert.deepStrictEqual(parseProbe(probeJson({ width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] })), { width: 1080, height: 1920 })
  assert.deepStrictEqual(parseProbe(probeJson({ width: 1920, height: 1080, side_data_list: [{ rotation: 180 }] })), { width: 1920, height: 1080 })
})

test('parseProbe: no usable video stream or garbage gives null', () => {
  assert.strictEqual(parseProbe('not json'), null)
  assert.strictEqual(parseProbe(JSON.stringify({ streams: [] })), null)
  assert.strictEqual(parseProbe(probeJson({ width: 0, height: 900 })), null)
})

test('probeVideo: a missing or failing ffprobe is null, never an exception', () => {
  assert.strictEqual(probeVideo('/x.mp4', () => { throw new Error('ENOENT ffprobe') }), null)
})

test('probeVideo: passes the file to the runner and parses what it prints', () => {
  let seen = ''
  const meta = probeVideo('/tmp/a.mp4', (file, args) => {
    seen = file
    assert.ok(args.includes('-of'))
    return probeJson({ width: 390, height: 844 }, '71.7')
  })
  assert.strictEqual(seen, '/tmp/a.mp4')
  assert.deepStrictEqual(meta, { width: 390, height: 844, duration: 72 })
})

test('mediaInput: a probed video carries width, height and duration', () => {
  const input = mediaInput('video', new Uint8Array([1]), 'demo.mp4', { caption: 'Демо' }, { width: 1440, height: 900, duration: 1114 })
  assert.strictEqual(input.type, 'video')
  assert.strictEqual(input.supportsStreaming, true)
  assert.strictEqual(input.width, 1440)
  assert.strictEqual(input.height, 900)
  assert.strictEqual(input.duration, 1114)
  assert.strictEqual(input.caption, 'Демо')
})

test('mediaInput: without a probe the video goes out as before; photos never get video attributes', () => {
  const video = mediaInput('video', new Uint8Array([1]), 'demo.mp4', {}, null)
  assert.strictEqual('width' in video, false)
  assert.strictEqual(video.supportsStreaming, true)
  const photo = mediaInput('photo', new Uint8Array([1]), 'a.png', {}, { width: 10, height: 10 })
  assert.strictEqual('width' in photo, false)
  assert.strictEqual('supportsStreaming' in photo, false)
})
