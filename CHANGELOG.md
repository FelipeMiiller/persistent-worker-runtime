# Changelog

All notable changes to `persistent-worker-runtime` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
