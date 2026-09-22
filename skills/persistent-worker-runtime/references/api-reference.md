# API Reference (v0.2.0)

Complete reference for the public API. For narrative documentation and patterns, see `SKILL.md` and `references/patterns.md`.

> **v0.2.0 additions** (vs v0.1.0): 11 HARDEN options (`accumulationRateMbPerSec`, `minRecycleIntervalMs`, `recycleOnTasksExhausted`, `dispatchStrategy`, `workerPollIntervalMs`, `recycleBackoffMs`, `observeWorkerMemory`, `memoryEmitIntervalMs`, `concurrency`, `timeoutMs`), `runtime.getWorkers()` snapshot, `runtime.recycleWorker()`, `runtime.stream()`, `runtime.broadcast()` / `subscribe()` / `unsubscribe()` / `hasSubscribers()`, expanded `runtime.stats` block (`workers`, `adaptive`, `activeStreams`, `pendingStreams`), new events (`worker:memory`, `worker_tasks:exhausted`, `worker:retiring`, `stream:*`), new exports (`Stream`).

---

## `createWorkerRuntime(options) → Promise<WorkerRuntime>`

Factory for the runtime. Returns an initialized `WorkerRuntime` instance with workers spawned and ready.

```typescript
interface WorkerRuntimeOptions {
  workers?: number;                          // fixed pool size; default: 1 (was availableParallelism()-1)
  concurrency?: 'adaptive' | 'fixed' | 'auto';  // sizing policy; default: 'adaptive' on >4-core hosts
  minWorkers?: number;                      // adaptive band lower bound; default: 1
  maxWorkers?: number;                      // adaptive band upper bound; default: availableParallelism()
  idleTimeoutMs?: number;                   // ms before idle worker is reaped; default: 15000

  maxTasksPerWorker?: number;               // recycle after N tasks; default: Infinity
  maxMemoryMb?: number;                     // recycle if heap exceeds N MB; default: Infinity
  accumulationRateMbPerSec?: number;       // HARDEN-06: recycle if EWMA growth > N MB/s; default: Infinity (off)
  minRecycleIntervalMs?: number;           // HARDEN-07: hysteresis window; default: 0 (off)
  recycleOnTasksExhausted?: boolean;        // HARDEN-08: opt-out flag; default: true
  recycleBackoffMs?: number;               // HARDEN-11: drain-grace window; default: 0

  dispatchStrategy?: 'fifo' | 'lru' | 'random';  // HARDEN-09; default: 'lru'
  workerPollIntervalMs?: number;            // HARDEN-10: watchdog cadence; default: 1000, clamp min 100

  observeWorkerMemory?: boolean;            // HARDEN-05: emit worker:memory events; default: false
  memoryEmitIntervalMs?: number;            // HARDEN-05: ms between events; default: 1000

  timeoutMs?: number;                       // HARDEN-01: default per-task timeout; default: 5000
  forceKillOnTimeout?: boolean;             // hard preempt runaway tasks; default: false
  killGracePeriodMs?: number;               // cooperative cancel window; default: 500

  maxQueueSize?: number;                    // queue capacity; default: 2000
  queueTimeoutMs?: number;                  // default wait timeout; default: 30000

  workerScript?: string;                    // path to a custom worker entry; default: built-in
  handlerPath?: string;                     // path to an ES module exporting custom task handlers
  resourceLimits?: ResourceLimits;          // V8 memory/stack limits per worker isolate

  // Adaptive controller overrides (ADR-0014) — leave unset for production
  shrinkEluThreshold?: number;
  shrinkLatencyP99Ms?: number;
  growEluThreshold?: number;
  growLatencyP99Ms?: number;
  ewmaAlpha?: number;
  debounceTicks?: number;
}
```

---

## `WorkerRuntime`

The central execution engine. Extends `EventEmitter`.

```typescript
// HARDEN-03 / ADR-0024: live getters
runtime.maxTasksPerWorker;           // number
runtime.maxMemoryMb;                 // number
runtime.forceKillOnTimeout;          // boolean
runtime.killGracePeriodMs;           // number
runtime.recycleBackoffMs;            // number (HARDEN-11)
runtime.workerPollIntervalMs;        // number (HARDEN-10)
runtime.accumulationRateMbPerSec;    // number (HARDEN-06)
runtime.minRecycleIntervalMs;        // number (HARDEN-07)
runtime.recycleOnTasksExhausted;     // boolean (HARDEN-08)
runtime.dispatchStrategy;            // 'fifo' | 'lru' | 'random' (HARDEN-09)
runtime.observeWorkerMemory;         // boolean (HARDEN-05)
runtime.memoryEmitIntervalMs;        // number (HARDEN-05)
runtime.timeoutMs;                   // number (HARDEN-01 default per-task)
runtime.adaptiveEnabled;             // boolean (ADR-0014)
runtime.isShuttingDown;              // boolean

// HARDEN-04 + ADR-0014: stats
runtime.stats;                       // RuntimeStats
```

### `runtime.execute(task) → Promise<result>`

**Request-Response mode**. Submits a task and resolves with the result. Rejects on timeout, abort, worker crash, or thrown error inside `fn`.

```typescript
interface ExecuteTask<T = any> {
  type: string;                      // logical task type (used for handler dispatch)
  payload?: any;                     // serializable data passed to fn
  fn?: (payload) => T | Promise<T>;  // inline function (serialized to fnCode)
  fnCode?: string;                   // OR raw JS source for the function
  signal?: AbortSignal;              // cooperative cancellation
  priority?: number;                 // higher = dequeued first; default: 0
  affinityKey?: string;              // pin to a worker with matching affinity
  transferList?: ArrayBuffer[];      // zero-copy transferable buffers
  timeoutMs?: number;                // per-task timeout override (default: runtime.timeoutMs)
  forceKillOnTimeout?: boolean;      // per-task preemption override
  retries?: number;                  // number of retry attempts; default: 0
  retryDelayMs?: number;             // initial retry delay; default: 500
  backoff?: 'exponential' | 'linear' | 'fixed';  // backoff strategy; default: 'exponential'
  metadata?: Record<string, any>;    // app metadata (outboxId, traceId)
}
```

### `runtime.dispatch(task) → TaskHandle`

**Outbox (background) mode**. Returns immediately with a `TaskHandle`. The task runs asynchronously; settlement is delivered via callbacks.

```typescript
interface TaskHandle {
  readonly id: string;
  readonly type: string;
  readonly payload: any;
  readonly affinityKey: string | null;
  readonly isSettled: boolean;
  readonly promise: Promise<any>;
  readonly durationMs: number;
  readonly attempts: number;

  onComplete(callback: (result) => void | Promise<void>): this;
  onError(callback: (error) => void | Promise<void>): this;
}
```

### `runtime.executeAll(tasks) → Promise<results[]>`

Submits multiple tasks with bounded concurrency. Waits for all to settle.

### `runtime.executeAllSettled(tasks) → Promise<settledResults[]>`

Same as `executeAll` but uses `Promise.allSettled` semantics — never rejects.

### `runtime.dispatchAll(tasks) → TaskHandle[]`

Submits multiple background tasks. Returns immediately with an array of handles.

### `runtime.createWorker(options?) → Promise<WorkerHandle>`

Spawns a dedicated worker handle for direct stateful access (L1 heap, custom IPC). Useful for stateful scenarios requiring persistent in-worker memory.

```typescript
interface WorkerHandleOptions {
  affinityKey?: string;               // workers with the same key receive the same task
  name?: string;                      // human-readable name for logs/stats
  initialState?: Record<string, any>; // serialized into the worker's L1 on boot
}
```

### `runtime.getWorkers() → WorkerSnapshot[]` (HARDEN-03)

Synchronous snapshot of the worker pool. Returns a fresh array per call.

```typescript
interface WorkerSnapshot {
  id: string;
  status: 'starting' | 'idle' | 'busy' | 'recycling' | 'preempting' | 'terminating' | 'terminated';
  tasksCompleted: number;
  tasksActive: number;
  lastMemoryUsageBytes: number;
  lastTaskAt: number | null;
  affinityKey: string | null;
  isDedicated: boolean;
}
```

### `runtime.recycleWorker(workerId) → boolean`

Forces an immediate recycle-check for a specific worker, bypassing the normal `task_completed` / poll trigger. Useful for operators who want to drain a worker before a rolling deploy. Returns `false` if the worker is not in the pool.

### `runtime.stream(taskFn, payload?, options?) → Stream` (ADR-0012)

Streams task results from an async (or sync) generator worker function. Returns a `Stream` whose `for await (const chunk of stream)` consumes the generator's yields with backpressure.

```typescript
interface StreamOptions {
  signal?: AbortSignal;               // external cancellation
  highWaterMark?: number;             // buffer cap; default: 16
}

// Consumer-side — standard async iteration. Breaks / aborts propagate to
// the worker so its `finally` block still runs.
for await (const chunk of runtime.stream(generator, payload, { signal })) {
  process.stdout.write(chunk.delta);
}
```

See `references/quickstart.md` §10 and `examples/streaming-llm.js` for the full pattern.

### `runtime.broadcast(channel, message)` / `subscribe(channel, handler)` / `unsubscribe(channel, handler)` / `hasSubscribers(channel)` (ADR-0013)

Main-thread facade for native `BroadcastChannel`. Backed by Node's built-in bus — O(1) per publish across all subscribed workers. See `references/broadcast-channel.md` for the full worker-side API and `examples/broadcast-cache-invalidation.js` for a runnable demo.

```typescript
runtime.broadcast('cache:user', { userId: 42, reason: 'update' });

const unsubscribe = runtime.subscribe('cache:user', (msg) => {
  metrics.incr('cache.invalidate', { reason: msg.reason });
});

runtime.hasSubscribers('cache:user');   // true
runtime.unsubscribe('cache:user', handler);  // true
```

### `runtime.shutdown() → Promise<void>`

Gracefully drains the queue, terminates all workers, and rejects any in-flight tasks with `WorkerRuntimeError('Runtime is shutting down')`. Idempotent.

### `runtime.stats` (HARDEN-04 + ADR-0014)

```typescript
interface RuntimeStats {
  totalWorkers: number;
  idleWorkers: number;
  queueDepth: number;
  waitingQueueCount: number;
  submittedTasks: number;
  completedTasks: number;
  failedTasks: number;
  recycledWorkersCount: number;       // total recycling events
  preemptedTasksCount: number;        // total hard preemption events

  // HARDEN-04: aggregate pool counters
  workers: {
    total: number;
    idle: number;
    busy: number;
    recycling: number;
    terminating: number;
    byStatus: Record<string, number>;
    totalMemoryBytes: number;
  };

  // ADR-0014: live adaptive-controller telemetry (undefined when disabled)
  adaptive?: {
    enabled: boolean;
    effectiveWorkers: number;
    minWorkers: number;
    maxWorkers: number;
    elu: number | null;               // Event Loop Utilization, 0..1
    latencyP99Ms: number | null;      // p99 event-loop delay in ms
    lastResizeReason: 'grow' | 'shrink-from-busy' | 'shrink-from-idle' | 'hold' | null;
    lastResizeAt: number | null;
    ticksSinceResize: number;
    totalGrowEvents: number;
    totalShrinkEvents: number;
  };

  // ADR-0012: stream state
  activeStreams: number;
  pendingStreams: number;
}
```

### Events

```typescript
// Tasks & workers
runtime.on('task:retrying',  ({ taskId, attempt, maxRetries, delayMs, error }) => {});
runtime.on('task:completed', ({ taskId, type, durationMs, result }) => {});
runtime.on('task:failed',    ({ taskId, type, durationMs, attempts, error }) => {});
runtime.on('task:preempted' | 'task_preempted', ({ workerId, taskId, timeoutMs, preempted }) => {});

runtime.on('worker:recycling' | 'worker_recycling', ({ workerId, reason, tasksCompleted, memoryUsage }) => {});
runtime.on('worker:recycled'  | 'worker_recycled',  ({ oldWorkerId, newWorkerId }) => {});
runtime.on('worker:preempted' | 'worker_preempted', ({ workerId, exitCode }) => {});
runtime.on('worker:ready',     ({ workerId }) => {});
runtime.on('worker:replaced',  ({ oldId, newId }) => {});

// HARDEN-05: per-worker memory (requires observeWorkerMemory: true)
runtime.on('worker:memory',   ({ workerId, memoryUsageBytes, atMs }) => {});

// HARDEN-08 + adaptive controller
runtime.on('worker_tasks:exhausted', ({ workerId, tasksCompleted }) => {});
runtime.on('worker:retiring',        ({ workerId, reason: 'drain' }) => {});

// ADR-0012: streaming
runtime.on('stream:created',     ({ taskId }) => {});
runtime.on('stream:chunk',       ({ taskId, seq }) => {});
runtime.on('stream:end',         ({ taskId, totalChunks, returnValue }) => {});
runtime.on('stream:aborted',     ({ taskId, reason }) => {});
runtime.on('stream:backpressure',({ taskId, state, queueLength }) => {});
```

---

## `WorkerHandle`

Returned by `runtime.createWorker()`. Provides direct access to a single worker.

```typescript
interface WorkerHandle {
  readonly id: string;
  readonly name?: string;
  readonly affinityKey?: string;
  readonly status: 'starting' | 'idle' | 'busy' | 'recycling' | 'preempting' | 'terminating' | 'terminated';
  readonly isDedicated: boolean;
  readonly isIdle: boolean;
  readonly isRecycling: boolean;
  readonly tasksCompleted: number;
  readonly lastMemoryUsageBytes: number;

  // Stateful L1 memory access (worker-side Map)
  getState<T = any>(key: string): Promise<T | undefined>;
  setState<T = any>(key: string, value: T): Promise<boolean>;
  clearState(): Promise<boolean>;

  // Direct task execution
  executeTask<T = any>(task: TaskHandle<T>): Promise<T>;
  dispatchTask<T = any>(task: TaskHandle<T>): TaskHandle<T>;

  // Health check
  ping(): Promise<'pong'>;

  // Lifecycle
  terminate(): Promise<void>;
}
```

---

## `Stream<TChunk, TReturn>`

Async-iterable result stream returned by `runtime.stream()`.

```typescript
class Stream<TChunk = any, TReturn = any> implements AsyncIterable<TChunk> {
  readonly totalChunks: number;
  readonly endReceived: boolean;
  readonly errorReceived: boolean;
  readonly aborted: boolean;
  readonly abortedReason: string | null;
  readonly returnValue: TReturn | null;

  [Symbol.asyncIterator](): AsyncIterator<TChunk>;

  return(value?: any): Promise<IteratorResult<TChunk>>;
  throw(err?: any): Promise<IteratorResult<TChunk>>;

  on(event: 'stream:aborted', listener: (data: { reason: string }) => void): this;
  on(event: 'stream:backpressure', listener: (data: { state: 'paused' | 'resumed'; queueLength: number }) => void): this;
  on(event: 'stream:chunk', listener: (data: { seq: number }) => void): this;
  on(event: 'stream:end', listener: (data: { totalChunks: number; returnValue: TReturn }) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
}
```

---

## `Supervisor` (advanced)

Pool orchestration. Exposed for advanced scenarios (custom worker selection, debug instrumentation).

```typescript
class Supervisor {
  start(): Promise<void>;
  shutdown(): Promise<void>;

  readonly idleWorkers: WorkerHandle[];
  readonly allWorkers: WorkerHandle[];
  readonly totalWorkers: number;

  readonly recycledCount: number;
  readonly preemptedCount: number;
  readonly maxTasksPerWorker: number;
  readonly maxMemoryMb: number;
  readonly recycleBackoffMs: number;            // HARDEN-11
  readonly workerPollIntervalMs: number;        // HARDEN-10
  readonly accumulationRateMbPerSec: number;    // HARDEN-06
  readonly minRecycleIntervalMs: number;        // HARDEN-07
  readonly dispatchStrategy: 'fifo' | 'lru' | 'random';  // HARDEN-09
  readonly forceKillOnTimeout: boolean;
  readonly killGracePeriodMs: number;

  findWorkerForTask(task: { affinityKey?: string }): WorkerHandle | null;
  createDedicatedWorker(options?: WorkerHandleOptions): Promise<WorkerHandle>;
}
```

---

## Error hierarchy

```
Error
└── WorkerRuntimeError                       (code: 'ERR_WORKER_RUNTIME')
    ├── WorkerCrashError                     (code: 'ERR_WORKER_CRASHED', workerId, exitCode)
    ├── TaskTimeoutError                     (code: 'ERR_TASK_TIMEOUT', taskId, timeoutMs, preempted, workerId)
    ├── TaskQueueTimeoutError                (code: 'ERR_TASK_QUEUE_TIMEOUT', taskId, waitedMs, queueDepth)
    └── QueueOverflowError                   (code: 'ERR_QUEUE_OVERFLOW', maxQueueSize)

TaskAbortedError                             (code: 'ERR_TASK_ABORTED', taskId)
```

All errors extend `Error`. The `code` property is stable for programmatic checks. Use `instanceof` for type-safe handling.

---

## TypeScript types

Full TypeScript definitions ship at `node_modules/persistent-worker-runtime/src/index.d.ts`. Import from the package:

```typescript
import type {
  WorkerRuntime,
  WorkerHandle,
  TaskHandle,
  Stream,
  WorkerSnapshot,
  RuntimeStats,
  ExecuteTask,
  DispatchTask,
  WorkerRuntimeOptions,
} from 'persistent-worker-runtime';
```

The `.d.ts` file is the source of truth — every option on this page is typed there.
