# API Reference

Complete reference for the public API. For narrative documentation and patterns, see `SKILL.md` and `references/patterns.md`.

---

## `createWorkerRuntime(options) → Promise<WorkerRuntime>`

Factory for the runtime. Returns an initialized `WorkerRuntime` instance with workers spawned and ready.

```typescript
interface WorkerRuntimeOptions {
  workers?: number;                  // fixed pool size; default: availableParallelism() - 1
  minWorkers?: number;               // elastic pool minimum; default: workers or 1
  maxWorkers?: number;               // elastic pool maximum; default: workers or 16
  idleTimeoutMs?: number;            // ms before idle worker is reaped; default: 15000
  maxTasksPerWorker?: number;        // recycle after N tasks; default: Infinity
  maxMemoryMb?: number;              // recycle if heap exceeds N MB; default: Infinity
  maxQueueSize?: number;             // queue capacity; default: 2000
  queueTimeoutMs?: number;           // default wait timeout; default: 30000
  forceKillOnTimeout?: boolean;      // hard preempt runaway tasks; default: false
  killGracePeriodMs?: number;        // cooperative cancel window before hard kill; default: 500
  workerScript?: string;             // path to a custom worker entry; default: built-in
  handlerPath?: string;              // path to an ES module exporting custom task handlers
}
```

---

## `WorkerRuntime`

The central execution engine. Extends `EventEmitter`.

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
  timeoutMs?: number;                // per-task timeout override
  forceKillOnTimeout?: boolean;      // per-task preemption override
  retries?: number;                  // number of retry attempts; default: 0
  retryDelayMs?: number;             // initial retry delay; default: 100
  backoff?: 'exponential' | 'linear'; // backoff strategy; default: 'exponential'
}
```

### `runtime.dispatch(task) → TaskHandle`

**Outbox (background) mode**. Returns immediately with a `TaskHandle`. The task runs asynchronously; settlement is delivered via callbacks.

The `TaskHandle` is also extended with the same fields as `ExecuteTask` for consistency.

```typescript
interface TaskHandle {
  readonly id: string;
  readonly promise: Promise<any>;      // resolves on success, rejects on final failure
  isSettled: boolean;                  // true after terminal success or failure

  onComplete(callback: (result) => void): this;   // attach a final-success handler
  onError(callback: (error) => void): this;       // attach a final-failure handler
}
```

### `runtime.executeAll(tasks) → Promise<results[]>`

Submits multiple tasks with bounded concurrency. Waits for all to settle. Returns results in submission order, each as `{ status: 'fulfilled', value }` or `{ status: 'rejected', reason }`.

```typescript
executeAll<T>(tasks: ExecuteTask<T>[]): Promise<PromiseSettledResult<T>[]>
```

### `runtime.executeAllSettled(tasks) → Promise<settledResults[]>`

Same as `executeAll` but uses `Promise.allSettled` semantics — never rejects, always returns the settled-result envelope.

### `runtime.dispatchAll(tasks) → TaskHandle[]`

Submits multiple background tasks. Returns immediately with an array of handles. Caller is responsible for attaching `onComplete` / `onError` callbacks.

### `runtime.createWorker(options?) → Promise<WorkerHandle>`

Spawns a dedicated worker handle for direct stateful access (L1 heap, custom IPC). Useful for stateful scenarios requiring persistent in-worker memory.

```typescript
interface WorkerHandleOptions {
  affinityKey?: string;               // workers with the same key receive the same task
  name?: string;                      // human-readable name for logs/stats
  initialState?: Record<string, any>; // serialized into the worker's L1 on boot
}
```

### `runtime.shutdown() → Promise<void>`

Gracefully drains the queue, terminates all workers, and rejects any in-flight tasks with `WorkerRuntimeError('Runtime is shutting down')`. Idempotent.

### `runtime.stats() → RuntimeStats`

Returns aggregate counters and gauges.

```typescript
interface RuntimeStats {
  totalTasks: number;          // all tasks ever dispatched
  completedTasks: number;      // tasks that returned successfully
  failedTasks: number;         // tasks that exhausted retries
  queuedTasks: number;         // currently in queue (waiting for slot)
  activeWorkers: number;       // currently busy workers
  idleWorkers: number;         // currently idle workers
  recycledCount: number;       // total worker recycling events
  preemptedCount: number;      // total hard preemption events
}
```

### Events

```typescript
runtime.on('task:retrying',  ({ task, attempt, maxRetries, error }) => {});
runtime.on('task:settled',   ({ task, result | error }) => {});
runtime.on('task_preempted', ({ worker, task }) => {});
runtime.on('worker_recycled',({ oldId, newId }) => {});
runtime.on('worker_replaced',({ oldId, newId }) => {});
```

---

## `WorkerHandle`

Returned by `runtime.createWorker()`. Provides direct access to a single worker.

```typescript
interface WorkerHandle {
  readonly id: string;
  readonly name?: string;
  readonly affinityKey?: string;
  readonly isDedicated: boolean;

  // Stateful L1 memory access (worker-side Map)
  getState(key: string): Promise<any>;
  setState(key: string, value: any): Promise<void>;
  clearState(): Promise<void>;

  // Direct task execution
  executeTask(task: ExecuteTask): Promise<any>;
  dispatchTask(task: DispatchTask): TaskHandle;

  // Health check
  ping(): Promise<'pong'>;

  // Lifecycle
  terminate(): Promise<void>;
}
```

---

## `TaskQueue`

Lower-level queue abstraction. Exposed for advanced use cases where you need direct queue manipulation. Most users should not need this — go through `WorkerRuntime` instead.

```typescript
class TaskQueue {
  constructor(options?: { maxQueueSize?: number; queueTimeoutMs?: number });

  size: number;                      // currently queued tasks
  waitingCount: number;              // tasks parked in waiters (queue full)

  enqueue(task: TaskHandleLike): Promise<void>;
  dequeue(worker?: { affinityKey?: string; name?: string; isDedicated?: boolean }): TaskHandleLike | null;

  destroy(reason?: Error): void;     // settle all queued + waiting tasks
}
```

---

## `Supervisor`

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

Full TypeScript definitions are published at `node_modules/persistent-worker-runtime/src/index.d.ts`. Import from the package:

```typescript
import type { WorkerRuntime, WorkerHandle, TaskHandle, ExecuteTask, DispatchTask } from 'persistent-worker-runtime';
```
