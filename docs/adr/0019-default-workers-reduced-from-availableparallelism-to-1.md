# ADR-0019: Default Worker Pool Size Reduced from `availableParallelism() - 1` to `1`

- **Date**: 2026-09-17
- **Status**: Accepted
- **Deciders**: Felipe Miiller
- **Tags**: memory, sizing, default, observability, resource-limits, worker_threads

## Context and Problem Statement

The current default worker pool size, established in the initial implementation (ADR-0001, ADR-0009), is:

```js
const defaultWorkers = Math.max(1, availableParallelism() - 1);
```

On a 28-core machine (a common production / CI host), this spawns **27 V8 isolates** at startup, each a fully-fledged Node.js worker thread with its own:

- Heap (default old-gen ≈ 2-4 GB per isolate, configurable via `--max-old-space-size`)
- Code cache (JIT)
- Stack + native module state
- **Process `rss` baseline of ~30-50 MB resident memory per worker** on a fresh boot

Empirical result: starting `createWorkerRuntime()` on a 28-core laptop with default settings reserves **~1 GB of resident memory** before any task is dispatched. On a 4-core box the cost is ~150 MB. On 2-core or 1-core it is ~50 MB.

In our internal benchmarks, **most workloads (transactional outbox, request-response, bounded batch) do not exceed 1-2 active workers at a time**. The default over-provisions by a factor of 10-20× and ships the cost to every consumer of the library — including apps that never run a second task in parallel.

The library's stated philosophy is **"The Event Loop coordinates. Persistent Workers execute."** — but that does NOT mean "spawn as many workers as the host has cores by default." Persistent means "alive across tasks", not "fills the threadpool."

### Why this matters now

1. **CI environment parity**: GitHub Actions runners expose 2 cores on free tier, 4 on pro, 28 on hosted enterprise (`-latest`) and macOS. Random default behaviour per host creates unpredictable memory pressure in tests and production parity issues.

2. **Container / serverless deployment**: A 512 MB container that runs `node ...` plus the runtime must reserve memory upfront. 27 workers × ~40 MB = 1.08 GB just for the pool, blowing past container limits with zero work done.

3. **Memory headroom for the actual workload**: Tasks that legitimately need L1 caches or large buffers (AST trees, ML embeddings, compiled WASM modules) need MB of heap to themselves. Crowding 20 workers into a 1 GB RSS budget means each one can only grow to ~50 MB before the OS swap-thrashes.

4. **Cost**: Production servers billed by RAM (AWS Lambda, Cloud Run, Fly.io) pay the wrong invoice.

## Decision Drivers

- Default behavior must be safe on the smallest host the library targets (1-core CI runners, 256 MB containers).
- Users who need parallelism must be able to opt in explicitly and easily.
- Sizing guidance must be visible at runtime (a startup hint), not buried in docs nobody reads.
- Do NOT change the runtime API surface — `options.workers` already exists; just default it better.
- Do NOT silently cap the user's explicit choice — if they say `workers: 8`, they get 8.
- Heed Node.js core's actual primitives: `Worker` already accepts `resourceLimits`, `process.memoryUsage()` already works per-isolate, and we should surface both without inventing a new abstraction layer.

## Cross-Language Reference

We surveyed worker-pool sizing in **Go** (closest comparable mainstream runtime with a strong concurrency story):

| Aspect | Go | Node `worker_threads` | Implication |
| --- | --- | --- | --- |
| Worker stack | ~2 KB (growable) | ~30-50 MB resident (full V8 isolate) | Node is **10000× more expensive per worker** in memory |
| Spawn latency | ~1 µs | ~20-100 ms (V8 init + module graph) | Node is **10000× slower to start** |
| Default pool sizing | `runtime.GOMAXPROCS` = `runtime.NumCPU()` for CPU-bound; 2-10× for I/O | Currently `Math.max(1, availableParallelism() - 1)` | Go's default is fine; Node's is overkill by ~20× for typical CPU work and leaks the cost into every host |
| Heap sharing | All goroutines share one GC heap | Each worker is a separate V8 isolate with its own heap | Node cannot elide worker memory via shared caches |
| Cost model | Cheap, fan-out is free, often millions of goroutines | Expensive, pay per worker upfront | Node's default should match this — *low default, opt up* |

The Go reference confirms our read: a serious production language that has cheap workers still sizes the **default pool** to `GOMAXPROCS` (= core count) but expects most apps to **overprovision** only when measurements say so. Node's analogous posture is "start with 1, opt up only when benchmarked throughput requires it" — given the memory ratio above.

Node.js's own internal recommendations back this up. The `Worker` constructor accepts `resourceLimits: { maxOldGenerationSizeMb, maxYoungGenerationSizeMb, codeRangeSizeMb, stackSizeMb }` precisely so consumers can impose per-worker ceilings. Reaching a limit terminates the worker with `ERR_WORKER_OUT_OF_MEMORY` (Node >= 24). This is the right primitive; we should use it, not invent something new.

## Considered Options

- **Option 1: Keep `availableParallelism() - 1` as the default** — status quo. Memory cost paid by every consumer regardless of workload shape.
- **Option 2: New default = `1`, warn on machines with >4 cores** — lightweight, non-breaking, surfaces the trade-off. **Chosen.**
- **Option 3: New default = `0` (lazy, spawn-on-demand)** — also memory-safe but introduces a cold-start penalty on the first task and requires a `min: 1` floor anyway.
- **Option 4: Default = `1`, allow `Infinity` for unbounded** — invites OOM in production.

## Decision Outcome

Chosen: **"Option 2: New default = `1`, warn on machines with >4 cores"**.

### Architectural Mechanics

#### 1. Constructor change (`src/worker-runtime.js:66-86`)

```js
const userSpecifiedWorkerCount = typeof options.workers === 'number';
const defaultWorkers = 1; // see ADR-0019; user can opt up to availableParallelism() - 1
const workerCount = userSpecifiedWorkerCount ? options.workers : defaultWorkers;

if (!userSpecifiedWorkerCount) {
  const cores = availableParallelism();
  if (cores > 4) {
    process.emitWarning(
      `persistent-worker-runtime: started with default workers=1 on a ${cores}-core host. ` +
      `Each Node worker is a separate V8 isolate (~30-50 MB RSS) and uses a parallel OS thread; ` +
      `size the pool explicitly via createWorkerRuntime({ workers: N }) where N <= ` +
      `os.availableParallelism() - 1. See BENCHMARKS.md §Memory and ADR-0019 for sizing guidance.`,
      'PersistentWorkerRuntimeDefaultSizing',
    );
  }
}
```

Key invariants:

- **Breaking change for nobody in the 90% case**: apps that explicitly pass `workers: N` get exactly `N` workers, like before.
- **Apps that previously relied on the default to ~fill the host** will see one worker instead. They will see the warning, follow the docs to opt up, and run a benchmark to find their actual sweet spot.
- The warning uses `process.emitWarning('...', 'PersistentWorkerRuntimeDefaultSizing')` so it carries a code prefix, is captured by `util.getCallSite`, and can be filtered upstream.

#### 2. Validation of `options.resourceLimits`

`resourceLimits` was already plumbed from `createWorkerRuntime` → Supervisor → WorkerHandle → `new Worker(...)`. We add input validation:

```js
if (options.resourceLimits !== undefined) {
  const rl = options.resourceLimits;
  if (rl === null || typeof rl !== 'object') {
    throw new TypeError('resourceLimits must be an object or undefined');
  }
  for (const k of [
    'maxYoungGenerationSizeMb',
    'maxOldGenerationSizeMb',
    'codeRangeSizeMb',
    'stackSizeMb',
  ]) {
    if (rl[k] !== undefined && (typeof rl[k] !== 'number' || rl[k] <= 0)) {
      throw new RangeError(`resourceLimits.${k} must be a positive number (got ${rl[k]})`);
    }
  }
}
```

This catches typos at startup instead of letting them silently propagate as a malformed `resourceLimits` object.

#### 3. Documentation rewrite (`BENCHMARKS.md`, `HANDOVER.md`, `AGENTS.md`)

A new **§Memory** subsection in `BENCHMARKS.md` will publish per-benchmark `process.memoryUsage()` deltas (RSS peak, heap growth) so users can see the real cost of each pattern before choosing sizing.

### Positive Consequences

- **Default container footprint drops ~20×** on multi-core hosts.
- Users running on ≥8-core boxes gain a visible signal (the warning) that they are leaving capacity on the table — they can opt up explicitly.
- Code uses primitives already in Node (`Worker.resourceLimits`, `process.memoryUsage`, `process.emitWarning`) — no new abstractions.
- Apps that already pass `workers` explicitly are unaffected (no API change, no runtime behaviour change).
- `resourceLimits` becomes a first-class validated option rather than an undocumented escape hatch.

### Negative Consequences

- **Breaking change for users who relied on the default to scale to host core count.** Mitigation: the warning makes the migration path self-documenting; the fix is one line of `createWorkerRuntime({ workers: N })`.
- The warning is verbose on every startup. Mitigation: it only fires when the **default** is taken AND the host has > 4 cores (which is most CI / prod but not every local dev box).
- Sizing guidance is per-host and per-workload — there is no one-size-fits-all recommendation. Mitigation: the BENCHMARKS.md §Memory section will publish the empirical numbers from a 28-core machine so users have a reference point, not just a recommendation.

## Pros and Cons of the Options

### Option 2 ✅ Chosen

- ✅ Lowest default memory footprint for the common case.
- ✅ Self-documenting via the `PersistentWorkerRuntimeDefaultSizing` warning.
- ✅ Zero effect on explicit callers.
- ✅ All Node-core primitives, zero new abstractions.
- ❌ Mild migration cost for existing implicit-default users.

### Option 1 (status quo)

- ✅ No migration friction.
- ❌ 1 GB+ RSS baseline on common hosts — unsustainable for containers and serverless.
- ❌ Encourages the "fill the core pool" anti-pattern that Node's memory model cannot afford.

### Option 3 (lazy default = 0)

- ✅ Even more memory-efficient on cold start.
- ❌ First-task latency penalty (V8 spawn).
- ❌ Confusing API: a `workers: 0` runtime that becomes `workers: 1` mid-stream is a footgun.
- ❌ Does not help if the runtime is long-lived (the typical case).

### Option 4 (default = 1, allow Infinity)

- ✅ Maximum flexibility.
- ❌ `Infinity` workers will OOM a container in seconds. Capping at runtime-config-defined `maxWorkers` would be safer, but that's a different feature.

## Verification

- Unit tests must assert the new behaviour:
  - `workers: 1` (explicit) → 1 worker, no warning emitted.
  - No `workers` option on a 28-core host → 1 worker + warning with code `PersistentWorkerRuntimeDefaultSizing`.
  - No `workers` option on a ≤4-core host → 1 worker + NO warning (don't nag small hosts).
  - `workers: N` for arbitrary N → N workers, no warning, no validation error.
- Benchmarks (`BENCHMARKS.md §Memory`) publish RSS / heap stats measured at the main thread at user-controlled sample points using a `MemoryProfiler` utility (`benchmarks/lib/memory-profiler.js`). See §Follow-ups.

## Follow-ups (deferred to a future chat / spec)

1. **`runtime.memoryUsageReport()`** — send an IPC ping to each live worker and aggregate `process.memoryUsage()` from each isolate. The main thread's own `process.memoryUsage()` only shows the main isolate; without this method users have to add per-worker plumbing to see the whole pool's footprint.
2. **`worker.getHeapSnapshot()`-based profile diff** — when investigating suspected leaks, call `worker.getHeapSnapshot()` from each worker and `heapProfiler` the result. Convenience method on the runtime to gather and emit per-worker `.heapsnapshot` files on demand.
3. **`maxOldGenerationSizeMb` warning helper** — when the user passes `resourceLimits` whose values collectively exceed the recommended ~75 % of host physical memory (read from `os.totalmem()` / `cgroup memory.max`), emit a startup warning.
4. **Per-benchmark memory sections** in `BENCHMARKS.md` (deferred — large content; should be a spec on its own).

## Links

- Empirical memory cost captured for the next chat: see the in-progress change at `src/worker-runtime.js:66-86` (default=1 + warning) and `benchmarks/lib/memory-profiler.js` (shared util).
- Node reference: [`worker.resourceLimits`](https://nodejs.org/api/worker_threads.html#workerresourcelimits) — `maxOldGenerationSizeMb`, `maxYoungGenerationSizeMb`, `codeRangeSizeMb`, `stackSizeMb`. Reaching a limit terminates the worker with `ERR_WORKER_OUT_OF_MEMORY` (Node >= 24).
- Node reference: [`process.memoryUsage()`](https://nodejs.org/api/process.html#processmemoryusage) — per-thread snapshot (`rss`, `heapTotal`, `heapUsed`, `external`, `arrayBuffers`); workers are **invisible** to the main thread's measurement.
- Node reference: [Understanding and Tuning Memory](https://nodejs.org/learn/diagnostics/memory/understanding-and-tuning-memory) — best-practice guidance for production memory monitoring.
- Go reference: [Mastering the Go Work-Stealing Scheduler](https://martinuke0.github.io/posts/2026-06-01-mastering-the-go-work-stealing-scheduler-architecture-goroutine-management-and-production-performance-patterns/) — pool size = `GOMAXPROCS` for CPU-bound, 2-10× for I/O; goroutines cost ~2 KB stack + µs spawn because they share one heap.
- Related ADRs:
  - [ADR-0001](0001-persistent-worker-runtime-over-worker-threads.md) — the original choice that picked `availableParallelism() - 1` as the default; ADR-0019 reverses part of that choice based on empirical cost.
  - [ADR-0009](0009-elastic-worker-pool-auto-scaling.md) — the dynamic sizing layer (`min`, `max`, `idleTimeoutMs`); ADR-0019 sets the *un*-sized default but does NOT conflict with the dynamic sizing API.
  - [ADR-0010](0010-automatic-worker-recycling-anti-memory-leak.md) — `maxTasksPerWorker` + `maxMemoryMb` recycle policy; ADR-0019 makes the per-worker ceiling a normalized concern via `resourceLimits`.