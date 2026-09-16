# Persistent Worker Runtime for Node.js

[![NPM Version](https://img.shields.io/npm/v/persistent-worker-runtime.svg)](https://www.npmjs.com/package/persistent-worker-runtime)
[![CI](https://github.com/FelipeMiiller/persistent-worker-runtime/actions/workflows/ci.yml/badge.svg)](https://github.com/FelipeMiiller/persistent-worker-runtime/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.0.0-green.svg)](https://nodejs.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](src/index.d.ts)

> **"The Event Loop coordinates. Persistent Workers execute."**

A production-grade, concurrent execution layer built atop `node:worker_threads`. Engineered in **pure modern JavaScript (zero external dependencies)** targeting **Node.js >= 22.0.0** (tested on Node.js 24), designed as a reference implementation for proposed inclusion in **Node.js Core** (`nodejs/node`).

---

## 📑 Table of Contents

- [The Problem: Event Loop Starvation](#-the-problem-event-loop-starvation)
- [Architectural Philosophy](#-architectural-philosophy)
- [Key Capabilities](#-key-capabilities)
- [Empirical Benchmarks](#-empirical-benchmarks)
- [Quick Start](#-quick-start)
  - [1. Interactive Computation (Request-Response)](#1-interactive-computation-request-response)
  - [2. Bounded Batch Concurrency (Promise.all Style)](#2-bounded-batch-concurrency-promiseall-style)
  - [3. Transactional Outbox & Background Dispatch](#3-transactional-outbox--background-dispatch)
  - [4. Stateful Workers with Warm L1 Memory](#4-stateful-workers-with-warm-l1-memory)
  - [5. Zero-Copy Binary Data Transfer](#5-zero-copy-binary-data-transfer)
  - [6. Resilient Retries with Exponential Backoff](#6-resilient-retries-with-exponential-backoff)
- [Architecture & Memory Hierarchy](#-architecture--memory-hierarchy)
- [Comparison with Existing Solutions](#-comparison-with-existing-solutions)
- [Architecture Decision Records (ADRs)](#-architecture-decision-records-adrs)
- [Node.js Core RFC Proposal](#-nodejs-core-rfc-proposal)
- [Running Tests & Benchmarks](#-running-tests--benchmarks)
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
| **Node.js Core RFC Target** | N/A | ❌ No | ❌ No | ✅ **Yes (Direct Core Proposal)** |

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

---

## 🏛 Node.js Core RFC Proposal

This codebase serves as the reference implementation for a proposal to the **Node.js Technical Steering Committee (TSC)**:
* **[Official RFC Proposal Draft](NODEJS_RFC_PROPOSAL_DRAFT.md)**: Ready-to-submit RFC for `nodejs/node`.
* **[Node.js Core Contribution Guide](CONTRIBUTING_TO_NODEJS_PROCESS.md)**: Strategic analysis of the "Small Core" philosophy and submission roadmap.

---

## 🧪 Running Tests & Benchmarks

```bash
# Run all unit tests with native Node.js test runner
npm test

# Run code coverage report (>80% line coverage)
npm run test:coverage

# Run all 4 concurrency and performance benchmarks
npm run benchmark:all

# Run individual examples
node examples/express-outbox-email.js
node examples/image-resizer-batch.js
node examples/persistent-ai-model.js
```

---

## 📄 License

[MIT](LICENSE) © 2026 Felipe Miiller
