import { TaskQueueTimeoutError } from './errors.js';

/**
 * TaskQueue with asynchronous backpressure waiting and timeout guarantees.
 * Ensures the main Event Loop never blocks when queue capacity is reached.
 */
export class TaskQueue {
  #queue = [];
  #waiters = [];
  #affinityIndex = new Map(); // affinityKey -> Set<TaskHandle>
  #maxQueueSize;
  #defaultQueueTimeoutMs;

  constructor(options = {}) {
    this.#maxQueueSize = options.maxQueueSize || 1000;
    this.#defaultQueueTimeoutMs = options.queueTimeoutMs || 30000;
  }

  get size() {
    return this.#queue.length;
  }

  get waitingCount() {
    return this.#waiters.length;
  }

  /**
   * Enqueues a task handle. If queue is at capacity, waits asynchronously up to queueTimeoutMs.
   * @param {TaskHandle} task
   * @returns {Promise<void>} Resolves when the task is officially queued or rejects on timeout.
   */
  async enqueue(task) {
    if (task.isSettled) return;

    if (this.#queue.length < this.#maxQueueSize) {
      this.#insert(task);
      return;
    }

    // Queue is full: apply async non-blocking backpressure with timeout
    const timeoutMs = task.queueTimeoutMs || this.#defaultQueueTimeoutMs;

    return new Promise((resolve, reject) => {
      const waitEntry = {
        task,
        timer: null,
        resolve: () => {
          if (waitEntry.timer) clearTimeout(waitEntry.timer);
          this.#insert(task);
          resolve();
        },
        reject: (err) => {
          if (waitEntry.timer) clearTimeout(waitEntry.timer);
          reject(err);
        },
      };

      waitEntry.timer = setTimeout(() => {
        // Remove from waiters
        const idx = this.#waiters.indexOf(waitEntry);
        if (idx !== -1) this.#waiters.splice(idx, 1);

        const err = new TaskQueueTimeoutError(
          `Task ${task.id} timed out waiting for queue capacity after ${timeoutMs}ms`,
          {
            taskId: task.id,
            waitedMs: timeoutMs,
            queueDepth: this.#queue.length,
          },
        );
        task.reject(err);
        reject(err);
      }, timeoutMs);

      this.#waiters.push(waitEntry);
    });
  }

  /**
   * Dequeues the next appropriate task for the given worker.
   * Considers worker affinity and priority.
   * @param {WorkerHandle} worker
   * @returns {TaskHandle|null}
   */
  dequeue(worker = null) {
    if (this.#queue.length === 0) return null;

    let selectedIndex = -1;

    // 1. If worker has an assigned affinity or name, check for matching tasks
    if (worker && (worker.affinityKey || worker.name)) {
      const targetKey = worker.affinityKey || worker.name;
      selectedIndex = this.#queue.findIndex(
        (task) => !task.isSettled && task.affinityKey === targetKey,
      );
    }

    // 2. Otherwise, check for any unpinned task (affinityKey is null)
    if (selectedIndex === -1) {
      selectedIndex = this.#queue.findIndex(
        (task) => !task.isSettled && (!task.affinityKey || !worker?.isDedicated),
      );
    }

    if (selectedIndex === -1) {
      return null;
    }

    const [task] = this.#queue.splice(selectedIndex, 1);

    if (task.affinityKey) {
      const set = this.#affinityIndex.get(task.affinityKey);
      if (set) {
        set.delete(task);
        if (set.size === 0) this.#affinityIndex.delete(task.affinityKey);
      }
    }

    // Since we consumed a slot, promote the next waiting arrival if any
    this.#drainWaiters();

    return task;
  }

  #insert(task) {
    // Insert sorted by priority descending (higher number = higher priority)
    let insertIndex = this.#queue.length;
    for (let i = 0; i < this.#queue.length; i++) {
      if (task.priority > this.#queue[i].priority) {
        insertIndex = i;
        break;
      }
    }
    this.#queue.splice(insertIndex, 0, task);

    if (task.affinityKey) {
      if (!this.#affinityIndex.has(task.affinityKey)) {
        this.#affinityIndex.set(task.affinityKey, new Set());
      }
      this.#affinityIndex.get(task.affinityKey).add(task);
    }
  }

  #drainWaiters() {
    while (this.#waiters.length > 0 && this.#queue.length < this.#maxQueueSize) {
      const nextWaiter = this.#waiters.shift();
      if (nextWaiter.task.isSettled) {
        // Abandoned waiter: clear its timer and reject the enqueue promise
        // so callers awaiting enqueue() don't leak unhandled rejections.
        if (nextWaiter.timer) clearTimeout(nextWaiter.timer);
        nextWaiter.reject(new Error('Task was settled before queue capacity was available'));
        continue;
      }
      nextWaiter.resolve();
      break;
    }
  }

  /**
   * Clears the queue and rejects all pending tasks and waiters (used during shutdown).
   */
  destroy(reason = new Error('TaskQueue was destroyed')) {
    for (const waiter of this.#waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.task.reject(reason);
      waiter.reject(reason);
    }
    this.#waiters = [];

    for (const task of this.#queue) {
      task.reject(reason);
    }
    this.#queue = [];
    this.#affinityIndex.clear();
  }
}
