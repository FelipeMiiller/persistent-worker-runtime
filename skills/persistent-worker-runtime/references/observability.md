# Observability, Lifecycle, and Errors

## Observability

### Aggregate stats

```javascript
const stats = runtime.stats();
// {
//   totalTasks, completedTasks, failedTasks,
//   queuedTasks, activeWorkers, recycledCount, ...
// }
```

### Lifecycle events

```javascript
runtime.on('task:retrying', ({ task, attempt, maxRetries }) => {});
runtime.on('task_preempted', ({ worker, task }) => {});
runtime.on('worker_recycled', ({ oldId, newId }) => {});
```

Subscribe to events for metrics emission, log aggregation, or custom health checks. The runtime emits events on the EventEmitter base class.

### A preempted task emits `task:preempted`, NOT `task:failed`

This is the single most common integration mistake, because the failure is silent: a
`task:failed` listener simply never fires for preempted tasks.

| | counter | event |
| --- | --- | --- |
| ordinary task failure | `stats.failedTasks++` | `task:failed` |
| forced preemption (watchdog) | `stats.failedTasks++` **and** `stats.preemptedTasksCount++` | `task:preempted` only |

`stats.failedTasks` is an **aggregate that includes preemption**; `task:failed` is the stream of
task-level failures. They are not two views of the same fact. Preemption is deliberately a separate
event so a consumer can tell a forced kill from a cooperative timeout (ADR-0011, Decision Driver
#4) — folding it into `task:failed` would erase that distinction.

The handle itself settles normally: `WorkerHandle` rejects it with
`TaskTimeoutError { preempted: true }` **before** emitting `task:preempted`, so your `await` and
your `onError` callback both fire as usual. Only the event name differs.

```javascript
// WRONG — silently misses every preemption
runtime.on('task:failed', ({ taskId }) => alerts.page(taskId));

// RIGHT — both paths alert, and the preemption one carries the reason
runtime.on('task:failed',    ({ taskId, error }) => alerts.page(taskId, error.message));
runtime.on('task:preempted', ({ taskId })         => alerts.page(taskId, 'preempted'));
```

To count "did not succeed", read `runtime.stats().failedTasks`. To know *why*, listen to both.

### TaskHandle events (per-dispatch)

```javascript
const handle = runtime.dispatch({ ... });

handle.onComplete((result) => db.auditLog.insert({ task, result, completedAt: new Date() }));
handle.onError((err) => db.failedJobs.insert({ task, error: err.message }));
```

These are called **after all retries exhausted** (for `onError`) or **on first success** (for `onComplete`). This is the recommended way to implement transactional outbox.

## Lifecycle

```javascript
const runtime = await createWorkerRuntime({ workers: 4 });
// ... use it ...
await runtime.shutdown(); // graceful: drains queue, closes BCs, terminates workers
```

The runtime ships **no signal handlers** (ADR-0005 — it stays a library, not a daemon). You wire
the transport. The production-safe shape has two properties beyond the obvious one-liner:

```javascript
let shutdownPromise = null;
const shutdown = () => (shutdownPromise ??= runtime.shutdown());

const onSignal = (signal) => {
  shutdown().then(
    () => process.exit(0),
    (err) => { console.error(err); process.exit(1); },
  );
  // Hard timeout: a stuck worker must not outlive the orchestrator's
  // grace period (k8s terminationGracePeriodSeconds defaults to 30s).
  setTimeout(() => process.exit(1), 30_000).unref();
};

process.on('SIGTERM', () => onSignal('SIGTERM'));
process.on('SIGINT',  () => onSignal('SIGINT'));
```

1. **Idempotent** — a second `SIGTERM` mid-drain must not start a parallel drain. `shutdown()`
   itself is idempotent, but the *handler* still needs a guard so a second signal does not
   re-enter and re-log.
2. **Bounded** — without a hard-timeout fallback, a wedged worker leaves a zombie process until the
   orchestrator sends `SIGKILL`. `.unref()` the timer so it does not itself keep the Event Loop
   alive past the success-path `process.exit(0)`.

Runnable: `examples/sigterm-drain.js` (DR §8.1). It measures the drain and proves the idempotency
(measured: ~9 ms for 4 in-flight 100 ms tasks; second-signal call resolves in 0 ms).

`shutdown()` is idempotent. After it returns:
- New `dispatch()` / `execute()` / `broadcast()` calls reject / throw with `WorkerRuntimeError('Runtime is shutting down')`
- All main-thread-owned `BroadcastChannel` instances are closed
- All worker threads are terminated

## Memory Hygiene (Automatic Recycling)

Workers are recycled after `maxTasksPerWorker` or `maxMemoryMb` to prevent heap fragmentation:

```javascript
const runtime = await createWorkerRuntime({
  workers: 4,
  maxTasksPerWorker: 500, // recycle after 500 tasks
  maxMemoryMb: 512,       // recycle if heap exceeds 512MB
});
```

Recycled workers lose their L1 cache — design stateful code to gracefully re-warm.

`runtime.stats().recycledCount` is the cumulative recycle count; alert on it going up faster than expected.

## Error Hierarchy

```
WorkerRuntimeError                (base)
├── WorkerCrashError              (exit code, workerId)
├── TaskTimeoutError              (taskId, timeoutMs, preempted)
├── TaskAbortedError              (taskId, AbortSignal.aborted)
├── TaskQueueTimeoutError         (taskId, waitedMs, queueDepth)
└── QueueOverflowError            (maxQueueSize)
```

All extend `Error`. Use `err.code === 'ERR_TASK_TIMEOUT'` etc. for programmatic checks, or `instanceof TaskAbortedError` for type-safe handling.

### Code constants

| Error | `err.code` |
| --- | --- |
| `WorkerRuntimeError` | `ERR_WORKER_RUNTIME` |
| `WorkerCrashError` | `ERR_WORKER_CRASH` |
| `TaskTimeoutError` | `ERR_TASK_TIMEOUT` |
| `TaskAbortedError` | `ERR_TASK_ABORTED` |
| `TaskQueueTimeoutError` | `ERR_TASK_QUEUE_TIMEOUT` |
| `QueueOverflowError` | `ERR_QUEUE_OVERFLOW` |

## See also

- `src/errors.js` — full error class definitions
- `examples/express-outbox-email.js` — uses `onComplete` / `onError` for transactional outbox