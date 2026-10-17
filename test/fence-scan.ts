import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/**
 * Syntax-level scanners for the fence tests (D13f).
 *
 * The first generation of the fence (eval-29) greps for `.name(` in the text. That
 * is cheap and it has two known holes, both named in D13c: it matches call SYNTAX,
 * so an alias or a raw twin walks past it, and it matches TEXT, so a comment that
 * mentions a method looks like a call. These scanners read each file with the
 * TypeScript parser instead, so comments, strings and regexes are what they are,
 * and an alias is a node they can ask about.
 *
 * They are still syntax, not semantics: `tg['send' + 'Text']` is not caught by
 * anything short of running the code, and the dynamic-lookup rule below exists to
 * make that spelling a failure of its own rather than a quiet escape.
 *
 * Everything here is a pure function over `{ path, source }` pairs, so a test can
 * inject a violating file next to the real sources and watch the scanner fail
 * (the D14 tripwire check).
 */

export interface SourceText {
  /** Path relative to src/, with forward slashes: `send/index.ts`. */
  path: string
  source: string
}

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url))

/** Every .ts file under src/, read once. */
export function loadSources(dir = SRC_DIR, prefix = ''): SourceText[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) return loadSources(path, relative)
    return entry.name.endsWith('.ts') ? [{ path: relative, source: readFileSync(path, 'utf-8') }] : []
  })
}

function parse(file: SourceText): ts.SourceFile {
  return ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function where(sf: ts.SourceFile, node: ts.Node): string {
  return `${sf.fileName}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`
}

/** The text of a string literal or a plain template literal, else null. */
function literalText(node: ts.Node | undefined): string | null {
  if (!node) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return null
}

function propertyKeyText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text
  return null
}

function walk(sf: ts.SourceFile, visit: (node: ts.Node) => void): void {
  const step = (node: ts.Node): void => {
    visit(node)
    ts.forEachChild(node, step)
  }
  step(sf)
}

/* ------------------------------------------------------------------ raw TL */

export interface RawCall {
  where: string
  /** The method literal in `{ _: '...' }`, or null when the call cannot be read statically. */
  method: string | null
}

/** The `_` string of an object literal, if it has one as a plain literal. */
function objectMethod(node: ts.Expression | undefined): string | null | undefined {
  if (!node || !ts.isObjectLiteralExpression(node)) return undefined
  for (const prop of node.properties) {
    if (ts.isPropertyAssignment(prop) && propertyKeyText(prop.name) === '_') {
      return literalText(prop.initializer)
    }
  }
  return null
}

/**
 * Every `.call(...)` (also `['call'](...)`) in a file, with the TL method it names.
 *
 * `method: null` means the first argument is not an object literal with a literal
 * `_`: a variable, a spread, a computed name. That cannot be fenced by name, so
 * outside the fence it is a violation by itself.
 */
export function findRawCalls(file: SourceText): RawCall[] {
  const sf = parse(file)
  const found: RawCall[] = []

  walk(sf, (node) => {
    if (!ts.isCallExpression(node)) return
    const callee = node.expression
    const isCall =
      (ts.isPropertyAccessExpression(callee) && callee.name.text === 'call') ||
      (ts.isElementAccessExpression(callee) && literalText(callee.argumentExpression) === 'call')
    if (!isCall) return

    const method = objectMethod(node.arguments[0])
    found.push({ where: where(sf, node), method: typeof method === 'string' ? method : null })
  })

  return found
}

/** Binding or property names that alias a raw call: `const { call } = tg`. */
export function findCallAliases(file: SourceText): string[] {
  const sf = parse(file)
  const found: string[] = []

  walk(sf, (node) => {
    if (ts.isBindingElement(node)) {
      const bound = node.propertyName ? propertyKeyText(node.propertyName) : ts.isIdentifier(node.name) ? node.name.text : null
      if (bound === 'call') found.push(where(sf, node))
    }
  })

  return found
}

/**
 * Every object literal with a `_: '<name>'` property whose name is a TL RPC method,
 * wherever it appears and whatever it is passed to.
 *
 * Constructor names (`inputPeerEmpty`, `inputNotifyUsers`) are data a read needs
 * to describe its question and are not listed here; the schema says which names
 * are methods, so the check does not depend on a naming convention.
 */
export function findMethodLiterals(
  file: SourceText,
  isMethod: (name: string) => boolean,
  options: { excludeCallArguments?: boolean } = {}
): { where: string; method: string }[] {
  const sf = parse(file)
  const found: { where: string; method: string }[] = []

  walk(sf, (node) => {
    if (!ts.isObjectLiteralExpression(node)) return
    // The request handed straight to `.call(...)` is the call's own business and is
    // reported there; counting it twice would make every violation read as two.
    if (options.excludeCallArguments && isRawCallArgument(node)) return
    for (const prop of node.properties) {
      if (!ts.isPropertyAssignment(prop) || propertyKeyText(prop.name) !== '_') continue
      const text = literalText(prop.initializer)
      if (text !== null && isMethod(text)) found.push({ where: where(sf, prop), method: text })
    }
  })

  return found
}

function isRawCallArgument(node: ts.ObjectLiteralExpression): boolean {
  const parent = node.parent
  if (!ts.isCallExpression(parent) || parent.arguments[0] !== node) return false
  const callee = parent.expression
  return (
    (ts.isPropertyAccessExpression(callee) && callee.name.text === 'call') ||
    (ts.isElementAccessExpression(callee) && literalText(callee.argumentExpression) === 'call')
  )
}

/**
 * The raw-call tripwire.
 *
 * Outside `src/send/`, a raw TL call passes only if it is a literal naming a method
 * in `readMethods`. Inside, it must name a listed write or read: an unlisted raw
 * write in the one file that is allowed to write is the case eval-29b cannot see.
 */
export function rawCallViolations(
  files: SourceText[],
  lists: { readMethods: readonly string[]; writeMethods: readonly string[]; isMethod: (name: string) => boolean }
): string[] {
  const violations: string[] = []
  const reads = new Set(lists.readMethods)
  const writes = new Set(lists.writeMethods)

  for (const file of files) {
    const inFence = file.path.startsWith('send/')

    for (const call of findRawCalls(file)) {
      if (call.method === null) {
        violations.push(`${call.where}: a raw call whose method is not a string literal cannot be checked`)
      } else if (inFence && !writes.has(call.method) && !reads.has(call.method)) {
        violations.push(`${call.where}: raw call ${call.method} is not in WRITE_TL_METHODS or READ_TL_METHODS`)
      } else if (!inFence && !reads.has(call.method)) {
        violations.push(`${call.where}: raw call ${call.method} outside src/send/ is not in READ_TL_METHODS`)
      }
    }

    if (inFence) continue

    for (const alias of findCallAliases(file)) {
      violations.push(`${alias}: \`call\` is destructured, which hides a raw call from the scan`)
    }
    // A request built first and passed in later is a call this scan cannot see
    // the argument of: the literal itself is the evidence.
    for (const literal of findMethodLiterals(file, lists.isMethod, { excludeCallArguments: true })) {
      if (!reads.has(literal.method)) {
        violations.push(`${literal.where}: the TL method ${literal.method} is written out outside src/send/ and is not in READ_TL_METHODS`)
      }
    }
  }

  return violations
}

/* ------------------------------------------------------------------- alias */

/**
 * The alias tripwire: a fenced name used in any way other than a plain call, outside
 * the files that may name it.
 *
 * - `tg.sendText` that is not called (assigned, passed, bound)
 * - `tg['sendText']`
 * - `const { sendText } = tg`, `const { sendText: send } = tg`
 * - the string `'sendText'` handed to Reflect or Object, or used with `in`
 * - `tg[name]` on the client with a name that is not a literal: a dynamic lookup
 *
 * Plain calls are eval-29's business and stay there; this covers everything that
 * regex cannot see.
 */
export function aliasViolations(
  files: SourceText[],
  fenced: readonly string[],
  allowlist: ReadonlySet<string>
): string[] {
  const names = new Set(fenced)
  const violations: string[] = []

  for (const file of files) {
    if (allowlist.has(file.path)) continue
    const sf = parse(file)

    walk(sf, (node) => {
      if (ts.isPropertyAccessExpression(node) && names.has(node.name.text)) {
        const called = ts.isCallExpression(node.parent) && node.parent.expression === node
        // `rights.deleteMessages` and `restrictions.sendMedia` are TL flag names that
        // happen to share a spelling with a method; the object says which it is.
        const isFlag = /(rights|permissions|restrictions)/i.test(node.expression.getText(sf))
        if (!called && !isFlag) violations.push(`${where(sf, node)}: .${node.name.text} is used without being called`)
      } else if (ts.isElementAccessExpression(node)) {
        const key = literalText(node.argumentExpression)
        if (key !== null && names.has(key)) {
          violations.push(`${where(sf, node)}: bracket access to ${key}`)
        } else if (key === null && /^(tg|client|_client|this\.tg|this\.client)$/.test(node.expression.getText(sf))) {
          violations.push(`${where(sf, node)}: the client is indexed with a name that is not a literal`)
        }
      } else if (ts.isBindingElement(node)) {
        const bound = node.propertyName ? propertyKeyText(node.propertyName) : ts.isIdentifier(node.name) ? node.name.text : null
        if (bound !== null && names.has(bound)) violations.push(`${where(sf, node)}: ${bound} is destructured`)
      } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        // A bare string equal to a fenced name is only an alias when it is used to
        // LOOK UP the method: `Reflect.get(tg, 'sendText')`, `'sendText' in tg`. Other
        // strings with that spelling are unrelated names (TL field names such as the
        // `sendMedia` restriction flag in groups/rights.ts) and must not be flagged.
        if (!names.has(node.text)) return
        const parent = node.parent
        const lookup =
          (ts.isCallExpression(parent) && /^(Reflect|Object)\./.test(parent.expression.getText(sf))) ||
          (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InKeyword && parent.left === node)
        if (lookup) violations.push(`${where(sf, node)}: the string "${node.text}" is used to look up a fenced method`)
      }
    })
  }

  return violations
}

/* ------------------------------------------------------------ client calls */

/**
 * Every place a name from `known` is used as a property: `tg.getMe(...)`, a
 * callback `tg.getMe`, `tg['getMe']`. The object does not matter: matching on the
 * name alone errs towards reporting, and a false positive is a test to read, where
 * a false negative would be a hole.
 */
export function clientUses(files: SourceText[], known: ReadonlySet<string>): { path: string; name: string; where: string }[] {
  const found: { path: string; name: string; where: string }[] = []

  for (const file of files) {
    const sf = parse(file)
    walk(sf, (node) => {
      if (ts.isPropertyAccessExpression(node) && known.has(node.name.text)) {
        found.push({ path: file.path, name: node.name.text, where: where(sf, node) })
      } else if (ts.isElementAccessExpression(node)) {
        const key = literalText(node.argumentExpression)
        if (key !== null && known.has(key)) found.push({ path: file.path, name: key, where: where(sf, node) })
      }
    })
  }

  return found
}

/** Every literal `_: 'x'` in src whose value is a TL RPC method, by file. */
export function rawMethodsNamed(files: SourceText[], isMethod: (name: string) => boolean): { path: string; method: string }[] {
  return files.flatMap((file) => findMethodLiterals(file, isMethod).map((l) => ({ path: file.path, method: l.method })))
}

/* ------------------------------------------------------------ import graph */

export interface ImportEdges {
  /** Files under src/ this file imports, as `dir/name.ts` paths. */
  to: string[]
  /** Imports the walk cannot follow: a dynamic `import(x)` or `require(x)` with a non-literal argument. */
  unfollowable: string[]
}

/**
 * What a file imports, from the syntax tree.
 *
 * The first generation of eval-30 and eval-31 matched `from '...'` in the text,
 * which does not see `import '../send/index.js'` (a side-effect import), a dynamic
 * `import('../send/index.js')`, or `require`. Those are the ways to link the send
 * module that a text pattern misses, so they are edges here, and a dynamic import
 * whose argument is not a literal is reported as unfollowable rather than ignored.
 */
export function importEdges(file: SourceText): ImportEdges {
  const sf = parse(file)
  const specifiers: string[] = []
  const unfollowable: string[] = []

  walk(sf, (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const text = literalText(node.moduleSpecifier)
      if (text !== null) specifiers.push(text)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const text = literalText(node.moduleReference.expression)
      if (text !== null) specifiers.push(text)
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression
      const dynamic = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')
      if (!dynamic) return
      const text = literalText(node.arguments[0])
      if (text === null) unfollowable.push(where(sf, node))
      else specifiers.push(text)
    }
  })

  const dir = dirname(file.path)
  const to = specifiers
    .filter((spec) => spec.startsWith('.'))
    .map((spec) => posix.normalize(posix.join(dir, spec.replace(/\.js$/, '.ts'))))
  return { to, unfollowable }
}

/** `path -> files it imports`, for a whole source set. */
export function importGraph(files: SourceText[]): { graph: Map<string, string[]>; unfollowable: string[] } {
  const graph = new Map<string, string[]>()
  const unfollowable: string[] = []
  for (const file of files) {
    const edges = importEdges(file)
    graph.set(file.path, edges.to)
    unfollowable.push(...edges.unfollowable)
  }
  return { graph, unfollowable }
}

/** Every file reachable from `entries` by imports, the entries included. */
export function closureOf(graph: ReadonlyMap<string, string[]>, entries: string[]): Set<string> {
  const seen = new Set<string>()
  const queue = [...entries]
  while (queue.length > 0) {
    const path = queue.pop() as string
    if (seen.has(path)) continue
    seen.add(path)
    queue.push(...(graph.get(path) ?? []))
  }
  return seen
}
