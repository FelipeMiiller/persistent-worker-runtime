# Node 26 becomes LTS on 2026-10-28: CI matrix, `lts/*` auto-flip, unverified engine floor, and DEP0210

**Status**: ✅ **FIXED** — 2026-10-23, on `develop`. All four gaps closed (CI matrix leg, `lts/*` pin,
engine-floor job, DEP0210 shim). The new `26.x` leg then failed on its first run and surfaced a
**fifth** gap (the test suite fails on Node 26) — also fixed and verified on Node v26.12.1.
See [Verification](#verification) for what was run and the numbers.

**Discovered**: 2026-10-23, during a state audit of `develop` (HEAD `1ed718d`).
**Component**: `.github/workflows/ci.yml`, `.github/workflows/lint.yml`, `.github/workflows/coverage.yml`, `.github/workflows/commit-lint.yml`, `package.json` (`engines`), `src/queue/sqlite-backend.js`

## Evidence

Node release lines relevant to this package, as of 2026-10-23 (source: `nodejs/release` schedule table,
`nodejs.org/en/about/previous-releases`, `endoflife.date/nodejs`):

| Line | First release | LTS start | Maintenance start | EOL |
| --- | --- | --- | --- | --- |
| 22.x (Jod) | 2024-04-24 | 2024-10-29 | 2025-10-21 | 2027-04-30 |
| 24.x (Krypton) | 2025-05-06 | 2025-10-28 | **2026-10-20** | 2028-04-30 |
| 26.x | 2026-05-05 | **2026-10-28** | 2027-10-20 | 2029-04-30 |

Latest releases at discovery time: `v22.23.4`, `v24.22.1`, `v26.12.1` (all three shipped security
fixes on 2026-10-21).

## Gap 1 — the test matrix does not include Node 26

`.github/workflows/ci.yml:39` pins:

```yaml
node-version: [22.x, 24.x]
```

Node 26 is the line that becomes Active LTS in five days, and it is the line with the newest V8
(14.6) and the most platform churn. A defect that only reproduces on Node 26 would be found by
*users* on the new LTS, not by this CI.

**Proposed fix**: `node-version: [22.x, 24.x, 26.x]`. Cost is one more matrix leg per OS.

## Gap 2 — `lts/*` flips the CI runtime on a date nobody chose

`lint.yml:42`, `coverage.yml:41` and `commit-lint.yml:21` all use:

```yaml
node-version: lts/*
```

Today `lts/*` resolves to Node 24. On **2026-10-28** it silently resolves to Node 26 — no commit, no
review, no changelog entry. If Node 26 changes anything the Linters or Coverage workflows depend
on, the repo goes red on a date the team did not pick, and the failure looks unrelated to any change
under review.

**Proposed fix**: pin explicit versions (`node-version: 24.x`) and add Node 26 as an explicit matrix
leg, so the runtime change is a reviewed diff rather than an ambient one.

## Gap 3 — the declared engine floor is never tested

`package.json` declares `"engines": { "node": ">=22.13.0" }`. The floor is real and deliberate:
`node:sqlite` stopped requiring the `--experimental-sqlite` flag exactly in **22.13.0**
(`nodejs/node` PR #55890), and `src/queue/sqlite-backend.js` imports `node:sqlite` at the top level.

But the matrix uses `22.x`, which resolves to the **latest** 22.x (22.23.4). The floor itself is
never exercised, so a change that silently raises the real minimum (a newer builtin, a newer
`worker_threads` behaviour) would ship while `engines` still claims 22.13.0.

**Proposed fix**: add one CI leg pinned to `22.13.0` (Linux only, to keep the cost down) that
runs `npm test`.

## Gap 4 — DEP0210: `DatabaseSync` is a deprecated alias, and it is imported at the top level

Node renamed `node:sqlite`'s `DatabaseSync` to `Database` in **26.11.0**. Verified in the Node
source at `v26.12.1` (`lib/sqlite.js`):

```js
module.exports = {
  Database,
  // DEP0210: Documentation-only deprecation, kept for backward
  // compatibility with the class's pre-rename name.
  DatabaseSync: Database,
  Statement,
  // DEP0211: Documentation-only deprecation, ...
  StatementSync: Statement,
  ...
};
```

So **nothing breaks today** — the alias is still exported, on every supported line (22.13+ only ever
exported `DatabaseSync`; 26.11+ exports both). The risk is forward-looking:

- `src/queue/sqlite-backend.js:43` does `import { DatabaseSync } from 'node:sqlite';` at module
  scope, and `src/index.js` re-exports `SqliteTaskQueue` from that module. When Node removes the
  DEP0210 alias, the failure is a `SyntaxError` at **import time of the whole package** — not a
  degraded SQLite backend. Every consumer of the library breaks, including those who never touch
  the durable queue.
- `examples/durable-task-vacuum.js:40` and `test/sqlite-queue.test.js` carry the same import.

**Proposed fix** — a namespace import with a fallback that works on both naming eras:

```js
import * as nodeSqlite from 'node:sqlite';
// `DatabaseSync` was renamed to `Database` in Node 26.11 (DEP0210). The old
// name is still exported today, but the canonical spelling differs per line.
const DatabaseCtor = nodeSqlite.Database ?? nodeSqlite.DatabaseSync;
```

Then `new DatabaseCtor(options.path)`. Add a test asserting the resolved constructor is a function,
so the shim itself is covered on whatever Node runs it.

## Prevention

- **`lts/*` in CI is an ambient dependency.** Pin the version; treat the LTS flip as a reviewed
  change (add the leg, run it, then bump the pin).
- **A declared engine floor is a promise that needs a test.** The floor must appear in the matrix
  literally, not just in `package.json`.
- **A top-level import of a renamed builtin is a package-wide failure mode.** Anything imported at
  module scope by `src/index.js` must degrade gracefully or be version-agnostic, because a missing
  export breaks the whole public entry point.

## Verification

Everything below was run on `develop` (Windows, Node v24.16.0) on 2026-10-23, after the fix.

### What changed

| Gap | Fix | Where |
| --- | --- | --- |
| 1 — no Node 26 leg | `node-version: [22.x, 24.x, 26.x]` | `.github/workflows/ci.yml:43` |
| 2 — `lts/*` auto-flip | pinned to `24.x`, with the reason in a comment | `.github/workflows/lint.yml:46`, `coverage.yml:45`, `commit-lint.yml:25` |
| 3 — engine floor untested | new `engine-floor` job: Node **22.13.0**, `ubuntu-latest`, `npm test` only | `.github/workflows/ci.yml:76` (job), `ci.yml:98` (setup), `ci.yml:111` (test step) |
| 4 — DEP0210 `DatabaseSync` | namespace import + runtime resolution, exported as `DatabaseCtor` | `src/queue/sqlite-backend.js:43` (import), `:54` (shim), `:171` (use); `examples/durable-task-vacuum.js:40,47,108`; `test/sqlite-queue.test.js:5,47` |
| 5 — **found by the new leg** | 6 Node 26 built-ins added to the leak-check allowlist | `test/common.js:513-529` |

The DEP0210 shim is deliberately a **namespace import** (`import * as nodeSqlite from 'node:sqlite'`)
followed by `nodeSqlite.Database ?? nodeSqlite.DatabaseSync`. A namespace import of a module that
lacks a member does not throw at import time; a *named* import of a removed member does — which is
exactly the package-wide failure mode this issue describes. `DatabaseCtor` is exported from
`src/queue/sqlite-backend.js` so the shim itself is covered by a test on whichever Node line runs the
suite. It is **not** re-exported from `src/index.js`, so the public API surface is unchanged (still
16 names).

### Gap 5 — the new leg failed on its first run, and it was right to

Adding the `26.x` leg immediately produced **3 failures** (ubuntu, macos, windows) in the `Run Unit
Tests` step — while `22.x`, `24.x` and the `engine-floor` job all passed. Root cause:

`test/common.js` keeps a **static** allowlist of the platform's global surface, and the exit-time
leak check compares `globalThis` against it **by name**:

```js
export function getLeakedGlobals() {
  const leaked = [];
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    if (!expectedGlobalKeys.has(name)) leaked.push(name);
  }
  return leaked;
}
```

Node 26 adds six built-ins — `ErrorEvent`, `QuotaExceededError`, `Storage`, `Temporal`,
`localStorage`, `sessionStorage` — so the check reported **Node's own globals** as test pollution and
called `process.exit(1)`, failing the 11 test files that import the helper. The six names are now in
the allowlist, in their own block so the next Node line is a one-line diff. Listing a global the
current Node does not have is harmless: the check only reports names **present** in `globalThis` and
**absent** from the set.

This is the clearest possible vindication of Gap 1: the defect was real, it was invisible while
Node 26 was untested, and it was invisible *only* because the line was untested.

### What was run

| Command | Result |
| --- | --- |
| `npm run lint` | ✅ 0 errors (103 files) |
| `npm run format:check` | ✅ 0 errors (103 files) |
| `npm test` | ✅ **624 pass / 0 fail** (171 suites) — 622 before, +2 from the new DEP0210 shim tests |
| `npm run benchmark:hot-path` | ✅ PASSED — all 7 p99 budgets met |
| `npm run validate` | ✅ exit 0 (lint + test + hot-path) |
| `npm run examples` | ✅ 20/20 ok, 0 skipped, 0 failed |
| `npm run skill:validate` | ✅ exit 0 — 35 JS blocks: 4 executed, 4 skipped, 23 fragment, 4 external-dependency, 0 runtime-error, **0 syntax-error** |
| `npm pack --dry-run` | ✅ 30 files — `scripts/` does not leak into the tarball (`package.json#files` = `src`, `skills`, `README.md`, `LICENSE`) |
| `npx -y node@26 --test --test-concurrency=4 "test/**/*.test.js"` | ✅ **624 pass / 0 fail** on Node **v26.12.1** (before the Gap 5 fix: 635 tests, 624 pass, **11 fail**) |
| `npx -y node@26 scripts/run-examples.js` | ✅ 20/20 ok on Node v26.12.1 |
| `npx -y node@26 scripts/validate-skill.js` | ✅ exit 0 on Node v26.12.1 — same counts as Node 24 |

### The two new shim tests

`test/sqlite-queue.test.js` — `describe('node:sqlite DEP0210 shim')`:

1. asserts `typeof DatabaseCtor === 'function'` and that it is the canonical `node:sqlite` export on
   the Node line running the suite;
2. opens a real database through `DatabaseCtor`, writes a row and reads it back — so the shim is
   exercised, not merely asserted.

### How Node 26 was verified locally

`npx -y node@26` downloads the official Node **v26.12.1** binary into the npm cache (nothing is
installed system-wide and the repository is untouched) and runs it directly. That made the whole
Node 26 story verifiable on a Node 24 host, instead of waiting a full CI cycle per hypothesis.

### Not verified here

- **The `engine-floor` job (Node 22.13.0) has not run locally.** The 22.13.0 floor is asserted by the
  CI job itself; this host runs Node v24.16.0 and the npm cache has no 22.13.0 build. The CI run
  `39981180594` did execute the job and it **passed**.
- **The `26.x` CI leg had not passed at the time of writing.** The fix for Gap 5 is verified locally
  on Node v26.12.1 (624/624 at the time of the fix; the suite has grown since, to 641/641);
  the CI re-run is the confirmation.
