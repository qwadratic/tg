# D13f — core reads and fence hardening

Date: 2026-10-17 | Author: agent, on the operator's instruction of 2026-10-17
Status: accepted
Amends: D13c (2026-08-31), whose admission that "a raw `tg.call` twin would not be caught" is closed here; D13b (2026-08-30), whose `WRITE_TL_METHODS` gains a reading counterpart
Scope: `test/trust.test.ts` (evals 29-31, 175-180), `test/fence-scan.ts`, `test/mtcute-api.ts`, `test/coverage-manifest.ts`; the read verbs of 0.8.0 (sections below, added with the commits that ship them). Answers question 3 of TASK-43's section 8.

## Decision

Phase 0.8 of TASK-43 has two halves, shipped together as 0.8.0 and sharing this record. It adds no write RPC and widens nothing the account can do to other people.

1. **The fence is checked from the syntax tree and from the installed mtcute, deny by default.** What the first generation enforced with hand-kept lists and text patterns is now derived. This half is hardening only: it can make a suite fail that used to pass, never the reverse.
2. **Core reads become verbs.** Chat info and the admin log, a single member, messages by id, link and thread, live search, user info, contacts, dialogs, drafts, scheduled messages, reactions, and the account's sessions and privacy and notification settings, plus `--topic` and `--thread` on `dump`. Every one reads; none can reach `src/send/`.
3. **`src/send/index.ts` is not split in this release.** See "Question 3".

The operator answered TASK-43's open questions on 2026-10-17 with "делай как рекомендуешь"; the recommendation for question 3, recorded below, is the one this release follows.

## Fence hardening

All four checks live in `test/trust.test.ts`. Their scanners are in `test/fence-scan.ts`, which parses each file of `src/` with the TypeScript compiler API (no type-check, so it is fast), and each eval runs a scanner on synthetic files first, then on the real tree, then on the real tree with a violation injected next to it (the D14 tripwire check). Reading the syntax tree instead of the text is what makes them immune to a comment that mentions a method, a string that looks like a call, a regex literal, and a quote style.

### 1. Raw-call tripwire (eval-175)

D13b put `messages.toggleDialogPin` and `account.updateNotifySettings` on `WRITE_TL_METHODS` and D13c admitted the rest: a raw `tg.call({ _: 'messages.sendMessage' })` anywhere outside `src/send/` passed every test, because nobody had listed that method. The rule now runs the other way.

- Outside `src/send/`, a `.call(...)` (also `['call'](...)`, `tg._client.call(...)`) passes only if its first argument is an object literal whose `_` is a string literal that is on `READ_TL_METHODS`. A variable, a spread or a computed `_` is refused on its own: a call that cannot be read cannot be fenced.
- Any object literal outside `src/send/` that writes out an RPC method name (`_: 'messages.sendMessage'`) is refused unless it is a listed read, even if it is only built there and passed in later. Which names are methods and which are constructors (`inputPeerEmpty`, which a read needs to describe its question) is read from the TL schema bundled with mtcute, not from a naming convention.
- `const { call } = tg` is refused: it hides every later raw call from the scan.
- Inside `src/send/` a raw call must still be listed, as a write or a read. eval-29b only checked the positive direction (a listed method appears), so an unlisted raw write in the one file allowed to write was invisible.
- `READ_TL_METHODS` and `WRITE_TL_METHODS` must name real methods of the installed TL schema (a typo fences nothing), and every entry of `READ_TL_METHODS` must be a `get*` method, so a write cannot be put on the list by mistake.

### 2. Alias tripwire (eval-176)

eval-29 matches `.sendText(`. These are the other ways to hold the same method, refused outside the allowlisted files: `tg.sendText` that is not called (taken, passed, bound), `tg['sendText']`, `const { sendText } = tg` and `{ sendText: post }`, `Reflect.get(tg, 'sendText')` and `'sendText' in tg`, and an indexing of the client with a name that is not a literal (`tg[method](...)`). Plain calls stay eval-29's job, so no violation is reported twice. Two TL flag names share a spelling with a fenced method (`deleteMessages`, an admin right; `sendMedia`, a restriction); property access on something named rights, permissions or restrictions, and a bare string, are not aliases.

### 3. eval-31, derived from the module graph

The old eval-31 listed five entry points by hand, so a new read verb was checked only if somebody remembered to add it. Now:

- Every file under `src/cli/commands/` is classified in `COMMAND_CLASS` (write, legacy-write, unattended, read, plumbing). A command file in no class fails the suite until somebody decides what it is.
- The write class is exactly the command files on `WRITE_ALLOWLIST`, and `legacy-write` is exactly the commands that import `src/contacts/import.ts` (`check-phones`, D13's older exception).
- The set of files whose import closure reaches `src/send/index.ts` or `src/send/gate.ts` must equal five named files: `index.ts` (the registration root), `cli/commands/send.ts`, `cli/commands/group.ts`, `send/gate.ts` and `send/index.ts`. Every other file in `src/`, including every read module, today's and tomorrow's, cannot. `group.ts` mixes reads and writes, so its reads are checked through the read module they import, which this rule covers like any other file.
- The walk is built from the syntax tree, so a side-effect import (`import '../send/gate.js'`), `export * from`, a dynamic `import('...')` and `require` are edges (eval-177), and a dynamic import whose argument is not a literal fails the suite instead of being skipped. The text pattern it replaces saw only `from '...'`. eval-30 and eval-32 use the same walk.

### 4. Coverage manifest (evals 178-180)

`test/coverage-manifest.ts` classifies every method of mtcute's `TelegramClient` and a curated set of raw TL methods, as TASK-43 planned: `covered`, `planned:<release>`, `defer`, `never`, `excluded:<reason>`.

- The method names are read from the installed `@mtcute/core` declaration (`highlevel/client.d.ts`) and the RPC methods from the TL schema bundled with it. A method mtcute adds that is not in the manifest fails eval-178, so an upgrade cannot widen what the account can do without somebody deciding what the new method is; a method mtcute removes fails it too, so the manifest cannot rot. A test shows the deny-by-default by adding a fictitious method.
- The manifest has a second axis that TASK-43 did not ask for, and it is what lets it do fence work: each entry is `read`, `write` or `session` (the login lifecycle). eval-179 then holds the manifest and the code to each other: a method marked covered is called from `src/` (or its `iter*` twin is); outside the allowlisted files only reads and the login lifecycle are called; a write that is called anywhere is on `WRITE_RPCS` (or is one of the two older `check-phones` calls, `importContacts` and `deleteContacts`, which 0.9 moves into `src/send/`). That closes a hole eval-29 could not: a write method nobody had put on `WRITE_RPCS`, called from any file, was invisible.
- eval-180: a `never` method is called nowhere, and the raw TL methods written out in `src/` are exactly the ones the raw manifest calls covered, which are exactly `READ_TL_METHODS` plus `WRITE_TL_METHODS`.
- The 307 names split into 90 excluded (12 login, 21 internal, 17 `iter*` twins, 24 variants, 16 bot-only) and 217 in scope, the denominator TASK-43 counts against. Where TASK-43's hand-made table (never 25, defer 20) and its section 6 (the reasons) disagree, section 6 won: the manifest has 29 never and 16 defer, and the totals are unchanged.

## Question 3: `src/send/index.ts` stays one file

TASK-43 asked whether to split the send module by area, which would turn the fence from "one file" into "one directory". The operator's instruction was to split it in this release only if the read verbs had to touch it, and never to mix a refactor with features.

- **They do not touch it.** Every read verb here lives in its own module under `src/` and imports nothing from `src/send/`; the one thing a read needs that lives there, the mapping of Telegram's refusals to exit codes (`friendlyTelegramError`), is not imported either: the reads get their own mapper in `src/reads/errors.ts`, so the send module is byte-for-byte unchanged by 0.8.0.
- **Answer: keep one file.** Today it is 1654 lines (TASK-43 counted 1133 before the 0.6 and 0.7 verbs) and the roadmap adds about 300 a phase. What the single file buys is that "every write RPC in this codebase is in this one file" is true of a file a reviewer can open, which is the property D13 was built around; a directory keeps the property but changes what eval-29, eval-29b, eval-31's `WRITE_CAPABLE`, the allowlist and AGENTS.md all say. Nothing in phase 0.8 or 0.9 is blocked by the size.
- **The trigger to revisit** is a phase whose review cannot be done in one sitting, or the file passing 2500 lines. If it is split, it is its own pull request that moves code and changes no behaviour, the fence becomes the prefix `send/`, and eval-29, 29b, 31, the raw tripwire (which already treats `send/` as a prefix) and AGENTS.md are updated in the same commit. TASK-43's acceptance criterion 12, which asks for this answer before 0.10 starts, is met by this record.

## Limits, said plainly

The fence still matches syntax, not semantics. A method name assembled at run time (`tg['send' + 'Text']`), `eval`, `Function(...)` and code loaded from outside `src/` are not caught by anything short of running the code. The dynamic-lookup rule makes the common spelling of that (`tg[name]`) a failure of its own; the rest is the review that D13 already relies on.
