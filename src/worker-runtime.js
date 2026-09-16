import { EventEmitter } from 'node:events';
import { availableParallelism } from 'node:os';
import { TaskHandle } from './task-handle.js';
import { TaskQueue } from './task-queue.js';
import { Supervisor } from './supervisor.js';
import { WorkerRuntimeError } from './errors.js';

/**
 * WorkerRuntime is the primary concurrency engine.
 * Coordinates execution between the Event Loop and persistent worker threads.
 */
export class WorkerRuntime extends EventEmitter {
  #queue;
  #supervisor;
  #isStarted = false;
  #isShuttingDown = false;
  #stats = {
    submittedTasks: 0,
    completedTasks: 0,
    failedTasks: 0,
  };

  constructor(options = {}) {
    super();
    const defaultWorkers = Math.max(1, availableParallelism() - 1);
    const workerCount = options.workers || defaultWorkers;

    this.#queue = new TaskQueue({
      maxQueueSize: options.maxQueueSize || 2000,
      queueTimeoutMs: options.queueTimeoutMs || 30000,
    });

    this.#supervisor = new Supervisor({
      workers: workerCount,
      workerScript: options.workerScript,
      handlerPath: options.handlerPath,
      resourceLimits: options.resourceLimits,
    });

    // Wire supervisor events to runtime events
    this.#supervisor.on('worker_ready', (worker) => {
      this.#scheduleNext();
      this.emit('worker:ready', { workerId: worker.id });
    });

    this.#supervisor.on('worker_replaced', ({ oldId, newId }) => {
      this.#scheduleNext();
      this.emit('worker:replaced', { oldId, newId });
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
        const delay = task.backoff === 'exponential'
          ? task.retryDelayMs * Math.pow(2, task.attempts - 1)
          : (task.backoff === 'linear' ? task.retryDelayMs * task.attempts : task.retryDelayMs);

        this.emit('task:retrying', {
          taskId: task.id,
          attempt: task.attempts,
          maxRetries: task.retries,
          delayMs: delay,
          error,
        });

        setTimeout(() => {
          if (!this.#isShuttingDown && !task.isSettled) {
            this.#queue.enqueue(task)
              .then(() => this.#scheduleNext())
              .catch(() => {});
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
    };
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
   * Submits a task and awaits its result (interactive request-response mode).
   * @param {Object|Function} taskDefinition
   * @returns {Promise<any>}
   */
  async execute(taskDefinition) {
    const handle = this.dispatch(taskDefinition);
    return handle.promise;
  }

  /**
   * Dispatches a task in the background without blocking, returning a TaskHandle immediately.
   * Ideal for outbox patterns, email sending, webhooks, and asynchronous side-effects.
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

    const task = new TaskHandle(taskOptions);
    this.#stats.submittedTasks++;

    // Enqueue asynchronously without blocking the Event Loop
    this.#queue.enqueue(task)
      .then(() => {
        this.#scheduleNext();
      })
      .catch((err) => {
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
    await this.#supervisor.shutdown();
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
