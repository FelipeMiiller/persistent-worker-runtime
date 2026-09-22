import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { TaskTimeoutError, WorkerCrashError, WorkerRuntimeError } from './errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_WORKER_SCRIPT = join(__dirname, 'worker-thread-entry.js');

let workerSequence = 1;

/**
 * WorkerHandle manages a single Worker thread instance, its IPC lifecycle, and task execution.
 */
export class WorkerHandle extends EventEmitter {
  #worker = null;
  #currentTask = null;
  #streamTask = null;
  #status = 'starting';
  #tasksCompleted = 0;
  #lastMemoryUsageBytes = 0;
  // HARDEN-03 (ADR-0024 B1): wall-clock timestamp of the last task
  // completion/failure on this worker. Used by `snapshot()` so dashboards
  // can answer "when was this worker last active?" without an extra IPC.
  // 0 = worker has never completed a task.
  #lastTaskAt = 0;
  // HARDEN-03 (ADR-0024 B1): in-worker recycle count. Workers aren't
  // recycled in-place today (recycle = terminate + replace, see
  // supervisor.js), so this stays 0 for live workers. The field is wired
  // here so a future in-place recycler can increment without an API break.
  #recycledCount = 0;
  // HARDEN-05 (ADR-0024 B3): opt-in `worker:memory` event emission. When
  // `observeMemory` is true the worker emits `memory` after each task
  // settlement, rate-limited to ≤ 1 emission per `memoryEmitIntervalMs`.
  // Default off — zero overhead when false (we never set the timer or
  // touch the rate-limit field).
  #observeMemory = false;
  #memoryEmitIntervalMs = 1000;
  #lastMemoryEmitAt = 0;
  #watchdogTimer = null;
  #graceTimer = null;
  #isPreempted = false;
  #readyPromise = null;
  #readyResolver = null;

  constructor(options = {}) {
    super();
    this.id = options.id || `worker_${Date.now()}_${workerSequence++}`;
    this.name = options.name || null;
    this.affinityKey = options.affinityKey || null;
    this.isDedicated = Boolean(options.isDedicated);
    this.workerScript = options.workerScript || DEFAULT_WORKER_SCRIPT;
    this.handlerPath = options.handlerPath || null;
    this.resourceLimits = options.resourceLimits || null;
    // HARDEN-05 (ADR-0024 B3): opt-in memory observability. When true,
    // this worker emits a `memory` event after each task settlement,
    // rate-limited via `#memoryEmitIntervalMs`. The option is read once
    // at spawn — flipping it later has no effect (intentional: the
    // overhead cost would be paying for the listener wiring we'd never
    // get back).
    this.#observeMemory = Boolean(options.observeMemory);
    this.#memoryEmitIntervalMs =
      typeof options.memoryEmitIntervalMs === 'number' && options.memoryEmitIntervalMs > 0
        ? options.memoryEmitIntervalMs
        : 1000;

    this.#readyPromise = new Promise((resolve, reject) => {
      this.#readyResolver = { resolve, reject };
    });

    this.#spawn();
  }

  get status() {
    return this.#status;
  }

  get isIdle() {
    return this.#status === 'idle';
  }

  get isRecycling() {
    return this.#status === 'recycling';
  }

  get isPreempted() {
    return this.#isPreempted;
  }

  get currentTask() {
    return this.#currentTask;
  }

  get tasksCompleted() {
    return this.#tasksCompleted;
  }

  get lastMemoryUsageBytes() {
    return this.#lastMemoryUsageBytes;
  }

  get lastMemoryUsage() {
    return this.#lastMemoryUsageBytes;
  }

  get lastTaskAt() {
    return this.#lastTaskAt;
  }

  get recycledCount() {
    return this.#recycledCount;
  }

  /**
   * HARDEN-03 (ADR-0024 B1): returns an in-memory snapshot of this worker's
   * observable state. Sync, zero-IPC, suitable for `runtime.getWorkers()`
   * which returns an array of these. The returned object is a plain shape
   * (no class identity) — callers may mutate it freely without affecting
   * runtime state.
   *
   * Shape per ADR-0024 §B1:
   *   { id, memoryUsageBytes, tasksCompleted, tasksActive, status,
   *     recycledCount, lastTaskAt }
   *
   * @returns {{
   *   id: string,
   *   memoryUsageBytes: number,
   *   tasksCompleted: number,
   *   tasksActive: 0 | 1,
   *   status: string,
   *   recycledCount: number,
   *   lastTaskAt: number
   * }}
   */
  snapshot() {
    return {
      id: this.id,
      memoryUsageBytes: this.#lastMemoryUsageBytes,
      tasksCompleted: this.#tasksCompleted,
      // Streams are 1:1 with workers for their full lifetime, so
      // `tasksActive` is binary: 1 if a regular task or stream is in
      // flight, 0 otherwise. We check both slots because either could
      // hold work.
      tasksActive: this.#currentTask !== null || this.#streamTask !== null ? 1 : 0,
      status: this.#status,
      recycledCount: this.#recycledCount,
      lastTaskAt: this.#lastTaskAt,
    };
  }

  /**
   * Marks this worker as recycling so it stops accepting new tasks.
   */
  markRecycling() {
    if (this.#status === 'terminating' || this.#status === 'terminated') {
      return;
    }
    this.#status = 'recycling';
  }

  /**
   * Resolves when the worker thread is fully initialized and ready to accept tasks.
   */
  async waitUntilReady() {
    return this.#readyPromise;
  }

  #spawn() {
    this.#worker = new Worker(this.workerScript, {
      workerData: {
        workerId: this.id,
        handlerPath: this.handlerPath,
      },
      resourceLimits: this.resourceLimits,
    });

    this.#worker.on('message', (message) => {
      if (message?.type === 'ready') {
        this.#status = 'idle';
        if (this.#readyResolver) {
          this.#readyResolver.resolve();
          this.#readyResolver = null;
        }
        this.emit('ready', this);
        return;
      }

      if (message?.type === 'init_error') {
        const err = new WorkerRuntimeError(message.error.message, { cause: message.error });
        if (this.#readyResolver) {
          this.#readyResolver.reject(err);
          this.#readyResolver = null;
        }
        this.emit('error', err);
        return;
      }

      if (message?.taskId && this.#currentTask && this.#currentTask.id === message.taskId) {
        this.#clearWatchdog();
        const task = this.#currentTask;
        this.#currentTask = null;

        if (typeof message.memoryUsageBytes === 'number') {
          this.#lastMemoryUsageBytes = message.memoryUsageBytes;
        }

        if (
          this.#status !== 'recycling' &&
          this.#status !== 'terminating' &&
          this.#status !== 'terminated'
        ) {
          this.#status = 'idle';
        }
        this.#tasksCompleted++;
        // HARDEN-03 (ADR-0024 B1): record wall-clock time of last task
        // settlement so `snapshot().lastTaskAt` reflects fresh data.
        this.#lastTaskAt = Date.now();
        // HARDEN-05 (ADR-0024 B3): opt-in memory observability. Rate-limited
        // to ≤ 1 emission per `memoryEmitIntervalMs` per worker. When off
        // (default), the `if` short-circuits — zero overhead. During
        // shutdown, `this.#status` is `terminating` so we also skip — the
        // spec forbids emission during shutdown.
        if (this.#observeMemory && this.#status === 'idle') {
          const now = Date.now();
          if (now - this.#lastMemoryEmitAt >= this.#memoryEmitIntervalMs) {
            this.#lastMemoryEmitAt = now;
            this.emit('memory', {
              workerId: this.id,
              memoryUsageBytes: this.#lastMemoryUsageBytes,
              atMs: now,
            });
          }
        }

        if (message.success) {
          task.resolve(message.result);
          this.emit('task_completed', {
            worker: this,
            task,
            result: message.result,
            memoryUsageBytes: this.#lastMemoryUsageBytes,
          });
        } else {
          const err = new WorkerRuntimeError(message.error?.message || 'Task execution failed', {
            code: message.error?.code,
          });
          if (message.error?.stack) err.stack = message.error.stack;
          this.emit('task_failed', {
            worker: this,
            task,
            error: err,
            memoryUsageBytes: this.#lastMemoryUsageBytes,
          });
        }
        return;
      }

      // Streaming protocol — route MSG_STREAM_* frames to the registered
      // stream handler (one active stream per worker, by design).
      if (
        typeof message?.type === 'string' &&
        message.type.startsWith('MSG_STREAM_') &&
        this.#streamTask?.taskId === message.taskId
      ) {
        const streamTask = this.#streamTask;
        if (message.type === 'MSG_STREAM_CHUNK') {
          streamTask.onChunk({ seq: message.seq, chunk: message.chunk });
        } else if (message.type === 'MSG_STREAM_END') {
          // T5 ordering fix: tear the stream down BEFORE invoking onEnd.
          // The runtime's onEnd handler calls #scheduleNext to dispatch
          // any queued stream waiting for a free worker; if the worker
          // is still flagged 'busy' at that point, dispatchPendingStreams
          // sees an empty idleWorkers list and the queued stream hangs
          // forever.
          this.#teardownStream();
          streamTask.onEnd({
            returnValue: message.returnValue,
            aborted: message.aborted,
            reason: message.reason,
            memoryUsageBytes: message.memoryUsageBytes,
          });
        } else if (message.type === 'MSG_STREAM_ERROR') {
          // Same ordering fix as MSG_STREAM_END above.
          this.#teardownStream();
          streamTask.onError(message.error);
        }
        return;
      }

      // Incoming MSG_STREAM_ABORT from the worker? Currently the worker
      // does not initiate aborts — the main thread does. Anything else
      // is ignored.
    });

    this.#worker.on('error', (err) => {
      this.emit('error', err);
    });

    this.#worker.on('exit', (exitCode) => {
      this.#clearWatchdog();
      const prevStatus = this.#status;
      this.#status = 'terminated';

      // If a task was running when worker died, reject with WorkerCrashError
      if (this.#currentTask) {
        const task = this.#currentTask;
        this.#currentTask = null;
        task.reject(
          new WorkerCrashError(
            `Worker ${this.id} crashed with exit code ${exitCode} while running task ${task.id}`,
            { workerId: this.id, exitCode, taskId: task.id },
          ),
        );
      }

      this.emit('exit', { worker: this, exitCode, prevStatus, isPreempted: this.#isPreempted });
    });
  }

  /**
   * Executes a task on this worker thread.
   * @param {TaskHandle} task
   */
  async executeTask(task) {
    if (!this.isIdle) {
      throw new WorkerRuntimeError(`Worker ${this.id} is busy with status: ${this.#status}`);
    }

    if (task.isSettled) return;

    this.#status = 'busy';
    this.#currentTask = task;
    task.markStarted();

    if (task.timeoutMs > 0 && task.forceKillOnTimeout) {
      this.#armWatchdog(task);
    }

    const message = {
      taskId: task.id,
      type: task.type,
      payload: task.payload,
      fnCode: task.fnCode || null,
      // HARDEN-02 (ADR-0024 A2): `node:*` specifiers the worker should
      // pre-resolve and inject as bare-name closure bindings so the fn
      // can call `net.createConnection(...)` directly. Empty array is
      // safe — the worker falls back to user code's own dynamic imports.
      fnDeps: Array.isArray(task.fnDeps) ? task.fnDeps.slice() : [],
    };

    if (task.transferList && task.transferList.length > 0) {
      this.#worker.postMessage(message, task.transferList);
    } else {
      this.#worker.postMessage(message);
    }
    return task.promise;
  }

  /**
   * Dispatches a streaming task to this worker. The worker detects the
   * generator function via the worker-side T2 protocol and emits
   * MSG_STREAM_* frames back; this handle routes them to `onChunk`,
   * `onEnd`, and `onError`. The `onAbort` callback is invoked when the
   * consumer cancels the stream so the main thread can post
   * MSG_STREAM_ABORT to the worker.
   *
   * @param {Object}   opts
   * @param {string}   opts.taskId
   * @param {string}   opts.fnCode
   * @param {*}        opts.payload
   * @param {(frame: {seq:number, chunk:any}) => void} opts.onChunk
   * @param {(end: {returnValue:any, aborted:boolean, reason:any, memoryUsageBytes:number}) => void} opts.onEnd
   * @param {(error: any) => void} opts.onError
   * @param {(reason: any) => void} opts.onAbort
   * @returns {void}
   */
  executeStreamTask({ taskId, fnCode, fnDeps, payload, onChunk, onEnd, onError, onAbort }) {
    if (!this.isIdle) {
      throw new WorkerRuntimeError(`Worker ${this.id} is busy with status: ${this.#status}`);
    }
    if (this.#streamTask) {
      throw new WorkerRuntimeError(`Worker ${this.id} already has an active stream`);
    }

    this.#status = 'busy';
    this.#streamTask = { taskId, onChunk, onEnd, onError, onAbort };

    this.#worker.postMessage({
      taskId,
      type: 'stream',
      payload,
      fnCode,
      // HARDEN-02 (ADR-0024 A2): same manifest as the regular path. Empty
      // array = no `node:*` injection; the streaming fn uses dynamic import
      // for user-installed deps or bare-name refs as before.
      fnDeps: Array.isArray(fnDeps) ? fnDeps.slice() : [],
    });
  }

  /**
   * Posts MSG_STREAM_ABORT to the worker for the active stream, if any.
   * No-op if no stream is active on this worker.
   *
   * @param {string} taskId
   * @param {any}    reason
   */
  abortStream(taskId, reason) {
    if (!this.#streamTask || this.#streamTask.taskId !== taskId) return;
    this.#worker.postMessage({
      type: 'MSG_STREAM_ABORT',
      taskId,
      reason,
    });
  }

  /**
   * Posts MSG_STREAM_PAUSE to the worker, asking it to suspend the
   * stream's iterator before posting the next chunk. No-op if no
   * stream is active on this worker or the taskId does not match.
   *
   * @param {string} taskId
   */
  pauseStream(taskId) {
    if (!this.#streamTask || this.#streamTask.taskId !== taskId) return;
    this.#worker.postMessage({
      type: 'MSG_STREAM_PAUSE',
      taskId,
    });
  }

  /**
   * Posts MSG_STREAM_RESUME to the worker, asking it to continue the
   * suspended iterator. No-op if no stream is active on this worker.
   *
   * @param {string} taskId
   */
  resumeStream(taskId) {
    if (!this.#streamTask || this.#streamTask.taskId !== taskId) return;
    this.#worker.postMessage({
      type: 'MSG_STREAM_RESUME',
      taskId,
    });
  }

  #teardownStream() {
    if (this.#streamTask) {
      const handler = this.#streamTask.onAbort;
      this.#streamTask = null;
      if (
        this.#status !== 'recycling' &&
        this.#status !== 'terminating' &&
        this.#status !== 'terminated'
      ) {
        this.#status = 'idle';
      }
      // Notify caller that the stream slot is free; safe to ignore
      // when no onAbort handler is attached.
      if (handler) handler();
    }
  }

  /**
   * Clears any active watchdog or grace period timers.
   */
  #clearWatchdog() {
    if (this.#watchdogTimer) {
      clearTimeout(this.#watchdogTimer);
      this.#watchdogTimer = null;
    }
    if (this.#graceTimer) {
      clearTimeout(this.#graceTimer);
      this.#graceTimer = null;
    }
  }

  /**
   * Arms the execution timeout watchdog on the main thread for uncooperative task preemption.
   * @param {TaskHandle} task
   */
  #armWatchdog(task) {
    this.#clearWatchdog();

    if (!task || task.timeoutMs <= 0 || !task.forceKillOnTimeout) {
      return;
    }

    this.#watchdogTimer = setTimeout(() => {
      this.#watchdogTimer = null;

      if (task.isSettled || this.#currentTask !== task) {
        return;
      }

      if (task.killGracePeriodMs > 0) {
        if (task.signal && !task.signal.aborted) {
          try {
            task.signal.dispatchEvent(new Event('abort'));
          } catch (_) {
            // Ignore dispatch errors
          }
        }

        this.#graceTimer = setTimeout(() => {
          this.#graceTimer = null;
          this.#preemptWorker(task);
        }, task.killGracePeriodMs);
      } else {
        this.#preemptWorker(task);
      }
    }, task.timeoutMs);
  }

  /**
   * HARDEN-10 (ADR-0024 D2): public entry point for the supervisor's
   * poll-based watchdog. Preempts the currently-active task with the
   * same semantics as the per-task watchdog (TaskTimeoutError with
   * `preempted: true`, worker terminates, `task_preempted` event
   * emitted). No-op when the worker is already preempting or
   * terminated, or when there is no active task.
   *
   * Added so `Supervisor.#checkWorkerWatchdog` can drive preemption
   * without reaching into private state. Per-task watchdog in
   * `#armWatchdog` keeps firing at `task.timeoutMs` as the first line
   * of defense; this is the second.
   */
  preempt() {
    if (this.#status === 'preempting' || this.#status === 'terminated') {
      return;
    }
    if (!this.#currentTask) {
      return;
    }
    this.#preemptWorker(this.#currentTask);
  }

  /**
   * Forcibly preempts the active worker thread and terminates the underlying V8 isolate.
   * @param {TaskHandle} task
   */
  #preemptWorker(task) {
    if (this.#status === 'preempting' || this.#status === 'terminated') {
      return;
    }

    this.#status = 'preempting';
    this.#isPreempted = true;
    this.#clearWatchdog();

    const currentTask = this.#currentTask || task;
    this.#currentTask = null;

    const timeoutErr = new TaskTimeoutError(
      `Task ${currentTask.id} exceeded execution timeout of ${currentTask.timeoutMs}ms and was forcibly preempted`,
      {
        taskId: currentTask.id,
        timeoutMs: currentTask.timeoutMs,
        preempted: true,
        workerId: this.id,
      },
    );

    currentTask.reject(timeoutErr);

    this.emit('task_preempted', {
      worker: this,
      workerId: this.id,
      taskId: currentTask.id,
      timeoutMs: currentTask.timeoutMs,
      preempted: true,
    });

    if (this.#worker) {
      this.#worker.terminate().catch(() => {
        // Intentional: termination errors are not actionable — the
        // worker is already in a crash state.
      });
    }
  }

  /**
   * Executes a stateful operation on this worker's L1 memory.
   */
  async getState(key) {
    return this.executeDirectTask('__get_state__', { key });
  }

  async setState(key, value) {
    return this.executeDirectTask('__set_state__', { key, value });
  }

  async clearState() {
    return this.executeDirectTask('__clear_state__', null);
  }

  async ping() {
    return this.executeDirectTask('__ping__', null);
  }

  async executeDirectTask(type, payload) {
    const { TaskHandle } = await import('./task-handle.js');
    const task = new TaskHandle({ type, payload });
    return this.executeTask(task);
  }

  /**
   * Gracefully retires the worker: lets any in-flight task complete
   * naturally, then terminates. Used by the adaptive concurrency
   * controller's shrink path (T7 — ADR-0014) where preemption is
   * explicitly forbidden (drain semantics, see ADAPTIVE-09).
   *
   * Behaviour matrix:
   *   - `idle`: terminate immediately. Nothing to drain.
   *   - `busy`: arm a one-shot listener on the next `task_completed`
   *     or `task_failed` event. When the in-flight task settles, the
   *     worker is terminated. The listener is registered BEFORE we
   *     flip status to `draining` so a task completing concurrently
   *     with the call cannot race past us.
   *   - `draining` / `recycling` / `terminating` / `terminated`: no-op
   *     (idempotent + safe under repeated calls from the controller's
   *     fire site).
   *
   * Returns the worker id so the supervisor can map the retire back
   * to its pool entry. The supervisor is responsible for removing the
   * entry — this method only handles the worker-side drain.
   *
   * @returns {Promise<string>} The worker id.
   */
  async retire() {
    if (
      this.#status === 'terminating' ||
      this.#status === 'terminated' ||
      this.#status === 'draining' ||
      this.#status === 'recycling' ||
      this.#status === 'preempting'
    ) {
      return this.id;
    }

    if (this.#status === 'idle') {
      await this.terminate();
      return this.id;
    }

    // `busy` (or `stream` task in flight). Mark as `draining` so the
    // supervisor's `findWorkerForTask` skips us (isIdle returns false)
    // and so the task-complete handler keeps the status pinned until we
    // explicitly terminate.
    this.#status = 'draining';

    return new Promise((resolve) => {
      const onSettled = () => {
        // Belt + suspenders: task_completed flips status to 'idle' only
        // when not in 'draining'/'recycling'/'terminating'. Pin it
        // before terminate so no observer ever sees 'idle' on a draining
        // worker.
        this.#status = 'terminating';
        this.terminate()
          .then(() => resolve(this.id))
          .catch(() => resolve(this.id)); // termination errors are not actionable
      };
      this.once('task_completed', onSettled);
      this.once('task_failed', onSettled);
    });
  }

  /**
   * Gracefully terminates the worker thread.
   */
  async terminate() {
    this.#clearWatchdog();
    if (this.#status !== 'preempting') {
      this.#status = 'terminating';
    }
    const worker = this.#worker;
    if (worker) {
      this.#worker = null;
      await worker.terminate();
    }
    this.#status = 'terminated';
  }
}
