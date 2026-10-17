import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * What the installed mtcute really declares, read from its own files.
 *
 * The fence tests need two lists that nobody here maintains by hand, because a
 * hand-kept copy goes stale the day mtcute upgrades: every high-level method of
 * `TelegramClient`, and every RPC method of the Telegram schema. Both come from
 * the dependency that is actually installed, so an upgrade that adds a method
 * changes the answer and the suite notices (coverage manifest, D13f).
 */

/** Directory of the installed `@mtcute/core` package. */
function coreDir(): string {
  // `import.meta.resolve` gives the entry file; the package root is the folder
  // that holds highlevel/ and package.json next to it.
  return dirname(fileURLToPath(import.meta.resolve('@mtcute/core')))
}

/**
 * The method names of `interface TelegramClient`, from the published declaration.
 *
 * Parsed with a pattern rather than a TypeScript program: it has to be fast and it
 * has to fail LOUDLY when the layout changes, so the result is sanity-checked
 * (size, and a few names that must exist) instead of trusted. An empty list
 * would make every check below pass for the wrong reason.
 */
export function clientMethodNames(): string[] {
  const text = readFileSync(join(coreDir(), 'highlevel', 'client.d.ts'), 'utf-8')
  const start = text.indexOf('export interface TelegramClient extends')
  if (start === -1) throw new Error('mtcute changed: no `interface TelegramClient` in highlevel/client.d.ts')

  const names = new Set<string>()
  for (const line of text.slice(start).split('\n')) {
    // The interface closes at column 0; everything after it is another export.
    if (line.startsWith('}')) break
    // A member is one indent in. Property-style members (`readonly onUpdate:`)
    // have a colon before any parenthesis and are events, not methods.
    const match = /^ {4}([A-Za-z_][A-Za-z0-9_]*)\s*[(<]/.exec(line)
    if (match) names.add(match[1]!)
  }
  // The constructor signature is declared with the methods and is not one.
  names.delete('constructor')

  for (const known of ['sendText', 'getMe', 'iterHistory', 'getChatMembers', 'searchMessages']) {
    if (!names.has(known)) throw new Error(`mtcute changed: client.d.ts no longer declares ${known}`)
  }
  if (names.size < 250) throw new Error(`mtcute changed: only ${names.size} client methods found`)
  return [...names].sort()
}

interface SchemaEntry { kind: string; name: string }

/** Every RPC method of the Telegram TL schema bundled with mtcute (`messages.getHistory`, ...). */
export function tlRpcMethods(): Set<string> {
  // @mtcute/tl is a dependency of @mtcute/core, not of this repo, and pnpm does
  // not hoist it: resolve it from where core lives.
  const fromCore = createRequire(join(coreDir(), 'package.json'))
  const schema = JSON.parse(readFileSync(fromCore.resolve('@mtcute/tl/api-schema.json'), 'utf-8')) as { e: SchemaEntry[] }

  const methods = new Set(schema.e.filter((entry) => entry.kind === 'method').map((entry) => entry.name))
  for (const known of ['messages.sendMessage', 'account.getAuthorizations', 'messages.toggleDialogPin']) {
    if (!methods.has(known)) throw new Error(`mtcute changed: the TL schema no longer has ${known}`)
  }
  return methods
}

