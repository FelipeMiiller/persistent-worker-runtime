# Persistent Worker Runtime for Node.js

> **"The Event Loop coordinates. Persistent Workers execute."**

A concurrent execution layer built atop `node:worker_threads`, engineered in **pure modern JavaScript (zero external dependencies)** targeting **Node.js >= 24**, designed for submission as a native proposal to **Node.js Core** (`nodejs/node`).

---

## 🎯 Motivation

Node.js features a single-threaded Event Loop optimized for asynchronous non-blocking I/O. However, when an application executes **CPU-bound tasks** (cryptography, image/document manipulation, AST parsing, ML embeddings, heavy template rendering) or **background side-effects** (sending emails, webhook calls, outbox events), the main thread freezes.

This runtime provides first-class native execution primitives:
1. **Interactive Computation (`execute`)**: Offload CPU-heavy tasks and await the result with near-zero Event Loop lag.
2. **Bounded Concurrency (`executeAll`)**: Parallel batch processing with `Promise.all` semantics, strictly bounded to the pool's capacity.
3. **Background Dispatch & Outbox (`dispatch` / `dispatchAll`)**: Fire-and-track tasks without blocking the HTTP response, confirming completion asynchronously via `.onComplete()` and `.onError()`.
4. **Stateful Workers with L1 Memory**: Persistent worker threads that maintain warm in-memory heaps (caches, loaded models, WASM modules) across tasks.
5. **Zero External Dependencies**: Authored strictly using Node.js built-in modules (`node:worker_threads`, `node:async_hooks`, `node:events`, `node:perf_hooks`).

---

## 📊 Benchmark: Event Loop Lag Under Load

Running 8 CPU-heavy Fibonacci(36) calculations:

```text
=====================================================================
BENCHMARK: Main Event Loop Responsiveness Under CPU-Bound Load
=====================================================================

[1/2] Synchronous Execution on Main Event Loop:
  -> Duration: 2217.38ms
  -> Main Event Loop FREEZE: 2207.93ms (Total HTTP Starvation)

[2/2] Persistent Worker Runtime (4 Workers):
  -> Duration: 590.45ms (3.8x faster wall-clock throughput)
  -> Main Event Loop Max Lag: 6.48ms
  -> Main Thread: 100% available for incoming I/O during computation!
```

---

## 🚀 Quick Start

### 1. Interactive Computation (Request-Response)
```javascript
import { createWorkerRuntime } from 'persistent-worker-runtime';

const runtime = await createWorkerRuntime({ workers: 4 });

// Offload CPU work away from the Event Loop
const result = await runtime.execute({
  type: 'compress',
  payload: { data: largeBuffer },
  fn: (p) => heavyCompression(p.data),
});
```

### 2. Bounded Concurrency Batch Execution (`Promise.all` style)
```javascript
// Executes in parallel, bounded strictly by the configured worker pool capacity
const [invoice, receipt, shipping] = await runtime.executeAll([
  { type: 'invoice', payload: order, fn: (p) => generateInvoice(p) },
  { type: 'receipt', payload: order, fn: (p) => generateReceipt(p) },
  { type: 'shipping', payload: order, fn: (p) => createShippingLabel(p) },
]);
```

### 3. Transactional Outbox & Background Jobs (`dispatch`)
```javascript
// Fast sub-5ms HTTP endpoint:
app.post('/register', async (req, res) => {
  const user = await db.users.create(req.body);
  const outbox = await db.outbox.create({ userId: user.id, task: 'send_email', status: 'PENDING' });

  // Dispatches to worker in microseconds; does NOT block the HTTP response
  const task = runtime.dispatch({
    type: 'send_welcome_email',
    payload: { outboxId: outbox.id, email: user.email },
    fn: (p) => sendMail(p.email),
  });

  // Asynchronous confirmation updates the outbox table
  task.onComplete(async (result) => {
    await db.outbox.update(outbox.id, { status: 'COMPLETED', result });
  });
  task.onError(async (err) => {
    await db.outbox.update(outbox.id, { status: 'FAILED', error: err.message });
  });

  // Responds to client immediately!
  return res.status(201).json({ userId: user.id });
});
```

### 4. Dedicated Stateful Worker with L1 In-Memory Persistence
```javascript
const mlWorker = await runtime.createWorker({ name: 'ai-engine' });

// Store warm state in the worker's private L1 heap
await mlWorker.setState('model:bert', loadedWeights);

// Subsequent executions reuse the warmed state with 0 re-initialization overhead
const embedding = await mlWorker.executeTask(task);
```

---

## 🏛 Architecture Decision Records (ADRs)

All core design choices are documented in [`docs/adr/`](docs/adr/README.md):
* **[ADR-0001](docs/adr/0001-persistent-worker-runtime-over-worker-threads.md)**: Persistent Worker Runtime Over worker_threads
* **[ADR-0002](docs/adr/0002-three-tier-memory-architecture.md)**: Three-Tier Memory Architecture (L1 / L2 / L3)
* **[ADR-0003](docs/adr/0003-dual-execution-model-execute-and-dispatch.md)**: Dual Execution Model (execute vs. dispatch) and Transactional Outbox Support
* **[ADR-0004](docs/adr/0004-asynchronous-queue-backpressure-with-timeout.md)**: Asynchronous Queue Backpressure with Timeout and AsyncResource
* **[ADR-0005](docs/adr/0005-native-javascript-esm-with-zero-external-dependencies.md)**: Pure Modern JavaScript (ESM, Node.js >= 24) with Zero External Dependencies
* **[ADR-0006](docs/adr/0006-bounded-concurrency-batch-processing.md)**: Bounded Concurrency Batch Processing (executeAll & dispatchAll)

---

## 📋 Running Tests & Benchmarks

```bash
# Run native Node.js test runner (zero external testing dependencies)
npm test

# Run the Event Loop lag benchmark
npm run benchmark
```
