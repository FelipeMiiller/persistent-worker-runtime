/**
 * Custom error hierarchy for Persistent Worker Runtime
 */

export class WorkerRuntimeError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = this.constructor.name;
    this.code = options.code || 'ERR_WORKER_RUNTIME';
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

export class WorkerCrashError extends WorkerRuntimeError {
  constructor(message, options = {}) {
    super(message, { ...options, code: 'ERR_WORKER_CRASHED' });
    this.workerId = options.workerId;
    this.exitCode = options.exitCode;
  }
}

export class TaskQueueTimeoutError extends WorkerRuntimeError {
  constructor(message, options = {}) {
    super(message, { ...options, code: 'ERR_TASK_QUEUE_TIMEOUT' });
    this.taskId = options.taskId;
    this.waitedMs = options.waitedMs;
    this.queueDepth = options.queueDepth;
  }
}

export class TaskTimeoutError extends WorkerRuntimeError {
  constructor(message, options = {}) {
    super(message, { ...options, code: 'ERR_TASK_TIMEOUT' });
    this.taskId = options.taskId;
    this.timeoutMs = options.timeoutMs;
  }
}

export class TaskAbortedError extends WorkerRuntimeError {
  constructor(message = 'Task was aborted by caller', options = {}) {
    super(message, { ...options, code: 'ERR_TASK_ABORTED' });
    this.taskId = options.taskId;
  }
}

export class QueueOverflowError extends WorkerRuntimeError {
  constructor(message, options = {}) {
    super(message, { ...options, code: 'ERR_QUEUE_OVERFLOW' });
    this.maxQueueSize = options.maxQueueSize;
  }
}
