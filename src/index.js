/**
 * Persistent Worker Runtime for Node.js
 *
 * "The Event Loop coordinates. Persistent Workers execute."
 */

export { WorkerRuntime, createWorkerRuntime } from './worker-runtime.js';
export { TaskHandle } from './task-handle.js';
export { TaskQueue } from './task-queue.js';
export { WorkerHandle } from './worker-handle.js';
export { Supervisor } from './supervisor.js';

export {
  WorkerRuntimeError,
  WorkerCrashError,
  TaskQueueTimeoutError,
  TaskTimeoutError,
  TaskAbortedError,
  QueueOverflowError,
} from './errors.js';
