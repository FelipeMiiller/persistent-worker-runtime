import { ResourceLimits } from 'node:worker_threads';
import { EventEmitter } from 'node:events';

/**
 * Snapshot of one worker's state at the time of `runtime.getWorkers()` call.
 */
export interface WorkerSnapshot {
  id: string;
  status: 'starting' | 'idle' | 'busy' | 'recycling' | 'preempting' | 'terminating' | 'terminated';
  tasksCompleted: number;
  tasksActive: number;
  lastMemoryUsageBytes: number;
  lastTaskAt: number | null;
  affinityKey: string | null;
  isDedicated: boolean;
}

/**
 * Per-worker memory usage event payload (emitted at most once per
 * `memoryEmitIntervalMs` per worker; requires `observeWorkerMemory: true`).
 */
export interface WorkerMemoryEvent {
  workerId: string;
  memoryUsageBytes: number;
  atMs: number;
}

/**
 * Aggregate counters for the worker pool block of `runtime.stats`.
 */
export interface WorkersStatsAggregate {
  total: number;
  idle: number;
  busy: number;
  recycling: number;
  terminating: number;
  byStatus: Record<string, number>;
  totalMemoryBytes: number;
}

/**
 * Live snapshot of the adaptive concurrency controller's telemetry.
 * Present when the controller is enabled (default behaviour on
 * >4-core hosts when `workers` is not explicit).
 */
export interface AdaptiveControllerStats {
  enabled: boolean;
  effectiveWorkers: number;
  minWorkers: number;
  maxWorkers: number;
  elu: number | null;
  latencyP99Ms: number | null;
  lastResizeReason: 'grow' | 'shrink-from-busy' | 'shrink-from-idle' | 'hold' | null;
  lastResizeAt: number | null;
  ticksSinceResize: number;
  totalGrowEvents: number;
  totalShrinkEvents: number;
}

/**
 * Live runtime metrics snapshot.
 */
export interface RuntimeStats {
  totalWorkers: number;
  idleWorkers: number;
  queueDepth: number;
  waitingQueueCount: number;
  submittedTasks: number;
  completedTasks: number;
  failedTasks: number;
  recycledWorkersCount: number;
  preemptedTasksCount: number;
  /** Aggregate counter block for the worker pool (HARDEN-04). */
  workers: WorkersStatsAggregate;
  /** Adaptive controller telemetry block (ADR-0014). `undefined` when disabled. */
  adaptive?: AdaptiveControllerStats;
  activeStreams: number;
  pendingStreams: number;
}

/**
 * Configuration options for initializing a WorkerRuntime.
 */
export interface WorkerRuntimeOptions {
  /**
   * Fixed number of persistent worker threads in the pool.
   * Defaults to 1 on hosts >4 cores (with a one-time
   * `PersistentWorkerRuntimeDefaultSizing` warning); the previous
   * `availableParallelism() - 1` heuristic is now opt-in via
   * `concurrency: 'auto'` (ADR-0019 + ADR-0023).
   */
  workers?: number;

  /**
   * Sizing policy for the worker pool.
   * - `'adaptive'` (default when `workers` is not explicit on >4-core hosts):
   *   pool size is dynamically tuned by the dual-signal ELU +
   *   `monitorEventLoopDelay` controller (ADR-0014). Band `[minWorkers, maxWorkers]`.
   * - `'fixed'`: pool stays at the explicit `workers` value; controller stays disabled.
   * - `'auto'`: pool starts at `availableParallelism() - 1` and is still
   *   resized by the controller within `[minWorkers, maxWorkers]`.
   */
  concurrency?: 'adaptive' | 'fixed' | 'auto';

  /**
   * Maximum number of tasks a worker thread executes before graceful recycling.
   * Defaults to Infinity. Set to a positive integer to recycle periodically
   * and avoid V8 heap fragmentation.
   */
  maxTasksPerWorker?: number;

  /**
   * Maximum V8 heap memory (MB) allowed before graceful worker recycling is triggered.
   * Defaults to Infinity.
   */
  maxMemoryMb?: number;

  /**
   * HARDEN-06 (ADR-0024): recycle workers whose memory growth rate (EWMA,
   * MB/s) exceeds this threshold BEFORE the absolute `maxMemoryMb` ceiling.
   * Useful for catching monotonic-growth leaks early on long-lived workers.
   * Defaults to `Infinity` (disabled). Set to e.g. `50` to recycle workers
   * growing >50 MB/s.
   */
  accumulationRateMbPerSec?: number;

  /**
   * HARDEN-07 (ADR-0024): hysteresis window (ms) that suppresses follow-up
   * recycles for the same worker. Mitigates spurious recycles on transient
   * bursts. Defaults to `0` (disabled — every recycle reason fires).
   */
  minRecycleIntervalMs?: number;

  /**
   * HARDEN-08 (ADR-0024): when `false`, the supervisor emits a
   * `worker_tasks:exhausted` warning event instead of recycling workers
   * that exceed `maxTasksPerWorker`. The user keeps full control over
   * when to drain + recycle. Defaults to `true`.
   */
  recycleOnTasksExhausted?: boolean;

  /**
   * HARDEN-09 (ADR-0024): worker selection strategy. Defaults to `'lru'`
   * (round-robin by last-touched). Set to `'fifo'` to preserve the
   * pre-v0.2.0 determinism contract (workers always pick `workers[0]` first).
   */
  dispatchStrategy?: 'fifo' | 'lru' | 'random';

  /**
   * HARDEN-10 (ADR-0024): supervisor watchdog poll cadence (ms). Independent
   * from `task.timeoutMs` — a tighter poll lets the runtime detect runaway
   * workers faster without shortening the per-task budget. Clamp min 100 ms,
   * default 1000 ms.
   */
  workerPollIntervalMs?: number;

  /**
   * HARDEN-11 (ADR-0024): drain-grace window (ms) between worker recycle
   * decision and physical termination. The recycled worker stays in
   * `runtime.getWorkers()` (status `'recycling'`) for this long while the
   * replacement is already serving tasks. Pool capacity is temporarily N+1,
   * drops back to N when the timer fires. Defaults to `0` (immediate).
   */
  recycleBackoffMs?: number;

  /**
   * HARDEN-05 (ADR-0024): when `true`, the runtime emits a `worker:memory`
   * event per worker at the configured cadence. Defaults to `false`
   * (no overhead on hot path).
   */
  observeWorkerMemory?: boolean;

  /**
   * HARDEN-05 (ADR-0024): ms between consecutive `worker:memory` emissions
   * per worker. Defaults to `1000`. Requires `observeWorkerMemory: true`.
   */
  memoryEmitIntervalMs?: number;

  /**
   * Lower bound for the adaptive concurrency controller's resize band.
   * Defaults to `1`. Honoured only when adaptive is enabled (no explicit
   * `workers: N` and no `concurrency: 'fixed'`); otherwise the pool stays
   * pinned to the explicit size.
   */
  minWorkers?: number;

  /**
   * Upper bound for the adaptive concurrency controller's resize band.
   * Defaults to `availableParallelism()`. Honoured only when adaptive is
   * enabled (no explicit `workers: N` and no `concurrency: 'fixed'`).
   */
  maxWorkers?: number;

  /**
   * Idle time (ms) before surplus workers are terminated down to minWorkers.
   * Defaults to 15000ms.
   */
  idleTimeoutMs?: number;

  /**
   * Custom absolute path to the worker thread script.
   */
  workerScript?: string;

  /**
   * Path to an ECMAScript module exporting a custom task handler.
   */
  handlerPath?: string;

  /**
   * Maximum queue depth before non-blocking backpressure is applied.
   * Defaults to 2000.
   */
  maxQueueSize?: number;

  /**
   * Maximum duration (ms) a task can wait in queue before rejecting with TaskQueueTimeoutError.
   * Defaults to 30000ms.
   */
  queueTimeoutMs?: number;

  /**
   * HARDEN-01 (ADR-0024): default per-task timeout (ms) when caller does not
   * specify `timeoutMs` on a task. Defaults to `5000`. A one-time
   * `PersistentWorkerRuntimeTimeoutMsDefault` process warning fires if the
   * caller never sets an explicit `timeoutMs`.
   */
  timeoutMs?: number;

  /**
   * Whether to forcibly terminate the worker thread on execution timeout via worker.terminate().
   * Defaults to false.
   */
  forceKillOnTimeout?: boolean;

  /**
   * Override for the adaptive controller's shrink ELU threshold.
   * Pass-through to the controller (ADR-0014). Leave unset for production.
   */
  shrinkEluThreshold?: number;

  /**
   * Override for the adaptive controller's shrink latency p99 threshold (ms).
   * Pass-through to the controller. Leave unset for production.
   */
  shrinkLatencyP99Ms?: number;

  /**
   * Override for the adaptive controller's grow ELU threshold.
   * Pass-through to the controller. Leave unset for production.
   */
  growEluThreshold?: number;

  /**
   * Override for the adaptive controller's grow latency p99 threshold (ms).
   * Pass-through to the controller. Leave unset for production.
   */
  growLatencyP99Ms?: number;

  /**
   * Override for the adaptive controller's EWMA smoothing factor.
   * Pass-through to the controller. Leave unset for production.
   */
  ewmaAlpha?: number;

  /**
   * Override for the adaptive controller's debounce window (consecutive ticks).
   * Pass-through to the controller. Leave unset for production.
   */
  debounceTicks?: number;

  /**
   * Grace period (ms) to allow cooperative cancellation before hard thread termination.
   * Defaults to 500ms.
   */
  killGracePeriodMs?: number;

  /**
   * V8 memory and stack resource limits applied to each worker isolate.
   */
  resourceLimits?: ResourceLimits;
}

/**
 * Configuration options for submitting a single task to the runtime.
 */
export interface TaskOptions<TPayload = any, TResult = any> {
  /**
   * Unique identifier for this task. Generated automatically if omitted.
   */
  id?: string;

  /**
   * Task type identifier (used to route to custom handlers or logging).
   */
  type?: string;

  /**
   * Input payload sent to the worker thread via structured cloning.
   */
  payload?: TPayload;

  /**
   * Function to execute inside the worker thread isolate.
   */
  fn?: ((payload: TPayload, state: Map<string, any>) => TResult | Promise<TResult>) | string;

  /**
   * Task priority. Higher numbers are dequeued first.
   * Defaults to 0.
   */
  priority?: number;

  /**
   * Maximum execution duration (ms) allowed before rejecting with TaskTimeoutError.
   * 0 means unlimited. Defaults to 0.
   */
  timeoutMs?: number;

  /**
   * Whether to forcibly terminate the worker thread on execution timeout.
   * Defaults to the runtime-level configuration (false).
   */
  forceKillOnTimeout?: boolean;

  /**
   * Grace period (ms) before hard kill is executed.
   * Defaults to the runtime-level configuration (500ms).
   */
  killGracePeriodMs?: number;

  /**
   * Maximum queue wait duration (ms) before rejecting with TaskQueueTimeoutError.
   * Defaults to 30000ms.
   */
  queueTimeoutMs?: number;

  /**
   * AbortSignal for cooperative or immediate cancellation.
   */
  signal?: AbortSignal;

  /**
   * Routing key for worker affinity. Tasks with the same key route to the same worker.
   */
  affinityKey?: string;

  /**
   * List of ArrayBuffer objects to transfer ownership of without copying.
   */
  transferList?: ArrayBuffer[];

  /**
   * Number of automatic retry attempts upon failure.
   * Defaults to 0.
   */
  retries?: number;

  /**
   * Base delay (ms) between retry attempts.
   * Defaults to 500ms.
   */
  retryDelayMs?: number;

  /**
   * Backoff strategy between retries.
   * Defaults to 'exponential'.
   */
  backoff?: 'exponential' | 'linear' | 'fixed';

  /**
   * Custom application metadata attached to this task (e.g. outboxId, traceId).
   */
  metadata?: Record<string, any>;
}

/**
 * Live runtime metrics snapshot.
 */
export interface RuntimeStats {
  totalWorkers: number;
  idleWorkers: number;
  queueDepth: number;
  waitingQueueCount: number;
  submittedTasks: number;
  completedTasks: number;
  failedTasks: number;
  recycledWorkersCount: number;
  preemptedTasksCount: number;
  /** Aggregate counter block for the worker pool (HARDEN-04). */
  workers: WorkersStatsAggregate;
  /** Adaptive controller telemetry block (ADR-0014). `undefined` when disabled. */
  adaptive?: AdaptiveControllerStats;
  activeStreams: number;
  pendingStreams: number;
}

/**
 * Event payload emitted when a persistent worker begins graceful recycling.
 */
export interface WorkerRecyclingEvent {
  workerId: string;
  reason: 'tasks_exceeded' | 'memory_exceeded' | string;
  tasksCompleted: number;
  memoryUsage: number;
}

/**
 * Event payload emitted when a retired worker terminates and its replacement is active.
 */
export interface WorkerRecycledEvent {
  oldWorkerId: string;
  newWorkerId: string;
}

/**
 * Event payload emitted when a task is forcibly preempted due to timeout.
 */
export interface TaskPreemptedEvent {
  workerId: string;
  taskId: string;
  timeoutMs: number;
  preempted: boolean;
}

/**
 * Event payload emitted when a preempted worker terminates.
 */
export interface WorkerPreemptedEvent {
  workerId: string;
  exitCode?: number;
}

/**
 * Handle representing a task submitted to the Persistent Worker Runtime.
 */
export class TaskHandle<TResult = any> {
  readonly id: string;
  readonly type: string;
  readonly payload: any;
  readonly affinityKey: string | null;
  readonly isSettled: boolean;
  readonly promise: Promise<TResult>;
  readonly durationMs: number;
  readonly attempts: number;

  /**
   * Registers a non-blocking completion callback.
   * Essential for Transactional Outbox updates and fire-and-track tasks.
   *
   * @example
   * task.onComplete(async (result) => {
   *   await db.outbox.update(outboxId, { status: 'COMPLETED', result });
   * });
   */
  onComplete(callback: (result: TResult) => void | Promise<void>): this;

  /**
   * Registers a non-blocking error callback.
   *
   * @example
   * task.onError(async (err) => {
   *   await db.outbox.update(outboxId, { status: 'FAILED', error: err.message });
   * });
   */
  onError(callback: (error: Error) => void | Promise<void>): this;
}

/**
 * Handle to a dedicated persistent worker with warm L1 private memory.
 */
export class WorkerHandle {
  readonly id: string;
  readonly name: string | null;
  readonly affinityKey: string | null;
  readonly status: 'starting' | 'idle' | 'busy' | 'recycling' | 'preempting' | 'terminating' | 'terminated';
  readonly isIdle: boolean;
  readonly isRecycling: boolean;
  readonly isPreempted: boolean;
  readonly tasksCompleted: number;
  readonly lastMemoryUsageBytes: number;
  readonly lastMemoryUsage: number;

  /**
   * Marks this worker as recycling to prevent new task assignments.
   */
  markRecycling(): void;

  /**
   * Gets a value from the worker's private L1 in-memory heap.
   */
  getState<T = any>(key: string): Promise<T | undefined>;

  /**
   * Stores a value in the worker's private L1 in-memory heap.
   */
  setState<T = any>(key: string, value: T): Promise<boolean>;

  /**
   * Clears the worker's private L1 in-memory heap.
   */
  clearState(): Promise<boolean>;

  /**
   * Health check ping to verify worker thread responsiveness.
   */
  ping(): Promise<'pong'>;

  /**
   * Executes a task specifically on this dedicated worker instance.
   */
  executeTask<T = any>(task: TaskHandle<T>): Promise<T>;

  /**
   * Gracefully terminates this worker thread.
   */
  terminate(): Promise<void>;
}

/**
 * Persistent Worker Runtime orchestrator.
 */
export class WorkerRuntime extends EventEmitter {
  constructor(options?: WorkerRuntimeOptions);

  get maxTasksPerWorker(): number;
  get maxMemoryMb(): number;
  get forceKillOnTimeout(): boolean;
  get killGracePeriodMs(): number;
  /** HARDEN-11: drain-grace window in ms. `0` (default) means no grace. */
  get recycleBackoffMs(): number;
  /** HARDEN-10: supervisor watchdog poll cadence in ms. Default 1000. */
  get workerPollIntervalMs(): number;
  /** HARDEN-06: rate-based recycling threshold in MB/s. `Infinity` = disabled. */
  get accumulationRateMbPerSec(): number;
  /** HARDEN-07: hysteresis window in ms. `0` = disabled. */
  get minRecycleIntervalMs(): number;
  /** HARDEN-08: whether to recycle on `maxTasksPerWorker`. Default `true`. */
  get recycleOnTasksExhausted(): boolean;
  /** HARDEN-09: dispatch strategy. Default `'lru'`. */
  get dispatchStrategy(): 'fifo' | 'lru' | 'random';
  /** HARDEN-05: whether `worker:memory` events are emitted. Default `false`. */
  get observeWorkerMemory(): boolean;
  /** HARDEN-05: ms between `worker:memory` events per worker. Default 1000. */
  get memoryEmitIntervalMs(): number;
  /** HARDEN-01: default per-task timeout. Default 5000. */
  get timeoutMs(): number;
  /** True when the adaptive concurrency controller is wired in. */
  get adaptiveEnabled(): boolean;
  /** True when the runtime is shutting down. */
  get isShuttingDown(): boolean;

  /**
   * Current real-time metrics of the worker pool and task queue.
   */
  get stats(): RuntimeStats;

  on(event: 'worker_recycling' | 'worker:recycling', listener: (data: WorkerRecyclingEvent) => void): this;
  on(event: 'worker_recycled' | 'worker:recycled', listener: (data: WorkerRecycledEvent) => void): this;
  on(event: 'worker_preempted' | 'worker:preempted', listener: (data: WorkerPreemptedEvent) => void): this;
  on(event: 'worker:ready', listener: (data: { workerId: string }) => void): this;
  on(event: 'worker:replaced', listener: (data: { oldId: string; newId: string }) => void): this;
  on(event: 'worker:memory', listener: (data: WorkerMemoryEvent) => void): this;
  on(event: 'worker_tasks:exhausted', listener: (data: { workerId: string; tasksCompleted: number }) => void): this;
  on(event: 'worker:retiring', listener: (data: { workerId: string; reason: 'drain' }) => void): this;
  on(event: 'task_preempted' | 'task:preempted', listener: (data: TaskPreemptedEvent) => void): this;
  on(event: 'task:completed', listener: (data: { taskId: string; type: string; durationMs: number; result: any }) => void): this;
  on(event: 'task:failed', listener: (data: { taskId: string; type: string; durationMs: number; attempts: number; error: Error }) => void): this;
  on(event: 'task:retrying', listener: (data: { taskId: string; attempt: number; maxRetries: number; delayMs: number; error: Error }) => void): this;
  on(event: 'stream:created', listener: (data: { taskId: string }) => void): this;
  on(event: 'stream:chunk', listener: (data: { taskId: string; seq: number }) => void): this;
  on(event: 'stream:end', listener: (data: { taskId: string; totalChunks: number; returnValue: any }) => void): this;
  on(event: 'stream:aborted', listener: (data: { taskId: string; reason: string }) => void): this;
  on(event: 'stream:backpressure', listener: (data: { taskId: string; state: 'paused' | 'resumed'; queueLength: number }) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;

  /**
   * Starts the runtime and warms up persistent worker threads.
   */
  start(): Promise<this>;

  /**
   * HARDEN-03 (ADR-0024): synchronous snapshot of the worker pool. Returns
   * a fresh array each call — callers may mutate without affecting state.
   */
  getWorkers(): WorkerSnapshot[];

  /**
   * Forces an immediate recycle-check for a specific worker, bypassing the
   * normal `task_completed` / poll trigger. Useful for operators who want
   * to drain a worker before a rolling deploy.
   * Returns `false` if the worker is not in the pool.
   */
  recycleWorker(workerId: string): boolean;

  /**
   * Executes a CPU-bound or blocking task off-thread, returning a Promise with the result.
   *
   * @example
   * const result = await runtime.execute({
   *   type: 'heavy_compute',
   *   payload: { value: 42 },
   *   fn: (p) => p.value * 2
   * });
   */
  execute<TPayload = any, TResult = any>(
    task: TaskOptions<TPayload, TResult> | ((payload: TPayload, state: Map<string, any>) => TResult | Promise<TResult>)
  ): Promise<TResult>;

  /**
   * Executes multiple tasks in parallel with bounded worker concurrency (Promise.all semantics).
   *
   * @example
   * const [invoice, receipt] = await runtime.executeAll([
   *   { type: 'invoice', payload: order, fn: (p) => makeInvoice(p) },
   *   { type: 'receipt', payload: order, fn: (p) => makeReceipt(p) },
   * ]);
   */
  executeAll<TPayload = any, TResult = any>(
    tasks: Array<TaskOptions<TPayload, TResult> | ((payload: TPayload, state: Map<string, any>) => TResult | Promise<TResult>)>
  ): Promise<TResult[]>;

  /**
   * Executes multiple tasks with Promise.allSettled semantics, bounded by worker pool capacity.
   */
  executeAllSettled<TPayload = any, TResult = any>(
    tasks: Array<TaskOptions<TPayload, TResult> | ((payload: TPayload, state: Map<string, any>) => TResult | Promise<TResult>)>
  ): Promise<PromiseSettledResult<TResult>[]>;

  /**
   * Dispatches a background task without awaiting execution (Transactional Outbox pattern).
   * Returns a TaskHandle immediately so the caller can return fast HTTP responses.
   *
   * @example
   * const task = runtime.dispatch({
   *   type: 'send_email',
   *   payload: { email: 'user@example.com' },
   *   fn: (p) => sendMail(p.email),
   * });
   * task.onComplete((res) => console.log('Sent!'));
   */
  dispatch<TPayload = any, TResult = any>(
    task: TaskOptions<TPayload, TResult> | ((payload: TPayload, state: Map<string, any>) => TResult | Promise<TResult>)
  ): TaskHandle<TResult>;

  /**
   * Dispatches multiple tasks for asynchronous background execution.
   */
  dispatchAll<TPayload = any, TResult = any>(
    tasks: Array<TaskOptions<TPayload, TResult> | ((payload: TPayload, state: Map<string, any>) => TResult | Promise<TResult>)>
  ): TaskHandle<TResult>[];

  /**
   * Spawns a dedicated worker handle with private persistent L1 heap memory.
   *
   * @example
   * const worker = await runtime.createWorker({ name: 'ai-engine' });
   * await worker.setState('model', loadedWeights);
   */
  createWorker(options?: { name?: string; affinityKey?: string }): Promise<WorkerHandle>;

  /**
   * ADR-0012: streams task results from an async generator worker function.
   * Returns a `Stream` whose `for await (const chunk of stream)` consumes
   * the generator's yields one at a time with backpressure.
   */
  stream<TPayload = any, TChunk = any, TReturn = any>(
    taskFn: AsyncGeneratorFunction | GeneratorFunction,
    payload?: TPayload,
    options?: {
      signal?: AbortSignal;
      highWaterMark?: number;
    }
  ): Stream<TChunk, TReturn>;

  /**
   * ADR-0013: publishes a message on a named BroadcastChannel from the main
   * thread to all subscribed workers. Returns immediately — does not wait
   * for consumer processing.
   */
  broadcast(channel: string, message: any): void;

  /**
   * ADR-0013: subscribes to a named BroadcastChannel on the main thread.
   * Returns an idempotent unsubscribe function.
   */
  subscribe<T = any>(channel: string, handler: (message: T) => void): () => boolean;

  /**
   * ADR-0013: removes a previously subscribed handler from a channel.
   * Returns `true` if the handler was removed, `false` otherwise.
   */
  unsubscribe<T = any>(channel: string, handler: (message: T) => void): boolean;

  /**
   * ADR-0013: returns `true` if at least one handler is currently subscribed
   * to the named channel.
   */
  hasSubscribers(channel: string): boolean;

  /**
   * Gracefully drains the queue and terminates all worker threads.
   */
  shutdown(): Promise<void>;
}

/**
 * Async-iterable result stream returned by `runtime.stream()`.
 * Implements `Symbol.asyncIterator` for `for await ... of` consumption.
 */
export class Stream<TChunk = any, TReturn = any> implements AsyncIterable<TChunk> {
  /** Total chunks pushed (incremented per push, even before consumption). */
  readonly totalChunks: number;
  /** `true` after `pushEnd()` or `pushError()`. */
  readonly endReceived: boolean;
  /** `true` after `pushError()`. */
  readonly errorReceived: boolean;
  /** `true` once the underlying channel has been aborted. */
  readonly aborted: boolean;
  /** Reason for the abort, or `null` if not aborted. */
  readonly abortedReason: string | null;

  /** Generator return value (set after `pushEnd()`). */
  readonly returnValue: TReturn | null;

  [Symbol.asyncIterator](): AsyncIterator<TChunk>;

  /** Closes the consumer side and aborts the worker generator. */
  return(value?: any): Promise<IteratorResult<TChunk>>;
  /** Aborts and propagates an error into the worker generator. */
  throw(err?: any): Promise<IteratorResult<TChunk>>;

  on(event: 'stream:aborted', listener: (data: { reason: string }) => void): this;
  on(event: 'stream:backpressure', listener: (data: { state: 'paused' | 'resumed'; queueLength: number }) => void): this;
  on(event: 'stream:chunk', listener: (data: { seq: number }) => void): this;
  on(event: 'stream:end', listener: (data: { totalChunks: number; returnValue: TReturn }) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
}

/**
 * Creates and initializes a new WorkerRuntime instance.
 *
 * @example
 * import { createWorkerRuntime } from 'persistent-worker-runtime';
 * const runtime = await createWorkerRuntime({ workers: 4 });
 */
export function createWorkerRuntime(options?: WorkerRuntimeOptions): Promise<WorkerRuntime>;

/**
 * Supervisor monitors worker lifecycles, detects crashes, and maintains pool capacity automatically.
 */
export class Supervisor extends EventEmitter {
  constructor(options?: {
    workers?: number;
    workerScript?: string;
    handlerPath?: string;
    resourceLimits?: ResourceLimits;
    maxTasksPerWorker?: number;
    maxMemoryMb?: number;
    forceKillOnTimeout?: boolean;
    killGracePeriodMs?: number;
  });

  get maxTasksPerWorker(): number;
  get maxMemoryMb(): number;
  get forceKillOnTimeout(): boolean;
  get killGracePeriodMs(): number;
  get recycledCount(): number;
  get preemptedCount(): number;
  get totalWorkers(): number;
  get idleWorkers(): WorkerHandle[];
  get allWorkers(): WorkerHandle[];

  start(): Promise<void>;
  findWorkerForTask(task: any): WorkerHandle | null;
  createDedicatedWorker(options?: any): Promise<WorkerHandle>;
  shutdown(): Promise<void>;
}

// Error Hierarchy
export class WorkerRuntimeError extends Error {
  code: string;
}
export class WorkerCrashError extends WorkerRuntimeError {
  workerId: string;
  exitCode?: number;
}
export class TaskQueueTimeoutError extends WorkerRuntimeError {
  taskId: string;
  waitedMs: number;
  queueDepth: number;
}
export class TaskTimeoutError extends WorkerRuntimeError {
  taskId: string;
  timeoutMs: number;
  preempted: boolean;
  workerId: string | null;
}
export class TaskAbortedError extends WorkerRuntimeError {
  taskId: string;
}
export class QueueOverflowError extends WorkerRuntimeError {
  maxQueueSize: number;
}
