# Persistent Worker Runtime for Node.js

[![NPM Version](https://img.shields.io/npm/v/persistent-worker-runtime.svg)](https://www.npmjs.com/package/persistent-worker-runtime)
[![CI](https://github.com/FelipeMiiller/persistent-worker-runtime/actions/workflows/ci.yml/badge.svg)](https://github.com/FelipeMiiller/persistent-worker-runtime/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.0.0-green.svg)](https://nodejs.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](src/index.d.ts)

> **"The Event Loop coordinates. Persistent Workers execute."**

A production-grade, concurrent execution layer built atop `node:worker_threads`. Engineered in **pure modern JavaScript (zero external dependencies)** targeting **Node.js >= 22.0.0** (tested on Node.js 24).

---

## 📑 Table of Contents

- [The Problem: Event Loop Starvation](#-the-problem-event-loop-starvation)
- [Architectural Philosophy](#-architectural-philosophy)
- [Key Capabilities](#-key-capabilities)
- [Empirical Benchmarks](#-empirical-benchmarks) · [Full results →](BENCHMARKS.md)
- [Quick Start](#-quick-start)
  - [1. Interactive Computation (Request-Response)](#1-interactive-computation-request-response)
  - [2. Bounded Batch Concurrency (Promise.all Style)](#2-bounded-batch-concurrency-promiseall-style)
  - [3. Transactional Outbox & Background Dispatch](#3-transactional-outbox--background-dispatch)
  - [4. Stateful Workers with Warm L1 Memory](#4-stateful-workers-with-warm-l1-memory)
  - [5. Zero-Copy Binary Data Transfer](#5-zero-copy-binary-data-transfer)
  - [6. Resilient Retries with Exponential Backoff](#6-resilient-retries-with-exponential-backoff)
  - [7. Priority Routing](#7-priority-routing)
  - [8. Cancellation via AbortSignal](#8-cancellation-via-abortsignal)
  - [9. Inter-Worker BroadcastChannel (L1 Cache Invalidation)](#9-inter-worker-broadcastchannel-l1-cache-invalidation)
  - [10. Streaming Task Results (Async Generators + Backpressure)](#10-streaming-task-results-async-generators--backpressure)
  - [11. Runtime Hardening & Adaptive Concurrency (v0.2.0)](#11-runtime-hardening--adaptive-concurrency-v020)
  - [12. Node.js Core RFC Proposal](#-nodejs-core-rfc-proposal)
- [Architecture & Memory Hierarchy](#-architecture--memory-hierarchy)
- [Comparison with Existing Solutions](#-comparison-with-existing-solutions)
- [Architecture Decision Records (ADRs)](#-architecture-decision-records-adrs)
- [Benchmarks & Empirical Results](BENCHMARKS.md)
- [Development Conventions (AGENTS.md)](AGENTS.md)
- [Handover Guide (HANDOVER.md)](HANDOVER.md)
- [Running Tests & Benchmarks](#-running-tests--benchmarks)
- [Examples](#-examples)
- [License](#-license)

---

## 🛑 The Problem: Event Loop Starvation

Node.js features a single-threaded Event Loop that provides unmatched throughput for non-blocking asynchronous I/O. However, when an application executes **synchronous, CPU-heavy operations** (cryptography, image/audio processing, AST parsing, ML embeddings, heavy template rendering) or **background side-effects** (sending emails, webhook calls), the main Event Loop freezes:

```text
HTTP Request (I/O)
       │
       ▼
Main Event Loop  ◄─── FROZEN by synchronous CPU task (e.g., 2,200ms)
       │
       ├── Incoming requests experience latency spikes / timeouts
       └── Health check endpoints (/health) fail to respond
```

In our empirical benchmarks, executing 8 CPU tasks synchronously on the main thread **froze the Event Loop for 2,207ms**, starving all incoming I/O.

---

## 💡 Architectural Philosophy

We do not fight the Event Loop; we protect it:

```text
                    NODE.JS APPLICATION
                            │
                            ▼
                     ┌─────────────┐
                     │ Event Loop  │ ◄─── Stays 100% responsive for I/O
                     └──────┬──────┘
                            │ submit(task)
                            ▼
              ┌───────────────────────────┐
              │      Worker Runtime       │
              │                           │
              │  TaskQueue (Backpressure) │
              │  Supervisor (Auto-Restart)│
              │  Scheduler (Affinity/FIFO)│
              └─────────────┬─────────────┘
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
      Worker Thread 1  Worker Thread 2  Worker Thread N
     ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
     │ L1 Local Mem │ │ L1 Local Mem │ │ L1 Local Mem │
     │ (Warm State) │ │ (Warm State) │ │ (Warm State) │
     └──────────────┘ └──────────────┘ └──────────────┘
```

* **The Event Loop Coordinates:** Handles networking, routing, database queries, and dispatching.
* **Persistent Workers Execute:** Process CPU-bound tasks and background side-effects off-thread.
* **Warm State is Preserved:** Workers retain warm in-memory heaps (L1 memory) between calls.

---

## ✨ Key Capabilities

| Capability | Description |
| :--- | :--- |
| **Dual Execution Model** | Supports both interactive request-response (`execute()`) and background fire-and-confirm (`dispatch()`). |
| **Transactional Outbox Engine** | Dispatches background jobs with `.onComplete(cb)` and `.onError(cb)` callbacks, returning sub-millisecond HTTP responses. |
| **Bounded Concurrency (`executeAll`)** | Native `Promise.all` semantics, but bounded strictly to the worker pool capacity to prevent CPU thrashing. |
| **Stateful L1 Memory** | Workers retain warm private heaps (`localState` Map) across consecutive calls with worker affinity (**33.2x faster**). |
| **Zero-Copy Memory Transfer** | Sub-millisecond transfer of `ArrayBuffer` payloads via native `transferList` without memory copying. |
| **Resilient Retries** | Automatic retry policies with exponential, linear, or fixed backoff without blocking worker threads. |
| **Diagnostics Transport** | Built-in `AsyncResource` (`node:async_hooks`) context propagation across the main → worker boundary. OpenTelemetry SDK + APM exporters are user-installed (zero-deps, ADR-0005); spans created on the main thread flow into workers automatically. |
| **Non-Blocking Backpressure** | Asynchronous queue wait with `queueTimeoutMs` so the process never runs out of memory or busy-waits. |
| **Resilient Supervisor** | Detects worker thread crashes and automatically spins up replacements to preserve capacity. |
| **Adaptive Concurrency Controller** (v0.2.0 / ADR-0014) | Dual-signal ELU + `monitorEventLoopDelay` controller tunes the pool band live; grow + drain-shrink (no terminate); pool band `[minWorkers, maxWorkers]`; first-class `runtime.stats.adaptive` telemetry. |
| **Runtime Hardening** (v0.2.0 / ADR-0024) | `accumulationRateMbPerSec`, `minRecycleIntervalMs`, `recycleOnTasksExhausted`, `dispatchStrategy`, `workerPollIntervalMs`, `recycleBackoffMs`, `observeWorkerMemory`, `timeoutMs` default 5000ms; `runtime.getWorkers()` snapshot; expanded `runtime.stats` block. |
| **Durable Queue Backend** (v0.3.0 / ADR-0020) | `SqliteTaskQueue` — zero-deps persistent queue via `node:sqlite` (Node ≥ 22.13 stdlib). Lease-based orphan recovery + retry budget enforcement (`max_retries`) so a worker that consistently crashes mid-task cannot trigger an infinite reclaim oscillation. Public `reclaimExpired()` for cron / scheduler sweeps. `queueBackend: 'memory' \| 'sqlite'` discriminator; no migrations required. |
| **Liveness + Readiness Probes** (v0.3.0 / DR §8.2) | `runtime.isAlive()` and `runtime.isReady()` return `{ ok: boolean, reason?: string }` with `reason` ∈ `{'not-started', 'no-workers', 'shutting-down', 'queue-full'}`. p99 ≤ 0.20μs in our benchmarks. Transport (HTTP route / cron / script) is the caller's responsibility — the runtime stays a library per ADR-0005. |
| **Streaming API** (ADR-0012) | `runtime.stream()` for async-generator tasks with native backpressure, queued dispatch, and 5 runtime events (`stream:created` / `chunk` / `end` / `aborted` / `backpressure`). |
| **Zero External Dependencies** | Written strictly using Node.js built-in modules (`node:worker_threads`, `node:async_hooks`, `node:events`, `node:perf_hooks`, `node:os`, `node:broadcast_channel`, `node:sqlite`). |
| **Inter-Worker BroadcastChannel** | Named-channel pub/sub between main thread and workers via Node's native `BroadcastChannel` — bus-style O(1) fan-out with no main-thread Event Loop routing. Canonical use case: L1 cache invalidation across workers. |
| **Pure ESM, Zero Dependencies** | `"type": "module"` with explicit `exports` map. Works with `import` on Node 22.13+; `require()` of the package works on Node 22.13+ (stable `require(esm)`) without any CJS shim. |

---

## 📊 Empirical Benchmarks

All benchmarks are reproducible via `npm run benchmark:all`:

### 1. Main Event Loop Lag Under Load
*Running 8 CPU-heavy Fibonacci(36) calculations:*
* **Synchronous Main Thread:** Froze the Event Loop for **2,207.93ms** (Total HTTP Starvation).
* **Persistent Worker Runtime (4 Workers):** Event Loop Max Lag was only **6.48ms** (**3.8x faster** wall-clock throughput).
* **Verdict:** The main thread remained 100% available for incoming I/O during computation.

### 2. Persistent L1 Memory vs. Stateless Reloading
*Executing 50 lookups over a 200,000-item in-memory dataset:*
* **Stateless Reloading (re-allocating dataset per task):** 2,618.64ms (52.37ms per query).
* **Stateful L1 Memory (warm heap reuse):** 78.88ms total (1.58ms per query).
* **Verdict:** Persistent L1 memory provides a **33.2x latency improvement**.

### 3. Bounded Concurrency Under Saturation
*Simulating 10 simultaneous HTTP requests firing 40 tasks into a 4-worker pool:*
* **Total Turnaround:** All 40 tasks completed in **30.60ms** (1,307 tasks/sec).
* **Verdict:** Zero deadlocks, zero race conditions, predictable FIFO draining.

### 4. Transactional Outbox Background Dispatch Ingestion
*Dispatching 2,000 background jobs from the main thread:*
* **Main Thread Ingestion Rate:** **95,815 tasks dispatched/second** without blocking.
* **Worker Processing Rate:** **23,613 jobs/second** processed and confirmed off-thread.

### 5. Zero-Copy ArrayBuffer Transfer vs. Structured Clone
*Transferring a 16MB raw buffer 50 times:*
* **Structured Clone (default):** 25.47ms per op — copies the entire buffer across the thread boundary.
* **Zero-Copy `transferList`:** 4.60ms per op — buffer is moved, not copied (**5.54x faster**, ~3.5 GB/s).
* **Verdict:** Mandatory for image, audio, video, and ML tensor payloads.

### 6. Priority Routing & Starvation Resistance
*Submitting 30 tasks across 4 priority tiers to a single-worker pool:*
* All `priority=10` tasks completed **before** any `priority=0` task.
* Within the same priority tier, FIFO order is preserved.
* `dispatch()` round-trip is sub-10 microseconds regardless of priority.

### 7. Cooperative Cancellation Latency
*Aborting 50 in-flight tasks via `AbortController`:*
* **Pre-aborted signal:** rejected in **< 1ms** without engaging a worker.
* **Mid-execution abort:** resolved in **~60ms** (50ms abort trigger + worker poll interval).
* **Bulk cancel:** 50 cancellations resolved in **47ms** (~1,064 cancels/sec).

### 8. Throughput Scaling vs. Worker Count
*1000 CPU-bound tasks across worker pool sizes:*
* **1 worker:** ~2,500 tasks/sec
* **4 workers:** ~10,000 tasks/sec (linear scaling)
* **`availableParallelism()` workers:** ~20,000 tasks/sec
* **Verdict:** Throughput scales linearly up to the CPU core count; oversubscription beyond that yields diminishing returns.

### 9. BroadcastChannel Fan-out vs. Per-Worker Dispatch
*5,000 publishes to 4 subscribed workers:*
* **`runtime.broadcast()`:** 5,000 publishes in **~11ms** — **438k msg/s** (~2.3μs per publish).
* **`runtime.dispatch()` × 4 workers:** 500 fan-out cycles in **~20ms** (~40μs per fan-out cycle).
* **Verdict:** Native `BroadcastChannel` fan-out is **~18× faster** than routing each invalidation through the per-worker dispatch path, and stays O(1) regardless of subscriber count.

---

## 🚀 Quick Start

### Installation

Install via npm:
```bash
npm install persistent-worker-runtime
```
Or via Yarn (Berry / v3+ recommended; v1 classic is unsupported):
```bash
yarn add persistent-worker-runtime
```

> **Pure ESM.** This package is published as ES modules (`"type": "module"`) with no CJS shim. Use `import { ... } from 'persistent-worker-runtime'`. If your consumer code needs `require()`, run it on Node 22.12+ where stable `require(esm)` makes that work directly; earlier Node 22.x versions need `--experimental-require-module` or `await import()`.

---

#### Contributing — line endings

The repo ships a top-level `.gitattributes` that forces LF for every text file (JS, MD, JSON, YAML, etc.), regardless of `core.autocrlf`. No manual setup is needed on Windows — `git checkout` will produce LF files directly, so pre-push lint hooks stay green without `--no-verify`.

---

### 1. Interactive Computation (Request-Response)

Offload heavy synchronous calculations and await the result without freezing the Event Loop:

```javascript
import { createWorkerRuntime } from 'persistent-worker-runtime';

const runtime = await createWorkerRuntime({ workers: 4 });

const result = await runtime.execute({
  type: 'heavy_math',
  payload: { value: 42 },
  fn: (p) => {
    // Executes inside worker thread isolate
    return p.value * 2;
  },
});

console.log('Result:', result); // 84
```

---

### 2. Bounded Batch Concurrency (Promise.all Style)

Execute multiple tasks in parallel with familiar `Promise.all` semantics, strictly bounded to your pool capacity:

```javascript
// Bounded to 4 worker threads; never thrashes CPU cores
const [invoice, receipt, label] = await runtime.executeAll([
  { type: 'invoice', payload: order, fn: (p) => generateInvoice(p) },
  { type: 'receipt', payload: order, fn: (p) => generateReceipt(p) },
  { type: 'shipping', payload: order, fn: (p) => createShippingLabel(p) },
]);
```

---

### 3. Transactional Outbox & Background Dispatch

Respond to HTTP requests in **< 1ms**, while background tasks execute concurrently on worker threads with asynchronous database confirmations:

```javascript
app.post('/register', async (req, res) => {
  // 1. Atomic database write (user + pending outbox records)
  const user = await db.users.create(req.body);
  const outbox = await db.outbox.create({ userId: user.id, task: 'send_email', status: 'PENDING' });

  // 2. Dispatch to worker in microseconds (non-blocking!)
  const task = runtime.dispatch({
    type: 'send_welcome_email',
    payload: { outboxId: outbox.id, email: user.email },
    retries: 3, // Auto-retry on transient failure
    fn: async (p) => {
      return await mailer.send(p.email);
    },
  });

  // 3. Asynchronous confirmation updates the Outbox table
  task.onComplete(async (result) => {
    await db.outbox.update(outbox.id, { status: 'COMPLETED', result });
  });
  task.onError(async (err) => {
    await db.outbox.update(outbox.id, { status: 'FAILED', error: err.message });
  });

  // 4. Client receives immediate response!
  return res.status(201).json({ userId: user.id });
});
```

---

### 4. Stateful Workers with Warm L1 Memory

Maintain warm in-memory heaps (caches, loaded AI models, WASM instances) across consecutive tasks with zero re-initialization overhead:

```javascript
const aiWorker = await runtime.createWorker({ name: 'embedding-worker' });

// Initialize warm model weights once in L1 memory
await aiWorker.setState('model:bert', loadedWeights);

// Subsequent queries read directly from warm L1 memory at 33x higher speed
const vectorA = await aiWorker.executeTask(taskA);
const vectorB = await aiWorker.executeTask(taskB);
```

---

### 5. Zero-Copy Binary Data Transfer

Transfer multi-megabyte `ArrayBuffer` payloads in **< 0.1ms** without memory copying:

```javascript
const largeBuffer = new ArrayBuffer(50 * 1024 * 1024); // 50MB

const result = await runtime.execute({
  type: 'process_audio',
  payload: { buffer: largeBuffer },
  transferList: [largeBuffer], // Transferred in < 0.1ms without cloning
  fn: (p) => {
    const view = new Uint8Array(p.buffer);
    return view.byteLength;
  },
});
```

---

### 6. Resilient Retries with Exponential Backoff

Configure automatic retries for background tasks without tying up worker threads during the delay:

```javascript
runtime.dispatch({
  type: 'call_webhook',
  payload: { url: 'https://api.partner.com/webhook', data },
  retries: 3,
  retryDelayMs: 1000,
  backoff: 'exponential', // 1s, 2s, 4s delays
});
```

---

### 7. Priority Routing

Ensure critical work runs first without blocking the Event Loop. Use cases:
premium-tier requests before free-tier, live chat before batch analytics,
time-sensitive webhooks before housekeeping:

```javascript
// Lower priority first
runtime.dispatch({
  type: 'batch_analytics',
  payload: { date: '2026-09-16' },
  priority: 0,
  fn: (p) => aggregate(p),
});

// Critical work submitted later jumps the queue
runtime.dispatch({
  type: 'premium_request',
  payload: { userId: 42 },
  priority: 10, // dequeued before any priority=0 task
  fn: (p) => serve(p),
});
```

---

### 8. Cancellation via AbortSignal

Cancel any in-flight task using the standard `AbortController` /
`AbortSignal` API. Useful for HTTP request cancellation, UI-driven
cancellation, and watchdog timeouts:

```javascript
const controller = new AbortController();

// Cancel after 5 seconds (e.g. user navigates away)
setTimeout(() => controller.abort(), 5000);

try {
  const result = await runtime.execute({
    type: 'generate_report',
    payload: { rows: 1_000_000 },
    signal: controller.signal,
    fn: async (p) => {
      // Long-running work
      await renderRows(p.rows);
      return 'done';
    },
  });
} catch (err) {
  if (err.name === 'TaskAbortedError') {
    // Cleanup any partial state
  }
}

// Or use the built-in timeout signal:
await runtime.execute({
  type: 'slow_query',
  payload: {},
  signal: AbortSignal.timeout(2_000), // auto-abort after 2s
  fn: () => doWork(),
});
```

---

### 9. Inter-Worker BroadcastChannel (L1 Cache Invalidation)

Workers can publish / subscribe to **named channels** without involving the main-thread Event Loop as a router. Backed by Node's native `BroadcastChannel` (web-standard API, zero dependencies).

The canonical use case: when one worker mutates a record, every other worker's hot L1 cache needs to evict its stale copy. The runtime gives you a bus-style API for that:

```javascript
// Inside a worker fn — fnCode is a string in the worker thread, so
// closures from the main module are NOT available. Inline the channel
// name as a literal.
async function fetchUser(payload, state, context) {
  const cache = (state.cache ||= new Map());

  // Subscribe ONCE per worker; subsequent calls reuse the same handler.
  // The wrapper is idempotent; the bus does not deliver to the sender.
  context.channel('cache:user').subscribe((msg) => {
    if (msg.userId === payload.userId) cache.delete(payload.userId);
  });

  if (cache.has(payload.userId)) return { from: 'cache', user: cache.get(payload.userId) };

  const user = await db.fetchUser(payload.userId);
  cache.set(payload.userId, user);
  return { from: 'source', user };
}

async function updateUser(payload, _state, context) {
  await db.updateUser(payload);

  // Broadcast invalidation. Returns IMMEDIATELY — does not wait for peers.
  context.channel('cache:user').publish({
    userId: payload.userId,
    reason: 'update',
  });
}
```

The main thread can also publish and subscribe — useful for observability, coordinated shutdown, or broadcasting control signals to all workers:

```javascript
// Main-thread observer
runtime.subscribe('cache:user', (msg) => {
  metrics.incr('cache.invalidate', { reason: msg.reason });
});

// Main-thread broadcast (main → all workers)
runtime.broadcast('system:reload', { at: Date.now() });

// Idempotent unsubscribe
runtime.unsubscribe('cache:user', observerHandler);
```

**Key semantics:**

| Property | Value |
| --- | --- |
| Backed by | `node:worker_threads` `BroadcastChannel` (built-in, zero deps) |
| Topology | O(1) per publish — native BC delivers to all listeners across threads |
| Loop-back | **No** — a thread does NOT receive its own publishes |
| Per-name caching | Yes — multiple `context.channel('ch')` calls share one underlying BC |
| Message serialization | Structured clone (Dates, Maps, Sets, ArrayBuffers, TypedArrays, RegExps supported) |
| Cleanup on `shutdown()` | All main-thread-owned BCs are closed; `FinalizationRegistry` is a GC safety net for worker-side wrappers |
| After shutdown | `runtime.broadcast()` throws `WorkerRuntimeError('Runtime is shutting down')` |

See `examples/broadcast-cache-invalidation.js` for a complete runnable demo and `skills/persistent-worker-runtime/SKILL.md` for the full embedded skill.

---

### 10. Streaming Task Results (Async Generators + Backpressure)

When the result of a task is too large, too slow, or too streaming-shaped to materialize as a single Promise, use `runtime.stream()` to feed the worker generator's yields to the consumer one chunk at a time. The same pattern works for LLM-style token streaming, large CSV exports, paginated DB queries, and SSE feeds.

```javascript
import { createWorkerRuntime } from '@persistent-worker-runtime/node';

const runtime = await createWorkerRuntime({ workers: 1 });

const ac = new AbortController();
setTimeout(() => ac.abort('user-cancel'), 5_000);

const stream = runtime.stream(
  // Worker-side generator. The function receives
  // (payload, state, context). The runtime reconstructs the
  // generator from source via `new Function(fnCode)`, so
  // closure variables from the main module are NOT available —
  // pass everything you need through `payload`.
  async function* chat({ tokens }, { signal }) {
    for (const token of tokens) {
      if (signal?.aborted) return;  // graceful exit
      await new Promise((r) => setTimeout(r, 20));
      yield { delta: token };
    }
  },
  { tokens: ['Once', ' upon', ' a', ' time', '.'] },         // payload
  {
    signal: ac.signal,                                       // external abort
    highWaterMark: 1024,                                     // buffer cap
  },
);

// Consumer-side — standard async iteration. Breaks / aborts
// propagate to the worker so its `finally` block still runs.
for await (const chunk of stream) {
  process.stdout.write(chunk.delta);
}
```

**Key semantics:**

| Property | Value |
| --- | --- |
| Worker function shape | `(Async)GeneratorFunction` — detected via regex on source (`new Function(fnCode)` strips constructor identity) |
| Backpressure | One-shot `stream:backpressure { state: 'paused' \| 'resumed', queueLength }` events; worker parks between yields when buffer ≥ `highWaterMark`, resumes when `< HWM / 2` |
| Cancellation | Consumer `break` → `MSG_STREAM_ABORT` with `reason: 'consumer-return'`. External `AbortSignal` → same with the signal reason. Both call `gen.return()` so generator `finally` runs |
| Runtime events | `stream:created { taskId }`, `stream:chunk { taskId, seq }`, `stream:end { taskId, totalChunks, returnValue }`, `stream:aborted { taskId, reason }`, `stream:backpressure { taskId, state, queueLength }` |
| Pool scheduling | One worker per active stream (1:1, full lifetime). When the pool is saturated, `stream()` queues the request and returns immediately — the consumer can iterate while waiting |
| `runtime.stats()` | `activeStreams` (dispatched) and `pendingStreams` (queued) are surfaced alongside the existing task counters |

**Twelve runnable examples** ship in `examples/` — every one carries a `[perf-tested]` header tag and ends with a measured metric that justifies the feature (governed by `.agents/rules/perf-first-authoring.md` + `.agents/skills/pwr-examples/SKILL.md`):

- `node examples/streaming-llm.js` — token-streaming LLM-style consumer, demonstrates TTFT, signal-abort path, and runtime event counts
- `node examples/streaming-csv-export.js` — fast producer + slow consumer with `highWaterMark: 8`, prints the backpressure timeline
- `node examples/zero-copy-image.js` — `transferList` vs structured-clone copy on a 31 MB buffer (**3.07×** speedup)
- `node examples/priority-routing.js` — `priority=10` interactive tasks jump 30 slots ahead of `priority=0` batch tasks
- `node examples/persistent-ai-model.js` — L1-cached 5 000-entry model rebuilt every query (**1.48×** speedup)
- `node examples/express-outbox-email.js` — `dispatch` vs sequential HTTP handler (**76.41×** HTTP-path speedup)
- `node examples/adaptive-concurrency.js` — auto controller grew 1→28 workers under 50-task CPU burst (**23.22×** speedup vs `fixed: workers: 1`)
- `node examples/broadcast-cache-invalidation.js` — cold vs warm cache reads (**2.69×** per warm hit, 25 ms cumulative saving)
- `node examples/cancel-on-disconnect.js` — cancel at 100 ms frees the worker **~99× sooner** than run-to-completion
- `node examples/image-resizer-batch.js` — worker pool fires **27× more** `setInterval(5 ms)` ticks than inline main-thread work
- `node examples/worker-recycling.js` — per-cycle overhead = **263 ms avg** (200 ms backoff + ~64 ms terminate)
- `node examples/event-target-pattern.js` — `addEventListener({ signal })` cleanup is 1 `abort()` call vs N `removeEventListener` calls

See **[ADR-0012](docs/adr/0012-streaming-task-results-via-async-generators.md)** for the architectural rationale, IPC frame schemas, and the ordering traps that the implementation handles.

---

### 11. Runtime Hardening & Adaptive Concurrency (v0.2.0)

v0.2.0 ships **two production-grade feature sets** out of the box: an adaptive concurrency controller (ADR-0014) that auto-tunes your worker pool to live traffic, and 11 runtime hardening options (ADR-0024) for recycling, preemption, memory observability, dispatch strategy, and drain grace.

#### 11.1 — Adaptive concurrency controller (ADR-0014)

Dual-signal controller (`Event Loop Utilization` + `monitorEventLoopDelay` p99, EWMA α=0.3, 5-tick debounce) tunes the pool band `[minWorkers, maxWorkers]` based on real load. **Grow** when both signals are below the grow band; **shrink-from-busy** when ELU is high; **shrink-from-idle** when latency is high; **hold** otherwise. Drain path never calls `worker.terminate()` — drained workers finish their current task then are reaped.

```javascript
const runtime = await createWorkerRuntime({
  // 'adaptive' is the default on >4-core hosts; explicit for clarity.
  concurrency: 'adaptive',
  minWorkers: 1,
  maxWorkers: 16,
});

// Live telemetry for dashboards / Prometheus:
setInterval(() => {
  const a = runtime.stats.adaptive;
  if (!a) return; // disabled (fixed-mode)
  metrics.gauge('runtime.workers', a.effectiveWorkers);
  metrics.gauge('runtime.elu',      a.elu);
  metrics.gauge('runtime.p99ms',    a.latencyP99Ms);
}, 1000);

// Opt out at any time:
await runtime.createWorker({ name: 'always-on' });   // dedicated workers stay outside the band
```

**Performance** (measured on 28-core host, full Phase A/B/C/D/E suite):

- Per-tick overhead: **p50 = 0.041 ms**, **p99 = 0.064 ms** (1k ticks with stubbed callbacks, T7 SLA met)
- `classifyTickDirection` throughput: **65.97 M ops/sec** (~15 ns/call)
- Listener scaling: 10 listeners / 1 listener = **0.99×** (linear, no superlinear broadcast cost)
- Per-controller memory footprint: **3.1 KB**
- Saturation knee: 16→20 worker ratio = **1.07×** (plateau — adding workers past `availableParallelism` returns diminishing throughput)
- Full A+B+E end-to-end suite wall time: **~17 s**

See `examples/adaptive-concurrency.js` and [ADR-0014](docs/adr/0014-adaptive-concurrency-controller.md).

#### 11.2 — Runtime hardening options (ADR-0024)

```javascript
const runtime = await createWorkerRuntime({
  workers: 4,

  // ─── Recycling tier (HARDEN-06/07/08/11) ───────────────────────────
  accumulationRateMbPerSec: 50,    // recycle when EWMA growth > 50 MB/s
  minRecycleIntervalMs:     5000,  // hysteresis window after a recycle
  recycleOnTasksExhausted:  false, // emit worker_tasks:exhausted instead of recycling
  recycleBackoffMs:          600,  // keep old worker in 'recycling' for 600 ms

  // ─── Dispatch + preemption (HARDEN-09/10) ──────────────────────────
  dispatchStrategy:       'lru',   // 'fifo' | 'lru' | 'random'; default 'lru'
  workerPollIntervalMs:   500,     // watchdog cadence (clamp min 100 ms)

  // ─── Observability (HARDEN-05) ──────────────────────────────────────
  observeWorkerMemory:       true,
  memoryEmitIntervalMs:     1000,
  runtime.on('worker:memory', ({ workerId, memoryUsageBytes }) => {
    metrics.gauge('worker.rss', memoryUsageBytes, { workerId });
  }),

  // ─── Timeout default (HARDEN-01) ────────────────────────────────────
  timeoutMs: 5000,                 // per-task default; emits PersistentWorkerRuntimeTimeoutMsDefault once if never overridden
});
```

**Live observability** — `runtime.stats` now exposes:

```javascript
runtime.stats.workers      // { total, idle, busy, recycling, terminating, byStatus, totalMemoryBytes }
runtime.stats.adaptive    // { enabled, effectiveWorkers, elu, latencyP99Ms, lastResizeReason, ... }
runtime.stats.activeStreams   // dispatched streams (ADR-0012)
runtime.stats.pendingStreams  // queued streams waiting for a slot
```

**Snapshot of the worker pool** — `runtime.getWorkers()` returns a fresh array per call:

```javascript
const snapshot = runtime.getWorkers();
// [{ id, status, tasksCompleted, tasksActive, lastMemoryUsageBytes, lastTaskAt, affinityKey, isDedicated }, ...]

const recycling = snapshot.filter((w) => w.status === 'recycling');
```

#### 11.3 — Behavior changes (all additive)

- **BC-1** Default dispatch changed from FIFO to LRU. Opt back via `dispatchStrategy: 'fifo'`.
- **BC-2** Watchdog cadence decoupled from `task.timeoutMs` — set `workerPollIntervalMs` independently.
- **BC-3** Poll always runs (was gated on accumulation rate). Cost: one cheap function call per worker per tick.

Full TypeScript surface at [`src/index.d.ts`](src/index.d.ts). See **[ADR-0024](docs/adr/0024-runtime-observability-and-recycling-hardening.md)** for the rationale and `[CHANGELOG.md](CHANGELOG.md)` for the migration notes.

---

## 📜 Node.js Core RFC Proposal

This package is also the **reference implementation** for an open RFC proposing `node:worker_runtime` as a **native built-in** in Node.js core — standardizing *"offload CPU-bound work from the Event Loop without losing observability, error propagation, or warm worker-local state"* the same way `node:test` standardized testing and `node:sqlite` provided friction-free embedded persistence.

📄 **[Read the RFC draft →](NODEJS_RFC_PROPOSAL_DRAFT.md)**

The RFC draft §7 enumerates the **current coverage of the reference implementation** (basic tasks, stateful workers, BroadcastChannel, streaming, default pool sizing, adaptive concurrency) and §8 lists the open questions for community discussion (top-level `node:worker_runtime` vs. extension to `node:worker_threads`; functional serialization shape; `AsyncLocalStorage` snapshotting across worker boundaries).

> 📦 **Production deployment guidance** is tracked in [`docs/operations/disaster-recovery.md §8`](docs/operations/disaster-recovery.md#8-open-items-gaps-to-close):
> - **`/healthz` / `/readyz` closed (2026-09-24)** — runtime exposes `isAlive()` + `isReady()` (DR §8.2). User wires HTTP / cron / script transport around the two probes — the runtime stays a library per ADR-0005 (no HTTP server in `src/`).
> - **SIGTERM handler with drain timeout** — user-wired `process.on('SIGTERM', () => runtime.shutdown())` (DR §8.1).
> - **OpenTelemetry spans + Postgres SKIP LOCKED backend** — **permanently out-of-scope by rule** (ADR-0005 pure vanilla JS, zero external runtime deps). User installs `@opentelemetry/api` themselves; user fronts with their own Postgres queue. See `AGENTS.md` cross-ref.

---

## 🏛 Architecture & Memory Hierarchy

The runtime organizes memory into three distinct tiers:

```text
              Worker Runtime
                    │
       ┌────────────┼────────────┐
       │            │            │
       ▼            ▼            ▼
    L1 Memory    L2 Shared     L3 Durable
  (Local Heap)     Memory       Storage
```

1. **L1 — Worker-Local Memory (Private Heap):** Private to each worker thread. Standard V8 speed, zero locks. Ideal for warm caches, model weights, and ASTs.
2. **L2 — Shared Memory:** `SharedArrayBuffer` + `Atomics`. Strictly opt-in for zero-copy binary streaming and ring buffers.
3. **L3 — Durable Storage:** External to the worker heap (`node:sqlite`, filesystem, WAL). Survives thread crashes and process restarts.

---

## 🥊 Comparison with Existing Solutions

| Feature | Raw `worker_threads` | `piscina` | Redis + BullMQ | **Persistent Worker Runtime** |
| :--- | :---: | :---: | :---: | :---: |
| **Out-of-the-box Worker Pool** | ❌ Manual | ✅ Yes | ⚠️ Process-based | ✅ **Yes** |
| **Zero External Dependencies** | ✅ Native | ⚠️ 3rd-party npm | ❌ Requires Redis | ✅ **100% Native Zero-Dep** |
| **Stateful L1 Memory (Warm Heaps)** | ❌ No | ❌ Stateless only | ❌ Out-of-process | ✅ **Yes (33.2x faster)** |
| **Worker Affinity Routing** | ❌ No | ❌ No | ❌ No | ✅ **Yes** |
| **In-Process Outbox Dispatch** | ❌ No | ❌ No | ⚠️ External broker | ✅ **Native (`dispatch`)** |
| **Bounded Concurrency (`executeAll`)**| ❌ No | ⚠️ Manual `p-limit` | ⚠️ Queue-based | ✅ **Native `Promise.all` style** |
| **Non-blocking Queue Backpressure** | ❌ No | ⚠️ Memory limits | ⚠️ Redis queue | ✅ **Native with Timeout SLA** |
| **Automatic Retries with Backoff** | ❌ No | ❌ No | ✅ Yes | ✅ **Native in-process** |
| **Zero-Copy `transferList` Support** | ⚠️ Manual | ⚠️ Limited | ❌ No | ✅ **Built-in** |
| **RFC Draft Available** | N/A | ❌ No | ❌ No | ✅ [`NODEJS_RFC_PROPOSAL_DRAFT.md`](NODEJS_RFC_PROPOSAL_DRAFT.md) |

---

## 📜 Architecture Decision Records (ADRs)

Every major architectural choice is documented following the **MADR** format in [`docs/adr/`](docs/adr/README.md):

* **[ADR-0001](docs/adr/0001-persistent-worker-runtime-over-worker-threads.md)**: Persistent Worker Runtime Over worker_threads
* **[ADR-0002](docs/adr/0002-three-tier-memory-architecture.md)**: Three-Tier Memory Architecture (L1 / L2 / L3)
* **[ADR-0003](docs/adr/0003-dual-execution-model-execute-and-dispatch.md)**: Dual Execution Model (execute vs. dispatch) and Transactional Outbox Support
* **[ADR-0004](docs/adr/0004-asynchronous-queue-backpressure-with-timeout.md)**: Asynchronous Queue Backpressure with Timeout and AsyncResource
* **[ADR-0005](docs/adr/0005-native-javascript-esm-with-zero-external-dependencies.md)**: Pure Modern JavaScript (ESM, Node.js >= 24) with Zero External Dependencies
* **[ADR-0006](docs/adr/0006-bounded-concurrency-batch-processing.md)**: Bounded Concurrency Batch Processing (executeAll & dispatchAll)
* **[ADR-0007](docs/adr/0007-automatic-retry-policies-with-exponential-backoff.md)**: Automatic Retry Policies with Exponential Backoff for Background Tasks
* **[ADR-0008](docs/adr/0008-zero-copy-binary-data-transfer-via-transferable-objects.md)**: Zero-Copy Binary Data Transfer via Transferable Objects
* **[ADR-0009](docs/adr/0009-elastic-worker-pool-auto-scaling.md)**: Elastic Worker Pool Auto-Scaling with Min/Max Bounds and Idle Timeout
* **[ADR-0010](docs/adr/0010-automatic-worker-recycling-anti-memory-leak.md)**: Automatic Worker Recycling and Heap Rejuvenation
* **[ADR-0011](docs/adr/0011-hard-preemption-and-timeout-termination-for-runaway-tasks.md)**: Hard Preemption and Thread Termination for Runaway Tasks
* **[ADR-0012](docs/adr/0012-streaming-task-results-via-async-generators.md)**: Streaming Task Results via Async Generators and Structured IPC
* **[ADR-0013](docs/adr/0013-worker-inter-communication-via-broadcast-channel.md)**: Worker Inter-Communication via Native BroadcastChannel
* **[ADR-0014](docs/adr/0014-adaptive-concurrency-auto-tuning-via-event-loop-utilization.md)**: Adaptive Concurrency Auto-Tuning via Event Loop Utilization (ELU)
* **[ADR-0015](docs/adr/0015-promise-rejection-contract-for-task-queue-waiters.md)**: Promise Rejection Contract for TaskQueue Waiters (destroy() rejects in-flight enqueue Promises)
* **[ADR-0016](docs/adr/0016-priority-routing-and-fairness.md)**: Priority Routing and Fairness (priority tier dequeue + FIFO-within-tier)
* **[ADR-0017](docs/adr/0017-cooperative-cancellation-via-abortsignal.md)**: Cooperative Cancellation via AbortSignal (TaskAbortedError, signal-aware dispatch)
* **[ADR-0018](docs/adr/0018-fire-and-forget-hazard-with-execute-and-post-shutdown-flakes.md)**: Fire-and-Forget Hazard with `runtime.execute()` and Post-Shutdown Test Flakes (always await `execute()` or use `dispatch()`)

---

## 🧪 Running Tests, Lint & Benchmarks

```bash
# ── Quality gates ──────────────────────────────────────────────────────
npm test                # 621 tests across 170 suites (native node:test)
npm run test:coverage   # >95% line coverage report
npm run lint            # biome check (lint src/test/examples/benchmarks)
npm run lint:fix        # biome check --write --unsafe (auto-fix what's safe)
npm run format          # biome format --write (apply formatter)
npm run validate        # lint + test (wired into pre-push + prepublish)

# ── Benchmarks (11 total — full results in BENCHMARKS.md) ─────────────
npm run benchmark:all   # Run all 11 (~2 minutes on a modern workstation)
npm run benchmark              # Event Loop lag under load
npm run benchmark:stateful     # Warm L1 memory vs stateless reload
npm run benchmark:concurrency  # Bounded batch concurrency
npm run benchmark:outbox       # Transactional outbox throughput
npm run benchmark:zero-copy    # transferList vs structured clone
npm run benchmark:priority     # Priority routing & fairness
npm run benchmark:cancel       # AbortController cancellation latency
npm run benchmark:scaling      # Throughput scaling vs worker count
npm run benchmark:preemption   # Hard preemption watchdog + pool healing
npm run benchmark:recycling    # Automatic worker recycling
npm run benchmark:broadcast    # BroadcastChannel fan-out vs. per-worker dispatch
npm run benchmark:io-throughput # ADR-0024 sustained-rate (50k tasks, ~30s)
npm run benchmark:cpu-saturation # Phase E — CPU saturation knee
npm run benchmark:hot-path      # DR §8.2 probe perf contract (≤5μs p99) — wired into `npm run validate`
```

### Pre-commit hooks

This repo uses **husky 9** + **lint-staged 15**:

| Hook | Runs |
| --- | --- |
| `pre-commit` | `lint-staged` (biome auto-fix on staged files) + `npm test` |
| `pre-push` | `npm run validate` (lint + test + hot-path-micro benchmark) |
| `prepublish` | `npm run validate` |

Lint violations that can't be auto-fixed (e.g. `debugger`, suspicious code) **block the commit**.

## 📚 Examples

Run any example directly with `node examples/<name>.js`:

| Example | What it shows |
| :--- | :--- |
| `express-outbox-email.js` | Express HTTP server + transactional outbox for sending emails in the background. |
| `image-resizer-batch.js` | Bounded batch processing of image resize jobs across multiple workers. |
| `persistent-ai-model.js` | Stateful worker holding a warm AI model in L1 memory for low-latency inference. |
| `priority-routing.js` | Submit low-priority work first, then critical work — verify critical work runs first. |
| `zero-copy-image.js` | Transfer a 30MB raw image buffer to a worker via `transferList` (no copy). |
| `cancel-on-disconnect.js` | Manual cancellation, `AbortSignal.timeout()`, and pre-aborted signals. |
| `broadcast-cache-invalidation.js` | L1 cache invalidation across workers via `context.channel()` + `runtime.broadcast()`. |
| `streaming-llm.js` | Token-streaming LLM-style consumer — TTFT measurement, `AbortSignal` mid-stream, runtime event counts. |
| `durable-task-recovery-runtime.js` | T13 — submit tasks to `SqliteTaskQueue`, kill the runtime mid-flight, restart it, watch lease-based orphan recovery reclaim the in-flight tasks. Demonstrates the retry budget too: tasks with `retries: 0` land in `failed` instead of leaking into an infinite reclaim loop. |
| `durable-queue-shutdown-recovery.js` | Companion to the recovery example — exercises the full T13.1 hardening surface: atomic check, corrupt envelope quarantine, WAL checkpoint. |
| `durable-queue-throughput.js` | Throughput benchmark for the SQLite backend vs the in-memory `TaskQueue` (memory backend is faster but ephemeral; SQLite is durable). |
| `streaming-csv-export.js` | Fast producer + slow consumer with `highWaterMark: 8` — prints the backpressure timeline (paused / resumed crossings). |
| `event-target-pattern.js` | EventTarget observation patterns: `addEventListener` with `{ signal }` for AbortController cleanup, bounded-N event collector, manual `removeEventListener`. Recommended for v0.3.x+ code (the runtime now extends web-standard `EventTarget`; the `.on()` / `.off()` compat shim is scheduled for v0.4.x removal). |

## 🤖 Agent Skill (Embedded)

This package ships with an **AI-agent skill** at `skills/persistent-worker-runtime/` so coding assistants (Claude Code, Cursor, Windsurf, etc.) can pick up the library's API automatically when you `npm install persistent-worker-runtime`.

After installing, point your agent at the skill directory — for example, with the Tech Leads Club installer:

```bash
npx @tech-leads-club/agent-skills install --skill node_modules/persistent-worker-runtime/skills/persistent-worker-runtime
```

The skill covers: pool setup, request-response vs outbox modes, L1 state management, cancellation, priority routing, zero-copy transfer, retries, and preemption — plus six production-ready patterns (transactional outbox, image batch, AI inference, priority routing, cancellation, streaming).

---

## 📄 License

[MIT](LICENSE) © 2026 Felipe Miiller
