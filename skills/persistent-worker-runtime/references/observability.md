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

// Or hook to a signal:
process.on('SIGTERM', () => runtime.shutdown());
```

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