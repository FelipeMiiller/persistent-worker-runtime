# Changelog

All notable changes to `persistent-worker-runtime` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
