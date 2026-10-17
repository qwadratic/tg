#!/usr/bin/env node
/**
 * Keep the VERSION literal in src/index.ts equal to package.json.
 *
 * `npm version minor` bumps package.json only, and eval-72 fails the suite (and
 * so the publish workflow's gates) when the two drift. This runs from the
 * package's own `version` lifecycle script, after the bump and before npm makes
 * its commit, so the literal rides in the same commit as the tag points at.
 * Run it from the package root; it reads and writes relative to the cwd.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync('package.json', 'utf-8'))
const file = 'src/index.ts'
const source = readFileSync(file, 'utf-8')

if (!/^const VERSION = '[^']*'$/m.test(source)) {
  console.error(`::error::${file} has no \`const VERSION = '...'\` line to update`)
  process.exit(1)
}

writeFileSync(file, source.replace(/^const VERSION = '[^']*'$/m, `const VERSION = '${version}'`))
console.log(`${file}: VERSION = ${version}`)
