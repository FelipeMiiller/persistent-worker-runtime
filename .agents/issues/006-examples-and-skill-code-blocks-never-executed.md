# The 20 `examples/` scripts and the shipped skill's code blocks are never executed by CI

**Status**: ✅ **FIXED** — 2026-10-23, on `develop`. Both gates ship (`npm run examples`,
`npm run skill:validate`) and both are wired into CI. The skill gate found **three real defects** in
the shipped skill on its first run. See [Verification](#verification) for what was run and the numbers.

**Discovered**: 2026-10-23, during a state audit of `develop` (HEAD `1ed718d`).
**Component**: `examples/` (20 scripts), `skills/persistent-worker-runtime/` (shipped in the npm
tarball), `.github/workflows/ci.yml`

## Evidence

`ci.yml` runs exactly three things:

```yaml
- name: Run Unit Tests                              # npm test
- name: Run Full Concurrency & Performance Benchmarks # npm run benchmark:all
- name: Verify ESM Package Exports                  # node -e "import * as mod from './src/index.js'"
```

A search of every workflow for `examples` returns **no match**. No test file references
`examples/` either. The 20 example scripts are executed by hand, occasionally.

The skill has the same problem, plus a trigger problem: `skills/**` is entirely `.md`, and all three
workflows carry `paths-ignore: ['**.md', '.github/ISSUE_TEMPLATE/**', 'docs/**', '.agents/**']`.
**CI does not even trigger** when a skill file changes.

## Why this matters — it already cost a shipped bug

`CHANGELOG.md:66` records it:

> **`examples/durable-task-vacuum.js` crashed with `ReferenceError: DatabaseSync is not defined`.**

The example imported `DatabaseSync` without importing it, was listed in the README's examples table,
and was only caught when the docs were reconciled against the filesystem *by hand*. A 10-line CI
step would have caught it at PR time.

The lesson that was extracted at the time was *"docs reconciled against the filesystem **and
executed**"* — but only the first half was institutionalized. The execution half is still manual.

## What is at stake

- `examples/` is the primary API documentation for a library whose selling point is a large,
  non-obvious surface (priority routing, affinity keys, abort signals, zero-copy transfer, durable
  queues, recycling). A broken example is a broken promise to the first user who copies it.
- The skill ships **inside the npm tarball** (`skills/persistent-worker-runtime/`, 9 files, ~66 kB)
  and is loaded by AI agents. A stale code example in the skill is worse than a stale README line:
  the agent will treat it as authoritative and reproduce the bug in someone else's project.
  `skills/.../references/api-reference.md` alone contains ~15 TypeScript code blocks that are never
  compiled or executed.

## Proposed fix

**Step 1 — a script that runs every example.** A new `npm run examples` script iterates
`examples/*.js`, spawns each one with a timeout, and fails on a non-zero exit. Examples that need
arguments or external services should declare it (e.g. a `// requires: <env>` marker) and be
skipped explicitly rather than silently.

**Step 2 — wire it into CI.** One step in `ci.yml`, after `npm test`:

```yaml
- name: Run Examples
  run: npm run examples
```

**Step 3 — narrow the `paths-ignore` for the skill.** `skills/**` should not be silently excluded
from triggering CI. Either remove `**.md` from `paths-ignore` for a `skills/**`-specific rule, or
add a dedicated workflow that validates the skill.

**Step 4 (optional) — execute the skill's code blocks.** Extract fenced `js`/`mjs` blocks from
`skills/**/SKILL.md` and `references/*.md` and run them the same way as the examples. This is the
same class of check as Step 1 applied to the artifact that ships to agents.

## Prevention

- **An example that is not executed is a comment.** If it is the main API documentation, it is a
  test.
- **`paths-ignore` is a decision about what CI protects.** Anything inside the published tarball
  (`files: ["src", "skills", "README.md", "LICENSE"]`) is a shipped artifact and needs a gate.
- **Reconcile docs against the filesystem *and execute them*.** The first half of that rule is
  institutionalized; the second half is not.

## Verification

Everything below was run on `develop` (Windows, Node v24.16.0) on 2026-10-23, after the fix.

### What shipped

| Step | What | Where |
| --- | --- | --- |
| 1 — run every example | `npm run examples` → `scripts/run-examples.js` | `scripts/run-examples.js`, `scripts/lib/spawn.js` |
| 2 — wire it into CI | `Run Examples` step, after `npm test` | `.github/workflows/ci.yml:67` |
| 3 — trigger on skill changes | dedicated workflow using `paths:` (not `paths-ignore`) | `.github/workflows/skill-validation.yml` |
| 4 — execute the skill's blocks | `npm run skill:validate` → `scripts/validate-skill.js` | `scripts/validate-skill.js` |

Both runners share `scripts/lib/spawn.js`: a child process with a **hard wall-clock budget** (a hung
example is killed and fails the gate instead of burning the CI job), verbatim stdout/stderr capture,
and **no shell** (arguments are an array, so a path with a space cannot change the command line). Both
run their children with the working directory **outside** the repository, so an example that writes a
file — `examples/patterns.md`'s `queue.db*`, the vacuum example's SQLite file — cannot leave debris in
the working tree.

`scripts/` is now a linted and formatted source directory like every other one: `biome.json`
`files.includes` and the `noConsole` override both cover `scripts/**/*.js`, and all five lint/format
npm scripts plus `lint-staged` list `scripts/` explicitly.

### Examples gate — measured

```
total: 20 | ok: 20 | skipped: 0 | failed: 0
```

Every one of the 20 examples runs, none is skipped, none fails. `git status --short` after the run is
**clean** — no example leaves a file in the working tree.

### Skill gate — measured, and what it found

Final state (after the fixes below):

```
documents: 9 | fenced blocks: 55
javascript blocks: 35 | executed: 4 | skipped: 4 | fragment: 23
                  | external-dependency: 4 | runtime-error: 0 | syntax-error: 0 | timeout: 0
out-of-scope blocks: 20   (typescript 15, untagged 3, bash 1, sql 1)
```

The 4 `skipped` blocks are excluded on purpose, each with a stated reason: two start an HTTP listener
or fire 100 outbound requests at `httpbin.org` (the gate must not depend on or hammer a third party),
and two only declare code that is never invoked. The 15 TypeScript blocks are out of scope because the
repository is zero-dependency (ADR-0005) and ships no TypeScript compiler — a separate decision.

**On its first run the gate found three real defects in the shipped skill.** All three are fixed.

#### D1 — two blocks did not parse (SYNTAX)

| File:line | Before | After |
| --- | --- | --- |
| `references/observability.md:58` | `const handle = runtime.dispatch({ ... });` | `const handle = runtime.dispatch({ type: 'audit', payload: { id: 1 } });` |
| `references/stateful-l1.md:42-44` | `payload: { ... }, fn: ...` (×3 lines) | `payload: { step: 1..3 }, fn: () => { /* process step */ }` |

`{ ... }` and `fn: ...` are not valid JavaScript. A snippet that does not parse is a broken snippet, and
an agent copies it verbatim.

#### D2 — the skill called a getter as a function

`runtime.stats` is a **getter** (`get stats()` in `src/worker-runtime.js:631`), but
`references/observability.md` called `runtime.stats()` in three places — lines **8**, **53** and
**124**. Anyone following the skill got `TypeError: runtime.stats is not a function`. All three are now
`runtime.stats`.

#### D3 — the priority + cancellation snippet crashed the process

`references/quickstart.md:129` failed with `WorkerRuntimeError: Runtime is shutting down`. Root cause:
the snippet dispatches 10 background tasks fire-and-forget and then calls `await runtime.shutdown()`
while they are still queued. `shutdown()` destroys the queue (`src/worker-runtime.js:1327`), which
rejects those tasks with `WorkerRuntimeError('Runtime is shutting down')`; `dispatch()` does not attach
a handler to the handle promise, so the rejection was **unhandled** and Node took the process down.
The snippet now keeps the handles and settles them (`Promise.allSettled`) before shutting down. It
executes cleanly — the block moved from `runtime-error` to `executed`.

### The gate is a gate now

The first version of `scripts/validate-skill.js` reported a syntax error and **exited 0**. That is not
a gate: a block that does not parse is broken without excuse — it is not a fragment of a larger
program (a fragment still parses) and it is not an external dependency. A syntax error is now fatal,
with the file, the line and the parser message. `FRAGMENT`, `EXTERNAL-DEPENDENCY` and `RUNTIME-ERROR`
stay non-fatal, for the reasons already documented above.

### What was run

| Command | Result |
| --- | --- |
| `npm run examples` | ✅ 20/20 ok, 0 skipped, 0 failed; `git status --short` clean afterwards |
| `npm run skill:validate` | ✅ exit 0 — 0 syntax-error, 0 runtime-error |
| `npm run lint` | ✅ 0 errors (103 files) |
| `npm run format:check` | ✅ 0 errors (103 files) |
| `npm test` | ✅ 624 pass / 0 fail (171 suites) |
| `npm run validate` | ✅ exit 0 (lint + test + hot-path) |
| `npm pack --dry-run` | ✅ 30 files — `scripts/` does not leak into the published tarball |

### Not verified here

- **The two CI workflows have not run yet.** `Run Examples` and `Skill validation` are new steps in
  `ci.yml` / `skill-validation.yml`; the signal comes from CI, not from this session.
- **The 15 TypeScript blocks in `references/api-reference.md` are still never compiled.** That is
  tracked separately in issue 005 — it needs a policy call about adding a TypeScript devDependency
  (ADR-0005).
