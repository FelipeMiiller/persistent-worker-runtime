import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { availableParallelism } from 'node:os';
import { createAdaptiveController } from './adaptive-controller.js';
import { ChannelRegistry } from './broadcast-channel.js';
import { StreamConfigError, WorkerRuntimeError } from './errors.js';
import { scanFnDeps } from './fn-deps-scanner.js';
import { isGeneratorFunction } from './stream-runner.js';
import { Stream } from './streaming.js';
import { Supervisor } from './supervisor.js';
import { TaskHandle } from './task-handle.js';
import { TaskQueue } from './task-queue.js';
import { WorkerHandle } from './worker-handle.js';
import {
  isDefaultSizing,
  resolveAdaptiveEnabled,
  resolveWorkerCount,
} from './worker-pool-sizing.js';

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
  #silentTimeoutDefaultWarning;
  #adaptiveEnabled;
  /**
   * Adaptive concurrency controller (ADR-0014 T7). `null` when the
   * factory detected an opt-out (`workers: N` or `concurrency: 'fixed'`)
   * — the resolver in `worker-pool-sizing.js` is the single source of
   * truth for the opt-out decision (computed eagerly in the constructor).
   * @type {ReturnType<typeof createAdaptiveController> | null}
   */
  #adaptiveController = null;
  /** @type {Map<string, {stream: Stream, worker: import('./worker-handle.js').WorkerHandle}>} */
  #activeStreams = new Map();
  /** FIFO queue of stream requests waiting for a free worker. Each entry
   * is `{ taskId, taskFn, fnCode, payload, options, stream }`. Streams
   * are kept 1:1 with workers for their full lifetime, so the queue
   * exists to back-pressure concurrent `runtime.stream()` calls when the
   * pool is saturated. */
  #pendingStreams = [];
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

    // HARDEN-01 (ADR-0024 A1): suppress the once-per-process warning that
    // fires when a TaskHandle is built with `forceKillOnTimeout: true` AND
    // `timeoutMs === 0`. Per-TaskHandle override is still available via the
    // `silentTimeoutDefaultWarning` task option.
    const silentTimeoutDefaultWarning = Boolean(options.silentTimeoutDefaultWarning);

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
    this.#silentTimeoutDefaultWarning = silentTimeoutDefaultWarning;
    // Set below after `resolveAdaptiveEnabled` resolves; placeholder so
    // the field always has a defined value (matches the other
    // primitive private fields above).
    this.#adaptiveEnabled = true;

    // Resolve the initial pool size from options + WORKER_CONCURRENCY env
    // (ADR-0023) and remember whether adaptive concurrency should be wired
    // up. `resolveAdaptiveEnabled` is computed NOW so its result is
    // observable even before T7 actually instantiates the controller —
    // callers (e.g. dashboards, tests) can read `adaptiveEnabled` off the
    // runtime immediately after construction.
    const workerCount = resolveWorkerCount(options);
    const adaptiveEnabled = resolveAdaptiveEnabled(options);
    this.#adaptiveEnabled = adaptiveEnabled;
    if (isDefaultSizing(options)) {
      const cores = availableParallelism();
      if (cores > 4) {
        process.emitWarning(
          `persistent-worker-runtime: started with default workers=1 on a ${cores}-core host. ` +
            `Each Node worker is a separate V8 isolate (~30-50 MB RSS) and uses a parallel OS thread; ` +
            `size the pool explicitly via createWorkerRuntime({ workers: N }), ` +
            `set WORKER_CONCURRENCY=<N|auto>, or pass { concurrency: 'auto' } ` +
            `(see ADR-0023 and BENCHMARKS.md §18 Phase E for sizing guidance).`,
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

    // T7 — instantiate the adaptive concurrency controller (ADR-0014 +
    // ADR-0023). The factory is the single source of truth for the
    // opt-out decision (`resolveAdaptiveEnabled` in
    // `worker-pool-sizing.js`): explicit numeric `workers` or
    // `concurrency: 'fixed'` leave `#adaptiveController` as `null` and
    // the runtime stays in fixed-mode. Otherwise the controller is
    // wired with:
    //
    //   - `minWorkers: 1` — the ADR-0019 floor; never below this.
    //   - `maxWorkers: availableParallelism()` — the empirical saturation
    //     knee from Phase E. Grows UP from `workerCount` when
    //     `workerCount < cores` (the conservative default), or matches
    //     `workerCount` exactly when the user already opted into the
    //     host-core count via `WORKER_CONCURRENCY=auto` /
    //     `concurrency: 'auto'`.
    //   - `spawnIdleWorker` / `retireLowestLoadWorker` — methods on
    //     `Supervisor` added in T7. The controller's debounce + band
    //     gates (T5) keep these in `[minWorkers, maxWorkers]`, so the
    //     controller never asks the supervisor to grow past the cap.
    //   - `events: this` — the runtime's own EventEmitter. The
    //     controller's T4 retire path emits `worker:retiring` here,
    //     giving observers one canonical stream for both supervisor
    //     and adaptive events.
    //
    // The controller's `start()` is called in `runtime.start()` — the
    // controller arms its own sampling interval (no new timer on the
    // Supervisor) so this stays consistent with the T7 architectural
    // decision to forward-declare the seam and wire it here.
    if (this.#adaptiveEnabled) {
      // Resolve the adaptive band from factory options. The defaults
      // preserve the pre-T9 behaviour (`minWorkers: 1`,
      // `maxWorkers: availableParallelism()`); explicit options let
      // T9 integration tests constrain the band so a single grow / shrink
      // cycle completes inside the test budget.
      //
      // `initialWorkers` (T9 — fixes a pre-existing inconsistency) makes
      // `runtime.stats.adaptive.effectiveWorkers` mirror the real pool at
      // start. Before this, the controller hard-initialised
      // `effectiveWorkers = minWorkers`, so a `workers: 4` config briefly
      // reported `effectiveWorkers: 1` to dashboards until the first
      // resize — a transient but real inconsistency that T9 P2 surfaced.
      const adaptiveMinWorkers = options.minWorkers === undefined ? 1 : options.minWorkers;
      const adaptiveMaxWorkers =
        options.maxWorkers === undefined ? availableParallelism() : options.maxWorkers;
      if (
        typeof adaptiveMinWorkers !== 'number' ||
        !Number.isInteger(adaptiveMinWorkers) ||
        adaptiveMinWorkers < 1
      ) {
        throw new RangeError(
          `createWorkerRuntime: options.minWorkers must be a positive integer, got ${options.minWorkers}`,
        );
      }
      if (
        typeof adaptiveMaxWorkers !== 'number' ||
        !Number.isInteger(adaptiveMaxWorkers) ||
        adaptiveMaxWorkers < 1
      ) {
        throw new RangeError(
          `createWorkerRuntime: options.maxWorkers must be a positive integer, got ${options.maxWorkers}`,
        );
      }
      if (adaptiveMinWorkers > adaptiveMaxWorkers) {
        throw new RangeError(
          `createWorkerRuntime: options.minWorkers (${adaptiveMinWorkers}) must be <= options.maxWorkers (${adaptiveMaxWorkers})`,
        );
      }

      // Build the controller's options object. Pass-through overrides
      // for the threshold knobs (`shrinkEluThreshold`, etc.) and the
      // smoothing knobs (`ewmaAlpha`, `debounceTicks`) — production code
      // leaves these unset and relies on the controller's Phase-E
      // derived defaults; integration tests use them to pin the band
      // in environments where GC pauses (p99 ~31ms even on an idle
      // Event Loop) or background load would otherwise keep the
      // signals out of the default grow window.
      const controllerOptions = {
        minWorkers: adaptiveMinWorkers,
        maxWorkers: adaptiveMaxWorkers,
        initialWorkers: workerCount,
        samplingCadenceMs: 100,
        // `events` flows through the controller's retire path so the
        // `worker:retiring` event lands on the runtime's own EE.
        events: this,
        spawnIdleWorker: () => this.#supervisor.spawnIdleWorker(),
        retireLowestLoadWorker: () => this.#supervisor.retireLowestLoadWorker(),
      };
      // Conditional pass-through — `undefined` would overwrite the
      // controller's defaults via the `...options` spread inside the
      // factory, so only set keys the caller actually provided.
      for (const key of [
        'shrinkEluThreshold',
        'shrinkLatencyP99Ms',
        'growEluThreshold',
        'growLatencyP99Ms',
        'ewmaAlpha',
        'debounceTicks',
      ]) {
        if (options[key] !== undefined) controllerOptions[key] = options[key];
      }

      this.#adaptiveController = createAdaptiveController(controllerOptions);
    }
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
      // T6 telemetry: count of streams currently dispatched to a worker.
      // Pending streams (queued because the pool was saturated) are
      // tracked separately via `pendingStreams` so observers can tell
      // "running" from "waiting to run".
      activeStreams: this.#activeStreams.size,
      pendingStreams: this.#pendingStreams.length,
      // T7/T8 telemetry (ADR-0014 §Architectural Mechanics): the adaptive
      // concurrency controller's stats block. When adaptive is disabled
      // (`concurrency: 'fixed'` or explicit `workers: N`), `enabled` is
      // `false` and the live EWMA signals are `null` per spec — the
      // sampling cadence is suppressed at the controller level, so any
      // observation of non-null signals implies adaptive is active.
      //
      // `effectiveWorkers` and `ticksSinceResize` stay meaningful even
      // when disabled — they reflect the current pool state and the
      // "ticks since last resize" counter, which only advances when
      // adaptive is sampling. Observers (dashboards, alerting) can
      // therefore still read pool state from this block.
      adaptive: this.#adaptiveController
        ? this.#adaptiveController.getStats()
        : {
            enabled: false,
            elu: null,
            latencyP99Ms: null,
            effectiveWorkers: this.#supervisor.totalWorkers,
            ticksSinceResize: 0,
            lastResizeReason: null,
            lastResizeAt: null,
          },
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
   * Whether the adaptive concurrency controller is enabled for this
   * runtime. Per ADR-0014 the controller is opt-out: explicit numeric
   * `workers` and `concurrency: 'fixed'` both disable it. T7 will use
   * this getter to decide whether to instantiate the controller at
   * all; until then the value is observable via the getter but the
   * runtime still spawns `workerCount` workers at start.
   *
   * @returns {boolean}
   */
  get adaptiveEnabled() {
    return this.#adaptiveEnabled;
  }

  /**
   * Initializes the pool and starts persistent workers.
   */
  async start() {
    if (this.#isStarted) return this;
    await this.#supervisor.start();
    // T7 — arm the adaptive concurrency controller's sampling cadence.
    // `start()` is idempotent (no double-arm). The controller uses its
    // own `setInterval` per ADR-0014 — we do NOT add a parallel timer
    // on the Supervisor. When adaptive is disabled (#adaptiveController
    // is null), this branch is a no-op.
    if (this.#adaptiveController) {
      this.#adaptiveController.start();
    }
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
    if (taskOptions.silentTimeoutDefaultWarning === undefined) {
      taskOptions.silentTimeoutDefaultWarning = this.#silentTimeoutDefaultWarning;
    }
    // HARDEN-02 (ADR-0024 A2): scan the serialized fn source for `node:*`
    // references so the worker can pre-resolve them and inject as bare-name
    // closure bindings. Backward-compat: explicit `taskOptions.fnDeps` from
    // the caller overrides the scan (use case: opt-in to bare-name injection
    // without changing the fn source).
    if (taskOptions.fnDeps === undefined) {
      taskOptions.fnDeps = scanFnDeps(taskOptions.fnCode);
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
   * When no worker is idle, the request is queued (`#pendingStreams`)
   * and the returned `Stream` parks until a worker becomes available.
   * The consumer can iterate immediately — `next()` will block until a
   * worker picks up the request.
   *
   * @param {Function} taskFn       An (Async)GeneratorFunction.
   * @param {*}        payload      Caller payload.
   * @param {Object}   [options]
   * @param {number}   [options.highWaterMark=1024]  Buffer threshold for `stream:backpressure`.
   * @param {AbortSignal} [options.signal]            External signal that aborts the stream.
   * @returns {Stream}
   * @throws {WorkerRuntimeError}  If the runtime is shutting down.
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

    const taskId = `stream-${randomUUID()}`;
    const stream = new Stream({
      highWaterMark: options.highWaterMark,
      signal: options.signal,
    });

    // T6 telemetry: fire `stream:created` synchronously from stream() so
    // observers see the stream at the same moment the user does (queued
    // or dispatched, doesn't matter — the stream exists from the caller's
    // POV).
    this.emit('stream:created', { taskId });

    const idleWorkers = this.#supervisor.idleWorkers;
    if (idleWorkers.length === 0) {
      // Queue the stream; it'll be picked up when a worker frees.
      // While queued, aborts are handled by removing the request from
      // the queue — no worker reference exists yet so we can't post
      // MSG_STREAM_ABORT. The `Stream` instance already handles
      // consumer-initiated return() / signal.aborted by flipping its
      // own `_aborted` flag and firing `stream:aborted`, which the
      // listener below picks up to clean up the queue entry.
      const fnCode = taskFn.toString();
      const request = { taskId, taskFn, fnCode, payload, options, stream };
      this.#pendingStreams.push(request);
      stream.on('stream:aborted', (data) => {
        const idx = this.#pendingStreams.indexOf(request);
        if (idx >= 0) {
          this.#pendingStreams.splice(idx, 1);
          // T6: only the queue-listener emits while the request is still
          // queued. After dispatch the indexOf returns -1 and the
          // dispatch-listener (added in #assignStreamToWorker) takes
          // over. This avoids duplicate `stream:aborted` emissions.
          this.emit('stream:aborted', { taskId, reason: data.reason });
        }
      });
      // Kick the scheduler in case a worker freed between the
      // idleWorkers check above and this point.
      this.#scheduleNext();
      return stream;
    }

    this.#assignStreamToWorker(taskFn, payload, options, taskId, stream, idleWorkers[0]);
    return stream;
  }

  /**
   * Wires a Stream to a worker, dispatches the streaming task, and
   * registers the cancellation/backpressure listeners. Called either
   * directly from `stream()` when a worker is free, or from
   * `#dispatchPendingStreams()` after a worker becomes available.
   */
  #assignStreamToWorker(taskFn, payload, _options, taskId, stream, worker) {
    const onAbortToWorker = (reason) => worker.abortStream(taskId, reason);
    // `stream:aborted` fires for both consumer-initiated cancellation
    // (`break` / `return()`) and external-signal aborts (T5 unification).
    // Both paths must reach the worker so its iterator can drain and
    // `finally` blocks can run deterministically. T6 also re-emits on
    // the runtime's EventEmitter so cross-stream observers can react.
    stream.on('stream:aborted', (data) => {
      onAbortToWorker(data.reason);
      this.emit('stream:aborted', { taskId, reason: data.reason });
    });
    // Backpressure: the bounded buffer flips `stream:backpressure
    // {state:'paused'}` on the upward crossing and `{state:'resumed'}`
    // when it drains below HWM / 2. Forward both to the worker so its
    // generator parks between yields instead of posting into a full
    // IPC channel. T6 also re-emits on the runtime's EventEmitter.
    stream.on('stream:backpressure', (data) => {
      if (data?.state === 'paused') {
        worker.pauseStream(taskId);
      } else if (data?.state === 'resumed') {
        worker.resumeStream(taskId);
      }
      this.emit('stream:backpressure', {
        taskId,
        state: data?.state,
        queueLength: data?.queueLength,
      });
    });

    this.#activeStreams.set(taskId, { stream, worker });

    worker.executeStreamTask({
      taskId,
      fnCode: taskFn.toString(),
      // HARDEN-02 (ADR-0024 A2): scan for `node:*` refs and ship them to
      // the worker so the streaming fn can use bare-name `net`, `crypto`,
      // etc. without dynamic-import boilerplate. Empty array = no manifest;
      // the streaming fn falls back to its own dynamic imports.
      fnDeps: scanFnDeps(taskFn.toString()),
      payload,
      onChunk: ({ seq, chunk }) => {
        stream.pushChunk(chunk);
        // T6 telemetry: stream:chunk { taskId, seq } fires per delivered
        // chunk. seq is the per-stream monotonic counter from the worker.
        this.emit('stream:chunk', { taskId, seq });
      },
      onEnd: (info) => {
        // Emit the runtime event BEFORE pushAbortEnd / pushEnd so the
        // notification fires regardless of whether the consumer-facing
        // push*() is a no-op (e.g. when an external AbortSignal already
        // flipped Stream._settled=true via _abort(), the abort-path
        // pushAbortEnd is a guarded early return).
        if (info.aborted) {
          this.emit('stream:aborted', { taskId, reason: info.reason });
          stream.pushAbortEnd({ reason: info.reason });
        } else {
          this.emit('stream:end', {
            taskId,
            totalChunks: stream.stats.totalChunks,
            returnValue: info.returnValue,
          });
          stream.pushEnd({ returnValue: info.returnValue });
        }
        this.#activeStreams.delete(taskId);
        // Free the worker so it can pick up the next queued task or
        // stream.
        this.#scheduleNext();
      },
      onError: (error) => {
        this.emit('stream:aborted', {
          taskId,
          reason: error?.message || 'generator-throw',
        });
        stream.pushError(error);
        this.#activeStreams.delete(taskId);
        this.#scheduleNext();
      },
    });
  }

  /**
   * Dispatch any pending streams (FIFO) to idle workers, then return.
   * Called from `#scheduleNext()` after a worker has freed up.
   */
  #dispatchPendingStreams() {
    while (this.#pendingStreams.length > 0 && this.#supervisor.idleWorkers.length > 0) {
      const request = this.#pendingStreams[0];
      // The stream might have been aborted while queued (consumer
      // break, external signal). Drop such requests without dispatch.
      if (request.stream.aborted) {
        this.#pendingStreams.shift();
        continue;
      }
      const idle = this.#supervisor.idleWorkers;
      if (idle.length === 0) break;
      this.#pendingStreams.shift();
      this.#assignStreamToWorker(
        request.taskFn,
        request.payload,
        request.options,
        request.taskId,
        request.stream,
        idle[0],
      );
    }
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
   * Scheduler loop: matches idle workers with queued streams first
   * (FIFO with each other), then queued tasks. Called whenever a worker
   * frees (worker_ready / task_completed / task_failed / stream end).
   */
  #scheduleNext() {
    if (this.#isShuttingDown) return;

    // First, dispatch any pending streams. Streams hold a worker for
    // their full lifetime so this frees up workers for tasks sooner.
    this.#dispatchPendingStreams();

    if (this.#queue.size === 0) return;

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
    // T7 — stop the adaptive controller BEFORE tearing down the
    // supervisor. The controller's setInterval is .unref()-ed so it
    // would not block Event Loop exit on its own, but ordering matters:
    // if a tick fires concurrently with supervisor.shutdown(), the
    // controller might call `spawnIdleWorker` against a shut-down
    // supervisor and the new worker would be stranded. Stop the
    // controller first so no further fires can land during teardown.
    if (this.#adaptiveController) {
      this.#adaptiveController.stop();
    }
    this.#queue.destroy(new WorkerRuntimeError('Runtime is shutting down'));
    // Abort every active stream so the worker's generator can drain its
    // finally blocks. pushAbortEnd fires `stream:aborted` which the
    // listener set up in stream() forwards to worker.abortStream(); the
    // explicit abortStream() call here is therefore redundant but kept
    // for the case where a stream has been registered before the
    // listener could be wired (defensive: belt + suspenders). T6 also
    // emits `stream:aborted` on the runtime's EventEmitter so observers
    // see the shutdown-driven aborts.
    for (const [taskId, { stream, worker }] of this.#activeStreams) {
      worker.abortStream(taskId, 'runtime-shutdown');
      stream.pushAbortEnd({ reason: 'runtime-shutdown' });
      this.emit('stream:aborted', { taskId, reason: 'runtime-shutdown' });
    }
    this.#activeStreams.clear();
    // Same drain for streams that were queued but never picked up a
    // worker — without this, their pending next() would hang forever
    // and prevent the Event Loop from exiting.
    for (const { stream, taskId } of this.#pendingStreams) {
      stream.pushAbortEnd({ reason: 'runtime-shutdown' });
      this.emit('stream:aborted', { taskId, reason: 'runtime-shutdown' });
    }
    this.#pendingStreams.length = 0;
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
