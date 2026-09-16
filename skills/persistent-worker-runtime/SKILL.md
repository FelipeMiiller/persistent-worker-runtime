---
name: persistent-worker-runtime
description: Use the persistent-worker-runtime library to offload CPU-bound work to persistent Node.js worker threads while keeping the Event Loop responsive. Load this skill when the user wants to set up a worker pool, execute tasks on workers, stream results, handle cancellations, transfer binary data with zero copy, set up stateful workers with warm L1 memory, implement transactional outbox patterns, or run persistent background jobs. Triggers on "persistent-worker-runtime", "worker pool", "worker_threads", "execute a task on a worker", "dispatch background job", "streaming results", "L1 worker memory", "transactional outbox", "zero-copy transfer", "abort a worker task", "priority task queue". DO NOT load for unrelated concurrency topics like Promise.all scaling or general multi-threading tutorials.
license: MIT
metadata:
  author: Felipe Miiller
  version: 0.1.0
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

Requires **Node.js >= 22**. Pure ESM, **zero external dependencies** (only `node:worker_threads`).

---

## 2. Quick Start (60 seconds)

### Two-mode execution model

The runtime provides two distinct APIs for two distinct use cases:

| Mode | Method | Returns | Use when |
| --- | --- | --- | --- |
| **Request-Response** | `runtime.execute(task)` | `Promise<result>` | You need the result back (sub-millisecond responses, RPC, HTTP handlers) |
| **Outbox (Background)** | `runtime.dispatch(task)` | `TaskHandle` (with `.onComplete`) | Fire-and-forget with database confirmation (transactional outbox, webhooks, batch jobs) |

### Request-Response: `execute()`

```javascript
import { createWorkerRuntime } from 'persistent-worker-runtime';

const runtime = await createWorkerRuntime({ workers: 4 });

const result = await runtime.execute({
  type: 'compute',
  payload: { a: 40, b: 2 },
  fn: ({ a, b }) => a + b,
});

console.log(result); // 42
await runtime.shutdown();
```

### Outbox: `dispatch()`

```javascript
const handle = runtime.dispatch({
  type: 'send_email',
  payload: { to: 'user@example.com', subject: 'Welcome' },
  retries: 3,
  retryDelayMs: 1000,
  fn: async (p) => {
    await mailer.send(p);
    return { sent: true };
  },
});

handle.onComplete((result) => {
  // Persist the confirmation to the database — the outbox pattern
  db.auditLog.insert({ task: 'send_email', result, completedAt: new Date() });
});

handle.onError((err) => {
  // Final settlement after all retries exhausted
  db.failedJobs.insert({ task: 'send_email', error: err.message });
});
```

---

## 3. Stateful Workers (L1 Memory)

Workers stay alive across tasks. Use the worker's `L1` heap as a warm cache — no re-loading per request.

```javascript
const runtime = await createWorkerRuntime({ workers: 1 });

// First call: worker loads the model from disk (slow)
await runtime.execute({
  type: 'warm_model',
  fn: async () => {
    const state = new Map();
    const data = await loadHugeModelFromDisk();
    state.set('model', data);
    return 'ready';
  },
});

// Subsequent calls: model is already in L1 (fast)
for (let i = 0; i < 1000; i++) {
  await runtime.execute({
    type: 'predict',
    payload: { input: i },
    fn: ({ input }) => model.predict(input), // <-- 33x faster than reloading per request
  });
}
```

See `references/patterns.md` for a complete LLM-inference example.

---

## 4. Bounded Concurrency Batch

`executeAll` and `dispatchAll` enforce pool-level concurrency (no naive Promise.all microtask floods):

```javascript
// 1000 tasks, only 4 running in parallel
await runtime.executeAll(
  Array.from({ length: 1000 }, (_, i) => ({
    type: 'image_thumbnail',
    payload: { id: i },
    fn: async ({ id }) => makeThumbnail(id),
  }))
);
```

Returns `Promise<results[]>` for `executeAll` or `Promise<TaskHandle[]>` for `dispatchAll`.

---

## 5. Cancellation via AbortController

Standard `AbortSignal` integration:

```javascript
const controller = new AbortController();

const promise = runtime.execute({
  type: 'long_query',
  payload: { rows: 1_000_000 },
  signal: controller.signal,
  fn: async (p) => scanRows(p.rows),
});

// Cancel manually (HTTP client disconnect, user navigation, etc.)
setTimeout(() => controller.abort(), 5000);

// Or use the built-in timeout helper:
await runtime.execute({
  type: 'slow_query',
  payload: {},
  signal: AbortSignal.timeout(2000), // auto-abort after 2s
  fn: () => query(),
});
```

Cancelled tasks reject with `TaskAbortedError`.

---

## 6. Priority Queue

Higher-priority tasks are dequeued first. Ties preserve FIFO.

```javascript
// Low-priority batch work first
runtime.dispatch({ type: 'analytics', priority: 0, payload: {}, fn: () => aggregate() });

// Critical user-facing work jumps the queue (submitted later, runs first)
runtime.dispatch({ type: 'live_chat', priority: 10, payload: { userId: 42 }, fn: serve });
```

---

## 7. Zero-Copy Binary Transfer

For multi-megabyte payloads (images, video, ML tensors), use `transferList` to move the buffer without copying:

```javascript
const imageBuffer = new ArrayBuffer(3840 * 2160 * 4); // ~31MB

await runtime.execute({
  type: 'process_image',
  payload: { buffer: imageBuffer, width: 3840, height: 2160 },
  transferList: [imageBuffer], // buffer detached from sender after transfer
  fn: (p) => applyFilter(p.buffer),
});
// 5x faster than structured clone (see benchmarks/zero-copy-transfer.benchmark.js)
```

---

## 8. Retries with Backoff

```javascript
runtime.dispatch({
  type: 'call_webhook',
  payload: { url: 'https://partner.example.com', data },
  retries: 5,
  retryDelayMs: 100,
  backoff: 'exponential', // 'exponential' or 'linear'
  fn: async (p) => fetch(p.url, { method: 'POST', body: JSON.stringify(p.data) }),
});
```

Background retries do NOT block the worker — the delay happens on the main thread's queue scheduler.

---

## 9. Cooperative + Hard Preemption

Two layers of timeout enforcement:

| Layer | Setting | Behavior |
| --- | --- | --- |
| Cooperative | `timeoutMs: 5000` | Worker can `await` cancellation; clean shutdown |
| Hard | `timeoutMs: 5000, forceKillOnTimeout: true` | Main thread forcibly `worker.terminate()`s if the worker doesn't yield; spawns replacement |

```javascript
await runtime.execute({
  type: 'parse_user_input',
  payload: { input: userText },
  timeoutMs: 100,
  forceKillOnTimeout: true, // protects against ReDoS / infinite sync loops
  fn: (p) => parser.parse(p.input),
});
```

Preempted tasks reject with `TaskTimeoutError` having `preempted: true`.

---

## 10. Memory Hygiene (Automatic Recycling)

Workers are recycled after `maxTasksPerWorker` or `maxMemoryMb` to prevent heap fragmentation:

```javascript
const runtime = await createWorkerRuntime({
  workers: 4,
  maxTasksPerWorker: 500, // recycle after 500 tasks
  maxMemoryMb: 512,       // recycle if heap exceeds 512MB
});
```

Recycled workers lose their L1 cache — design stateful code to gracefully re-warm.

---

## 11. Observability

```javascript
// Aggregate stats
const stats = runtime.stats();
// { totalTasks, completedTasks, failedTasks, queuedTasks, activeWorkers, recycledCount, ... }

// Lifecycle events
runtime.on('task:retrying', ({ task, attempt, maxRetries }) => {});
runtime.on('task_preempted', ({ worker, task }) => {});
runtime.on('worker_recycled', ({ oldId, newId }) => {});
```

---

## 12. Lifecycle

```javascript
const runtime = await createWorkerRuntime({ workers: 4 });
// ...
await runtime.shutdown(); // graceful: drains queue, terminates workers

// Or, on uncaught exception:
process.on('SIGTERM', () => runtime.shutdown());
```

---

## 13. Error Hierarchy

```
WorkerRuntimeError                (base)
├── WorkerCrashError              (exit code, workerId)
├── TaskTimeoutError              (taskId, timeoutMs, preempted)
├── TaskAbortedError              (taskId, AbortSignal.aborted)
├── TaskQueueTimeoutError         (taskId, waitedMs, queueDepth)
└── QueueOverflowError            (maxQueueSize)
```

All extend `Error`. Use `err.code === 'ERR_TASK_TIMEOUT'` etc. for programmatic checks, or `instanceof TaskAbortedError` for type-safe handling.

---

## 14. Common Mistakes

1. **Don't dispatch after `shutdown()`** — throws `WorkerRuntimeError`. Always guard with `if (!runtime.isShuttingDown)`.
2. **Don't reuse transferred buffers** — they're detached on the sender. Move the reference to the worker.
3. **Don't put closures in `fnCode`** — runs in worker thread with no main-thread scope. Pass everything via `payload`.
4. **Don't ignore `recycledCount`** — design stateful code to re-warm gracefully. Otherwise the first request after recycle will spike.
5. **Don't `await enqueue()` without handling cancellation** — if the task gets aborted mid-wait, the queue's `enqueue()` Promise stays pending until `runtime.shutdown()` (handled internally, but custom waiters should be cleaned up).

---

## When to load references

- For runnable end-to-end patterns (transactional outbox, image batch, AI inference): `references/patterns.md`
- For the full TypeScript API surface: `references/api-reference.md`
- For step-by-step examples in copy-pasteable form: `references/quickstart.md`
