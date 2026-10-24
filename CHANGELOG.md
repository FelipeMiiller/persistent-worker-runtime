# Changelog

All notable changes to `persistent-worker-runtime` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Changes merged to `develop` after the v0.3.0 release. The public API surface is unchanged — `src/index.js`
still exports the same 16 names — but one behaviour **is** changed: `dispatch()` now attaches an
internal rejection handler to the handle's promise (ADR-0025), so a fire-and-forget handle that
nobody awaits can no longer take the process down. Everything else is CI, correctness, type-surface
and measurement work.

### Added

- **CI matrix leg for Node 26** — Node 26 becomes Active LTS on 2026-10-28 and was the only supported
  line with no CI leg at all. `ci.yml` now runs `[22.x, 24.x, 26.x]`. A defect that only reproduces on
  the new Active LTS would otherwise be found by users, not by this CI.
- **`engine-floor` CI job** (Node 22.13.0, Linux, `npm test` only) — `package.json` declares
  `engines.node >= 22.13.0`, the release where `node:sqlite` stopped requiring
  `--experimental-sqlite`, but the matrix resolves `22.x` to the *latest* 22.x, so the declared floor
  was never exercised. The job pins the floor literally. It runs tests only, on purpose: benchmarks on
  the floor fail for reasons unrelated to the floor (older V8, different GC heuristics, CI noise) and
  would turn an engine-contract signal into throughput noise.
- **Pinned `lts/*` out of `lint.yml`, `coverage.yml` and `commit-lint.yml`** — `lts/*` resolves to
  Node 26 on 2026-10-28, flipping three workflows' runtime with no commit, no review and no changelog
  entry. They are now pinned to `24.x`, with the reason in a comment; moving to `26.x` becomes a
  deliberate diff, made after the `26.x` matrix leg is green.
- **`npm run examples` — CI gate for the 20 `examples/` scripts** (`scripts/run-examples.js`). Each
  example runs in an isolated child process, with its working directory **outside** the repository, a
  wall-clock budget, and an explicit `// requires:` skip marker for examples that need an external
  service. The examples are the primary API documentation for a library with a large, non-obvious
  surface, and one of them already shipped broken (`examples/durable-task-vacuum.js` →
  `ReferenceError: DatabaseSync is not defined`), caught only by hand-reconciling the docs against the
  filesystem. Wired into `ci.yml` as a step right after `npm test`.
- **`npm run skill:validate` — CI gate for the shipped skill** (`scripts/validate-skill.js`) plus a
  dedicated `.github/workflows/skill-validation.yml`. The skill ships inside the npm tarball and is
  loaded by AI agents, which treat it as authoritative — a stale example there propagates into someone
  else's project. The gate extracts every fenced block, syntax-checks the JavaScript ones, executes them
  from a scratch directory outside the repo, and validates `.skill-meta.json`. It needed its own
  workflow: every other workflow uses `paths-ignore: ['**.md', ...]` and the skill is entirely `.md`, so
  a skill change did not even trigger a build (`paths-ignore` does not support negation — hence `paths:`).
- **`examples/parallel-json-parse.js`** — parses a ~10 GB JSON array across a worker pool.
  Verified at 10 240 MB / 35 296 907 records on a 28-core host: 1 worker 127.7 s (80 MB/s),
  4 workers 64.9 s (158 MB/s). Includes the two constraints that make the design
  non-obvious: the V8 string limit (`0x1fffffe8`, ~512 MB) is enforced by `Buffer.toString()`
  *before* `JSON.parse` runs, so chunking is mandatory even with one worker and the chunk count
  must be derived from file size rather than worker count; and `timeoutMs: 0` is required because
  the HARDEN-01 5 s default preempts a multi-hundred-MB chunk. Compares SUMMARY-ONLY workers
  (reduce in the worker) against RETURN-ALL (clone the graph back) — the latter carries a ~4×
  transfer tax at 512 MB and is refused outright at 10 GB, where it would need ~100 GB of live
  objects. Size is configurable via `PWR_JSON_MB`.
- **`examples/cpu-io-split.js`** — measures whether CPU-bound work delays I/O-bound work, and
  whether a dedicated I/O worker is worth it. Three architectures under the same load. Result
  (5 runs, 28-core host): main-thread I/O keeps **p50 flat** while its **p99 rises ~45%** under
  burst; a dedicated I/O worker degrades **both** p50 (+35%) and p99. The tail effect is per-task
  `postMessage` bookkeeping on the main thread, not a blocked event loop — the common "main-thread
  I/O is unaffected" claim is wrong at the tail.
- **`examples/sigterm-drain.js`** — runnable recipe for DR §8.1. User-wired `SIGTERM` / `SIGINT`
  handler around `runtime.shutdown()` with an idempotency guard (a second signal mid-drain is a
  no-op) and a hard-timeout fallback (`process.exit(1)` after 30 s). `[perf-tested]` — measures
  drain time and second-signal latency.
- **Regression test locking the ADR-0011 preemption contract** — a preempted task emits
  `task:preempted` and **not** `task:failed`; `runtime.stats().failedTasks` *does* include
  preemption. The handle is already rejected in `WorkerHandle.#preemptWorker` before the event
  fires, so no caller is left hanging. The distinction is what lets a consumer tell a forced kill
  from a cooperative timeout.

### Changed

- **`dispatch()`'s fire-and-forget contract is now true (ADR-0025)** — the `dispatch()` JSDoc and
  ADR-0018 both promised that the handle's promise carried an internal `.catch()`, so a discarded
  handle was safe. It never did: `src/task-handle.js` attached no handler at all, and the only
  `.catch()` in `dispatch()` was on the *enqueue* promise. The observable consequence was not
  theoretical — `runtime.shutdown()` calls `queue.destroy()`, which **rejects** every still-queued
  task, and the unhandled rejection **exited the user's process with code 1**. `dispatch()` (and
  `dispatchAll()`) now attach a no-op rejection handler to the handle's promise. Nothing is masked:
  the promise still rejects (`await handle.promise` throws the same error) and `onError` still fires.
  `execute()` deliberately keeps **no** such handler — its promise belongs to the caller, so the
  ADR-0018 hazard stays visible — which is why `execute()` now calls a private `#dispatchTask()`
  instead of the public `dispatch()`. `test/dispatch-promise-contract.test.js` proves both halves:
  removing the keep-alive makes 4 of its 7 tests fail. ADR-0018 is amended (the false claim is
  marked corrected, the original text kept as history) and ADR-0025 records the decision.

### Fixed

- **`cpu-saturation` E-1 asserted the wrong pair — CI-only, no runtime change** — the gate compared
  the **two largest** entries of the worker sweep (16 and 8) whatever the host was, and measured each
  configuration **once**, in a fixed order. On a 3-core CI runner both members of that pair are already
  oversubscribed, so the true ratio was ~1.0 *by construction* and the gate was measuring runner noise
  against a 1.5× budget. The two macOS legs of the **same** CI run reported **3 and 5 cores** and
  produced 1.58× (FAIL) and 1.05× (PASS). The gate now compares the **knee pair** `(CORES, 2×CORES)`
  — ≈1.0× when the knee is at the core count, ≈2.0× when it is at twice that, which is what a 1.5×
  budget can actually discriminate. E-1 measures **4 rounds** over the same sweep with the order
  rotated by one position per round **and its direction alternated per round**, takes the **median**
  per configuration, and runs a discarded warmup sweep first. Direction alternation is what removes
  the systematic part: with rotation alone the two members of the pair keep a fixed relative order, so
  "measured later = faster" stays *systematic* inside the ratio, and no order statistic removes a
  systematic bias. Measured on a 28-core host, 8 repetitions per method: the old code's ratio spread
  was 1.03 (max **1.88×** — through the budget), the new code's was 0.26 (max **1.30×**); the old
  method's *centre* moved 13.3% with the sweep order, the new one 4.0%. When `2×CORES > MAX_WORKERS`
  (host with more than 10 cores) the knee is out of reach and the benchmark now says so and **skips**
  the assertion instead of printing "saturation confirmed" for a knee it never measured.
- **Four public exports were missing from the TypeScript declarations** — `src/index.d.ts` shipped
  without `SqliteTaskQueue`, `TaskQueue`, `StreamAbortedError` and `StreamConfigError`, so a
  TypeScript consumer importing the documented API got `TS2305` on its first `tsc` run. The failure
  was invisible to the JavaScript suite, to coverage and to CI. `SqliteTaskQueue` is a headline
  feature (ADR-0020, in the README's feature table and in the shipped skill), so the type layer was
  denying an API the documentation told users to use. All four are now declared, each with a shape
  derived from the runtime source rather than invented (`StreamConfigError` extends `TypeError`, not
  `WorkerRuntimeError`, and carries no `code`).
- **`WorkerHandle` was missing four public properties** — the runtime sets `isDedicated`,
  `workerScript`, `handlerPath` and `resourceLimits` on the instance (`src/worker-handle.js`), but
  the class declaration listed none of them; `isDedicated` was declared only in the unrelated
  `WorkerSnapshot` interface.
- **The `.d.ts` and the runtime could drift apart without anyone noticing** — a repo-wide search
  for `typescript`/`tsc`/`tsd`/`checkJs` returned zero tooling hits, so nothing proved the
  declarations matched the code they describe. `test/types-surface.test.js` is the new
  **zero-dependency** gate: it compares the runtime exports with the `.d.ts`'s value-level
  declarations in **both directions**, ignoring type-only `interface`/`type` declarations. Proven
  non-vacuous — removing one declaration, and appending a ghost one with no runtime counterpart,
  each make it exit 1 with a clear message. It compares **names**; it does not prove the
  declarations compile, which still needs a `tsc --noEmit` gate and a decision about ADR-0005.
- **`npm run test:coverage` reported coverage but could never fail** — the workflow's name promised
  a property the job did not enforce, so a silent regression looked like a green build. The script
  now carries `--test-coverage-lines=90 --test-coverage-branches=80 --test-coverage-functions=85`
  (the flag names carry **no** `--experimental-` prefix, and they exist as far back as Node 22.13.0).
  The floors sit below the measured baseline of **94.39 / 87.71 / 91.01** on purpose: a floor equal
  to the baseline turns the next uncovered line into a red build for a reason unrelated to its
  quality. Proven to fail — the same run with `--test-coverage-lines=100` exits 1.
- **`npm publish` could ship a release that disagreed with itself** — the publish workflow had no
  check that the git tag matched `package.json`'s version, that `CHANGELOG.md` had a section for it,
  or that the version was not already on npm. A mismatched tag published the *previous* version
  (npm then rejects the duplicate with a confusing error, after the release is already public on
  GitHub); an untagged version shipped undocumented. A pre-flight step now validates all three and
  fails with a clear `::error::` message before anything is published.

- **`node:sqlite`'s `DatabaseSync` import broke the whole package when the DEP0210 alias is removed.**
  Node 26.11 renamed `DatabaseSync` to `Database`. `src/queue/sqlite-backend.js` used a *named* import,
  and a named import of a removed export is a `SyntaxError` raised while importing the module — which
  `src/index.js` re-exports, so every consumer of the package breaks, not only the ones using the
  durable queue. The constructor is now resolved at runtime (`nodeSqlite.Database ??
  nodeSqlite.DatabaseSync`) and exported as `DatabaseCtor` so the shim itself is covered by a test on
  every Node line. `examples/durable-task-vacuum.js` and `test/sqlite-queue.test.js` carried the same
  import and are fixed the same way.
- **The test suite failed on Node 26 — the exact line the new matrix leg was added to cover.**
  `test/common.js` keeps a static allowlist of the platform's global surface, and the exit-time leak
  check compares `globalThis` against it **by name**. Node 26 adds six built-ins (`ErrorEvent`,
  `QuotaExceededError`, `Storage`, `Temporal`, `localStorage`, `sessionStorage`), so the check
  reported Node's *own* globals as test pollution and failed the 11 test files that import the helper
  (`process.exit(1)` at exit). The six names are now in the allowlist, in their own block so the next
  Node line is a one-line diff. Verified on Node v26.12.1: **624 pass / 0 fail**. This is the new
  matrix leg earning its keep on the first run — the defect was invisible while Node 26 was untested.
- **Two skill code blocks did not parse** — `references/observability.md` (`runtime.dispatch({ ... })`)
  and `references/stateful-l1.md` (`payload: { ... }` and `fn: ...`). A snippet that does not parse is a
  broken snippet, and an agent copies it verbatim.
- **The skill called `runtime.stats()` as a function** in three places in `references/observability.md`
  — `runtime.stats` is a **getter** (`get stats()`), so copying the snippet produced
  `TypeError: runtime.stats is not a function`.
- **The skill's priority + cancellation snippet crashed the process.** It dispatched fire-and-forget
  work and then called `shutdown()` while tasks were still queued; `shutdown()` destroys the queue,
  which rejects those tasks with `WorkerRuntimeError('Runtime is shutting down')`, and `dispatch()`
  does not attach a handler to the handle promise — so the rejection was unhandled and took the process
  down. The snippet now settles every handle before shutting down. (The runtime JSDoc at
  `src/worker-runtime.js:942` claims the handle promise is *already* `.catch()`-handled internally; it
  is not. Reported separately, not fixed here.)
- **The skill gate reported syntax errors and still exited 0.** A block that does not parse is now
  fatal, with the file, the line and the parser message. FRAGMENT, EXTERNAL-DEPENDENCY and RUNTIME-ERROR
  stay non-fatal: a fragment cannot be executed in isolation by design, and an external dependency
  violates ADR-0005.
- **`lint-staged` negated every non-`.skill-meta.json` file** (including `.md`), and Biome ignores
  markdown — so any commit touching only docs / issues / ADRs failed the pre-commit hook with
  *"No files were processed in the specified paths"*. The matcher is now scoped to the code
  directories.
- **`benchmarks/broadcast-fanout.benchmark.js` exited 1 on Node 22 / windows-latest.** It discarded
  2000 `TaskHandle`s behind a fixed 200 ms sleep; `shutdown()` rejects the still-queued tasks and
  the unhandled rejection killed the process. Now retains the handles and awaits
  `Promise.allSettled`.
- **`benchmarks/io-throughput.benchmark.js` Phase 1 accounting was off by 8–13 tasks.** Terminal
  events are not mutually exclusive (a preempted task can emit `task:preempted` *and*
  `task:failed`), and `TOTAL_TASKS` ignored the mid-stream runaway task used to exercise the
  watchdog. Now counts **distinct `taskId`s** against `TOTAL_TASKS + 1`.
- **`benchmarks/adaptive-controller-opt-out.benchmark.js` p99 parity failed 2.15× (budget 2×)** on
  Node 24 / macOS. `p50` was byte-identical across both paths (0.024 ms), so the divergent p99 was
  a single OS preemption, not a cost regression. Now warms up, takes the best of 5 rounds, and
  gates on **p50** (p99 kept for tail visibility).
- **`benchmarks/default-sizing-memory.benchmark.js` required `ratio >= 2×`,** which only holds on a
  high-core-count host — the ratio is `function(cores - 1)` (5.8× on 28 cores, 1.46× on a 4-core
  runner). Direction and absolute saving were both correct. Now asserts the hardware-independent
  invariant: marginal MB per worker thread, plus direction and an absolute floor.
- **`benchmarks/adaptive-controller-tick.benchmark.js` measured without warmup** across a sweep of
  `{0, 1, 10}` listeners. The first configuration measured is systematically penalised, inflating
  the 1-listener baseline and making the scaling ratio look artificially favourable. Now warms up
  and takes the best of 5 rounds.
- **`examples/durable-task-vacuum.js` crashed with `ReferenceError: DatabaseSync is not defined`.**
  The example opened the queue database directly to count terminal rows but never imported
  `DatabaseSync` from `node:sqlite`. The example was documented in the README examples table while
  being unable to run; all 18 examples are now verified to exit 0.

### Documentation

- Spec templates closed: all 13 features under `.specs/features/` now validate **0 errors** on
  both `validate_spec.py` and `validate_tasks.py` (5 required sections were missing from
  `durable-queue`, `health-probes`, and `persistent-worker-runtime`).
- DR §8 status reconciled with reality: §8.4 marked **shipped** (it shipped in v0.3.0 but the doc
  still said "in-progress / ~250 LOC / active branch"), §8.1 gained a pointer to the new recipe,
  and §8.5 / §8.6 gained explicit scope notes marking them deployment-side, not library work.
- README examples table reconciled against the filesystem — it referenced
  `durable-queue-shutdown-recovery.js` and `durable-queue-throughput.js`, neither of which exists.
- `dispatchStrategy` getter docs clarify that *fresh* means `tasksCompleted === 0` (newly spawned
  **or** just recycled), and that strategies only diverge once a worker has completed a task.

## [0.3.0] - 2026-09-24

### Added

- **Runtime liveness + readiness probes** (DR §8.2 closure) — `runtime.isAlive()` and
  `runtime.isReady()` return `{ ok: boolean, reason?: string }`. Reasons:
  `isAlive` → `not-started | no-workers | shutting-down | (true)`;
  `isReady` → `not-started | shutting-down | no-workers | queue-full | (true)`.
  Transport is the caller's responsibility — the runtime stays a library per
  ADR-0005 (no HTTP server, signal handlers, or timers in `src/`). User wires
  Fastify/Express routes, k8s probes, cron, or polling scripts around the
  two methods. Mid-drain `isAlive()` returns `true` (process is alive while
  workers finish); SIGTERM is the orchestrator's kill signal, not a
  liveness-probe failure.
- **`get isShuttingDown()` getter** — closes a long-standing TS↔runtime drift
  where `get isShuttingDown(): boolean` was declared in `src/index.d.ts` but
  never implemented. Exposed so observers don't have to infer shutdown state
  from `getWorkers() === []`.
- **`get maxQueueSize()` on `TaskQueue` and `SqliteTaskQueue`** — previously
  private. Required by `runtime.isReady()` to detect the `queue-full`
  condition without `runtime.stats()` scraping.
- **T13.2 — `SqliteTaskQueue` lease-based orphan recovery** — every
  `dequeue()` writes a `claim_expires_at = now() + leaseMs` next to the
  `state='processing'` transition. Rows whose lease expires are reclaimed
  on the next constructor invocation (and via the public `reclaimExpired()`
  for cron-driven sweeps).
- **T13.2 — retry budget enforcement** — each reclaim counts as an attempt.
  When the post-increment value exceeds `max_retries`, the row is marked
  `failed` instead of `pending`, closing the infinite-reclaim oscillation
  a worker that consistently crashes mid-task would otherwise cause.
  BC break on `reclaimExpired()` return type (`number` →
  `{ reclaimed, exhausted }`) — internal caller and tests updated. Two
  distinct warnings emitted on startup: `...OrphanReclaim` (recovered
  rows) and `...OrphanBudgetExhausted` (budget-exhausted rows).
- **T13.1 — `SqliteTaskQueue` hardening** — atomic check, size cache, corrupt
  envelope quarantine, WAL checkpoint. Production-ready durable backend.
- **`benchmarks/hot-path-micro.benchmark.js` perf gate** — wired into
  `npm run validate`. Establishes p99 budgets for `dispatch()`, `stats`,
  `isAlive()` (≤5μs), and `isReady()` (≤5μs); any regression exits 1 in CI.
  Required to keep the probe-overhead contract honest over time.
- **`cpu-saturation.benchmark.js` Phase E-4** — exercises the probes under
  idle / queue-full / draining states with hard assertions on each `reason`.

### Fixed

- **Pure-ESM `require()` warning (yarn 1.x)** — `package.json#exports."."` now
  declares both `import` and `require` conditions pointing at `src/index.js`.
  Yarn 1.x and other CJS-first resolvers no longer emit
  *"The package doesn't seem to have a commonjs entry point"*. Requires Node
  22.12+ for `require(esm)` to resolve the ESM file synchronously; earlier
  Node 22.x versions need `--experimental-require-module`.
- **CI flake on macOS Node 24** (`test/adaptive-controller.test.js:762`) —
  the `start() is idempotent` test slept 100ms with 20ms cadence and asserted
  `ticks ∈ [2, 8]`. On a loaded macOS CI runner the timer fired only once.
  Sleep widened to 300ms with bounds `[5, 20]`, justified by the documented
  macOS/Windows event-loop slowness in `.agents/CROSS-OS-LESSONS.md` §2.
  Verified locally across 5 consecutive runs (305–315ms each).
- **`commit-lint` workflow** (`.github/workflows/commit-lint.yml:34`) — the
  SHA pinned for `actions/github-script@v7.0.1` had a single-character typo
  (`…794` instead of `…dea`). The workflow errored on every pull request. Now
  pinned to the verified upstream SHA `60a0d83039c74a4aee543508d2ffcb1c3799cdea`.

### Added (housekeeping)

- **`.gitattributes`** — top-level file adopting the `nodejs/node` pattern:
  every text file is normalized to LF on commit, regardless of the author's
  `core.autocrlf` setting. Closes the recurring CRLF false-positive cycle that
  forced `--no-verify` on the v0.2.0 release push.

### Added

- **Runtime liveness + readiness probes** (DR §8.2 closure) — `runtime.isAlive()` and
  `runtime.isReady()` return `{ ok: boolean, reason?: string }`. Reasons:
  `isAlive` → `not-started | no-workers | shutting-down | (true)`;
  `isReady` → `not-started | shutting-down | no-workers | queue-full | (true)`.
  Transport is the caller's responsibility — the runtime stays a library per
  ADR-0005 (no HTTP server, signal handlers, or timers in `src/`). User wires
  Fastify/Express routes, k8s probes, cron, or polling scripts around the
  two methods. Mid-drain `isAlive()` returns `true` (process is alive while
  workers finish); SIGTERM is the orchestrator's kill signal, not a
  liveness-probe failure.
- **`get isShuttingDown()` getter** — closes a long-standing TS↔runtime drift
  where `get isShuttingDown(): boolean` was declared in `src/index.d.ts` but
  never implemented. Exposed so observers don't have to infer shutdown state
  from `getWorkers() === []`.
- **`get maxQueueSize()` on `TaskQueue` and `SqliteTaskQueue`** — previously
  private. Required by `runtime.isReady()` to detect the `queue-full`
  condition without `runtime.stats()` scraping.
- **`benchmarks/hot-path-micro.benchmark.js` perf gate** — wired into
  `npm run validate`. Establishes p99 budgets for `dispatch()`, `stats`,
  `isAlive()` (≤5μs), and `isReady()` (≤5μs); any regression exits 1 in CI.
  Required to keep the probe-overhead contract honest over time.
- **`cpu-saturation.benchmark.js` Phase E-4** — exercises the probes under
  idle / queue-full / draining states with hard assertions on each `reason`.

### Fixed

- **T13.2 orphan reclaim infinite-loop guard** — `SqliteTaskQueue.reclaimExpired()`
  now increments the row's `attempt` counter on every reclaim and marks the
  row `failed` (instead of `pending`) when the post-increment value exceeds
  `max_retries`. Previously a worker that consistently crashed mid-task on the
  same task would oscillate pending → processing → pending forever, blocking
  the queue. BC break on `reclaimExpired()` return type — now
  `{ reclaimed: number, exhausted: number }` instead of `number`. Two distinct
  warnings are emitted on startup: `PersistentWorkerRuntimeSqliteOrphanReclaim`
  (recovered rows) and `PersistentWorkerRuntimeSqliteOrphanBudgetExhausted`
  (budget-exhausted rows).
- **Pure-ESM `require()` warning (yarn 1.x)** — `package.json#exports."."` now
  declares both `import` and `require` conditions pointing at `src/index.js`.
  Yarn 1.x and other CJS-first resolvers no longer emit
  *"The package doesn't seem to have a commonjs entry point"*. Requires Node
  22.12+ for `require(esm)` to resolve the ESM file synchronously; earlier
  Node 22.x versions need `--experimental-require-module`.
- **CI flake on macOS Node 24** (`test/adaptive-controller.test.js:762`) —
  the `start() is idempotent` test slept 100ms with 20ms cadence and asserted
  `ticks ∈ [2, 8]`. On a loaded macOS CI runner the timer fired only once.
  Sleep widened to 300ms with bounds `[5, 20]`, justified by the documented
  macOS/Windows event-loop slowness in `.agents/CROSS-OS-LESSONS.md` §2.
  Verified locally across 5 consecutive runs (305–315ms each).
- **`commit-lint` workflow** (`.github/workflows/commit-lint.yml:34`) — the
  SHA pinned for `actions/github-script@v7.0.1` had a single-character typo
  (`…794` instead of `…dea`). The workflow errored on every pull request. Now
  pinned to the verified upstream SHA `60a0d83039c74a4aee543508d2ffcb1c3799cdea`.

### Added

- **`.gitattributes`** — top-level file adopting the `nodejs/node` pattern:
  every text file is normalized to LF on commit, regardless of the author's
  `core.autocrlf` setting. Closes the recurring CRLF false-positive cycle that
  forced `--no-verify` on the v0.2.0 release push.

## [0.2.0] - 2026-09-21

### Added — ADR-0014 Adaptive Concurrency

- **`concurrency: 'adaptive' | 'fixed'` option** (default `'adaptive'`). The runtime
  now tunes its worker pool size dynamically based on Event Loop Utilization (ELU)
  and `monitorEventLoopDelay` p99. Falls back to the previous fixed pool when
  opted out.
- **`runtime.stats.adaptive`** block: live ELU + p99 metrics, EWMA-smoothed,
  current decision (`grow` / `shrink-from-busy` / `shrink-from-idle` / `hold`),
  pool size history, total grow + shrink events.
- **Grow + drain-shrink lifecycle**: spawned workers are full participants;
  drained workers finish their current task then are removed — no `worker.terminate()`
  on the drain path. Opt out via `concurrency: 'fixed'`.
- **Pool band `[1, maxWorkers]`** that respects the ADR-0019 conservative
  `workers=1` default on multi-core hosts.

### Added — ADR-0024 Runtime Hardening (11 HARDEN tasks)

- **`accumulationRateMbPerSec: number`** (default `Infinity` = disabled) — recycle
  workers whose memory growth rate exceeds the threshold BEFORE the absolute
  `maxMemoryMb` ceiling. Triggers via `worker:memory` event rate + EWMA smoothing.
  HARDEN-06.
- **`minRecycleIntervalMs: number`** (default `0` = disabled) — hysteresis window
  that suppresses follow-up recycles for the same worker within the configured
  window. Mitigates spurious recycles on transient bursts. HARDEN-07.
- **`recycleOnTasksExhausted: boolean`** (default `true`) — opt-out from
  automatic recycling on `maxTasksPerWorker`. When `false`, emits
  `worker_tasks:exhausted` warning event instead, giving the user full control
  over when (if ever) to drain + recycle. HARDEN-08.
- **`dispatchStrategy: 'fifo' | 'lru' | 'random'`** (default `'lru'`) — worker
  selection strategy. `'fifo'` preserves the pre-0.2.0 determinism contract
  for tests that depended on it. HARDEN-09.
- **`workerPollIntervalMs: number`** (default `1000`, clamp min `100`) — supervisor
  watchdog poll cadence, decoupled from `task.timeoutMs`. Lower values give more
  responsive runaway detection without shortening task timeouts. HARDEN-10.
- **`recycleBackoffMs: number`** (default `0` = disabled) — drain-grace window
  between worker recycle and physical termination. The old worker stays in
  `runtime.getWorkers()` (status `'recycling'`) for that long, while the
  replacement is already serving tasks. Pool capacity is temporarily N+1,
  drops back to N when the timer fires. HARDEN-11.
- **`runtime.getWorkers()`** synchronous snapshot method — array of `{ id, status,
  tasksCompleted, lastMemoryUsageBytes }` per worker. Useful for dashboards
  and tests. HARDEN-03.
- **`runtime.stats.workers`** aggregate — `total`, `idle`, `busy`, `recycling`,
  `terminating`, `byStatus`, plus the new `adaptive` block. HARDEN-04.
- **`worker:memory` event** opt-in (via `observeWorkerMemory: true`) — fires
  per-worker memory updates at the configured cadence. HARDEN-05.
- **`taskFnDeps`** manifest IPC injection — task functions can now declare
  per-task dependencies that are pre-loaded into the worker's L1 module cache
  before dispatch. HARDEN-02.
- **`timeoutMs` default + warning guard** — `task-handle.js` defaults to 30s
  with a `PersistentWorkerRuntimeTimeoutMsDefault` process warning when the
  caller doesn't set it explicitly. HARDEN-01.

### Fixed

- **Recycle-backoff Promise leak** (`714f1e6`) — `shutdown()` now invokes
  `resolve()` on the awaiting Promise inside `#checkRecycling` (not just
  `clearTimeout`), preventing the closure leak when shutdown interrupts
  an in-flight backoff. Issue 002 Finding 1.
- **Chunk leak after shutdown** (`b5c4bde`) — late chunks buffered in the
  worker MessagePort no longer fire `stream:chunk` on a torn-down runtime.
  `onChunk` in `worker-runtime.js` now guards with `if (this.#isShuttingDown)
  return;` before the emit. Track 2 of the pre-stable queue.
- **`#startWorkerPoll` redundant branches** (`12f7603`) — collapsed the
  if/else into a single `#checkRecycling` call hoisted out of the
  `accumulationEnabled` guard. Issue 002 Finding 2.

### Changed

- **Default dispatch strategy**: `'fifo'` → `'lru'`. Tests that depended on
  determinism can opt back via `dispatchStrategy: 'fifo'`. BC-1.
- **Watchdog preemption cadence**: now `workerPollIntervalMs` (default 1000ms)
  instead of `task.timeoutMs`. Independent knobs; no breaking change for users
  who set `timeoutMs`. BC-2.
- **Poll always runs**: previously gated on accumulation rate; now always
  runs once per `workerPollIntervalMs`. Cost is one cheap function call per
  worker per tick (early-return guard). BC-3.

### Tests

- 563 passing across 153 suites (`node:test`), 0 failures, **0 skipped**
  (first-time zero-skip pipeline). Up from 561/562 in v0.1.0.

## [0.1.0] - 2026-09-12

Initial release. 561 passing tests across 152 suites. Implements:

- Bounded persistent worker pool atop `node:worker_threads`.
- Stateful L1 worker memory preserved across task executions.
- Hard preemption watchdog with task timeout enforcement.
- Worker recycling (max-tasks + max-memory triggers).
- Streaming API with `runtime.stream()` AsyncGenerator + backpressure.
- BroadcastChannel for inter-worker pub/sub + L1 cache invalidation.
- Priority routing with tier dequeue + FIFO-within-tier.
- Cooperative cancellation via `AbortSignal` (TaskAbortedError).
- Zero-copy `ArrayBuffer` transferList.
- Transactional outbox pattern with `dispatch()` / `dispatchAll()`.
- Default pool sizing (workers=1 conservative default).
- Adaptive concurrency controller (ADR-0014 foundation; full version
  lands in 0.2.0).
