import { EventEmitter } from 'node:events';
import { WorkerHandle } from './worker-handle.js';

/**
 * Supervisor monitors worker lifecycles, detects crashes, and maintains pool capacity automatically.
 */
export class Supervisor extends EventEmitter {
  #workers = new Map(); // workerId -> WorkerHandle
  #isShuttingDown = false;
  // PWR-001 fix: idempotent start(). The second call is a no-op so the
  // pool doesn't double. Reset in shutdown() so post-shutdown restart
  // still works (consistent with the existing #isShuttingDown reset in
  // start()).
  #isStarted = false;
  #workerOptions;
  #targetWorkers;
  #maxTasksPerWorker;
  #maxMemoryMb;
  #forceKillOnTimeout;
  #killGracePeriodMs;
  #recycledCount = 0;
  #preemptedCount = 0;
  // HARDEN-06 (ADR-0024 C1): per-worker memory accumulation-rate tracking.
  // When `accumulationRateMbPerSec !== Infinity`, a background timer
  // samples each worker's `lastMemoryUsageBytes` at `#accumulationPollIntervalMs`
  // and computes an EWMA-smoothed rate. Rate exceeding the threshold fires
  // `worker_recycling` with `reason: 'accumulation_exceeded'` BEFORE the
  // absolute `maxMemoryMb` threshold — catches slow leaks early.
  // `#accumulationHistory[workerId]` is a ring buffer of the last 3 samples
  // (per ADR-0024 C1: "EWMA over last 3 samples"). `#accumulationEwma[workerId]`
  // carries the smoothed rate across ticks so the EWMA is stable across
  // sample windows rather than resetting per batch.
  #accumulationRateMbPerSec = Infinity;
  #accumulationHistory = new Map(); // workerId -> Array<{atMs, bytes}>
  #accumulationEwma = new Map(); // workerId -> MB/s (smoothed)
  #accumulationPollTimer = null;
  // HARDEN-07 (ADR-0024 C2): per-worker recycle hysteresis. Records the
  // wall-clock timestamp of each worker's LAST ACTUAL recycle. Subsequent
  // `#checkRecycling` decisions for the same worker within
  // `minRecycleIntervalMs` are throttled — emit `worker_recycle:skipped`
  // instead of triggering another `markRecycling` + spawn cycle. Prevents
  // pool thrashing when a worker's memory is leaking fast (e.g. user code
  // bug that persists across isolates) and the rate would otherwise
  // recycle every poll tick.
  #minRecycleIntervalMs = 30000;
  #lastRecycledAt = new Map(); // workerId -> ms timestamp
  // HARDEN-08 (ADR-0024 C3): opt-out from recycling on
  // `maxTasksPerWorker` exhaustion. When `false`, the worker exceeding
  // the task limit emits `worker_tasks:exhausted` warning event instead
  // of being recycled. The user keeps full control — they decide
  // externally when (if ever) to drain + recycle.
  // Default `true` preserves the pre-HARDEN-08 behavior.
  // `#tasksExhaustedNotified` is a per-worker idempotency guard so the
  // warning fires at most once per worker exhaustion cycle (avoids
  // spamming the listener on every subsequent `task_completed`).
  #recycleOnTasksExhausted = true;
  #tasksExhaustedNotified = new Set(); // workerId (one-shot per worker)
  // Hard-coded 1000 ms for T6; T10 (HARDEN-10 / Wave 4) exposes this as
  // `workerPollIntervalMs` and decouples it from `timeoutMs`.
  #accumulationPollIntervalMs = 1000;

  constructor(options = {}) {
    super();
    // ADR-0023 (T6) — the previous `options.workers || 4` magic-number
    // fallback was unreachable: `WorkerRuntime` always passes a finite
    // integer >= 1 to the Supervisor after running its options through
    // `resolveWorkerCount()`. We replace the silent fallback with an
    // explicit validation that fails fast when the contract is broken
    // (e.g. a third-party consumer constructs a `Supervisor` directly
    // without `workers`).
    if (
      typeof options.workers !== 'number' ||
      !Number.isInteger(options.workers) ||
      options.workers < 1
    ) {
      throw new RangeError(
        `Supervisor: options.workers must be a positive integer, got ${options.workers}`,
      );
    }
    this.#targetWorkers = options.workers;
    this.#maxTasksPerWorker =
      options.maxTasksPerWorker === undefined ? Infinity : options.maxTasksPerWorker;
    this.#maxMemoryMb = options.maxMemoryMb === undefined ? Infinity : options.maxMemoryMb;
    this.#forceKillOnTimeout = Boolean(options.forceKillOnTimeout);
    this.#killGracePeriodMs =
      options.killGracePeriodMs === undefined ? 500 : options.killGracePeriodMs;
    // HARDEN-06 (ADR-0024 C1): accumulation-rate guard. `Infinity` =
    // disabled (back-compat default); positive number = threshold in MB/s.
    // Negative or non-numeric values throw so a typo doesn't silently
    // disable recycling.
    if (options.accumulationRateMbPerSec === undefined) {
      this.#accumulationRateMbPerSec = Infinity;
    } else if (
      typeof options.accumulationRateMbPerSec !== 'number' ||
      Number.isNaN(options.accumulationRateMbPerSec)
    ) {
      throw new TypeError(
        `Supervisor: options.accumulationRateMbPerSec must be a non-negative number or Infinity, got ${options.accumulationRateMbPerSec}`,
      );
    } else if (options.accumulationRateMbPerSec < 0) {
      throw new RangeError(
        `Supervisor: options.accumulationRateMbPerSec must be non-negative or Infinity, got ${options.accumulationRateMbPerSec}`,
      );
    } else {
      this.#accumulationRateMbPerSec = options.accumulationRateMbPerSec;
    }
    // HARDEN-07 (ADR-0024 C2): recycle hysteresis. `0` (default) disables
    // the throttle — back-compat with the pre-HARDEN-07 behavior. A
    // positive number is the minimum ms between consecutive recycles of
    // the SAME worker. Negative values throw so a typo doesn't silently
    // pin the pool (always throttled = no recycle ever).
    if (options.minRecycleIntervalMs === undefined) {
      this.#minRecycleIntervalMs = 30000;
    } else if (
      typeof options.minRecycleIntervalMs !== 'number' ||
      Number.isNaN(options.minRecycleIntervalMs)
    ) {
      throw new TypeError(
        `Supervisor: options.minRecycleIntervalMs must be a non-negative number, got ${options.minRecycleIntervalMs}`,
      );
    } else if (options.minRecycleIntervalMs < 0) {
      throw new RangeError(
        `Supervisor: options.minRecycleIntervalMs must be non-negative, got ${options.minRecycleIntervalMs}`,
      );
    } else {
      this.#minRecycleIntervalMs = options.minRecycleIntervalMs;
    }
    // HARDEN-08 (ADR-0024 C3): opt-out from recycling on tasks-exhausted.
    // `true` (default) preserves the pre-HARDEN-08 behavior. `false`
    // emits a one-time `worker_tasks:exhausted` warning event per worker
    // instead of recycling — the user controls recycling externally.
    if (options.recycleOnTasksExhausted !== undefined) {
      if (typeof options.recycleOnTasksExhausted !== 'boolean') {
        throw new TypeError(
          `Supervisor: options.recycleOnTasksExhausted must be a boolean, got ${typeof options.recycleOnTasksExhausted}`,
        );
      }
      this.#recycleOnTasksExhausted = options.recycleOnTasksExhausted;
    }
    this.#workerOptions = {
      workerScript: options.workerScript,
      handlerPath: options.handlerPath,
      resourceLimits: options.resourceLimits,
      // HARDEN-05 (ADR-0024 B3): propagate opt-in memory observability.
      // When false (default), no overhead — WorkerHandle skips the emit
      // branch entirely.
      observeMemory: options.observeMemory === true,
      memoryEmitIntervalMs:
        typeof options.memoryEmitIntervalMs === 'number' && options.memoryEmitIntervalMs > 0
          ? options.memoryEmitIntervalMs
          : 1000,
    };
  }

  get maxTasksPerWorker() {
    return this.#maxTasksPerWorker;
  }

  get maxMemoryMb() {
    return this.#maxMemoryMb;
  }

  // HARDEN-06 (ADR-0024 C1): exposes the configured accumulation-rate
  // threshold for tests / dashboards. `Infinity` means the rate-based
  // guard is disabled (default).
  get accumulationRateMbPerSec() {
    return this.#accumulationRateMbPerSec;
  }

  // HARDEN-07 (ADR-0024 C2): exposes the configured recycle hysteresis
  // window. `0` means no throttle (back-compat default per ADR-0010);
  // positive number is the minimum ms between consecutive recycles of
  // the SAME worker.
  get minRecycleIntervalMs() {
    return this.#minRecycleIntervalMs;
  }

  // HARDEN-08 (ADR-0024 C3): exposes the tasks-exhausted recycle opt.
  // `true` (default) recycles on `maxTasksPerWorker` (pre-HARDEN-08
  // behavior). `false` emits `worker_tasks:exhausted` warning event
  // instead — user controls recycling externally.
  get recycleOnTasksExhausted() {
    return this.#recycleOnTasksExhausted;
  }

  /**
   * HARDEN-07 (ADR-0024 C2): returns the wall-clock ms timestamp of the
   * worker's last ACTUAL recycle, or `null` if the worker has never been
   * recycled. Useful for tests and dashboards that want to display
   * "time since last recycle" per worker.
   *
   * @param {string} workerId
   * @returns {number | null}
   */
  getLastRecycledAt(workerId) {
    return this.#lastRecycledAt.get(workerId) ?? null;
  }

  get forceKillOnTimeout() {
    return this.#forceKillOnTimeout;
  }

  get killGracePeriodMs() {
    return this.#killGracePeriodMs;
  }

  get recycledCount() {
    return this.#recycledCount;
  }

  get preemptedCount() {
    return this.#preemptedCount;
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
   * HARDEN-03 (ADR-0024 B1): returns an in-memory snapshot of every worker
   * the supervisor currently tracks. Sync, zero-IPC — each entry is built
   * from `worker.snapshot()` which reads private fields. Returned array is
   * fresh per call (callers may mutate elements without affecting state).
   *
   * @returns {Array<ReturnType<import('./worker-handle.js').WorkerHandle['prototype']['snapshot']>>}
   */
  getWorkerSnapshots() {
    return Array.from(this.#workers.values()).map((w) => w.snapshot());
  }

  /**
   * Initializes the pool up to the target worker count and waits for them to be ready.
   *
   * Idempotent (PWR-001 fix): if the supervisor is already started and
   * not shutting down, this is a no-op. Calling start() twice does NOT
   * duplicate the pool. Reset `#isStarted` in shutdown() so a post-
   * shutdown restart still works.
   */
  async start() {
    if (this.#isStarted) return;
    this.#isShuttingDown = false;
    this.#isStarted = true;
    // HARDEN-06 (ADR-0024 C1): start the accumulation-rate sampling poll
    // ONLY when the user opted into a finite threshold. The poll is
    // otherwise a no-op (no timer) — keeps the disabled-by-default
    // path truly zero-overhead.
    this.#startAccumulationPoll();
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
        (w) => w.affinityKey === task.affinityKey || w.name === task.affinityKey,
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
   * Spawns a new general-purpose worker and returns its id. Wired into
   * the adaptive concurrency controller's `spawnIdleWorker` callback
   * (T7 — ADR-0014) so the controller can grow the pool within the
   * `[minWorkers, maxWorkers]` band without touching the private
   * `#spawnWorker` machinery.
   *
   * Returns `null` when shutting down (matches the "graceful no-op"
   * contract documented on the controller's spawn callback — the
   * controller treats `null`/empty as "no spawn", no state mutation).
   *
   * @returns {Promise<string | null>}
   */
  async spawnIdleWorker() {
    if (this.#isShuttingDown) return null;
    const worker = await this.#spawnWorker();
    return worker?.id ?? null;
  }

  /**
   * Picks the general-purpose worker with the smallest
   * `tasksCompleted` (LRU proxy — fewer completions ⇒ less
   * warmed-up ⇒ cheaper to drop without losing work) and drains it.
   * Wired into the adaptive concurrency controller's
   * `retireLowestLoadWorker` callback (T7 — ADR-0014). The controller's
   * fire site already enforces the `effectiveWorkers > minWorkers`
   * band (T5), so this method trusts the call to have room to retire.
   *
   * "Drain" semantics per ADR-0014 / ADAPTIVE-09:
   *   - No `worker.terminate()` while a task is in-flight (no forced
   *     kill — that is the ADR-0011 preemption escape hatch).
   *   - The worker is marked `draining` so the supervisor's
   *     `findWorkerForTask` skips it (won't dispatch new tasks).
   *   - When the in-flight task settles, the worker terminates.
   *   - The supervisor pool entry is removed eagerly so a concurrent
   *     grow-fire cannot race against the drain and over-spawn.
   *
   * Returns the retired worker id, or `null` when no general-purpose
   * worker is eligible (all are dedicated, draining, recycling, or
   * already on their way out).
   *
   * @returns {Promise<string | null>}
   */
  async retireLowestLoadWorker() {
    if (this.#isShuttingDown) return null;

    // Filter out workers that cannot be retired (dedicated, already
    // draining, recycling, preempting). LRU proxy: smallest
    // `tasksCompleted` is the cheapest to drop.
    let candidate = null;
    for (const w of this.#workers.values()) {
      if (w.isDedicated) continue;
      if (
        w.status === 'draining' ||
        w.status === 'recycling' ||
        w.status === 'terminating' ||
        w.status === 'terminated' ||
        w.status === 'preempting'
      ) {
        continue;
      }
      if (candidate === null || w.tasksCompleted < candidate.tasksCompleted) {
        candidate = w;
      }
    }
    if (candidate === null) return null;

    // Eagerly remove from the pool so a concurrent grow-fire sees the
    // post-retire size. The worker is still alive (draining) so any
    // in-flight task completes naturally.
    this.#workers.delete(candidate.id);
    try {
      const workerId = await candidate.retire();
      return workerId;
    } catch {
      return null;
    }
  }

  /**
   * Checks whether a worker has exceeded task or memory limits and initiates recycling.
   *
   * HARDEN-07 (ADR-0024 C2): hysteresis is checked AFTER reason
   * determination but BEFORE the recycling guard, so the skipped event
   * fires for any would-recycle decision within the window — even when
   * the worker is already in `recycling` state from a prior decision.
   * Without this ordering, the recycling guard would mask the skipped
   * event and the hysteresis would never be observable for workers that
   * were flagged multiple times before their replacement was ready.
   */
  #checkRecycling(worker) {
    if (this.#isShuttingDown) return;
    if (worker.isDedicated) return;

    let reason = null;
    if (worker.tasksCompleted >= this.#maxTasksPerWorker) {
      reason = 'tasks_exceeded';
    } else if (
      this.#accumulationRateMbPerSec !== Infinity &&
      this.getAccumulationRateMbPerSec(worker.id) > this.#accumulationRateMbPerSec
    ) {
      // HARDEN-06 (ADR-0024 C1): rate-based recycling fires BEFORE the
      // absolute `maxMemoryMb` threshold when growth is fast enough. The
      // poll tick has already updated the EWMA by the time we read it
      // here, so the value is fresh.
      reason = 'accumulation_exceeded';
    } else if (
      this.#maxMemoryMb !== Infinity &&
      worker.lastMemoryUsageBytes / (1024 * 1024) >= this.#maxMemoryMb
    ) {
      reason = 'memory_exceeded';
    }

    if (!reason) return;

    // HARDEN-08 (ADR-0024 C3): opt-out from recycling on tasks-exhausted.
    // When the user set `recycleOnTasksExhausted: false`, the supervisor
    // emits a one-time `worker_tasks:exhausted` warning event per worker
    // and skips the recycle decision. Memory and accumulation reasons
    // are NOT affected — they still trigger recycling because they're
    // crash-class signals (OOM, leak), not "warmed-up" thresholds like
    // task count. The opt-out only applies to the tasks-exhausted path.
    if (reason === 'tasks_exceeded' && !this.#recycleOnTasksExhausted) {
      if (!this.#tasksExhaustedNotified.has(worker.id)) {
        this.#tasksExhaustedNotified.add(worker.id);
        this.emit('worker_tasks:exhausted', {
          workerId: worker.id,
          tasksCompleted: worker.tasksCompleted,
          maxTasksPerWorker: this.#maxTasksPerWorker,
        });
      }
      return;
    }

    // HARDEN-07 (ADR-0024 C2): throttle when the same worker was
    // recycled less than `minRecycleIntervalMs` ago. The skipped event
    // payload carries `lastRecycledAt` so dashboards can render the
    // "throttled until" time. Runs BEFORE the recycling guard so an
    // already-recycling worker still emits the skipped event for the
    // would-recycle reason (otherwise the guard would silently no-op).
    if (this.#minRecycleIntervalMs > 0) {
      const lastAt = this.#lastRecycledAt.get(worker.id);
      if (lastAt !== undefined && Date.now() - lastAt < this.#minRecycleIntervalMs) {
        this.emit('worker_recycle:skipped', {
          workerId: worker.id,
          reason: 'hysteresis',
          lastRecycledAt: lastAt,
        });
        return;
      }
    }

    // Recycling guard: prevents double-recycling. With hysteresis
    // checked above, a second decision for the SAME worker within the
    // window emits a skipped event instead — so the guard is only
    // relevant for the rare case of `minRecycleIntervalMs === 0` (no
    // throttle, e.g. pre-HARDEN-07 behavior) where the same worker
    // could otherwise be marked recycling twice.
    if (worker.isRecycling || worker.status === 'terminating' || worker.status === 'terminated')
      return;

    worker.markRecycling();
    // HARDEN-07 (ADR-0024 C2): record `lastRecycledAt` at decision time
    // (right after markRecycling, BEFORE the spawn). This means a
    // subsequent `#checkRecycling` for the same worker — fired while
    // it's still in the pool in 'recycling' state, awaiting its
    // replacement — sees the timestamp and emits `worker_recycle:skipped`
    // immediately. If we recorded it AFTER `worker.terminate()` (the
    // current `worker_recycled` site), the worker would already be
    // removed from the pool by then and follow-up `forceRecycleCheck`
    // calls would no-op. Trade-off: if the spawn later fails, the
    // timestamp is stale — but a failed spawn is fatal anyway, and the
    // supervisor rebuilds from scratch on next start.
    this.#lastRecycledAt.set(worker.id, Date.now());

    this.emit('worker_recycling', {
      workerId: worker.id,
      reason,
      tasksCompleted: worker.tasksCompleted,
      memoryUsage: worker.lastMemoryUsageBytes,
    });

    this.#spawnWorker()
      .then(async (replacement) => {
        if (!replacement) return;

        if (this.#isShuttingDown) {
          await replacement.terminate();
          await worker.terminate();
          return;
        }

        await worker.terminate();
        this.#recycledCount++;

        this.emit('worker_recycled', {
          oldWorkerId: worker.id,
          newWorkerId: replacement.id,
        });
      })
      .catch((err) => {
        this.emit('error', err);
      });
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

    worker.on('exit', ({ worker, exitCode, prevStatus, isPreempted }) => {
      this.#workers.delete(worker.id);
      // HARDEN-06 (ADR-0024 C1): drop per-worker accumulation state when
      // the worker exits. `worker.id` can be re-assigned to a fresh worker
      // after restart, so leaving stale EWMA values would silently bias
      // the rate of the replacement worker.
      this.#accumulationHistory.delete(worker.id);
      this.#accumulationEwma.delete(worker.id);
      // HARDEN-07 (ADR-0024 C2): drop the recycle timestamp too — same
      // reasoning. A recycled-out worker is gone; its hysteresis state
      // must not survive into a restart that reuses the worker id.
      this.#lastRecycledAt.delete(worker.id);
      // HARDEN-08 (ADR-0024 C3): drop the tasks-exhausted notification
      // idempotency flag so a replacement worker (same id reused after
      // recycle) gets a fresh warning when IT exhausts.
      this.#tasksExhaustedNotified.delete(worker.id);
      this.emit('worker_exit', { workerId: worker.id, exitCode, prevStatus, isPreempted });

      // If worker was preempted and we are not shutting down, immediately spawn a replacement
      if (
        !this.#isShuttingDown &&
        !worker.isDedicated &&
        (isPreempted || prevStatus === 'preempting' || worker.isPreempted)
      ) {
        this.emit('worker_preempted', { workerId: worker.id, exitCode });
        this.#spawnWorker()
          .then((replacement) => {
            if (replacement) {
              this.emit('worker_replaced', { oldId: worker.id, newId: replacement.id });
            }
          })
          .catch((err) => {
            this.emit('error', err);
          });
        return;
      }

      // If worker crashed and we are not shutting down, automatically spawn a replacement
      if (
        !this.#isShuttingDown &&
        !worker.isDedicated &&
        prevStatus !== 'terminating' &&
        prevStatus !== 'recycling' &&
        !worker.isRecycling
      ) {
        this.emit('worker_restarting', { crashedWorkerId: worker.id, exitCode });
        this.#spawnWorker()
          .then((replacement) => {
            if (replacement) {
              this.emit('worker_replaced', { oldId: worker.id, newId: replacement.id });
            }
          })
          .catch((err) => {
            this.emit('error', err);
          });
      }
    });

    worker.on('task_preempted', (data) => {
      this.#preemptedCount++;
      this.emit('task_preempted', data);
    });

    worker.on('task_completed', (data) => {
      this.#checkRecycling(data.worker);
      this.emit('task_completed', data);
    });

    // HARDEN-05 (ADR-0024 B3): forward opt-in `memory` events from the
    // worker handle to the supervisor (and through it, the runtime).
    // WorkerHandle already rate-limits emission per its own config; the
    // supervisor is a passive re-emit point. When `observeMemory` is
    // false (default), this listener never fires — the WorkerHandle
    // short-circuits the emit branch.
    worker.on('memory', (data) => {
      this.emit('worker_memory', data);
    });

    worker.on('task_failed', (data) => {
      this.#checkRecycling(data.worker);
      this.emit('task_failed', data);
    });

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
    this.#isStarted = false; // PWR-001: allow post-shutdown restart
    this.#stopAccumulationPoll();
    // HARDEN-06 (ADR-0024 C1): clear per-worker accumulation state so a
    // post-shutdown restart doesn't inherit stale EWMA rates from the
    // previous pool (workerIds collide across restarts).
    this.#accumulationHistory.clear();
    this.#accumulationEwma.clear();
    // HARDEN-07 (ADR-0024 C2): same reasoning for the hysteresis map —
    // a post-shutdown restart must NOT inherit stale `lastRecycledAt`
    // entries from the previous pool.
    this.#lastRecycledAt.clear();
    // HARDEN-08 (ADR-0024 C3): same reasoning for the tasks-exhausted
    // notification set — a post-shutdown restart starts fresh.
    this.#tasksExhaustedNotified.clear();
    const terminations = Array.from(this.#workers.values()).map((w) => w.terminate());
    await Promise.all(terminations);
    this.#workers.clear();
  }

  /**
   * HARDEN-07 (ADR-0024 C2): forces an immediate `#checkRecycling` for the
   * given worker. Useful for operators who want to drain a specific
   * worker (e.g. before a rolling deploy) without waiting for the next
   * `task_completed` or poll tick. Returns `false` if the worker is not
   * in the pool (already recycled, dedicated, or shutting down).
   *
   * Side effects:
   *   - Emits `worker_recycle:skipped` when hysteresis blocks the decision.
   *   - Emits `worker_recycling` + spawns a replacement when the decision
   *     is committed (existing `#checkRecycling` behavior).
   *
   * @param {string} workerId
   * @returns {boolean} `true` if the worker was found and a check ran;
   *   `false` if the worker is no longer in the pool.
   */
  forceRecycleCheck(workerId) {
    if (this.#isShuttingDown) return false;
    const worker = this.#workers.get(workerId);
    if (!worker) return false;
    if (worker.isDedicated) return false;
    this.#checkRecycling(worker);
    return true;
  }

  /**
   * HARDEN-06 (ADR-0024 C1): starts the periodic accumulation-rate sampler.
   * No-op when `accumulationRateMbPerSec === Infinity` so the disabled
   * default path stays zero-overhead. The sampler is a `setInterval`
   * (not per-worker timers) so the cost is O(1) regardless of pool size.
   */
  #startAccumulationPoll() {
    if (this.#accumulationPollTimer !== null) return;
    if (this.#accumulationRateMbPerSec === Infinity) return;
    this.#accumulationPollTimer = setInterval(() => {
      for (const worker of this.#workers.values()) {
        this.#sampleAccumulation(worker);
        // Re-check recycling against the now-fresh EWMA rate. Cheap when
        // no rate is exceeded (existing `if (!reason) return;` guard).
        this.#checkRecycling(worker);
      }
    }, this.#accumulationPollIntervalMs);
    // `unref` so the poll never keeps the event loop alive on its own —
    // the workers themselves hold the loop open.
    if (typeof this.#accumulationPollTimer.unref === 'function') {
      this.#accumulationPollTimer.unref();
    }
  }

  #stopAccumulationPoll() {
    if (this.#accumulationPollTimer === null) return;
    clearInterval(this.#accumulationPollTimer);
    this.#accumulationPollTimer = null;
  }

  /**
   * HARDEN-06 (ADR-0024 C1): pushes a (atMs, bytes) sample for the given
   * worker into the 3-sample history ring and refreshes the EWMA rate.
   * Called from the supervisor's poll tick.
   */
  #sampleAccumulation(worker) {
    let history = this.#accumulationHistory.get(worker.id);
    if (!history) {
      history = [];
      this.#accumulationHistory.set(worker.id, history);
    }
    history.push({ atMs: Date.now(), bytes: worker.lastMemoryUsageBytes });
    // ADR-0024 C1: "EWMA over last 3 samples" — bounded ring buffer.
    while (history.length > 3) history.shift();
    // Refresh the EWMA state so `#getAccumulationRate` reflects the new
    // sample without re-walking the history. Idempotent for tests.
    this.#computeAccumulationRate(worker);
  }

  /**
   * HARDEN-06 (ADR-0024 C1): returns the EWMA-smoothed accumulation rate
   * (MB/s) for the given worker, or 0 when fewer than 2 samples are
   * available. The EWMA smooths the per-tick instantaneous rate
   * (computed from the two most recent samples) so transient GC pauses
   * or jitter don't trigger spurious recycling. α = 0.3 matches the
   * convention used by `adaptive-controller.js` Ewma.
   */
  #computeAccumulationRate(worker) {
    const history = this.#accumulationHistory.get(worker.id);
    if (!history || history.length < 2) {
      this.#accumulationEwma.set(worker.id, 0);
      return 0;
    }
    const newest = history[history.length - 1];
    const prev = history[history.length - 2];
    const bytesDelta = newest.bytes - prev.bytes;
    const msDelta = newest.atMs - prev.atMs;
    if (msDelta <= 0) {
      // Same-millisecond samples (very fast polling) — keep the prior
      // EWMA unchanged so the rate doesn't snap to zero.
      return this.#accumulationEwma.get(worker.id) ?? 0;
    }
    const instantaneousMbPerSec = bytesDelta / (1024 * 1024) / (msDelta / 1000);
    const prevEwma = this.#accumulationEwma.get(worker.id);
    const ewma =
      prevEwma === undefined ? instantaneousMbPerSec : 0.3 * instantaneousMbPerSec + 0.7 * prevEwma;
    this.#accumulationEwma.set(worker.id, ewma);
    return ewma;
  }

  /**
   * HARDEN-06 (ADR-0024 C1): public read-only accessor for tests /
   * dashboards. Returns the EWMA-smoothed rate in MB/s, or 0 when the
   * worker has fewer than 2 samples (no rate computable yet).
   */
  getAccumulationRateMbPerSec(workerId) {
    const ewma = this.#accumulationEwma.get(workerId);
    if (ewma !== undefined) return ewma;
    const worker = this.#workers.get(workerId);
    if (!worker) return 0;
    return this.#computeAccumulationRate(worker);
  }
}
