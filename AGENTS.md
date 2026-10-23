# Operational Guide for AI Agents (AGENTS.md)

This document provides operational instructions, navigation maps, and development rules for **AI Agents** (Antigravity, Claude Code, Cursor, Windsurf, Copilot) contributing to the **`persistent-worker-runtime`** repository.

---

## 🎯 Repository Mission & Architectural Philosophy

The **Persistent Worker Runtime** is a concurrent execution layer for Node.js built atop `node:worker_threads`.

Its core architectural axiom is:
> **"The Event Loop coordinates. Persistent Workers execute."**

The ultimate goal of this project is to provide a zero-dependency, pure JavaScript runtime atop `node:worker_threads` with stateful workers, priority routing, backpressure, and async-hooks-aware diagnostics.

---

## 🧭 Directory Map

```text
persistent-worker-runtime/
├── AGENTS.md                           # This operational guide
├── README.md                           # Primary user and developer documentation
├── HANDOVER.md                         # Handoff guide for the next chat/session
├── CONTEXT.md                          # Foundational architectural context (51 sections)
├── NODEJS_RFC_PROPOSAL_DRAFT.md        # Draft RFC proposal for a Node.js Persistent Worker Runtime built-in
├── package.json                        # Node.js >= 22, pure ESM, zero external dependencies
├── LICENSE                             # MIT License
├── .github/workflows/ci.yml            # Multi-OS matrix CI (Ubuntu, macOS, Windows)
├── .agents/rules/                      # Always-on rules (test-before-commit, MADR, zero-deps, end-of-spec hardening, perf-first-authoring)
├── docs/
│   └── adr/                            # Architecture Decision Records (MADR format, 0001..0014)
├── src/                                # Core implementation (pure JavaScript ESM)
│   ├── index.js                        # Public API entry point
│   ├── index.d.ts                      # TypeScript definitions for IDE autocompletion
│   ├── errors.js                       # Error hierarchy
│   ├── task-handle.js                  # Task model with AsyncResource and callbacks
│   ├── task-queue.js                   # Asynchronous priority queue with backpressure timeout
│   ├── worker-handle.js                # Managed Worker thread wrapper (watchdog, recycling, preemption)
│   ├── worker-thread-entry.js          # In-thread worker loop with L1 memory
│   ├── supervisor.js                   # Pool lifecycle, recycling, and crash recovery
│   └── worker-runtime.js               # Central execution engine
├── test/                               # Native unit tests (node:test, 641 tests across 175 suites)
│   ├── task-queue.test.js              # Queue unit tests (lifecycle, priority, affinity, drain, destroy)
│   ├── errors.test.js                  # Error hierarchy tests
│   ├── supervisor-units.test.js        # Supervisor getters, dispatch validation, retry path
│   ├── state-and-affinity.test.js      # L1 state ops, supervisor affinity, retry semantics
│   ├── zero-copy.test.js               # ArrayBuffer transferList semantics
│   ├── priority-routing.test.js        # Priority queue routing and FIFO within tier
│   ├── cancel-signal.test.js           # AbortController cancellation patterns
│   ├── recycling.test.js               # Worker recycling integration tests
│   ├── preemption.test.js              # Hard preemption watchdog integration tests
│   ├── concurrency-stress.test.js      # Concurrency stress tests
│   └── worker-runtime.test.js          # Core runtime end-to-end tests
├── benchmarks/                         # Performance and Event Loop lag benchmarks (10 total)
│   ├── event-loop-lag.benchmark.js
│   ├── stateful-vs-stateless.benchmark.js
│   ├── batch-concurrency.benchmark.js
│   ├── outbox-throughput.benchmark.js
│   ├── zero-copy-transfer.benchmark.js
│   ├── priority-routing.benchmark.js
│   ├── abort-cancellation.benchmark.js
│   ├── throughput-scaling.benchmark.js
│   ├── preemption-recovery.benchmark.js
│   └── worker-recycling.benchmark.js
├── examples/                           # Real-world usage patterns
│   ├── express-outbox-email.js         # Express + transactional outbox
│   ├── image-resizer-batch.js          # Bounded batch image processing
│   ├── persistent-ai-model.js          # Stateful worker with warm AI model in L1
│   ├── priority-routing.js             # Critical work vs. batch work ordering
│   ├── zero-copy-image.js              # TransferList for 30MB image buffer
│   └── cancel-on-disconnect.js         # Manual + AbortSignal.timeout + pre-aborted patterns
├── scripts/                            # CI gates (Node built-ins only, zero deps)
│   ├── run-examples.js                 # npm run examples — executes every examples/*.js
│   ├── validate-skill.js               # npm run skill:validate — executes the shipped skill's code blocks
│   └── lib/spawn.js                    # Shared child-process runner (hard timeout, no shell)
└── .specs/                             # LOCAL planning state (gitignored)
    ├── STATE.md                        # Active spec, decisions, handoff pointer
    └── features/                       # Per-feature spec + tasks breakdown
```

---

## 📂 Tracked Issues & Known Drift (`.agents/issues/`)

These are the **canonical link targets** for the next session / agent. Each item is a known limitation or drift point — read before assuming a feature is implemented or assuming the docs are current.

| # | File | Title | Status | Why it matters |
| --- | --- | --- | --- | --- |
| 001 | [`.agents/issues/001-supervisor-start-not-idempotent.md`](.agents/issues/001-supervisor-start-not-idempotent.md) | `Supervisor.start()` not idempotent (pool doubles on double-call) | ✅ **FIXED** (`5c4069c` + `205c384`) | Regression guard already in `test/supervisor-units.test.js`; `#isStarted` flag added |
| 002 | [`.agents/issues/002-runtime-hardening-wave4-review.md`](.agents/issues/002-runtime-hardening-wave4-review.md) | Wave 4 review findings (T9-T11 + chunk leak) | ✅ **CLOSED** 2026-09-22 | Findings 1 (backoff Promise leak) + 2 (poll branch collapse) + Track 2 chunk leak all shipped in v0.2.0. Finding 3 (fresh-priority doc note) ⏳ open — docs only |
| CI | [`.agents/issues/CI-FAILURE-macos-benchmarks.md`](.agents/issues/CI-FAILURE-macos-benchmarks.md) | `npm run benchmark:all` failed on macOS-Latest ARM64 | ✅ **RESOLVED** 2026-09-23 | Dependabot SHA bump + `cpu-saturation.benchmark.js` platform-aware threshold (1.15× darwin / 1.3× others). CI green across 4 consecutive runs |
| CI | [`.agents/issues/CI-FAILURE-windows-broadcast-fanout.md`](.agents/issues/CI-FAILURE-windows-broadcast-fanout.md) | `benchmark:all` failed on Node 22.x / windows-latest (run 36178398974) | ✅ **FIXED** 2026-09-27 | Not a platform quirk: `broadcast-fanout.benchmark.js` discarded 2000 `TaskHandle`s behind a fixed 200ms sleep; `shutdown()` rejected the still-queued ones and the unhandled rejection exited 1. Now retains handles + `Promise.allSettled` |
| CI | [`.agents/issues/CI-FAILURE-macos-adaptive-optout-noise.md`](.agents/issues/CI-FAILURE-macos-adaptive-optout-noise.md) | `adaptive-controller-opt-out` p99 parity failed 2.15× (budget 2×) on Node 24.x / macos-latest | ✅ **FIXED** 2026-09-28 | p50 was byte-identical (0.024 ms both paths) — the divergent p99 was one OS preemption, not a cost regression. Single unwarmed p99 pass is scheduler-noise sensitive at the ~30μs scale. Now: warmup + best-of-5 p99, plus a p50 assertion as the load-bearing signal |
| CI | [`.agents/issues/CI-FAILURE-macos-default-sizing-hardware-calibration.md`](.agents/issues/CI-FAILURE-macos-default-sizing-hardware-calibration.md) | `default-sizing-memory` required `ratio >= 2×`, which only holds on a high-core-count host | ✅ **FIXED** 2026-09-28 | The ratio is `function(cores - 1)`: 5.8× on a 28-core workstation, 1.46× on a 4-core CI runner. Direction and absolute saving (28.6 MB) were both correct. Now asserts the hardware-independent invariant — marginal MB per worker thread (≥2 MB) + direction + absolute floor. The `cores <= 4` degenerate guard was also factually wrong (legacy falls back to 1 at `cores <= 2`) and skipped valid measurements |
| CI | [`.agents/issues/CI-FAILURE-macos-recycling-fixed-sleep.md`](.agents/issues/CI-FAILURE-macos-recycling-fixed-sleep.md) | `recycling.test.js` flaked on Node 24.x / macos-latest (run 37069227658) | ✅ **FIXED** 2026-10-03 | A hard-coded 200 ms sleep stood in for the `worker_recycled` event, which only fires after the replacement thread has spawned and booted. Now deadline-based polling (5 s) at 5 sites in `recycling.test.js` + `recycle-backoff.test.js`. Note the same file already carried "bump to 200 ms to absorb CI timer noise" comments from an earlier flake — raising a sleep constant is the wrong fix, it just moves the cliff |
| BENCH | [`.agents/issues/io-throughput-preempted-accounting.md`](.agents/issues/io-throughput-preempted-accounting.md) | `io-throughput.benchmark.js` Phase 1 accounting assertion ignored `task:preempted` | ✅ **FIXED** 2026-09-27 | A preempted task increments `stats.failedTasks` but emits only `task:preempted`, never `task:failed` — so the two-counter sum could never reach `TOTAL_TASKS` once the watchdog fired. Assertion now sums all three terminal buckets. **Runtime left unchanged** — no ADR or test mandates that preemption also emit `task:failed` |
| 003 | [`.agents/issues/003-spec-validation-drift.md`](.agents/issues/003-spec-validation-drift.md) | `spec.md` files never run through `validate_spec.py` (only `validate_tasks.py`) | ✅ **FIXED** 2026-09-27 | 9 errors found across 3 specs (`durable-queue`, `health-probes`, `persistent-worker-runtime`); all 5 missing template sections added. **Run BOTH validators when closing a feature** — they cover different artifacts. Note `ID_RE` forbids the 2-hyphen `REQ-UBI-001` form in traceability tables |
| 004 | [`.agents/issues/004-node26-lts-flip-engine-floor-and-dep0210.md`](.agents/issues/004-node26-lts-flip-engine-floor-and-dep0210.md) | Node 26 becomes Active LTS on 2026-10-28 — matrix lacks `26.x`, `lts/*` auto-flips, `engines` floor untested, DEP0210 `DatabaseSync` | ✅ **FIXED** 2026-10-23 | `ci.yml` matrix is now `[22.x, 24.x, 26.x]`, and a new `engine-floor` job pins Node **22.13.0** literally (Linux, `npm test` only) — the matrix resolves `22.x` to the latest 22.x, so the declared `engines` floor was never exercised. `lint.yml`/`coverage.yml`/`commit-lint.yml` are pinned to `24.x` instead of `lts/*`, so the LTS flip becomes a reviewed diff. DEP0210 shim: `node:sqlite` is now a **namespace import** resolved at runtime (`nodeSqlite.Database ?? nodeSqlite.DatabaseSync`) — a *named* import of a removed export is a `SyntaxError` that would break the whole package at import time, not just the SQLite backend. Covered by 2 new tests. **The new leg then failed on its first run** (3 legs) and exposed a 5th gap: `test/common.js`'s static global allowlist did not know Node 26's six new built-ins (`ErrorEvent`, `QuotaExceededError`, `Storage`, `Temporal`, `localStorage`, `sessionStorage`), so the exit-time leak check reported Node's own globals as test pollution. Now allowed; verified on Node v26.12.1 (624/624 at the time — the suite has grown since, to 641/641). |
| 005 | [`.agents/issues/005-typescript-definitions-have-no-compile-gate.md`](.agents/issues/005-typescript-definitions-have-no-compile-gate.md) | `src/index.d.ts` shipped to npm with no compile gate — and had already drifted from the runtime | ✅ **FIXED** 2026-10-23 | The 4 public names missing from the declarations are declared, each shape derived from the runtime source (`StreamConfigError` extends `TypeError`, not `WorkerRuntimeError`). `test/types-surface.test.js` is the new **zero-dependency** gate: it compares the runtime exports with the `.d.ts`'s value-level declarations in **both directions**, ignoring type-only `interface`/`type` declarations. Proven non-vacuous — removing one declaration and appending a ghost one each make it exit 1 with a clear message. `WorkerHandle` also gained the 4 public properties the runtime exposes but the declarations omitted (`isDedicated`, `workerScript`, `handlerPath`, `resourceLimits`). **Known limit**: the gate compares **names**, not properties, and it does not prove the declarations *compile* — that still needs Option B (`tsc --noEmit`), which requires a decision about ADR-0005 |
| 006 | [`.agents/issues/006-examples-and-skill-code-blocks-never-executed.md`](.agents/issues/006-examples-and-skill-code-blocks-never-executed.md) | The 20 `examples/` scripts and the shipped skill's code blocks are never executed by CI | ✅ **FIXED** 2026-10-23 | `npm run examples` (`scripts/run-examples.js`) runs all 20 examples in isolated child processes **outside** the repo working tree, with a hard timeout and a visible `// requires:` skip marker — **20/20 ok, 0 skipped, 0 failed**, and `git status` stays clean. `npm run skill:validate` (`scripts/validate-skill.js`) syntax-checks and executes the shipped skill's code blocks; it needed its own workflow because every other workflow uses `paths-ignore: ['**.md', …]` and the skill is all `.md`. **A block that does not parse is now fatal** — the first version reported syntax errors and exited 0, which is not a gate. On its first run the gate found **3 real defects** in the shipped skill: 2 blocks that did not parse, 3 calls to `runtime.stats()` (it is a **getter**, so the snippet threw `TypeError`), and 1 snippet that crashed the process on `shutdown()` (unhandled rejection of a fire-and-forget handle). All 3 fixed. |
| 007 | [`.agents/issues/007-coverage-threshold-and-release-version-consistency.md`](.agents/issues/007-coverage-threshold-and-release-version-consistency.md) | Coverage reports but never fails; release never checks tag ↔ version ↔ CHANGELOG | ✅ **FIXED** 2026-10-23 | `npm run test:coverage` now carries `--test-coverage-lines=90 --test-coverage-branches=80 --test-coverage-functions=85` (note the names: **no** `--experimental-` prefix — they exist as far back as Node 22.13.0). Floors sit below the measured baseline (**94.39 / 87.71 / 91.01**), because a floor equal to the baseline turns the next uncovered line into a red build. Proven to fail: the same run with `--test-coverage-lines=100` exits 1. `release.yml` gained a pre-flight step before `npm publish` — tag ↔ `package.json` version ↔ a `## [X.Y.Z]` section in `CHANGELOG.md`, plus a registry check on the tagless `workflow_dispatch` path — failing with a clear `::error::` message |
| 008 | [`.agents/issues/008-taskhandle-promise-contract-mismatch.md`](.agents/issues/008-taskhandle-promise-contract-mismatch.md) | `TaskHandle.promise` was documented as internally `.catch()`-handled — and it was not | ✅ **FIXED** 2026-10-23 | **ADR-0025** implements the contract: `dispatch()` (and `dispatchAll()`) attach a no-op rejection handler to the handle's promise, so a discarded handle cannot raise an unhandled rejection — while the promise **still rejects** (`await handle.promise` throws) and `onError` **still fires**. `execute()` deliberately does **not** get the protection, so ADR-0018's hazard stays visible. `execute()` now calls a private `#dispatchTask()` instead of the public `dispatch()`. `test/dispatch-promise-contract.test.js` proves it: removing the keep-alive makes 4 of its 7 tests fail. ADR-0018 amended (false claim marked corrected, text kept as history), the JSDoc of both modes made coherent, and the shipped skill now documents `onError` as the failure channel |
| 009 | [`.agents/issues/009-skill-outbox-pattern-undefined-variable.md`](.agents/issues/009-skill-outbox-pattern-undefined-variable.md) | The shipped skill's outbox pattern references an out-of-scope variable | 🔴 **OPEN** 2026-10-23 | `skills/persistent-worker-runtime/references/patterns.md` (Pattern 1) uses `p.outboxId` inside the `onComplete`/`onError` handlers, but the pattern's own row variable is named `row` — copying the block verbatim throws `ReferenceError: p is not defined`. It slipped past the skill gate because the block is a **fragment**: fragments are parsed, not executed, so an undeclared identifier inside one is invisible. That is the gate's known blind spot |

**Cross-references for related gaps** (not in `.agents/issues/` but worth knowing):

- [DR plan §8](docs/operations/disaster-recovery.md#8-open-items-gaps-to-close) — production-readiness gaps. **Note (2026-09-24, Felipe):** items **8.3 OpenTelemetry** and **8.4 Postgres SKIP LOCKED backend** are **permanently out-of-scope by rule** — the project follows ADR-0005 (pure vanilla JS, zero external runtime deps), which excludes the `pg` driver and the `@opentelemetry/api` peer-dep eagerly. The workaround documented in DR §8 (user installs their own OTel SDK; user fronts with their own Postgres queue) is the final answer, not a placeholder. Treat any future proposal to add OTel or Postgres directly to `src/` as a violation of ADR-0005 unless ADR-0005 itself is amended first. **8.2 `/healthz` was closed 2026-09-24** — runtime now exposes `isAlive()` + `isReady()` (ADR-0024); user wires HTTP/cron/script transport (see `src/worker-runtime.js`). **8.1 SIGTERM** remains user-wired.
- [`HANDOVER.md`](HANDOVER.md) — current session's pending follow-ups (T13+ portability, `gh auth refresh --scopes workflow`, etc.).

> **Reading rule:** before declaring a feature "implemented" or "shipped" in any downstream doc, verify against `src/` + `STATE.md` + the relevant ADR/spec. See [agent memory `verify-implementation-claims-before-formalizing` (2026-09-23)](D:\.minimax/agents/mavis/memory/MEMORY.md) for the rule + diagnostic.

---

## 📌 Strict Rules of Conduct for Agents

1. **Pure Vanilla JavaScript (No TypeScript in `src/*.js`):**
   - The runtime code must remain 100% vanilla modern JavaScript (ESM).
   - Zero external runtime dependencies. Only built-in `node:*` modules may be imported.
   - Types are provided exclusively in `src/index.d.ts` for consumer IDE autocompletion.
2. **Mandatory Testing + Lint after Every Modification:**
   - Always run `npm run validate` (= `npm run lint && npm test && npm run benchmark:hot-path`) after any code change.
   - Never commit code if any unit test fails or any lint error remains.
   - The husky pre-commit hook runs `npx lint-staged` + `npm test` automatically; the pre-push hook runs the full validation.
3. **Architecture Decision Records (ADRs):**
   - Every major technical decision, concurrency pattern, or lifecycle alteration must be recorded in `docs/adr/` using the **MADR** format.
4. **All Documentation and Code in English:**
   - All code comments, variable names, ADRs, specifications, and git commits must be in English.
5. **Conventional Commits:**
   - Use standard prefixing: `feat:`, `fix:`, `docs:`, `test:`, `perf:`, `chore:`, `ci:`.

---

## 🧹 Lint + Format Workflow

The project uses **Biome 2.x** for both linting and formatting (single Rust binary, ~50× faster than ESLint).

| Script | Purpose |
| --- | --- |
| `npm run lint` | Check src/, test/, examples/, benchmarks/, research/, scripts/ against biome.json rules |
| `npm run lint:fix` | Auto-fix all fixable issues (use with care; `--unsafe` enables fixer for unsafe cases) |
| `npm run format` | Apply Biome formatter (single quotes, 2-space indent, trailing commas, LF) |
| `npm run format:check` | Verify formatting without applying |
| `npm run validate` | `lint` + `test` + `benchmark:hot-path` (used by pre-push hook and `prepublishOnly`) |

### Pre-commit hook (`.husky/pre-commit`)

```sh
npx lint-staged
npm test
```

`lint-staged` runs `biome check --write` only on the staged files (fast feedback + auto-fix safe style issues), then the full test suite runs to ensure nothing broke. **Non-fixable lint errors block the commit.**

### Pre-push hook (`.husky/pre-push`)

```sh
npm run validate
```

Runs the full lint + test suite before a push lands on `origin/develop`.

### Execution gates

Two npm scripts execute the artifacts that *document* the API. Both are wired into CI, both use only
Node built-ins (zero deps), and both run their children with the working directory **outside** the
repository so nothing they write lands in the working tree.

| Script | What it does | Wired into |
| --- | --- | --- |
| `npm run examples` | Runs every `examples/*.js` in an isolated child process with a hard wall-clock budget. An example that needs an external service declares it with a `// requires:` marker and is skipped **visibly**, never silently. | `ci.yml` → `Run Examples` (after `npm test`) |
| `npm run skill:validate` | Extracts every fenced code block from the shipped skill (`skills/persistent-worker-runtime/`), syntax-checks the JavaScript ones, executes them, and validates `.skill-meta.json`. A block that **does not parse is fatal**; `FRAGMENT`, `EXTERNAL-DEPENDENCY` and `RUNTIME-ERROR` are reported but non-fatal. | `.github/workflows/skill-validation.yml` (own workflow — the others use `paths-ignore: ['**.md', …]` and the skill is all `.md`, so a skill change did not even trigger a build) |

The skill ships **inside the npm tarball** and is loaded by AI agents, which treat it as authoritative.
A stale example there is worse than a stale README line: the agent reproduces it in someone else's
project. Run `npm run skill:validate` after editing anything under `skills/`.

### Per-directory overrides in `biome.json`

- `examples/**`, `benchmarks/**`, `research/**`, `scripts/**`: `noConsole` is **off** (these are demonstrative scripts that print output).
- `test/**`: `noConsole` and `noEmptyBlockStatements` are **off** (legitimate patterns like `.catch(() => {})` for fire-and-forget).

### Which directories are linted

`biome.json` `files.includes` and the five npm scripts (`lint`, `lint:ci`, `lint:fix`,
`format`, `format:check`) list these paths **explicitly** — a new top-level directory with JS is
NOT linted until it is added in both places:

```
src/  test/  examples/  benchmarks/  research/  scripts/
```

`research/` holds usage-pattern investigations (not CI gates). It is linted and formatted like
`benchmarks/` but deliberately absent from `benchmark:all`, because those scripts take 7–20 minutes
and generate GB of temp files. See [`research/README.md`](research/README.md).

`scripts/` holds the two CI gates (`run-examples.js`, `validate-skill.js`). It is linted and formatted
like `src/`, and `lint-staged` covers it — but it is **not** published: `package.json#files` lists only
`src`, `skills`, `README.md` and `LICENSE`, so `scripts/` never reaches the npm tarball.
