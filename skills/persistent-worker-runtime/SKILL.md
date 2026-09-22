---
name: persistent-worker-runtime
description: Use the persistent-worker-runtime library to offload CPU-bound work to persistent Node.js worker threads while keeping the Event Loop responsive. Load when the user wants to set up a worker pool, execute tasks on workers, stream results, handle cancellations, transfer binary data with zero copy, set up stateful workers with warm L1 memory, implement transactional outbox patterns, run persistent background jobs, or use BroadcastChannel for inter-worker communication (e.g. L1 cache invalidation). Triggers on "persistent-worker-runtime", "worker pool", "worker_threads", "execute a task on a worker", "dispatch background job", "streaming results", "L1 worker memory", "transactional outbox", "zero-copy transfer", "abort a worker task", "priority task queue", "broadcast channel", "inter-worker communication", "cache invalidation across workers". DO NOT load for unrelated concurrency topics like Promise.all scaling or general multi-threading tutorials.
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
| Full TypeScript API surface | `references/api-reference.md` |
| **Stateful workers, L1 cache, bounded batch, affinity** | `references/stateful-l1.md` |
| **Cancellation (AbortSignal) and priority queue** | `references/cancellation-priority.md` |
| **Zero-copy transfer, retries with backoff, hard preemption** | `references/zero-copy-preemption.md` |
| **Inter-worker BroadcastChannel (L1 cache invalidation)** | `references/broadcast-channel.md` |
| **Observability, lifecycle, memory recycling, error hierarchy** | `references/observability.md` |
| Runnable end-to-end patterns | `references/patterns.md` |

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