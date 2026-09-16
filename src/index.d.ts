import { ResourceLimits } from 'node:worker_threads';

/**
 * Configuration options for initializing a WorkerRuntime.
 */
export interface WorkerRuntimeOptions {
  /**
   * Fixed number of persistent worker threads in the pool.
   * Defaults to availableParallelism() - 1.
   */
  workers?: number;

  /**
   * Minimum number of worker threads kept alive in the elastic pool.
   */
  minWorkers?: number;

  /**
   * Maximum number of worker threads allowed during burst periods.
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
  readonly status: 'starting' | 'idle' | 'busy' | 'terminating' | 'terminated';
  readonly isIdle: boolean;
  readonly tasksCompleted: number;

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
export class WorkerRuntime {
  constructor(options?: WorkerRuntimeOptions);

  /**
   * Current real-time metrics of the worker pool and task queue.
   */
  get stats(): RuntimeStats;

  /**
   * Starts the runtime and warms up persistent worker threads.
   */
  start(): Promise<this>;

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
   * Gracefully drains the queue and terminates all worker threads.
   */
  shutdown(): Promise<void>;
}

/**
 * Creates and initializes a new WorkerRuntime instance.
 *
 * @example
 * import { createWorkerRuntime } from 'persistent-worker-runtime';
 * const runtime = await createWorkerRuntime({ workers: 4 });
 */
export function createWorkerRuntime(options?: WorkerRuntimeOptions): Promise<WorkerRuntime>;

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
}
export class TaskAbortedError extends WorkerRuntimeError {
  taskId: string;
}
export class QueueOverflowError extends WorkerRuntimeError {
  maxQueueSize: number;
}
