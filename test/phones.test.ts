import assert from 'node:assert'
import test from 'node:test'
import { chmodSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ANOTHER_NUMBER,
  MAX_REMEMBERED,
  describeAge,
  forgetPhone,
  historyEnabled,
  maskPhone,
  normalisePhone,
  phoneChoices,
  readPhones,
  rememberPhone
} from '../src/phones/index.js'
import { withTempDir } from './helpers.js'

/**
 * Remembering which numbers this human logs in with.
 *
 * The feature is a convenience, but what it stores is personal data belonging
 * to someone who is not in the room when an agent runs this tool. These evals
 * are mostly about the second part.
 */

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), 'utf-8')

test('eval-101 the most recently used number is offered first, and repeats merge', async () => {
  await withTempDir(() => {
    const path = join(process.cwd(), 'phones.json')
    const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000)

    rememberPhone('+15550001111', { path, now: at(9) })
    rememberPhone('+442071234567', { path, now: at(2) })
    rememberPhone('+15550001111', { path, now: at(0) })

    const records = readPhones(path)
    assert.deepEqual(
      records.map((r) => r.phone),
      ['+15550001111', '+442071234567'],
      'the list is newest first'
    )
    assert.equal(records.length, 2, 'logging in twice with one number is one entry')
    assert.equal(records[0].useCount, 2, 'the repeat is counted, not duplicated')
  })
})

test('eval-102 formatting differences do not create a second entry', async () => {
  // Someone types +1 555 000 1111 once and +15550001111 the next time. Two
  // rows for one phone makes the picker useless exactly as it grows.
  await withTempDir(() => {
    const path = join(process.cwd(), 'phones.json')
    for (const spelling of ['+1 555 000 1111', '+1-555-000-1111', '(1) 555.000.1111', '15550001111']) {
      rememberPhone(spelling, { path })
    }

    const records = readPhones(path)
    assert.equal(records.length, 1, `four spellings of one number produced ${records.length} entries`)
    assert.equal(records[0].phone, '+15550001111', 'stored in E.164')
  })
})

test('eval-103 the list is capped on disk, not just on the way out', async () => {
  await withTempDir(() => {
    const path = join(process.cwd(), 'phones.json')
    for (let i = 0; i < MAX_REMEMBERED + 4; i++) {
      rememberPhone(`+1555000${String(1000 + i)}`, { path, now: new Date(Date.now() + i * 60_000) })
    }

    // Asserting through readPhones would pass even with the write-side cap
    // removed, because reading caps too - and the thing that matters is how
    // many of someone's phone numbers are sitting on the disk.
    const onDisk = JSON.parse(readFileSync(path, 'utf-8')) as unknown[]
    assert.equal(onDisk.length, MAX_REMEMBERED, 'an unbounded history is a liability')
    assert.equal(readPhones(path).length, MAX_REMEMBERED)
  })
})

test('eval-104b a state directory we do not own does not break login', () => {
  // writePhones used to chmod its parent unconditionally. Pointed at a
  // directory owned by someone else - /tmp is the obvious one - that throws
  // EPERM, so remembering a number would crash the login it was helping with.
  // It also meant tg silently changed the mode of directories it did not make.
  const path = join('/tmp', `tg-phones-${process.pid}.json`)
  const before = statSync('/tmp').mode & 0o777

  try {
    assert.doesNotThrow(() => rememberPhone('+15550001111', { path }))
    assert.deepEqual(readPhones(path).map((r) => r.phone), ['+15550001111'])
    assert.equal(statSync(path).mode & 0o777, 0o600, 'the file is still locked down')
    assert.equal(statSync('/tmp').mode & 0o777, before, 'tg must not re-permission a shared directory')
  } finally {
    rmSync(path, { force: true })
  }
})

test('eval-104 the file is 0600, and stays 0600 when rewritten', async () => {
  await withTempDir(() => {
    const path = join(process.cwd(), 'phones.json')

    rememberPhone('+15550001111', { path })
    assert.equal(statSync(path).mode & 0o777, 0o600, 'a phone number is personal data')

    // Widen it the only way that actually works. Using writeFileSync's mode
    // option here would be a no-op on an existing file - which is the very
    // fact this eval exists to pin, and quietly makes the assertion vacuous.
    chmodSync(path, 0o644)
    assert.equal(statSync(path).mode & 0o777, 0o644, 'precondition: the file is now readable')

    rememberPhone('+442071234567', { path })
    assert.equal(statSync(path).mode & 0o777, 0o600, 'a rewrite must re-assert the mode')
  })
})

test('eval-105 a corrupt or hostile file never breaks a login', async () => {
  await withTempDir(() => {
    const path = join(process.cwd(), 'phones.json')

    for (const contents of [
      '',
      'not json at all',
      '{"phone":"+15550001111"}',
      '[{"phone":"; rm -rf /"},{"phone":"not-a-number"},{"phone":42}]',
      '[{"phone":"+15550001111","lastUsedAt":"never","useCount":-3}]',
      '[null,[],"string"]'
    ]) {
      writeFileSync(path, contents)
      const records = readPhones(path)
      assert.ok(Array.isArray(records), `${contents.slice(0, 20)} did not read as a list`)
      for (const record of records) {
        assert.match(record.phone, /^\+[0-9]{7,15}$/, `junk survived: ${record.phone}`)
        assert.ok(record.useCount >= 1, 'a negative use count survived')
        assert.ok(!Number.isNaN(Date.parse(record.lastUsedAt)), 'an unparseable date survived')
      }
    }
  })
})

test('eval-106 forgetting actually removes, and "all" clears', async () => {
  // Storing personal data with no way to remove it is a trap, not a feature.
  await withTempDir(() => {
    const path = join(process.cwd(), 'phones.json')
    rememberPhone('+15550001111', { path })
    rememberPhone('+442071234567', { path })

    assert.equal(forgetPhone('+1 555 000 1111', path), 1, 'forget accepts any spelling')
    assert.deepEqual(readPhones(path).map((r) => r.phone), ['+442071234567'])

    assert.equal(forgetPhone('+99999999999', path), 0, 'forgetting an absent number removes nothing')
    assert.equal(forgetPhone('all', path), 1)
    assert.deepEqual(readPhones(path), [], '"all" leaves nothing behind')
  })
})

test('eval-107 history can be switched off entirely', async () => {
  await withTempDir(() => {
    const path = join(process.cwd(), 'phones.json')
    const previous = process.env.TG_NO_PHONE_HISTORY

    try {
      for (const value of ['1', 'true', 'yes']) {
        process.env.TG_NO_PHONE_HISTORY = value
        assert.equal(historyEnabled(), false, `${value} should disable history`)
        rememberPhone('+15550001111', { path })
        assert.deepEqual(readPhones(path), [], `${value} still wrote a number to disk`)
      }

      for (const value of ['', '0', 'false']) {
        process.env.TG_NO_PHONE_HISTORY = value
        assert.equal(historyEnabled(), true, `${JSON.stringify(value)} should leave history on`)
      }
    } finally {
      if (previous === undefined) delete process.env.TG_NO_PHONE_HISTORY
      else process.env.TG_NO_PHONE_HISTORY = previous
    }
  })
})

test('eval-108 the picker always offers a way to type a different number', () => {
  // Without it, a remembered list becomes a trap the day someone changes phone.
  const now = new Date()
  const records = [
    { phone: '+15550001111', lastUsedAt: new Date(now.getTime() - 3_600_000).toISOString(), useCount: 2 },
    { phone: '+442071234567', lastUsedAt: new Date(now.getTime() - 86_400_000 * 3).toISOString(), useCount: 1 }
  ]

  const choices = phoneChoices(records, now)
  assert.equal(choices.length, records.length + 1)
  assert.deepEqual(choices.slice(0, 2).map((c) => c.value), records.map((r) => r.phone))
  assert.equal(choices.at(-1)?.value, ANOTHER_NUMBER, 'the escape hatch must be last')
  assert.equal(choices[0].hint, 'last used 1h ago')
  assert.equal(choices[1].hint, 'last used 3d ago')

  assert.equal(phoneChoices([], now).length, 1, 'with no history there is still a way through')
  assert.equal(normalisePhone(ANOTHER_NUMBER), null, 'the sentinel must not be a valid number')
})

test('eval-109 a number is only remembered after Telegram accepts it', () => {
  // Recording at the point it is typed fills the picker with numbers that do
  // not work - worse than an empty picker, because it looks authoritative.
  const auth = src('auth.ts')

  const remembers = [...auth.matchAll(/rememberPhone\(/g)]
  assert.ok(remembers.length >= 3, `expected every success path to record, found ${remembers.length}`)

  const sendCode = auth.indexOf('sendCode')
  assert.ok(sendCode !== -1)
  for (const match of remembers) {
    assert.ok(
      match.index > sendCode,
      'a number is recorded before Telegram has been asked about it'
    )
  }

  // Every path that returns a User should have recorded first.
  const returns = [...auth.matchAll(/^\s*return user$/gm)]
  assert.ok(returns.length >= 2, `expected the sign-in and 2FA returns, found ${returns.length}`)
  for (const ret of returns) {
    const preceding = auth.slice(0, ret.index)
    assert.ok(
      preceding.lastIndexOf('rememberPhone(') > preceding.lastIndexOf('s.start('),
      'a successful login returned without recording the number it used'
    )
  }
})

test('eval-110 numbers are masked everywhere they can outlive the terminal', () => {
  assert.equal(maskPhone('+15550001111'), '+15•••••1111')
  assert.equal(maskPhone('+442071234567'), '+44••••••4567')
  assert.doesNotMatch(maskPhone('+15550001111'), /5550001/, 'the middle must not survive')

  // --json is what an agent pipes into a transcript, so it must be masked
  // unless a human explicitly asked and is present to read it.
  const command = src('cli/commands/session.ts')
  const phones = command.slice(command.indexOf(".command('phones')"))
  const body = phones.slice(0, phones.indexOf(".command('status')"))

  assert.match(body, /maskPhone/, 'the listing must be able to mask')
  assert.match(body, /canPrompt\(\)/, '--reveal must require a human to be present')
  assert.match(body, /EXIT\.needsHuman/, 'refusing --reveal unattended is a human-needed refusal')

  const reveal = body.indexOf('const reveal')
  assert.ok(reveal !== -1 && reveal < body.indexOf('maskPhone'), 'masking must be the default path')
})

test('eval-111 the phone store cannot reach Telegram, an LLM or gbrain', () => {
  // It holds personal data belonging to someone who is not in the room. The
  // trust boundary that keeps credentials away from gbrain applies here too.
  const store = src('phones/index.ts')

  for (const forbidden of ['@mtcute', 'gbrain', 'openai', 'anthropic', 'fetch(', 'spawn', 'exec']) {
    assert.ok(!store.includes(forbidden), `the phone store reaches ${forbidden}`)
  }

  const imports = [...store.matchAll(/from '([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(
    imports.sort(),
    ['../paths.js', 'node:fs', 'node:path'],
    'the store should need nothing but a path and a file'
  )
})

test('eval-112 relative ages read the way a person would say them', () => {
  const now = new Date('2026-08-19T12:00:00Z')
  const ago = (ms: number) => describeAge(new Date(now.getTime() - ms).toISOString(), now)

  assert.equal(ago(30_000), 'just now')
  assert.equal(ago(5 * 60_000), '5m ago')
  assert.equal(ago(3 * 3_600_000), '3h ago')
  assert.equal(ago(4 * 86_400_000), '4d ago')
  assert.equal(ago(90 * 86_400_000), '3mo ago')
  assert.equal(describeAge('not a date', now), 'unknown')
})
