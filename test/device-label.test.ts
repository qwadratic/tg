import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workspaceDeviceLabel } from '../src/client.js'

test('device label is <date>/<workdir>, never "mtcute" or "Node.js"', () => {
  const label = workspaceDeviceLabel()

  assert.match(label, /^\d{4}-\d{2}-\d{2}\/[^/]+$/)
  assert.doesNotMatch(label.toLowerCase(), /mtcute|node\.js/)
  assert.ok(label.length <= 48)
})
