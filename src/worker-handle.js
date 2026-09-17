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
  executeStreamTask({ taskId, fnCode, payload, onChunk, onEnd, onError, onAbort }) {
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
