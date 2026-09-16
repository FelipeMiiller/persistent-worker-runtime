import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WorkerCrashError, WorkerRuntimeError } from './errors.js';

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
  #status = 'starting';
  #tasksCompleted = 0;
  #lastMemoryUsageBytes = 0;
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
        const task = this.#currentTask;
        this.#currentTask = null;

        if (typeof message.memoryUsageBytes === 'number') {
          this.#lastMemoryUsageBytes = message.memoryUsageBytes;
        }

        if (this.#status !== 'recycling' && this.#status !== 'terminating' && this.#status !== 'terminated') {
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
      }
    });

    this.#worker.on('error', (err) => {
      this.emit('error', err);
    });

    this.#worker.on('exit', (exitCode) => {
      const prevStatus = this.#status;
      this.#status = 'terminated';

      // If a task was running when worker died, reject with WorkerCrashError
      if (this.#currentTask) {
        const task = this.#currentTask;
        this.#currentTask = null;
        task.reject(
          new WorkerCrashError(
            `Worker ${this.id} crashed with exit code ${exitCode} while running task ${task.id}`,
            { workerId: this.id, exitCode, taskId: task.id }
          )
        );
      }

      this.emit('exit', { worker: this, exitCode, prevStatus });
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
    this.#status = 'terminating';
    if (this.#worker) {
      await this.#worker.terminate();
      this.#worker = null;
    }
    this.#status = 'terminated';
  }
}
