#!/usr/bin/env node
/**
 * Fail if the published tarball would contain anything that is not runtime code.
 *
 * The package once shipped `test/`, `backlog/`, `tsconfig.json` and an 804kB
 * demo recording to everyone who installed it: 937kB and 256 files, against
 * 80kB and 124 today. The `files` field in package.json fixed that, and this
 * keeps it fixed.
 *
 * Reads `npm pack --dry-run --json`, not the `npm notice` lines. Those lines
 * print bare paths, so a pattern written against a `package/` prefix matches
 * nothing and passes forever - which is exactly the mistake this script replaced.
 */
import { execFileSync } from 'node:child_process'

const FORBIDDEN = [/^test\//, /^backlog\//, /^demo\//, /^\.planning\//, /^\.prompts\//, /^src\//, /^\.github\//, /^scripts\//]
const REQUIRED = ['package.json', 'README.md', 'bin/tg.mjs', 'dist/index.js']
const MAX_BYTES = 400 * 1024

const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf-8' })
const [report] = JSON.parse(raw)
const files = report.files.map((f) => f.path)

const problems = []

for (const path of files) {
  const hit = FORBIDDEN.find((pattern) => pattern.test(path))
  if (hit) problems.push(`ships a non-runtime file: ${path}`)
}

for (const required of REQUIRED) {
  if (!files.includes(required)) problems.push(`missing from the tarball: ${required}`)
}

if (report.size > MAX_BYTES) {
  problems.push(`tarball is ${Math.round(report.size / 1024)}kB, over the ${MAX_BYTES / 1024}kB budget`)
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`)
  console.error(`\n${files.length} files, ${Math.round(report.size / 1024)}kB`)
  process.exit(1)
}

console.log(`package contents ok: ${files.length} files, ${Math.round(report.size / 1024)}kB`)
