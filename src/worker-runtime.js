import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { availableParallelism } from 'node:os';
import { ChannelRegistry } from './broadcast-channel.js';
import { StreamConfigError, WorkerRuntimeError } from './errors.js';
import { isGeneratorFunction } from './stream-runner.js';
import { Stream } from './streaming.js';
import { Supervisor } from './supervisor.js';
import { TaskHandle } from './task-handle.js';
import { TaskQueue } from './task-queue.js';
import { WorkerHandle } from './worker-handle.js';

/**
 * WorkerRuntime is the primary concurrency engine.
 * Coordinates execution between the Event Loop and persistent worker threads.
 */
export class WorkerRuntime extends EventEmitter {
  #queue;
  #supervisor;
  #isStarted = false;
  #isShuttingDown = false;
  #maxTasksPerWorker;
  #maxMemoryMb;
  #forceKillOnTimeout;
  #killGracePeriodMs;
  /** @type {Map<string, {stream: Stream, worker: import('./worker-handle.js').WorkerHandle}>} */
  #activeStreams = new Map();
  /** Main-thread BroadcastChannel registry. Workers have their own. */
  #channelRegistry = new ChannelRegistry();
  #stats = {
    submittedTasks: 0,
    completedTasks: 0,
    failedTasks: 0,
    preemptedTasksCount: 0,
  };

  constructor(options = {}) {
    super();

    const maxTasksPerWorker =
      options.maxTasksPerWorker === undefined ? Infinity : options.maxTasksPerWorker;
    if (typeof maxTasksPerWorker !== 'number' || Number.isNaN(maxTasksPerWorker)) {
      throw new TypeError('maxTasksPerWorker must be a positive number or Infinity');
    }
    if (maxTasksPerWorker <= 0) {
      throw new RangeError('maxTasksPerWorker must be greater than 0');
    }

    const maxMemoryMb = options.maxMemoryMb === undefined ? Infinity : options.maxMemoryMb;
    if (typeof maxMemoryMb !== 'number' || Number.isNaN(maxMemoryMb)) {
      throw new TypeError('maxMemoryMb must be a positive number or Infinity');
    }
    if (maxMemoryMb <= 0) {
      throw new RangeError('maxMemoryMb must be greater than 0');
    }

    const forceKillOnTimeout = Boolean(options.forceKillOnTimeout);
    const killGracePeriodMs =
      options.killGracePeriodMs === undefined ? 500 : options.killGracePeriodMs;
    if (typeof killGracePeriodMs !== 'number' || Number.isNaN(killGracePeriodMs)) {
      throw new TypeError('killGracePeriodMs must be a non-negative number');
    }
    if (killGracePeriodMs < 0) {
      throw new RangeError('killGracePeriodMs must be a non-negative number');
    }

    // Validate resourceLimits before any worker spawn. See ADR-0019 §2.
    if (options.resourceLimits !== undefined) {
      const rl = options.resourceLimits;
      if (rl === null || typeof rl !== 'object') {
        throw new TypeError('resourceLimits must be an object or undefined');
      }
      for (const k of [
        'maxYoungGenerationSizeMb',
        'maxOldGenerationSizeMb',
        'codeRangeSizeMb',
        'stackSizeMb',
      ]) {
        if (rl[k] !== undefined && (typeof rl[k] !== 'number' || rl[k] <= 0)) {
          throw new RangeError(`resourceLimits.${k} must be a positive number (got ${rl[k]})`);
        }
      }
    }

    this.#maxTasksPerWorker = maxTasksPerWorker;
    this.#maxMemoryMb = maxMemoryMb;
    this.#forceKillOnTimeout = forceKillOnTimeout;
    this.#killGracePeriodMs = killGracePeriodMs;

    // Default worker pool size = 1 (was availableParallelism() - 1; see ADR-0019).
    // On hosts with >4 cores, emit a startup warning so users on big boxes know
    // they can opt up via createWorkerRuntime({ workers: N }).
    const userSpecifiedWorkerCount = typeof options.workers === 'number';
    const defaultWorkers = 1;
    const workerCount = userSpecifiedWorkerCount ? options.workers : defaultWorkers;
    if (!userSpecifiedWorkerCount) {
      const cores = availableParallelism();
      if (cores > 4) {
        process.emitWarning(
          `persistent-worker-runtime: started with default workers=1 on a ${cores}-core host. ` +
            `Each Node worker is a separate V8 isolate (~30-50 MB RSS) and uses a parallel OS thread; ` +
            `size the pool explicitly via createWorkerRuntime({ workers: N }) where N <= ` +
            `os.availableParallelism() - 1. See BENCHMARKS.md §Memory and ADR-0019 for sizing guidance.`,
          'PersistentWorkerRuntimeDefaultSizing',
        );
      }
    }

    this.#queue = new TaskQueue({
      maxQueueSize: options.maxQueueSize || 2000,
      queueTimeoutMs: options.queueTimeoutMs || 30000,
    });

    this.#supervisor = new Supervisor({
      workers: workerCount,
      workerScript: options.workerScript,
      handlerPath: options.handlerPath,
      resourceLimits: options.resourceLimits,
      maxTasksPerWorker: this.#maxTasksPerWorker,
      maxMemoryMb: this.#maxMemoryMb,
      forceKillOnTimeout: this.#forceKillOnTimeout,
      killGracePeriodMs: this.#killGracePeriodMs,
    });

    // Wire supervisor events to runtime events
    this.#supervisor.on('worker_ready', (worker) => {
      this.#scheduleNext();
      this.emit('worker_ready', { workerId: worker.id });
      this.emit('worker:ready', { workerId: worker.id });
    });

    this.#supervisor.on('worker_replaced', ({ oldId, newId }) => {
      this.#scheduleNext();
      this.emit('worker_replaced', { oldId, newId });
      this.emit('worker:replaced', { oldId, newId });
    });

    this.#supervisor.on('worker_recycling', (data) => {
      this.emit('worker_recycling', data);
      this.emit('worker:recycling', data);
    });

    this.#supervisor.on('worker_recycled', (data) => {
      this.#scheduleNext();
      this.emit('worker_recycled', data);
      this.emit('worker:recycled', data);
    });

    this.#supervisor.on('worker_preempted', (data) => {
      this.emit('worker_preempted', data);
      this.emit('worker:preempted', data);
    });

    this.#supervisor.on('task_preempted', (data) => {
      this.#stats.preemptedTasksCount++;
      this.#stats.failedTasks++;
      this.emit('task_preempted', data);
      this.emit('task:preempted', data);
      this.#scheduleNext();
    });

    this.#supervisor.on('task_completed', ({ task, result }) => {
      this.#stats.completedTasks++;
      this.emit('task:completed', {
        taskId: task.id,
        type: task.type,
        durationMs: task.durationMs,
        result,
      });
      this.#scheduleNext();
    });

    this.#supervisor.on('task_failed', ({ task, error }) => {
      if (task.retries > 0 && task.attempts < task.retries) {
        task.attempts++;
        const delay =
          task.backoff === 'exponential'
            ? task.retryDelayMs * 2 ** (task.attempts - 1)
            : task.backoff === 'linear'
              ? task.retryDelayMs * task.attempts
              : task.retryDelayMs;

        this.emit('task:retrying', {
          taskId: task.id,
          attempt: task.attempts,
          maxRetries: task.retries,
          delayMs: delay,
          error,
        });

        setTimeout(() => {
          if (!this.#isShuttingDown && !task.isSettled) {
            this.#queue
              .enqueue(task)
              .then(() => this.#scheduleNext())
              .catch(() => {
                // Intentional: rejection is handled by the task's own
                // onError callbacks; nothing actionable here.
              });
          }
        }, delay);
      } else {
        this.#stats.failedTasks++;
        task.reject(error);
        this.emit('task:failed', {
          taskId: task.id,
          type: task.type,
          durationMs: task.durationMs,
          attempts: task.attempts,
          error,
        });
      }
      this.#scheduleNext();
    });
  }

  get stats() {
    return {
      totalWorkers: this.#supervisor.totalWorkers,
      idleWorkers: this.#supervisor.idleWorkers.length,
      queueDepth: this.#queue.size,
      waitingQueueCount: this.#queue.waitingCount,
      submittedTasks: this.#stats.submittedTasks,
      completedTasks: this.#stats.completedTasks,
      failedTasks: this.#stats.failedTasks,
      recycledWorkersCount: this.#supervisor.recycledCount,
      preemptedTasksCount: this.#stats.preemptedTasksCount,
    };
  }

  get maxTasksPerWorker() {
    return this.#maxTasksPerWorker;
  }

  get maxMemoryMb() {
    return this.#maxMemoryMb;
  }

  get forceKillOnTimeout() {
    return this.#forceKillOnTimeout;
  }

  get killGracePeriodMs() {
    return this.#killGracePeriodMs;
  }

  /**
   * Initializes the pool and starts persistent workers.
   */
  async start() {
    if (this.#isStarted) return this;
    await this.#supervisor.start();
    this.#isStarted = true;
    return this;
  }

  /**
   * Submits a task and AWAITS its result (interactive request-response mode).
   *
   * **Important**: the returned Promise MUST be awaited, `.then()`/`.catch()`-handled,
   * or returned by the caller. A fire-and-forget pattern like `runtime.execute(...)`
   * without `await` (or without attaching `.catch()`) leaves the worker vulnerable
   * to a `WorkerCrashError` that surfaces **asynchronously after the calling scope
   * returns**. On slower CI runners (e.g. macOS GitHub Actions Node 22), this
   * manifests as Node test runner errors of the form:
   *
   *   "Test '...' generated asynchronous activity after the test ended.
   *    ... WorkerCrashError ..."
   *
   * If you intentionally want fire-and-forget semantics (e.g. transactional outbox,
   * background webhooks), use `dispatch()` instead — it returns a `TaskHandle`
   * with `onComplete` / `onError` and an internally-captured `.promise.catch()`.
   *
   * @see ADR-0018 for the full fire-and-forget hazard analysis.
   * @param {Object|Function} taskDefinition
   * @returns {Promise<any>}
   */
  async execute(taskDefinition) {
    const handle = this.dispatch(taskDefinition);
    return handle.promise;
  }

  /**
   * Dispatches a task in the background without blocking, returning a TaskHandle
   * immediately. Ideal for outbox patterns, email sending, webhooks, and
   * asynchronous side-effects.
   *
   * The returned `TaskHandle` carries:
   *   - `onComplete(result)` / `onError(err)` callbacks
   *   - `.promise` (already `.catch()`-handled internally by the handle, so
   *     unhandled-rejection warnings do not fire on legitimate cleanup)
   *
   * **Prefer `dispatch()` over `execute()` when you do not need to await the
   * result synchronously** (background jobs, transactional outbox). See
   * ADR-0018 for the rationale behind the two-mode distinction.
   *
   * @see ADR-0018 for the full fire-and-forget hazard analysis.
   * @param {Object|Function} taskDefinition
   * @returns {TaskHandle}
   */
  dispatch(taskDefinition) {
    if (this.#isShuttingDown) {
      throw new WorkerRuntimeError('Cannot dispatch tasks: Runtime is shutting down');
    }

    let taskOptions = {};
    if (typeof taskDefinition === 'function') {
      taskOptions = {
        type: taskDefinition.name || 'anonymous_fn',
        fnCode: taskDefinition.toString(),
      };
    } else if (taskDefinition && typeof taskDefinition === 'object') {
      taskOptions = { ...taskDefinition };
      if (typeof taskDefinition.fn === 'function') {
        taskOptions.fnCode = taskDefinition.fn.toString();
      }
    } else {
      throw new TypeError('Task definition must be an object or a function');
    }

    if (taskOptions.forceKillOnTimeout === undefined) {
      taskOptions.forceKillOnTimeout = this.#forceKillOnTimeout;
    }
    if (taskOptions.killGracePeriodMs === undefined) {
      taskOptions.killGracePeriodMs = this.#killGracePeriodMs;
    }

    const task = new TaskHandle(taskOptions);
    this.#stats.submittedTasks++;

    // Enqueue asynchronously without blocking the Event Loop
    this.#queue
      .enqueue(task)
      .then(() => {
        this.#scheduleNext();
      })
      .catch((_err) => {
        // Handled via task.reject() inside queue
      });

    return task;
  }

  /**
   * Executes multiple tasks in parallel with bounded worker concurrency (Promise.all style).
   * @param {Array<Object|Function>} taskDefinitions
   * @returns {Promise<Array<any>>}
   */
  async executeAll(taskDefinitions) {
    if (!Array.isArray(taskDefinitions)) {
      throw new TypeError('executeAll expects an array of task definitions');
    }
    const promises = taskDefinitions.map((taskDef) => this.execute(taskDef));
    return Promise.all(promises);
  }

  /**
   * Executes multiple tasks in parallel with bounded worker concurrency (Promise.allSettled style).
   * @param {Array<Object|Function>} taskDefinitions
   * @returns {Promise<Array<{status: 'fulfilled'|'rejected', value?: any, reason?: any}>>}
   */
  async executeAllSettled(taskDefinitions) {
    if (!Array.isArray(taskDefinitions)) {
      throw new TypeError('executeAllSettled expects an array of task definitions');
    }
    const promises = taskDefinitions.map((taskDef) => this.execute(taskDef));
    return Promise.allSettled(promises);
  }

  /**
   * Dispatches multiple tasks in parallel for background execution (Outbox batch style).
   * @param {Array<Object|Function>} taskDefinitions
   * @returns {Array<TaskHandle>}
   */
  dispatchAll(taskDefinitions) {
    if (!Array.isArray(taskDefinitions)) {
      throw new TypeError('dispatchAll expects an array of task definitions');
    }
    return taskDefinitions.map((taskDef) => this.dispatch(taskDef));
  }

  /**
   * Streams chunks from a generator function running on a worker.
   *
   * `taskFn` MUST be an `AsyncGeneratorFunction` or `GeneratorFunction`;
   * anything else throws a `StreamConfigError` (which is a `TypeError`).
   * A `Stream` instance is returned immediately; chunks are yielded via
   * the standard async-iterator protocol, and the worker's
   * `MSG_STREAM_*` IPC frames are routed to the stream's producer side.
   *
   * Streams hold a worker for their full lifetime (no multiplexing), so
   * if you intend to run multiple concurrent streams, size the pool
   * accordingly via the `workers` constructor option.
   *
   * @param {Function} taskFn       An (Async)GeneratorFunction.
   * @param {*}        payload      Caller payload.
   * @param {Object}   [options]
   * @param {number}   [options.highWaterMark=1024]  Buffer threshold for `stream:backpressure`.
   * @param {AbortSignal} [options.signal]            External signal that aborts the stream.
   * @returns {Stream}
   * @throws {WorkerRuntimeError}  If the runtime is shutting down or no worker is idle.
   * @throws {StreamConfigError}   If `taskFn` is not a generator function.
   */
  stream(taskFn, payload, options = {}) {
    if (this.#isShuttingDown) {
      throw new WorkerRuntimeError('Cannot stream: Runtime is shutting down');
    }
    if (typeof taskFn !== 'function') {
      throw new StreamConfigError('stream() expects taskFn to be a function');
    }
    if (!isGeneratorFunction(taskFn)) {
      throw new StreamConfigError(
        'stream() taskFn must be an AsyncGeneratorFunction or GeneratorFunction',
      );
    }

    const idleWorkers = this.#supervisor.idleWorkers;
    if (idleWorkers.length === 0) {
      throw new WorkerRuntimeError(
        'No idle worker available for stream — concurrent streams are 1:1 with workers',
      );
    }
    const worker = idleWorkers[0];

    const taskId = `stream-${randomUUID()}`;
    const stream = new Stream({
      highWaterMark: options.highWaterMark,
      signal: options.signal,
    });

    const onAbortToWorker = (reason) => worker.abortStream(taskId, reason);
    // Both `stream:cancelled` (consumer break) and `stream:aborted`
    // (external signal) must reach the worker so its iterator can drain
    // and finally blocks can run.
    stream.on('stream:cancelled', (data) => onAbortToWorker(data.reason));
    stream.on('stream:aborted', (data) => onAbortToWorker(data.reason));

    this.#activeStreams.set(taskId, { stream, worker });

    worker.executeStreamTask({
      taskId,
      fnCode: taskFn.toString(),
      payload,
      onChunk: ({ chunk }) => stream.pushChunk(chunk),
      onEnd: (info) => {
        if (info.aborted) {
          stream.pushAbortEnd({ reason: info.reason });
        } else {
          stream.pushEnd({ returnValue: info.returnValue });
        }
        this.#activeStreams.delete(taskId);
        // Free the worker so it can pick up the next queued task.
        this.#scheduleNext();
      },
      onError: (error) => {
        stream.pushError(error);
        this.#activeStreams.delete(taskId);
        this.#scheduleNext();
      },
    });

    return stream;
  }

  /**
   * Creates or acquires a dedicated stateful worker handle with private L1 memory.
   * @param {Object} options
   * @returns {Promise<WorkerHandle>}
   */
  async createWorker(options = {}) {
    if (this.#isShuttingDown) {
      throw new WorkerRuntimeError('Cannot create worker: Runtime is shutting down');
    }
    return this.#supervisor.createDedicatedWorker(options);
  }

  /**
   * Scheduler loop: matches idle workers with queued tasks.
   */
  #scheduleNext() {
    if (this.#isShuttingDown || this.#queue.size === 0) return;

    const idleWorkers = this.#supervisor.idleWorkers;
    if (idleWorkers.length === 0) return;

    for (const worker of idleWorkers) {
      const task = this.#queue.dequeue(worker);
      if (!task) break;

      worker.executeTask(task).catch(() => {
        // Handled via worker events
      });
    }
  }

  /**
   * Gracefully shuts down the runtime, rejecting queued tasks and terminating worker threads.
   */
  async shutdown() {
    this.#isShuttingDown = true;
    this.#queue.destroy(new WorkerRuntimeError('Runtime is shutting down'));
    // Abort every active stream so the worker's generator can drain its
    // finally blocks. The worker termination below tears the connection
    // down anyway, but doing it explicitly produces a clean abort frame.
    for (const [taskId, { stream, worker }] of this.#activeStreams) {
      worker.abortStream(taskId, 'runtime-shutdown');
      stream.pushAbortEnd({ reason: 'runtime-shutdown' });
    }
    this.#activeStreams.clear();
    // Close every main-thread BroadcastChannel so the native BC handles
    // do not keep the Event Loop alive after worker shutdown.
    this.#channelRegistry.closeAll();
    await this.#supervisor.shutdown();
  }

  /**
   * Publishes a message to all subscribers of the named channel.
   *
   * The message is structured-cloned before delivery, so it may contain
   * any JSON-safe value (plain objects, arrays, primitives, Dates,
   * Maps, Sets, ArrayBuffers, etc.). The native BroadcastChannel bus
   * delivers directly to all subscribers in the same process and to
   * worker threads without involving the main-thread Event Loop as a
   * router.
   *
   * Returns once the bus has accepted the message. Does NOT wait for
   * consumer processing.
   *
   * @param {string} name Channel name (non-empty string).
   * @param {*} message Structured-clone-serializable payload.
   * @throws {TypeError} If `name` is not a string.
   * @throws {RangeError} If `name` is empty.
   * @throws {WorkerRuntimeError} If the runtime is shutting down.
   */
  broadcast(name, message) {
    if (this.#isShuttingDown) {
      throw new WorkerRuntimeError('Cannot broadcast: Runtime is shutting down');
    }
    this.#channelRegistry.publish(name, message);
  }

  /**
   * Subscribes to broadcasts on the named channel from the main thread.
   *
   * Useful for observability, logging, or coordinated shutdown signals.
   * Worker-side subscribers are managed via `context.channel(name).subscribe(handler)`
   * inside tasks; main-thread subscribers are useful for the orchestrator.
   *
   * @param {string} name Channel name (non-empty string).
   * @param {(message: any) => void} handler Subscriber function.
   * @returns {() => boolean} Unsubscribe function. Idempotent.
   * @throws {TypeError} If `name` is not a string or `handler` is not a function.
   * @throws {RangeError} If `name` is empty.
   */
  subscribe(name, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('subscribe() requires a function handler');
    }
    return this.#channelRegistry.subscribe(name, handler);
  }

  /**
   * Removes a previously-registered subscriber from the named channel.
   *
   * Equivalent to calling the unsubscribe function returned by
   * `subscribe()`; this is a convenience for callers that don't want
   * to retain the unsubscribe handle.
   *
   * @param {string} name Channel name (non-empty string).
   * @param {(message: any) => void} handler Subscriber function to remove.
   * @returns {boolean} True if the handler was removed, false if not found.
   * @throws {TypeError} If `name` is not a string or `handler` is not a function.
   * @throws {RangeError} If `name` is empty.
   */
  unsubscribe(name, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('unsubscribe() requires a function handler');
    }
    return this.#channelRegistry.unsubscribe(name, handler);
  }

  /**
   * Returns true if the named channel exists in the main-thread registry
   * AND has at least one active subscriber.
   *
   * A channel that has been closed (or never created) returns false.
   * A channel whose last subscriber was removed (but the underlying BC
   * handle is still open) also returns false.
   *
   * @param {string} name Channel name (non-empty string).
   * @returns {boolean}
   * @throws {TypeError} If `name` is not a string.
   * @throws {RangeError} If `name` is empty.
   */
  hasSubscribers(name) {
    return this.#channelRegistry.hasSubscribers(name);
  }
}

/**
 * Factory helper function to create and start a WorkerRuntime instance.
 * @param {Object} options
 * @returns {Promise<WorkerRuntime>}
 */
export async function createWorkerRuntime(options = {}) {
  const runtime = new WorkerRuntime(options);
  await runtime.start();
  return runtime;
}
