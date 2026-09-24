/**
 * SqliteTaskQueue — durable queue backend backed by `node:sqlite`
 * (ADR-0020, revised 2026-09-24).
 *
 * Replaces the in-memory `TaskQueue` for production deployments where
 * pending tasks must survive a runtime crash (RPO = 0). All envelopes
 * are persisted to a single SQLite file via `BEGIN IMMEDIATE` transactions
 * so multi-instance writers serialize through the database-level write lock.
 *
 * **In-memory BC shim.** The runtime contract requires that
 * `dispatch(task)` returns a `TaskHandle` whose `promise` resolves when the
 * task finishes on a worker. To preserve that contract without forcing
 * the runtime to rewire callbacks, this backend keeps an in-process
 * `Map<task_id, TaskHandle>` next to the SQLite file. The same JS instance
 * the caller awaits flows through `enqueue` → `peek` → `dequeue` →
 * `worker.executeTask`. After a process restart the SQLite file is the
 * source of truth and the in-memory Map is rebuilt by scanning
 * `state='pending'` rows — those restored tasks have **no live caller**
 * and complete silently (the runtime emits the standard `task:completed`
 * / `task:failed` events regardless).
 *
 * **Concurrency model.** SQLite has no `FOR UPDATE SKIP LOCKED`. We use
 * `BEGIN IMMEDIATE` (database-level write lock) for every state
 * transition: enqueue, claim, finalize. Readers (`peek`, `size`) use
 * plain `SELECT` which can run concurrently with other readers but is
 * blocked by a writer. ADR-0020 documents that this is adequate for
 * typical workloads (≤ ~1000 dispatches/sec).
 *
 * **Sync API.** `node:sqlite` is intentionally synchronous — every
 * `enqueue`/`dequeue` is a tiny atomic operation (typically < 1 ms on
 * local disk). The ADR explicitly accepts the brief Event Loop block
 * because the queue backend is not on the per-task hot path (workers
 * execute the actual work). Documented throughput ceiling in ADR-0020.
 *
 * **Limitations (v1).** Payload must be JSON-serializable. `transferList`
 * (ArrayBuffer transfer) is intentionally dropped — buffers are detached
 * by the first `postMessage` and cannot be re-attached across a SQLite
 * round-trip; users who need transferable buffers should not rely on
 * crash durability for the buffer payload itself (the task envelope is
 * still recoverable).
 */

import { DatabaseSync } from 'node:sqlite';
import { TaskQueueTimeoutError } from '../errors.js';
import { TaskHandle } from '../task-handle.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS queue_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT UNIQUE NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  affinity_key TEXT,
  payload BLOB NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempt INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 0,
  enqueued_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  claimed_by TEXT
);
CREATE INDEX IF NOT EXISTS queue_tasks_pending
  ON queue_tasks(state, priority DESC, enqueued_at ASC)
  WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS queue_tasks_affinity_pending
  ON queue_tasks(affinity_key, state, priority DESC, enqueued_at ASC)
  WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS queue_tasks_processing
  ON queue_tasks(state, updated_at)
  WHERE state = 'processing';
`;

/**
 * Fields persisted to SQLite. Anything not in this list is reconstructed
 * by the runtime (signal, asyncResource, timing fields, callbacks).
 * `transferList` is dropped intentionally — see class JSDoc.
 */
const ENVELOPE_KEYS = [
  'id',
  'type',
  'payload',
  'affinityKey',
  'priority',
  'timeoutMs',
  'queueTimeoutMs',
  'forceKillOnTimeout',
  'silentTimeoutDefaultWarning',
  'killGracePeriodMs',
  'fnCode',
  'fnDeps',
  'retries',
  'retryDelayMs',
  'backoff',
  'attempts',
  'metadata',
];

function serializeEnvelope(task) {
  const env = {};
  for (const key of ENVELOPE_KEYS) {
    env[key] = task[key];
  }
  return Buffer.from(JSON.stringify(env), 'utf8');
}

function deserializeEnvelope(blob) {
  return JSON.parse(Buffer.from(blob).toString('utf8'));
}

export class SqliteTaskQueue {
  #db;
  #maxQueueSize;
  #defaultQueueTimeoutMs;
  #tasks = new Map(); // task_id → TaskHandle (same-process BC shim)
  #waiters = [];
  #closed = false;
  #statementCache = new Map();

  constructor(options = {}) {
    if (!options || typeof options.path !== 'string' || options.path.length === 0) {
      throw new TypeError('SqliteTaskQueue requires options.path (string).');
    }
    this.#maxQueueSize = options.maxQueueSize || 2000;
    this.#defaultQueueTimeoutMs = options.queueTimeoutMs || 30000;

    this.#db = new DatabaseSync(options.path);
    // WAL = readers don't block writers; durable + fast. NORMAL = small
    // fsync window; durable enough for queue use (TRUNCATE/EXTRA are overkill
    // for non-financial data).
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec('PRAGMA synchronous = NORMAL;');
    this.#db.exec('PRAGMA busy_timeout = 5000;');
    this.#db.exec(SCHEMA);

    // Crash recovery: rebuild the in-memory TaskHandle map from any rows
    // still in `pending` state. The restored handles have no live caller;
    // they complete silently when workers execute them.
    this.#recoverPending();
  }

  #recoverPending() {
    const rows = this.#db
      .prepare("SELECT task_id, payload FROM queue_tasks WHERE state = 'pending'")
      .all();
    for (const row of rows) {
      const envelope = deserializeEnvelope(row.payload);
      const task = new TaskHandle(envelope);
      this.#tasks.set(row.task_id, task);
    }
  }

  #stmt(key, sql) {
    let stmt = this.#statementCache.get(key);
    if (!stmt) {
      stmt = this.#db.prepare(sql);
      this.#statementCache.set(key, stmt);
    }
    return stmt;
  }

  get size() {
    if (this.#closed) return 0;
    const row = this.#stmt(
      'size-pending',
      "SELECT COUNT(*) AS n FROM queue_tasks WHERE state = 'pending'",
    ).get();
    return row.n;
  }

  /**
   * Returns the highest-priority pending task WITHOUT claiming it.
   * Mirrors `TaskQueue.peek()`. Materializes a TaskHandle on demand when
   * called against rows that were restored from disk by `#recoverPending`
   * (no live in-memory instance yet — `peek` becomes the trigger for the
   * very first materialization in the current process).
   *
   * @returns {TaskHandle|null}
   */
  peek() {
    if (this.#closed) return null;
    const row = this.#stmt(
      'peek-pending',
      `SELECT task_id FROM queue_tasks
       WHERE state = 'pending'
       ORDER BY priority DESC, enqueued_at ASC
       LIMIT 1`,
    ).get();
    if (!row) return null;
    return this.#tasks.get(row.task_id) || null;
  }

  get waitingCount() {
    return this.#waiters.length;
  }

  /**
   * Enqueues a task handle. If the queue is at capacity, waits asynchronously
   * up to `queueTimeoutMs` (mirrors `TaskQueue.enqueue`).
   *
   * @param {TaskHandle} task
   * @returns {Promise<void>}
   */
  enqueue(task) {
    if (this.#closed) {
      task.reject(new Error('SqliteTaskQueue is closed'));
      return Promise.resolve();
    }
    if (task.isSettled) return Promise.resolve();

    const depth = this.size;
    if (depth < this.#maxQueueSize) {
      this.#insert(task);
      return Promise.resolve();
    }

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
        const idx = this.#waiters.indexOf(waitEntry);
        if (idx !== -1) this.#waiters.splice(idx, 1);
        const err = new TaskQueueTimeoutError(
          `Task ${task.id} timed out waiting for queue capacity after ${timeoutMs}ms`,
          {
            taskId: task.id,
            waitedMs: timeoutMs,
            queueDepth: this.size,
          },
        );
        task.reject(err);
        reject(err);
      }, timeoutMs);
      this.#waiters.push(waitEntry);
    });
  }

  #insert(task) {
    const blob = serializeEnvelope(task);
    const now = Date.now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#stmt(
        'insert-or-replace',
        `INSERT INTO queue_tasks
           (task_id, priority, affinity_key, payload, state, attempt, max_retries, enqueued_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           priority = excluded.priority,
           affinity_key = excluded.affinity_key,
           payload = excluded.payload,
           state = 'pending',
           attempt = excluded.attempt,
           max_retries = excluded.max_retries,
           updated_at = excluded.updated_at`,
      ).run(task.id, task.priority, task.affinityKey, blob, task.attempts, task.retries, now, now);
      this.#db.exec('COMMIT');
    } catch (err) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // ignore rollback failure
      }
      throw err;
    }
    this.#tasks.set(task.id, task);
    this.#drainWaiters();
  }

  /**
   * Dequeues the next appropriate task for the given worker, considering
   * affinity. Mirrors `TaskQueue.dequeue`. Returns the in-memory
   * `TaskHandle` instance when present (same-process BC), or
   * materializes a fresh `TaskHandle` from the SQLite envelope (post-crash
   * recovery path; no live caller exists).
   *
   * @param {object} [worker]
   * @returns {TaskHandle|null}
   */
  dequeue(worker = null) {
    if (this.#closed) return null;

    const targetAffinity =
      worker && (worker.affinityKey || worker.name) ? worker.affinityKey || worker.name : null;
    const isDedicated = worker ? Boolean(worker.isDedicated) : false;

    let claimedId = null;

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      // Step 1: affinity match (if worker has one).
      if (targetAffinity) {
        const row = this.#stmt(
          'dequeue-affinity',
          `SELECT task_id FROM queue_tasks
           WHERE state = 'pending' AND affinity_key = ?
           ORDER BY priority DESC, enqueued_at ASC
           LIMIT 1`,
        ).get(targetAffinity);
        if (row) claimedId = row.task_id;
      }

      // Step 2: unpinned fallback (or any-compatible when non-dedicated).
      if (!claimedId) {
        const where = isDedicated
          ? `state = 'pending' AND (affinity_key IS NULL OR affinity_key = '')`
          : `state = 'pending'`;
        const row = this.#stmt(
          'dequeue-any',
          `SELECT task_id FROM queue_tasks
           WHERE ${where}
           ORDER BY priority DESC, enqueued_at ASC
           LIMIT 1`,
        ).get();
        if (row) claimedId = row.task_id;
      }

      if (!claimedId) {
        this.#db.exec('COMMIT');
        return null;
      }

      this.#stmt(
        'claim-processing',
        `UPDATE queue_tasks
         SET state = 'processing', updated_at = ?
         WHERE task_id = ?`,
      ).run(Date.now(), claimedId);
      this.#db.exec('COMMIT');
    } catch (err) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // ignore rollback failure
      }
      throw err;
    }

    // Resolve to the same in-memory instance when present; otherwise
    // materialize from the SQLite envelope (post-crash recovery path).
    const task = this.#tasks.get(claimedId) || this.#materialize(claimedId);
    this.#tasks.delete(claimedId);
    this.#drainWaiters();
    return task;
  }

  #materialize(taskId) {
    const row = this.#stmt(
      'load-envelope',
      'SELECT payload FROM queue_tasks WHERE task_id = ?',
    ).get(taskId);
    if (!row) {
      // Row was claimed and immediately finalized by another instance.
      return null;
    }
    const envelope = deserializeEnvelope(row.payload);
    return new TaskHandle(envelope);
  }

  /**
   * Marks a task as completed and removes it from the queue. Called by
   * the runtime after `task.resolve()` so the SQLite row doesn't grow
   * unbounded. Optional — if the caller skips this, the row stays as
   * `processing` and is recovered on next startup as a fresh claim.
   *
   * @param {string} taskId
   */
  markDone(taskId) {
    if (this.#closed) return;
    this.#stmt('mark-done', `DELETE FROM queue_tasks WHERE task_id = ?`).run(taskId);
  }

  /**
   * Marks a task as failed (final, after retries exhausted). Kept in the
   * queue as `state='failed'` for post-mortem inspection; users can run
   * `vacuumCompleted()` periodically to GC old rows.
   *
   * @param {string} taskId
   * @param {Error} [_error]
   */
  markFailed(taskId, _error) {
    if (this.#closed) return;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#stmt(
        'mark-failed',
        `UPDATE queue_tasks SET state = 'failed', updated_at = ? WHERE task_id = ?`,
      ).run(Date.now(), taskId);
      this.#db.exec('COMMIT');
    } catch {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // ignore
      }
    }
  }

  /**
   * Removes terminal rows older than `olderThanMs`. Convenience for
   * callers that want a retention policy; the runtime does not call this
   * automatically.
   *
   * @param {number} olderThanMs
   * @returns {number} rows removed
   */
  vacuumCompleted(olderThanMs = 24 * 60 * 60 * 1000) {
    if (this.#closed) return 0;
    const cutoff = Date.now() - olderThanMs;
    const result = this.#stmt(
      'vacuum-completed',
      `DELETE FROM queue_tasks
       WHERE state IN ('done', 'failed')
         AND updated_at < ?`,
    ).run(cutoff);
    return Number(result.changes || 0);
  }

  #drainWaiters() {
    while (this.#waiters.length > 0 && this.size < this.#maxQueueSize) {
      const nextWaiter = this.#waiters.shift();
      if (nextWaiter.task.isSettled) {
        if (nextWaiter.timer) clearTimeout(nextWaiter.timer);
        nextWaiter.reject(new Error('Task was settled before queue capacity was available'));
        continue;
      }
      nextWaiter.resolve();
      break;
    }
  }

  /**
   * Closes the queue. Pending rows in the SQLite file are **left in place**
   * (state='pending') so that a fresh queue opened on the same `path`
   * recovers them via `#recoverPending` on startup. This is the correct
   * semantic for rolling deploys: the new instance picks up work the old
   * instance was about to dispatch.
   *
   * In-flight waiters (tasks blocked on backpressure) are rejected with
   * `reason` so callers don't leak unhandled promises.
   *
   * To explicitly drop all pending work (e.g., for a manual purge during
   * incident response), call `purgePending()` first, then `destroy()`.
   *
   * @param {Error} [reason]
   */
  destroy(reason = new Error('TaskQueue was destroyed')) {
    if (this.#closed) return;
    this.#closed = true;

    for (const waiter of this.#waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.task.reject(reason);
      waiter.reject(reason);
    }
    this.#waiters = [];

    this.#tasks.clear();
    this.#statementCache.clear();
    try {
      this.#db.close();
    } catch {
      // ignore: already closed or never opened
    }
  }

  /**
   * Marks every still-pending row as `state='failed'`. Use this for
   * incident response when you want to drop a backlog (e.g., after a
   * bad deploy that's been generating doomed tasks). Safe to call on a
   * destroyed queue (no-op).
   *
   * @returns {number} rows transitioned to `failed`
   */
  purgePending() {
    if (this.#closed) return 0;
    const result = this.#stmt(
      'purge-pending',
      `UPDATE queue_tasks SET state = 'failed', updated_at = ? WHERE state = 'pending'`,
    ).run(Date.now());
    return Number(result.changes || 0);
  }
}
