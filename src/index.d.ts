import { ResourceLimits } from 'node:worker_threads';

export interface WorkerRuntimeOptions {
  /** Number of persistent worker threads in the pool. Defaults to availableParallelism() - 1 */
  workers?: number;
  /** Custom path to the worker thread entry script. */
  workerScript?: string;
  /** Path to a module exporting a custom task handler. */
  handlerPath?: string;
  /** Maximum queue size before applying backpressure. Defaults to 2000 */
  maxQueueSize?: number;
  /** Maximum time (ms) a task waits in queue before rejecting with TaskQueueTimeoutError. Defaults to 30000 */
  queueTimeoutMs?: number;
  /** Resource limits applied to each worker V8 Isolate. */
  resourceLimits?: ResourceLimits;
}

export interface TaskOptions<TPayload = any, TResult = any> {
  id?: string;
  type?: string;
  payload?: TPayload;
  /** Function to execute inside the worker thread. */
  fn?: ((payload: TPayload, state: Map<string, any>) => TResult | Promise<TResult>) | string;
  priority?: number;
  /** Maximum execution duration (ms) before timing out. */
  timeoutMs?: number;
  /** Maximum time (ms) allowed waiting in queue. */
  queueTimeoutMs?: number;
  signal?: AbortSignal;
  affinityKey?: string;
  metadata?: Record<string, any>;
}

export interface RuntimeStats {
  totalWorkers: number;
  idleWorkers: number;
  queueDepth: number;
  waitingQueueCount: number;
  submittedTasks: number;
  completedTasks: number;
  failedTasks: number;
}

export class TaskHandle<TResult = any> {
  readonly id: string;
  readonly type: string;
  readonly payload: any;
  readonly affinityKey: string | null;
  readonly isSettled: boolean;
  readonly promise: Promise<TResult>;
  readonly durationMs: number;

  onComplete(callback: (result: TResult) => void): this;
  onError(callback: (error: Error) => void): this;
}

export class WorkerHandle {
  readonly id: string;
  readonly name: string | null;
  readonly status: 'starting' | 'idle' | 'busy' | 'terminating' | 'terminated';
  readonly isIdle: boolean;
  readonly tasksCompleted: number;

  getState<T = any>(key: string): Promise<T | undefined>;
  setState<T = any>(key: string, value: T): Promise<boolean>;
  clearState(): Promise<boolean>;
  ping(): Promise<'pong'>;
  executeTask<T = any>(task: TaskHandle<T>): Promise<T>;
  terminate(): Promise<void>;
}

export class WorkerRuntime {
  constructor(options?: WorkerRuntimeOptions);

  get stats(): RuntimeStats;

  start(): Promise<this>;
  execute<TResult = any>(task: TaskOptions<any, TResult> | ((payload: any, state: Map<string, any>) => TResult)): Promise<TResult>;
  executeAll<TResult = any>(tasks: Array<TaskOptions<any, TResult> | ((payload: any, state: Map<string, any>) => TResult)>): Promise<TResult[]>;
  executeAllSettled<TResult = any>(tasks: Array<TaskOptions<any, TResult> | ((payload: any, state: Map<string, any>) => TResult)>): Promise<PromiseSettledResult<TResult>[]>;
  dispatch<TResult = any>(task: TaskOptions<any, TResult> | ((payload: any, state: Map<string, any>) => TResult)): TaskHandle<TResult>;
  dispatchAll<TResult = any>(tasks: Array<TaskOptions<any, TResult> | ((payload: any, state: Map<string, any>) => TResult)>): TaskHandle<TResult>[];
  createWorker(options?: { name?: string; affinityKey?: string }): Promise<WorkerHandle>;
  shutdown(): Promise<void>;
}

export function createWorkerRuntime(options?: WorkerRuntimeOptions): Promise<WorkerRuntime>;

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
