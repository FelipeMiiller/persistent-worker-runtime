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
    this.workerId = options.workerId || null;
    this.preempted = Boolean(options.preempted);
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

/**
 * StreamAbortedError — raised when a streaming task is aborted by the
 * consumer (stream.return()), by an AbortSignal, or by runtime.shutdown().
 * Inherits from WorkerRuntimeError so callers can catch the broad runtime
 * family and still inspect the dedicated code (ERR_STREAM_ABORTED).
 *
 * @see ADR-0012 / .specs/features/streaming-results/spec.md
 */
export class StreamAbortedError extends WorkerRuntimeError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code || 'ERR_STREAM_ABORTED' });
    this.taskId = options.taskId;
    this.reason = options.reason;
  }
}

/**
 * StreamConfigError — TypeError raised when `runtime.stream()` is called
 * with invalid configuration (e.g. taskFn is neither an
 * AsyncGeneratorFunction nor a GeneratorFunction, or `highWaterMark` is
 * non-positive). Inherits from TypeError so callers can branch on
 * `err instanceof TypeError` for invalid-argument checks.
 *
 * @see ADR-0012 / .specs/features/streaming-results/spec.md
 */
export class StreamConfigError extends TypeError {
  constructor(message, options = {}) {
    super(message, { cause: options?.cause });
    this.name = 'StreamConfigError';
  }
}
