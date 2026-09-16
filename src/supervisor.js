import { EventEmitter } from 'node:events';
import { WorkerHandle } from './worker-handle.js';

/**
 * Supervisor monitors worker lifecycles, detects crashes, and maintains pool capacity automatically.
 */
export class Supervisor extends EventEmitter {
  #workers = new Map(); // workerId -> WorkerHandle
  #isShuttingDown = false;
  #workerOptions;
  #targetWorkers;
  #maxTasksPerWorker;
  #maxMemoryMb;

  constructor(options = {}) {
    super();
    this.#targetWorkers = options.workers || 4;
    this.#maxTasksPerWorker = options.maxTasksPerWorker === undefined ? Infinity : options.maxTasksPerWorker;
    this.#maxMemoryMb = options.maxMemoryMb === undefined ? Infinity : options.maxMemoryMb;
    this.#workerOptions = {
      workerScript: options.workerScript,
      handlerPath: options.handlerPath,
      resourceLimits: options.resourceLimits,
    };
  }

  get maxTasksPerWorker() {
    return this.#maxTasksPerWorker;
  }

  get maxMemoryMb() {
    return this.#maxMemoryMb;
  }

  get totalWorkers() {
    return this.#workers.size;
  }

  get idleWorkers() {
    return Array.from(this.#workers.values()).filter((w) => w.isIdle);
  }

  get allWorkers() {
    return Array.from(this.#workers.values());
  }

  /**
   * Initializes the pool up to the target worker count and waits for them to be ready.
   */
  async start() {
    this.#isShuttingDown = false;
    const spawnPromises = [];

    for (let i = 0; i < this.#targetWorkers; i++) {
      spawnPromises.push(this.#spawnWorker());
    }

    await Promise.all(spawnPromises);
  }

  /**
   * Finds an available idle worker, prioritizing affinity if task specifies an affinityKey.
   * @param {TaskHandle} task
   * @returns {WorkerHandle|null}
   */
  findWorkerForTask(task) {
    if (this.#isShuttingDown) return null;

    const idle = this.idleWorkers;
    if (idle.length === 0) return null;

    if (task.affinityKey) {
      // Look for a worker already pinned to this affinity
      const matched = idle.find(
        (w) => w.affinityKey === task.affinityKey || w.name === task.affinityKey
      );
      if (matched) return matched;

      // Or take any idle unpinned general worker and temporarily associate
      const unpinned = idle.find((w) => !w.isDedicated && !w.affinityKey);
      if (unpinned) return unpinned;
    }

    // Default: return first available idle general worker (not dedicated)
    return idle.find((w) => !w.isDedicated) || null;
  }

  /**
   * Spawns a new worker thread and registers lifecycle monitoring.
   */
  async #spawnWorker(overrides = {}) {
    if (this.#isShuttingDown) return null;

    const worker = new WorkerHandle({
      ...this.#workerOptions,
      ...overrides,
    });

    this.#workers.set(worker.id, worker);

    worker.on('exit', ({ worker, exitCode, prevStatus }) => {
      this.#workers.delete(worker.id);
      this.emit('worker_exit', { workerId: worker.id, exitCode, prevStatus });

      // If worker crashed and we are not shutting down, automatically spawn a replacement
      if (!this.#isShuttingDown && !worker.isDedicated && prevStatus !== 'terminating') {
        this.emit('worker_restarting', { crashedWorkerId: worker.id, exitCode });
        this.#spawnWorker().then((replacement) => {
          if (replacement) {
            this.emit('worker_replaced', { oldId: worker.id, newId: replacement.id });
          }
        }).catch((err) => {
          this.emit('error', err);
        });
      }
    });

    worker.on('task_completed', (data) => this.emit('task_completed', data));
    worker.on('task_failed', (data) => this.emit('task_failed', data));

    await worker.waitUntilReady();
    this.emit('worker_ready', worker);
    return worker;
  }

  /**
   * Creates a dedicated stateful worker with custom affinity or persistent role.
   */
  async createDedicatedWorker(options = {}) {
    return this.#spawnWorker({
      ...options,
      isDedicated: true,
    });
  }

  /**
   * Shuts down all workers cleanly.
   */
  async shutdown() {
    this.#isShuttingDown = true;
    const terminations = Array.from(this.#workers.values()).map((w) => w.terminate());
    await Promise.all(terminations);
    this.#workers.clear();
  }
}
