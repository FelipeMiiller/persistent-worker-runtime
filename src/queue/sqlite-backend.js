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
  claimed_by TEXT,
  -- T13.2: lease expiry timestamp (ms since epoch). A row with
  -- state='processing' AND claim_expires_at < now() is treated as an
  -- orphaned claim — the worker that owned it is presumed dead. The
  -- startup recovery sweep resets such rows back to state='pending'.
  claim_expires_at INTEGER
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
CREATE INDEX IF NOT EXISTS queue_tasks_lease_expiry
  ON queue_tasks(claim_expires_at)
  WHERE state = 'processing' AND claim_expires_at IS NOT NULL;
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
  // Defensive: a corrupted envelope (mid-write kill, disk error, manual
  // tampering) would otherwise throw and crash the calling worker thread,
  // taking down the whole runtime. Caller handles the failure.
  try {
    return JSON.parse(Buffer.from(blob).toString('utf8'));
  } catch {
    return null;
  }
}

export class SqliteTaskQueue {
  #db;
  #dbPath;
  #maxQueueSize;
  #defaultQueueTimeoutMs;
  // T13.2: lease duration (ms) — how long a `state='processing'` claim
  // is valid before the recovery sweep reclaims it as orphaned.
  // Default 30 000 ms accommodates most tasks; long-running tasks
  // should pass `leaseMs` explicitly or use the future heartbeat API
  // (Option 2 of the orphan-recovery design — not yet implemented).
  #leaseMs;
  // T13.2: stable worker identifier used in `claimed_by` so multi-
  // instance observers can tell which process owns which claim.
  // Generated per-instance; not persisted across restarts.
  #workerId;
  #tasks = new Map(); // task_id → TaskHandle (same-process BC shim)
  #waiters = [];
  #closed = false;
  #statementCache = new Map();
  // Cached pending count. Maintained alongside SQLite state via
  // BEGIN IMMEDIATE transactions; eliminates the O(n) `SELECT COUNT(*)`
  // the runtime invokes on every `queue.size` read (twice per task in
  // `#scheduleNext` + `getStats`). SQLite remains source of truth on
  // startup (`#recoverPending`) and is reconciled on every mutation.
  #size = 0;

  constructor(options = {}) {
    if (!options || typeof options.path !== 'string' || options.path.length === 0) {
      throw new TypeError('SqliteTaskQueue requires options.path (string).');
    }
    this.#maxQueueSize = options.maxQueueSize || 2000;
    this.#defaultQueueTimeoutMs = options.queueTimeoutMs || 30000;
    this.#leaseMs = options.leaseMs ?? 30000;
    this.#workerId =
      options.workerId ??
      `pwr-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    this.#dbPath = options.path;
    this.#db = new DatabaseSync(options.path);
    // WAL = readers don't block writers; durable + fast. NORMAL = small
    // fsync window; durable enough for queue use (TRUNCATE/EXTRA are overkill
    // for non-financial data).
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec('PRAGMA synchronous = NORMAL;');
    this.#db.exec('PRAGMA busy_timeout = 5000;');
    this.#db.exec(SCHEMA);
    // T13.2: idempotent migration for databases created before the
    // `claim_expires_at` column existed. `ALTER TABLE ... ADD COLUMN`
    // errors with "duplicate column name" if the column already exists;
    // we swallow that specific error and ignore all others.
    try {
      this.#db.exec('ALTER TABLE queue_tasks ADD COLUMN claim_expires_at INTEGER;');
    } catch (err) {
      if (!(err instanceof Error && /duplicate column name/i.test(err.message))) {
        throw err;
      }
    }

    // Crash recovery: first reclaim orphaned `processing` claims whose
    // lease expired (T13.2), then rebuild the in-memory TaskHandle map
    // from any rows still in `pending` state. The restored handles
    // have no live caller; they complete silently when workers
    // execute them.
    this.#recoverOrphans();
    this.#recoverPending();
  }

  #recoverOrphans() {
    // Reset any `processing` row whose lease has expired back to
    // `pending` so the next dequeue can claim it. Idempotent; safe
    // to call on every constructor invocation. `reclaimExpired`
    // returns `{reclaimed, exhausted}` so we can emit a distinct
    // warning when the retry budget was consumed.
    const { reclaimed, exhausted } = this.reclaimExpired();
    if (reclaimed > 0) {
      process.emitWarning(
        `persistent-worker-runtime: SqliteTaskQueue reclaimed ${reclaimed} orphaned claim(s) from previous instance(s).`,
        'PersistentWorkerRuntimeSqliteOrphanReclaim',
      );
    }
    if (exhausted > 0) {
      process.emitWarning(
        `persistent-worker-runtime: SqliteTaskQueue exhausted retry budget on ${exhausted} orphaned task(s); marked failed.`,
        'PersistentWorkerRuntimeSqliteOrphanBudgetExhausted',
      );
    }
  }

  /**
   * Sweep expired `processing` rows back to `pending`. Public so
   * operators can run it from a cron / scheduler alongside
   * `vacuumCompleted` and `checkpointWal`.
   *
   * Each reclaim counts as an attempt — the row's `attempt` column
   * is incremented before the budget check. If `attempt + 1 >
   * max_retries` the row is marked `failed` instead of reclaimed to
   * `pending`. This prevents the infinite-reclaim loop that would
   * otherwise occur when a worker consistently crashes mid-task on
   * the same task (the task would otherwise oscillate
   * pending → processing → pending forever, blocking the queue).
   *
   * @param {number} [now=Date.now()]
   * @returns {{reclaimed: number, exhausted: number}} count of rows
   *   reclaimed to `pending` and rows that exhausted their retry
   *   budget (marked `failed`).
   */
  reclaimExpired(now = Date.now()) {
    if (this.#closed) return { reclaimed: 0, exhausted: 0 };

    // Two-step to preserve clarity and avoid a complex CASE expression:
    //  1. UPDATE rows whose lease expired. Increment `attempt` so the
    //     budget check happens against the post-increment value. Set
    //     state based on whether the new attempt would exceed
    //     max_retries.
    //  2. Return both counts so callers can warn appropriately.
    // Increment `attempt` first (using its pre-UPDATE value on the
    // RHS, as required by SQLite semantics), then decide state based
    // on the same pre-UPDATE `attempt + 1`. Crucially, `attempt` is
    // ALWAYS incremented — including when the budget is exhausted —
    // so the audit trail reflects every reclaim attempt. Skipping the
    // increment on exhaustion (the previous design) silently dropped
    // evidence of the final reclaim.
    const result = this.#stmt(
      'reclaim-expired',
      `UPDATE queue_tasks
         SET attempt = attempt + 1,
             state = CASE
               WHEN attempt + 1 > max_retries THEN 'failed'
               ELSE 'pending'
             END,
             claimed_by = CASE
               WHEN attempt + 1 > max_retries THEN claimed_by
               ELSE NULL
             END,
             claim_expires_at = NULL,
             updated_at = ?
       WHERE state = 'processing'
         AND claim_expires_at IS NOT NULL
         AND claim_expires_at < ?`,
    ).run(now, now);
    const changed = Number(result.changes || 0);
    if (changed === 0) return { reclaimed: 0, exhausted: 0 };

    // Disaggregate by post-update state. Done in a separate query so
    // each branch is auditable via stderr / logs.
    const counts = this.#stmt(
      'reclaim-counts',
      `SELECT
         SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS reclaimed,
         SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS exhausted
       FROM queue_tasks
       WHERE updated_at = ?`,
    ).get(now);
    const reclaimed = Number(counts?.reclaimed || 0);
    const exhausted = Number(counts?.exhausted || 0);
    // Cache reconciliation: pending goes up by `reclaimed`, but the
    // rows that landed in `failed` were not in our local pending cache
    // (they were `processing`), so no decrement needed.
    if (reclaimed > 0) this.#size += reclaimed;
    return { reclaimed, exhausted };
  }

  #recoverPending() {
    const rows = this.#db
      .prepare("SELECT task_id, payload FROM queue_tasks WHERE state = 'pending'")
      .all();
    let recovered = 0;
    let corrupted = 0;
    for (const row of rows) {
      const envelope = deserializeEnvelope(row.payload);
      if (envelope === null) {
        corrupted++;
        // Quarantine the corrupt row as failed so vacuumCompleted can GC it
        // and so the user can inspect via SQL. Caller never gets a TaskHandle
        // for it — the warning below is the only runtime-visible signal.
        try {
          this.#stmt(
            'recover-corrupt',
            `UPDATE queue_tasks SET state = 'failed', updated_at = ? WHERE task_id = ?`,
          ).run(Date.now(), row.task_id);
        } catch {
          // best-effort: leave the row alone if the UPDATE fails
        }
        continue;
      }
      const task = new TaskHandle(envelope);
      this.#tasks.set(row.task_id, task);
      recovered++;
    }
    this.#size = recovered;
    if (recovered > 0 || corrupted > 0) {
      process.emitWarning(
        `persistent-worker-runtime: SqliteTaskQueue recovered ${recovered} pending task(s)` +
          (corrupted > 0 ? ` and quarantined ${corrupted} corrupt row(s)` : '') +
          ` from ${this.#dbPath}`,
        'PersistentWorkerRuntimeSqliteRecovery',
      );
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
    return this.#closed ? 0 : this.#size;
  }

  // ADR-0024 / DR §8.2: capacity ceiling exposed for `runtime.isReady()`.
  // Mirrors the constructor option. Same getter as `TaskQueue.maxQueueSize`
  // so the runtime can read either backend uniformly.
  get maxQueueSize() {
    return this.#maxQueueSize;
  }

  /**
   * Returns the highest-priority pending task WITHOUT claiming it.
   * Mirrors `TaskQueue.peek()`. Materializes a TaskHandle on demand when
   * called against rows that were restored from disk by `#recoverPending`
   * (no live in-memory instance yet — `peek` becomes the trigger for the
   * very first materialization in the current process). Also falls back to
   * materialization when a row exists in SQLite but the in-memory map was
   * wiped (e.g., by a `markDone` race across instances — defensive).
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
    return this.#tasks.get(row.task_id) || this.#materialize(row.task_id);
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

    // Fast path: `#insert` performs the authoritative capacity check
    // under `BEGIN IMMEDIATE` (closes the TOCTOU window for multi-instance
    // writers) and returns false when the queue is at capacity.
    if (this.#insert(task)) {
      return Promise.resolve();
    }
    return this.#parkAsWaiter(task);
  }

  /**
   * Atomic check-and-insert under `BEGIN IMMEDIATE`. Returns true on
   * successful insert, false when the queue is at capacity (the caller
   * must then park the task as a waiter).
   *
   * The transaction-scoped count check closes the TOCTOU window for
   * multi-instance writers: while we hold the database-level write lock,
   * no other instance can insert. Single-instance callers (JS is
   * single-threaded) also benefit because the cache and SQLite state
   * are reconciled in one indivisible step.
   *
   * On successful insert the in-memory `#tasks` map and the cached
   * `#size` are both updated before COMMIT returns — no second
   * `SELECT COUNT(*)` is needed for the next `size` read.
   *
   * @returns {boolean} true if inserted, false if capacity exhausted
   */
  #insert(task) {
    const blob = serializeEnvelope(task);
    const now = Date.now();
    let isNewRow = false;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const depthRow = this.#stmt(
        'insert-count',
        "SELECT COUNT(*) AS n FROM queue_tasks WHERE state = 'pending'",
      ).get();
      if (depthRow.n >= this.#maxQueueSize) {
        this.#db.exec('ROLLBACK');
        return false;
      }
      // Idempotency: re-enqueueing the same task_id must NOT bump `#size`
      // a second time. Detect whether the row already existed under the
      // same transaction lock so the cache stays consistent.
      const existing = this.#stmt(
        'insert-exists',
        'SELECT 1 AS x FROM queue_tasks WHERE task_id = ?',
      ).get(task.id);
      isNewRow = !existing;
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
    if (isNewRow) this.#size++;
    this.#drainWaiters();
    return true;
  }

  /**
   * Parks a task as a waiter when `#insert` reports the queue is full.
   * Re-tries `#insert` when a slot frees up (`#drainWaiters` resolves
   * waiters one at a time as capacity opens).
   *
   * @returns {Promise<void>}
   */
  #parkAsWaiter(task) {
    const timeoutMs = task.queueTimeoutMs || this.#defaultQueueTimeoutMs;
    return new Promise((resolve, reject) => {
      const waitEntry = {
        task,
        timer: null,
        resolve: () => {
          if (waitEntry.timer) clearTimeout(waitEntry.timer);
          if (this.#insert(task)) {
            resolve();
          } else {
            // Capacity still exhausted after slot freed (rare race — a
            // second drainWaiters caller fired in between). Re-arm as a
            // fresh waiter by chaining into #parkAsWaiter.
            this.#parkAsWaiter(task).then(resolve, reject);
          }
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
            queueDepth: this.#size,
          },
        );
        task.reject(err);
        reject(err);
      }, timeoutMs);
      this.#waiters.push(waitEntry);
    });
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
         SET state = 'processing',
             updated_at = ?,
             claimed_by = ?,
             claim_expires_at = ?
         WHERE task_id = ?`,
      ).run(Date.now(), this.#workerId, Date.now() + this.#leaseMs, claimedId);
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
    const inMemory = this.#tasks.get(claimedId);
    this.#tasks.delete(claimedId);
    this.#size--;
    let task = inMemory;
    if (!task) {
      task = this.#materialize(claimedId);
      if (!task) {
        // Orphan row — we just claimed + marked processing, but the
        // envelope row vanished (corrupt payload quarantined by recovery,
        // or row was DELETEd by markDone between our SELECT and UPDATE
        // in another process). Mark as failed so it shows up in audits
        // and is GC-eligible; return null so the runtime skips this slot.
        try {
          this.#stmt(
            'claim-orphan-fail',
            `UPDATE queue_tasks SET state = 'failed', updated_at = ? WHERE task_id = ?`,
          ).run(Date.now(), claimedId);
        } catch {
          // best-effort
        }
        this.#drainWaiters();
        return null;
      }
    }
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
    if (envelope === null) {
      // Quarantine corrupt envelope so the runtime doesn't crash on it
      // and the row is GC-eligible. Caller (peek/dequeue/#recoverPending)
      // gets null back and skips this slot.
      try {
        this.#stmt(
          'materialize-corrupt-fail',
          `UPDATE queue_tasks SET state = 'failed', updated_at = ? WHERE task_id = ?`,
        ).run(Date.now(), taskId);
      } catch {
        // best-effort
      }
      process.emitWarning(
        `persistent-worker-runtime: SqliteTaskQueue could not deserialize envelope for task ${taskId}; quarantined as failed.`,
        'PersistentWorkerRuntimeSqliteCorruptEnvelope',
      );
      return null;
    }
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
    const result = this.#stmt('mark-done', `DELETE FROM queue_tasks WHERE task_id = ?`).run(taskId);
    // Only decrement the pending counter if the row was actually pending
    // (not processing, not failed). The row's prior state is unknown here
    // because the DELETE returns only the count, so we keep a sticky
    // counter — over-count is acceptable because size is advisory.
    if (result.changes > 0 && this.#size > 0) this.#size--;
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
    let wasPending = false;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      // Capture the row's prior state under the transaction lock so we
      // know whether to decrement `#size` (pending → failed) or leave it
      // alone (processing → failed, done → failed, failed → failed).
      const prev = this.#stmt(
        'mark-failed-prev',
        'SELECT state FROM queue_tasks WHERE task_id = ?',
      ).get(taskId);
      if (prev && prev.state === 'pending') {
        wasPending = true;
      }
      this.#stmt(
        'mark-failed',
        `UPDATE queue_tasks SET state = 'failed', updated_at = ? WHERE task_id = ? AND state != 'failed'`,
      ).run(Date.now(), taskId);
      this.#db.exec('COMMIT');
    } catch {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // ignore
      }
      return;
    }
    if (wasPending && this.#size > 0) this.#size--;
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
    this.#size = 0;
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
    const purged = Number(result.changes || 0);
    if (purged > 0) this.#size = Math.max(0, this.#size - purged);
    return purged;
  }

  /**
   * Forces a WAL checkpoint. Without this, the `-wal` sidecar file grows
   * until it hits `journal_size_limit` (default ~1 GB). Call periodically
   * (e.g., on a 1-hour cron or after `vacuumCompleted`) to keep disk
   * usage bounded. Uses `TRUNCATE` which truncates the `-wal` file to
   * zero bytes after a successful checkpoint.
   *
   * Safe to call on a destroyed queue (returns -1).
   *
   * @returns {number} rows checkpointed (`busy` frames + `-1` on closed queue)
   */
  checkpointWal() {
    if (this.#closed) return -1;
    const row = this.#db.prepare('PRAGMA wal_checkpoint(TRUNCATE);').get();
    return row ? Number(row.busy || 0) : 0;
  }
}
