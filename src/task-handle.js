import { AsyncResource } from 'node:async_hooks';
import { TaskAbortedError, TaskTimeoutError } from './errors.js';

let taskIdSequence = 1;

/**
 * Represents a single executable task managed by the Persistent Worker Runtime.
 * Integrated with AsyncResource for APM/OpenTelemetry context propagation.
 */
export class TaskHandle {
  #completeCallbacks = [];
  #errorCallbacks = [];
  #settled = false;
  #executionTimer = null;

  constructor(options = {}) {
    this.id = options.id || `task_${Date.now()}_${taskIdSequence++}`;
    this.type = options.type || 'default';
    this.payload = options.payload ?? null;
    this.affinityKey = options.affinityKey || null;
    this.priority = options.priority || 0;
    this.timeoutMs = options.timeoutMs || 0;
    this.queueTimeoutMs = options.queueTimeoutMs || 30000;
    this.signal = options.signal || null;
    this.fnCode = options.fnCode || (typeof options.fn === 'function' ? options.fn.toString() : null);
    this.transferList = options.transferList || [];
    this.retries = options.retries || 0;
    this.retryDelayMs = options.retryDelayMs || 500;
    this.backoff = options.backoff || 'exponential';
    this.attempts = 0;
    this.metadata = options.metadata || {};

    this.createdAt = performance.now();
    this.startedAt = null;
    this.completedAt = null;
    this.durationMs = 0;

    // Node.js async tracking
    this.asyncResource = new AsyncResource('PersistentWorkerTask', {
      triggerAsyncId: options.triggerAsyncId,
      requireManualDestroy: false,
    });

    this.promise = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });

    // Handle user-provided AbortSignal
    if (this.signal) {
      if (this.signal.aborted) {
        this.reject(new TaskAbortedError('Task aborted before execution', { taskId: this.id }));
      } else {
        this._abortListener = () => {
          this.reject(new TaskAbortedError('Task aborted during execution', { taskId: this.id }));
        };
        this.signal.addEventListener('abort', this._abortListener, { once: true });
      }
    }
  }

  get isSettled() {
    return this.#settled;
  }

  /**
   * Registers an async completion callback (ideal for Outbox/fire-and-confirm patterns).
   * @param {Function} callback (result) => void
   * @returns {TaskHandle} this
   */
  onComplete(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Callback must be a function');
    }
    if (this.#settled && this._result !== undefined) {
      queueMicrotask(() => this.asyncResource.runInAsyncScope(callback, null, this._result));
    } else {
      this.#completeCallbacks.push(callback);
    }
    return this;
  }

  /**
   * Registers an async error callback.
   * @param {Function} callback (error) => void
   * @returns {TaskHandle} this
   */
  onError(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Callback must be a function');
    }
    if (this.#settled && this._error !== undefined) {
      queueMicrotask(() => this.asyncResource.runInAsyncScope(callback, null, this._error));
    } else {
      this.#errorCallbacks.push(callback);
    }
    return this;
  }

  /**
   * Marks the task as started on a worker thread.
   */
  markStarted() {
    this.startedAt = performance.now();

    if (this.timeoutMs > 0) {
      this.#executionTimer = setTimeout(() => {
        this.reject(
          new TaskTimeoutError(`Task ${this.id} exceeded execution timeout of ${this.timeoutMs}ms`, {
            taskId: this.id,
            timeoutMs: this.timeoutMs,
          })
        );
      }, this.timeoutMs);
    }
  }

  /**
   * Resolves the task with the worker result.
   */
  resolve(result) {
    if (this.#settled) return;
    this.#settled = true;
    this.#cleanupTimers();

    this.completedAt = performance.now();
    this.durationMs = this.startedAt ? this.completedAt - this.startedAt : 0;
    this._result = result;

    this.asyncResource.runInAsyncScope(() => {
      this._resolve(result);
      for (const cb of this.#completeCallbacks) {
        try {
          cb(result);
        } catch (err) {
          console.error(`Unhandled error in TaskHandle ${this.id} onComplete:`, err);
        }
      }
    });
  }

  /**
   * Rejects the task with an error.
   */
  reject(error) {
    if (this.#settled) return;
    this.#settled = true;
    this.#cleanupTimers();

    this.completedAt = performance.now();
    this.durationMs = this.startedAt ? this.completedAt - this.startedAt : 0;
    this._error = error;

    this.asyncResource.runInAsyncScope(() => {
      this._reject(error);
      for (const cb of this.#errorCallbacks) {
        try {
          cb(error);
        } catch (err) {
          console.error(`Unhandled error in TaskHandle ${this.id} onError:`, err);
        }
      }
    });
  }

  #cleanupTimers() {
    if (this.#executionTimer) {
      clearTimeout(this.#executionTimer);
      this.#executionTimer = null;
    }
    if (this.signal && this._abortListener) {
      this.signal.removeEventListener('abort', this._abortListener);
    }
  }
}
