---
name: persistent-worker-runtime
description: Use the persistent-worker-runtime library to offload CPU-bound work to persistent Node.js worker threads while keeping the Event Loop responsive. Load when the user wants to set up a worker pool (fixed or adaptive), execute tasks on workers, stream results via runtime.stream(), handle cancellations, transfer binary data with zero copy, set up stateful workers with warm L1 memory, implement transactional outbox patterns, run persistent background jobs, use a durable SQLite-backed queue (SqliteTaskQueue via queueBackend: 'sqlite' with lease-based orphan recovery + retry budget), wire liveness/readiness probes via runtime.isAlive() + runtime.isReady(), use BroadcastChannel for inter-worker communication (e.g. L1 cache invalidation), tune hard preemption via workerPollIntervalMs, configure worker recycling (maxTasksPerWorker, maxMemoryMb, accumulationRateMbPerSec, minRecycleIntervalMs, recycleOnTasksExhausted), set dispatchStrategy (fifo / lru / random), set recycleBackoffMs for drain grace, observe per-worker memory via observeWorkerMemory, or read runtime.getWorkers() / runtime.stats.workers / runtime.stats.adaptive for observability. Triggers on "persistent-worker-runtime", "worker pool", "worker_threads", "execute a task on a worker", "dispatch background job", "streaming results", "L1 worker memory", "transactional outbox", "zero-copy transfer", "abort a worker task", "priority task queue", "broadcast channel", "inter-worker communication", "cache invalidation across workers", "adaptive concurrency", "rate-based recycling", "watchdog", "preemption", "SqliteTaskQueue", "durable queue", "queueBackend sqlite", "lease reclaim", "retry budget", "runtime.isAlive", "runtime.isReady", "liveness probe", "readiness probe", "k8s livenessProbe", "k8s readinessProbe", "/healthz", "/readyz", "DR §8.2". DO NOT load for unrelated concurrency topics like Promise.all scaling or general multi-threading tutorials.
license: MIT
metadata:
  author: Felipe Miiller
  version: 0.3.0
  package: persistent-worker-runtime
---

# Persistent Worker Runtime

Offload CPU-bound work to persistent Node.js worker threads without blocking the Event Loop. Workers stay alive across tasks and can keep warm in-memory state.

```
┌──────────────────────┐         ┌──────────────────────┐
│  Main Thread         │  IPC    │  Worker Pool          │
│  (Event Loop)        │ ──────> │  ┌────┐ ┌────┐ ┌────┐ │
│  - HTTP requests     │         │  │ W1 │ │ W2 │ │ W3 │ │
│  - I/O               │         │  └────┘ └────┘ └────┘ │
│  - Coordination      │         │  (L1 heap / V8 isolate) │
└──────────────────────┘         └──────────────────────┘
```

---

## 1. Install

```bash
npm install persistent-worker-runtime
```

Requires **Node.js >= 22.13** (`node:sqlite` stdlib is the new minimum; stable on all current LTS lines). Pure ESM, **zero external dependencies** (only `node:*` built-ins — `node:worker_threads`, `node:sqlite`, `node:async_hooks`, `node:broadcast_channel`).

---

## 2. Quick Start (60 seconds)

### Two-mode execution model

| Mode | Method | Returns | Use when |
| --- | --- | --- | --- |
| **Request-Response** | `runtime.execute(task)` | `Promise<result>` | Need the result back (HTTP handlers, RPC) |
| **Outbox (Background)** | `runtime.dispatch(task)` | `TaskHandle` (with `.onComplete`) | Fire-and-confirm (transactional outbox, webhooks, batch jobs) |

```javascript
import { createWorkerRuntime } from 'persistent-worker-runtime';

// Request-Response
const runtime = await createWorkerRuntime({ workers: 4 });
const result = await runtime.execute({
  type: 'compute',
  payload: { a: 40, b: 2 },
  fn: ({ a, b }) => a + b,
});
console.log(result); // 42

// Outbox (Background)
const handle = runtime.dispatch({
  type: 'send_email',
  payload: { to: 'user@example.com', subject: 'Welcome' },
  retries: 3,
  fn: async (p) => mailer.send(p),
});
handle.onComplete((r) => db.auditLog.insert({ task: 'send_email', result: r }));
handle.onError((err) => db.failedJobs.insert({ task: 'send_email', error: err.message }));

await runtime.shutdown();
```

---

## 3. Which reference to read

The runtime has many features; load the reference that matches the task.

| Need | Read |
| --- | --- |
| Step-by-step first-use walkthrough | `references/quickstart.md` |
| Full TypeScript API surface (incl. `isAlive` / `isReady` / `SqliteTaskQueue`) | `references/api-reference.md` |
| **Stateful workers, L1 cache, bounded batch, affinity** | `references/stateful-l1.md` |
| **Cancellation (AbortSignal) and priority queue** | `references/cancellation-priority.md` |
| **Zero-copy transfer, retries with backoff, hard preemption** | `references/zero-copy-preemption.md` |
| **Inter-worker BroadcastChannel (L1 cache invalidation)** | `references/broadcast-channel.md` |
| **Observability, lifecycle, memory recycling, error hierarchy** | `references/observability.md` |
| Runnable end-to-end patterns | `references/patterns.md` |

### Runnable examples

All 20 live in [`examples/`](../../examples) and run directly with `node examples/<name>.js`.

**Core patterns**

| Example | Shows |
| --- | --- |
| `express-outbox-email.js` | Transactional outbox over HTTP |
| `image-resizer-batch.js` | Bounded batch processing |
| `persistent-ai-model.js` | Warm L1 model cache |
| `priority-routing.js` | Tiered priority ordering |
| `zero-copy-image.js` | 30 MB buffer via `transferList` |
| `cancel-on-disconnect.js` | `AbortController` + `AbortSignal.timeout()` |
| `broadcast-cache-invalidation.js` | L1 invalidation via `runtime.broadcast()` |
| `streaming-llm.js` | Token streaming, TTFT, mid-stream abort |
| `streaming-csv-export.js` | Backpressure timeline (`highWaterMark`) |
| `event-target-pattern.js` | `addEventListener` + `{ signal }` cleanup (v0.3.x+ style) |
| `worker-recycling.js` | Recycling observable end-to-end |
| `adaptive-concurrency.js` | Adaptive pool sizing, `stats.adaptive` |

**Durable queue (`queueBackend: 'sqlite'`)**

| Example | Shows |
| --- | --- |
| `durable-task-queue.js` | Rows survive a runtime restart |
| `durable-task-recovery-runtime.js` | Crash mid-flight → lease-based orphan recovery |
| `durable-task-priority.js` | Priority + `affinityKey` preserved across restart |
| `durable-task-multi-instance.js` | Two instances sharing one file, only one claims a row |
| `durable-task-vacuum.js` | `vacuumCompleted()` + `checkpointWal()` disk reclaim |

**Operations**

| Example | Shows |
| --- | --- |
| `sigterm-drain.js` | DR §8.1 recipe — idempotent SIGTERM handler + hard timeout |
| `cpu-io-split.js` | Does CPU work delay I/O? Do you need a dedicated I/O worker? |
| `parallel-json-parse.js` | Chunk-parallel parse of a multi-GB JSON file |

---

## 4. Common Mistakes

1. **Don't dispatch after `shutdown()`** — throws `WorkerRuntimeError`. Always guard with `if (!runtime.isShuttingDown)`.
2. **Don't reuse transferred buffers** — they're detached on the sender. Move the reference to the worker.
3. **Don't put closures in `fnCode`** — runs in worker thread with no main-thread scope. Pass everything via `payload`. This includes `BroadcastChannel` channel names — inline them as literals.
4. **Don't ignore `recycledCount`** — design stateful code to re-warm gracefully. Otherwise the first request after recycle will spike.
5. **Don't `await enqueue()` without handling cancellation** — if the task gets aborted mid-wait, the queue's `enqueue()` Promise stays pending until `runtime.shutdown()` (handled internally, but custom waiters should be cleaned up).
6. **Don't expect `BroadcastChannel` to loop back to the sender** — if a worker invalidates its own cache, do it explicitly in addition to `publish()`-ing.
7. **Don't `subscribe()` after `runtime.shutdown()`** — the underlying BC has been closed; `subscribe()` will throw. Subscribe BEFORE shutdown if you need to receive late messages.
8. **Don't assume worker affinity is permanent** — recycled workers lose their `affinityKey` mapping; re-dispatch with the same key to re-pin.
9. **Don't use `runtime.execute()` fire-and-forget** — `execute()` returns a Promise that MUST be awaited or `.catch()`-handled. A discarded Promise becomes a worker crash error after the calling scope returns, surfacing as a CI flake ("async activity after the test ended") on slower runners (macOS Node 22). Use `dispatch()` for intentional fire-and-forget. See ADR-0018.
10. **Don't treat `task:failed` as "every task that didn't succeed"** — a **preempted** task emits `task:preempted` and **never** `task:failed`, so a `task:failed`-only listener silently misses every watchdog kill. `stats.failedTasks` *does* include preemption; the event stream deliberately does not (ADR-0011, Decision Driver #4). Listen to both. The handle itself settles with `TaskTimeoutError { preempted: true }`, so `await` / `onError` are unaffected. See `references/observability.md`.
11. **Don't close over module scope inside a task `fn`** — `fn` is serialised and re-evaluated in the worker isolate (`new Function` in `worker-thread-entry.js`), so module-level `const`s are simply *undefined* there. Pass everything through `payload`; reach Node builtins with `await import('node:fs')` or the injected `fnDeps` manifest. This is the same class of bug as #3 and bites hardest in helpers that "obviously" have their config nearby.

---

## 4b. Large files: the bottleneck is usually the disk, not the parser

Measured on this repo (28 cores, cold SATA SSD — full write-up in
[`research/README.md`](../../research/README.md)):

| workload | 1 worker | 4 workers | ceiling |
| --- | --- | --- | --- |
| `JSON.parse` alone, in memory | 1.00× | **6.6×** | CPU |
| 10 GB file from disk | 1.00× | **1.97×** | **disk** |

`JSON.parse` itself parallelises near-linearly. A large *cold* file does not, because the
non-parse share of wall time climbs from ~12% (2 workers) to ~33% (8 workers) — more workers
interleave more read streams and queue worse on one device. **Do not tune worker count against a
cold multi-GB file**; you are optimising the disk. Warm the page cache, or use fewer/larger
sequential reads, first.

**Two hard constraints when parsing big JSON:**

1. **V8 refuses a string over `0x1fffffe8` chars (~512 MB).** It fails in `Buffer.toString()`,
   *before* `JSON.parse` runs. So you must read byte ranges, and the chunk count comes from file
   size — never from worker count, because the limit applies to a single slice no matter how many
   workers exist.
2. **Batch tasks need `timeoutMs: 0`.** The default is 5000 ms, and a multi-hundred-MB chunk
   blows straight through it.

**The time/memory trade** (4 GB file, peak RSS measured in a separate process per variant):

| approach | wall | peak RSS |
| --- | --- | --- |
| chunk-parallel ×1 | 48.7 s | 2.30 GB |
| chunk-parallel ×4 | 18.8 s | 7.42 GB |
| NDJSON streaming | 39.6 s | **0.34 GB** |

RAM scales linearly with worker count, so it is a straight trade, not a free win. Note that
NDJSON **beats single-worker chunk-parallel on both axes** — chunk-parallel only wins by adding
workers, and each costs ~1.9× the file size in RAM. Rule of thumb: chunk-parallel needs about
`1.9 × fileSize` of free RAM. Runnable: `examples/parallel-json-parse.js`.

---

## 5. Production deployment & known gaps

This skill teaches the **shipped API surface**. For production-readiness gaps that are **deliberately deferred** in the reference implementation, see:

- **AGENTS.md → [`.agents/issues/`](../../AGENTS.md#-tracked-issues--known-drift-agentsissues)** — canonical links to tracked issues (supervisor.start idempotency, Wave 4 review findings, macOS benchmark portability).
- **[`docs/operations/disaster-recovery.md` §8](../../docs/operations/disaster-recovery.md#8-open-items-gaps-to-close)** — production-readiness gaps. **§8.2 `/healthz` is closed (2026-09-24)** — runtime exposes `runtime.isAlive()` + `runtime.isReady()` (transport wiring is user-side: HTTP route / k8s probe / cron / polling script). The runtime stays a library per ADR-0005 (no HTTP server, signal handlers, or timers in `src/`). **`§8.3 OpenTelemetry` and `§8.4 Postgres SKIP LOCKED backend` are permanently out-of-scope by rule** (ADR-0005 pure vanilla JS, zero external runtime deps — see AGENTS.md cross-ref). User installs `@opentelemetry/api` themselves; user fronts with their own Postgres queue. **`§8.1 SIGTERM` is still user-wired**: `process.on('SIGTERM', () => runtime.shutdown())`. **`§8.5 / §8.6` are still open.**

If you're writing a skill or doc that claims a feature is "implemented", verify against `src/` + `STATE.md` + the relevant ADR before stating it as fact — tracked drift has shipped in the past (see `HANDOVER.md` lines 90-95 for the 2026-09-23 correction).