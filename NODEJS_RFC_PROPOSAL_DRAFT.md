# RFC Proposal: Persistent Worker Runtime for Node.js Core

**Author:** Felipe Miiller / Contributors  
**Status:** Draft / Proposed for Discussion  
**Target Repository:** `nodejs/node`  
**Target Subsystem:** `worker_threads` / `lib/internal/worker/` / `node:worker_runtime`  

---

## 1. Summary

This proposal outlines the addition of a built-in **Persistent Worker Runtime** to Node.js. 

While Node.js provides low-level threading primitives via `node:worker_threads` (`Worker`, `MessageChannel`, `MessagePort`), developers who need to offload CPU-bound work without starving the main Event Loop currently face high complexity in building, maintaining, and observing persistent worker pools. Furthermore, existing userland abstractions focus almost exclusively on ephemeral, stateless function execution, discarding valuable in-memory worker state (caches, parsed models, compiled assets) across tasks.

We propose a native, zero-dependency, promise-based runtime built into Node.js that enables:
1. Seamless offloading of CPU-bound tasks away from the Event Loop.
2. Built-in **Stateful Workers** with worker affinity, preserving L1 worker-local memory between executions.
3. First-class integration with Node.js diagnostics (`node:async_hooks` / `AsyncResource`), structured error propagation, backpressure controls, and graceful supervisor-driven lifecycle management.

---

## 2. Motivation: The CPU-Bound Dilemma in Node.js

Node.js is renowned for its non-blocking asynchronous I/O performance. However, whenever an application performs synchronous, CPU-intensive computation (e.g., cryptographic hashing, heavy JSON/AST manipulation, image transformation, machine learning inference, regex evaluation over large text), the single-threaded Event Loop freezes:

```text
HTTP Request (I/O)
       │
       ▼
Main Event Loop  ◄─── BLOCKED by synchronous CPU task (e.g., 80ms)
       │
       ├── Incoming requests experience latency spike / timeouts
       └── Event Loop lag surges
```

### The Current Status Quo & Limitations:
1. **Manual `new Worker()` per task:** High overhead. Creating a new V8 Isolate, thread stack, and bootstrap environment takes tens of milliseconds and significant memory.
2. **Ad-hoc Userland Pools:** Every team either writes their own fragile worker pool using `worker_threads` or relies on external npm packages like `piscina` or `workerpool`.
3. **Stateless Assumptions:** Almost all existing tools discard the Worker's private heap state after each task, preventing patterns where a worker loads a heavy artifact once (such as a WASM module, pre-computed graph, or ML model) and serves multiple subsequent tasks with near-zero initialization cost.
4. **Lack of a Standard Core Primitive:** Concurrency for CPU-bound tasks remains a second-class citizen in Node.js compared to languages like Go (goroutines/channels) or Java (ExecutorService).

---

## 3. Why This Belongs in Node.js Core ("Small Core" Justification)

In accordance with Node.js TSC principles, any addition to core must justify why it should not merely remain in userland. The justification for a native Persistent Worker Runtime is:

1. **Standardizing the Missing Concurrency Primitive:**
   Just as `node:test` standardized testing and `node:sqlite` provided friction-free embedded persistence, a built-in execution runtime provides a batteries-included answer to the most persistent complaint about Node.js ("Node cannot handle CPU work").
2. **Deep Diagnostic & Async Context Integration:**
   Native coordination with `AsyncResource` and `AsyncLocalStorage` guarantees transparent tracing across thread boundaries for OpenTelemetry and APMs without monkey-patching or userland tracking bugs.
3. **Optimized V8 Isolate & Memory Plumbing:**
   Core-level integration enables streamlined message passing, zero-copy buffer transfers, and controlled memory limit enforcement via V8 `ResourceLimits` that userland packages cannot configure with internal stability.
4. **Zero-Dependency Universal DX:**
   Developers building CLIs, microservices, and libraries can rely on a performant background execution layer without bloating their `node_modules` dependency trees.

---

## 4. Proposed High-Level Architecture

The core design principle is:
> **The Main Event Loop coordinates; Persistent Workers execute.**

```text
                    NODE.JS APPLICATION
                            │
                            ▼
                     ┌─────────────┐
                     │ Event Loop  │
                     └──────┬──────┘
                            │ submit(task)
                            ▼
              ┌───────────────────────────┐
              │      Worker Runtime       │
              │                           │
              │  TaskQueue (Backpressure) │
              │  Scheduler (Affinity/FIFO)│
              │  Supervisor (Health/Crash)│
              └─────────────┬─────────────┘
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
      Worker Thread 1  Worker Thread 2  Worker Thread N
     ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
     │ L1 Local Mem │ │ L1 Local Mem │ │ L1 Local Mem │
     │  (Cache/ML)  │ │  (Cache/ML)  │ │  (Cache/ML)  │
     └──────────────┘ └──────────────┘ └──────────────┘
```

### Memory Hierarchy:
* **L1 (Worker-Local Heap):** Private to each worker thread. Zero locking, maximum speed. Ideal for warm caches, initialized WASM/ML runtimes, and local scratchpads.
* **L2 (Shared Memory - Future Opt-in):** `SharedArrayBuffer` + `Atomics` for zero-copy binary streaming when benchmarks prove necessity.
* **L3 (Durable Storage):** External to the worker heap (e.g., SQLite via `node:sqlite` or filesystem) for crash resilience.

---

## 5. Proposed Public API (Conceptual JavaScript)

The API is fully Promise-based, idiomatic, and designed to minimize boilerplate.

### 5.1 Basic Usage: Ephemeral Tasks
```javascript
import { createWorkerRuntime } from 'node:worker_runtime';

// Initialize a pool with default hardware concurrency sizing
const runtime = createWorkerRuntime({
  maxWorkers: 4,
  workerScript: './workers/compute-processor.js',
  maxQueueSize: 1000,
});

// Submit a CPU-bound task without blocking the event loop
const result = await runtime.execute({
  type: 'compress-data',
  payload: largeBuffer,
});

console.log('Result received:', result);
```

### 5.2 Stateful Workers & Worker Affinity
```javascript
// Spawn or acquire a dedicated worker handle with persistent state
const aiWorker = runtime.createStatefulWorker({
  name: 'embedding-engine',
  workerScript: './workers/embedding-worker.js',
});

// Task 1: Initializes local state inside the worker (e.g., warm weights)
await aiWorker.execute({ action: 'load-model', modelId: 'bert-tiny' });

// Subsequent tasks reuse the warmed worker-local state with zero reload overhead
const vectorA = await aiWorker.execute({ action: 'embed', text: 'Hello Node' });
const vectorB = await aiWorker.execute({ action: 'embed', text: 'Persistent Workers' });
```

### 5.3 Cancellation, Timeouts & Backpressure
```javascript
const controller = new AbortController();

try {
  const result = await runtime.execute({
    type: 'heavy-render',
    payload: sceneData,
    timeoutMs: 5000,
    signal: controller.signal,
  });
} catch (err) {
  if (err.name === 'TimeoutError') {
    console.error('Task timed out');
  } else if (err.name === 'AbortError') {
    console.error('Task was aborted');
  }
}
```

### 5.4 Streaming Task Results (Async Generators + IPC Backpressure)

For workloads whose output is too large or too progressive to materialize as a single Promise — LLM token streams, multi-gigabyte CSV/JSON exports, paginated DB cursors, SSE feeds — the runtime exposes a `runtime.stream()` API returning an `AsyncIterable`. The worker function must be an `AsyncGeneratorFunction` or `GeneratorFunction`. Each `yield` becomes an IPC chunk; the consumer iterates via `for await`. Backpressure flows from the bounded consumer buffer back to the worker via `MSG_STREAM_PAUSE` / `MSG_STREAM_RESUME`. Cancellation — consumer `break` or external `AbortSignal` — propagates as `MSG_STREAM_ABORT`, calls `gen.return()`, and runs generator `finally` blocks.

```javascript
import { createWorkerRuntime } from 'node:worker_runtime';

const runtime = createWorkerRuntime({ maxWorkers: 1 });
const ac = new AbortController();
setTimeout(() => ac.abort('user-cancel'), 5_000);

const stream = runtime.stream(
  // Worker function. Closure variables are NOT transported — pass
  // everything via payload. See ADR-0012 §"Implementation Notes".
  async function* chat({ tokens }, { signal }) {
    for (const token of tokens) {
      if (signal?.aborted) return;
      await new Promise((r) => setTimeout(r, 20));
      yield { delta: token };
    }
  },
  { tokens: ['Once', ' upon', ' a', ' time'] },
  { signal: ac.signal, highWaterMark: 1024 },
);

for await (const chunk of stream) {
  process.stdout.write(chunk.delta);
}
```

**Wire protocol** (six IPC frame types, all carry `taskId`):

| Frame | Direction | Purpose |
|---|---|---|
| `MSG_STREAM_CHUNK` | worker → main | `{ taskId, seq, chunk }` per yield |
| `MSG_STREAM_END` | worker → main | `{ taskId, returnValue, aborted, reason }` on natural completion or abort |
| `MSG_STREAM_ERROR` | worker → main | `{ taskId, error }` on generator throw |
| `MSG_STREAM_ABORT` | main → worker | `{ taskId, reason }` to cancel |
| `MSG_STREAM_PAUSE` / `RESUME` | main → worker | `{ taskId }` for backpressure |

See **[ADR-0012](docs/adr/0012-streaming-task-results-via-async-generators.md)** for the full design rationale, the implementation traps (closure-scope loss, WorkerHandle ordering, emit-before-push), and the validation artifacts (323 tests, 3 dedicated benchmarks, 2 examples).

---

## 6. Worker Lifecycle & Fault Isolation (Supervisor)

1. **Crash Handling:** If a worker crashes (e.g., uncaught exception or fatal V8 error in worker code):
   - The Supervisor catches the exit code.
   - The active running task Promise rejects with a descriptive `WorkerCrashError`.
   - The Supervisor automatically spins up a replacement worker to maintain pool capacity.
2. **Backpressure:**
   - If `TaskQueue` reaches `maxQueueSize`, `runtime.execute()` immediately rejects with a `QueueOverflowError` (fast-fail) or applies async backpressure, protecting the process from out-of-memory cascading failures.
3. **Graceful Shutdown:**
   - `await runtime.shutdown()` allows in-flight tasks to complete while rejecting new submissions, terminating worker threads cleanly via `worker.terminate()`.

---

## 7. Reference Implementation Plan

To demonstrate viability to the Node.js community, a standalone Reference Implementation is being developed with:
- **Pure Modern JavaScript (ESM)**: Directly compatible with Node.js core coding conventions.
- **Zero External Runtime Dependencies**: Utilizing only `node:worker_threads`, `node:async_hooks`, `node:events`, and `node:os`.
- **Status (as of 2026-09-17)**: All RFC sections above have working code paths in the standalone repo (`FelipeMiiller/persistent-worker-runtime`):
  - **Basic tasks** (`runtime.execute()`): 11 unit tests; 6 benchmarks (concurrency, outbox, zero-copy, priority, cancel, scaling, preemption, recycling).
  - **Stateful workers** (`runtime.createStatefulWorker()`): 4 unit tests; warm L1 vs stateless benchmark (30.7× faster).
  - **BroadcastChannel** (`runtime.broadcast()` / `subscribe()`): 25 unit tests; benchmark 18.3× faster than per-worker dispatch.
  - **Streaming** (`runtime.stream()`): 36 unit tests across 4 files; 3 dedicated benchmarks (`streaming-throughput` ~210k chunks/s, `streaming-memory`, `streaming-stress`); 2 runnable examples (`streaming-llm.js` with TTFT ~70 ms, `streaming-csv-export.js` with observable backpressure).
  - **Default pool sizing** (ADR-0019): benchmark proves `workers=1` default is 6.45× more memory-efficient than legacy `os.availableParallelism()` on multi-core hosts.
- **CI matrix** mirrors `nodejs/node/.github`: lint, coverage, test (ubuntu/macos/windows × Node 22.x/24.x), and `commit-lint.yml` using `core-validate-commit@6.0.0`.

---

## 8. Questions for Discussion with the Node.js TSC

1. Should this capability be introduced as a new top-level built-in module (e.g., `node:worker_runtime` / `node:worker_pool`) or as an extension to `node:worker_threads` (e.g., `worker_threads.createPool()`)?
2. What are the community's preferences regarding functional serialization (`execute(() => { ... })` using stringified closures vs script-based tasks)?
3. How should `AsyncLocalStorage` snapshotting be standardized across worker boundaries in the default implementation?
