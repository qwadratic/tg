import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { workspaceDeviceLabel } from '../src/client.js'
import { friendlyHostname } from '../src/hosts.js'
import { withTempDir } from './helpers.js'

test('device label is <date>/<workdir>@<host>, never "mtcute" or "Node.js"', () => {
  const label = workspaceDeviceLabel()

  assert.match(label, /^\d{4}-\d{2}-\d{2}\/[^/@]+@[^/@]+$/)
  assert.doesNotMatch(label.toLowerCase(), /mtcute|node\.js/)
  assert.ok(label.length <= 48)
})

test('friendlyHostname falls back to the raw name with no alias file', () => {
  assert.equal(friendlyHostname('MacBookPro.home', '/nonexistent/hosts.json'), 'MacBookPro.home')
})

test('friendlyHostname reads an alias when one is configured', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'hosts.json')
    writeFileSync(path, JSON.stringify({ 'MacBookPro.home': 'qwadratic-laptop' }))
    assert.equal(friendlyHostname('MacBookPro.home', path), 'qwadratic-laptop')
    // An unmapped host on the same file still falls back to itself.
    assert.equal(friendlyHostname('some-other-host', path), 'some-other-host')
  })
})

test('friendlyHostname tolerates a malformed alias file', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'hosts.json')
    writeFileSync(path, 'not json')
    assert.equal(friendlyHostname('MacBookPro.home', path), 'MacBookPro.home')
  })
})
