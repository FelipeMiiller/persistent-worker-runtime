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
| **Native Diagnostics** | Built-in `AsyncResource` (`node:async_hooks`) propagation for transparent OpenTelemetry / APM distributed tracing. |
| **Non-Blocking Backpressure** | Asynchronous queue wait with `queueTimeoutMs` so the process never runs out of memory or busy-waits. |
| **Resilient Supervisor** | Detects worker thread crashes and automatically spins up replacements to preserve capacity. |
| **Zero External Dependencies** | Written strictly using Node.js built-in modules (`node:worker_threads`, `node:async_hooks`, `node:events`, `node:perf_hooks`, `node:os`). |
| **Inter-Worker BroadcastChannel** | Named-channel pub/sub between main thread and workers via Node's native `BroadcastChannel` — bus-style O(1) fan-out with no main-thread Event Loop routing. Canonical use case: L1 cache invalidation across workers. |

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
Or via Yarn:
```bash
yarn add persistent-worker-runtime
```

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

Two runnable examples ship in `examples/`:

- `node examples/streaming-llm.js` — token-streaming LLM-style consumer, demonstrates TTFT, signal-abort path, and runtime event counts
- `node examples/streaming-csv-export.js` — fast producer + slow consumer with `highWaterMark: 8`, prints the backpressure timeline

See **[ADR-0012](docs/adr/0012-streaming-task-results-via-async-generators.md)** for the architectural rationale, IPC frame schemas, and the ordering traps that the implementation handles.

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
npm test                # 213 tests across 72 suites (native node:test)
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
```

### Pre-commit hooks

This repo uses **husky 9** + **lint-staged 15**:

| Hook | Runs |
| --- | --- |
| `pre-commit` | `lint-staged` (biome auto-fix on staged files) + `npm test` |
| `pre-push` | `npm run validate` (full lint + test) |
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
| `streaming-csv-export.js` | Fast producer + slow consumer with `highWaterMark: 8` — prints the backpressure timeline (paused / resumed crossings). |

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
