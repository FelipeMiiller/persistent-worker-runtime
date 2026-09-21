import { AsyncResource } from 'node:async_hooks';
import { TaskAbortedError, TaskTimeoutError } from './errors.js';

let taskIdSequence = 1;

/**
 * HARDEN-01 (ADR-0024): warn at most once per process when a TaskHandle is
 * built with `forceKillOnTimeout: true` and `timeoutMs === 0`. The symbol is
 * stored on globalThis so the guard survives across module re-imports inside
 * the same process (workers + main thread each get their own globalThis).
 */
const __hardenTimeoutWarningEmitted = Symbol.for(
  'persistent-worker-runtime.__hardenTimeoutWarningEmitted',
);
if (globalThis[__hardenTimeoutWarningEmitted] === undefined) {
  globalThis[__hardenTimeoutWarningEmitted] = false;
}

/**
 * HARDEN-01 default. Five seconds covers 99% of CPU-bound runaway tasks per
 * the ADR-0024 sizing research; users who want long-running tasks set
 * `timeoutMs` explicitly. `0` is preserved as the explicit opt-in to disable
 * preemption.
 */
const DEFAULT_TIMEOUT_MS = 5000;

function warnTimeoutMisconfig() {
  if (globalThis[__hardenTimeoutWarningEmitted]) return;
  globalThis[__hardenTimeoutWarningEmitted] = true;
  process.emitWarning(
    '[hardening] TaskHandle created with forceKillOnTimeout=true but timeoutMs=0 — preemption will NOT fire. Set timeoutMs > 0 or pass silentTimeoutDefaultWarning: true to createWorkerRuntime() to suppress.',
    'PersistentWorkerRuntimeHardeningTimeoutMisconfig',
  );
}

/**
 * Resets the once-per-process HARDEN-01 warning guard. Test-only helper —
 * never called from production code. Use sparingly: callers are responsible
 * for not asserting on warnings emitted by other test cases.
 */
export function __resetHardenTimeoutWarningGuardForTests() {
  globalThis[__hardenTimeoutWarningEmitted] = false;
}

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
    // HARDEN-01 (ADR-0024 A1): default `timeoutMs` to 5000 ms instead of 0.
    // Use explicit `=== undefined` check so the value `0` is preserved as
    // the documented opt-in to disable preemption. The previous `|| 0`
    // pattern silently coerced any falsy value (NaN, '', false) to 0,
    // which masked misconfiguration when forceKillOnTimeout was true.
    this.timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
    this.queueTimeoutMs = options.queueTimeoutMs || 30000;
    this.signal = options.signal || null;
    this.forceKillOnTimeout = Boolean(options.forceKillOnTimeout);
    this.silentTimeoutDefaultWarning = Boolean(options.silentTimeoutDefaultWarning);

    // HARDEN-01: emit one-time warning when preemption is configured but the
    // timeout would never fire. The guard on `silentTimeoutDefaultWarning`
    // is the documented opt-out (set per-TaskHandle here, also propagated
    // from createWorkerRuntime options so users rarely have to set it).
    if (this.forceKillOnTimeout && this.timeoutMs === 0 && !this.silentTimeoutDefaultWarning) {
      warnTimeoutMisconfig();
    }

    const killGracePeriodMs =
      options.killGracePeriodMs === undefined ? 500 : options.killGracePeriodMs;
    if (typeof killGracePeriodMs !== 'number' || Number.isNaN(killGracePeriodMs)) {
      throw new TypeError('killGracePeriodMs must be a non-negative number');
    }
    if (killGracePeriodMs < 0) {
      throw new RangeError('killGracePeriodMs must be a non-negative number');
    }
    this.killGracePeriodMs = killGracePeriodMs;

    this.fnCode =
      options.fnCode || (typeof options.fn === 'function' ? options.fn.toString() : null);
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

    if (this.timeoutMs > 0 && !this.forceKillOnTimeout) {
      this.#executionTimer = setTimeout(() => {
        this.reject(
          new TaskTimeoutError(
            `Task ${this.id} exceeded execution timeout of ${this.timeoutMs}ms`,
            {
              taskId: this.id,
              timeoutMs: this.timeoutMs,
              preempted: false,
            },
          ),
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
          // biome-ignore lint/suspicious/noConsole: legitimate error logging when user callbacks throw
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
          // biome-ignore lint/suspicious/noConsole: legitimate error logging when user callbacks throw
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
