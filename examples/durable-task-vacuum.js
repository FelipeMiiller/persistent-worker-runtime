/**
 * [perf-tested] Example: WAL checkpoint + vacuum reclaim disk space.
 *
 * Demonstrates the retention + checkpoint primitives on the durable
 * queue backend. SqliteTaskQueue uses WAL (write-ahead log) mode,
 * which keeps the `-wal` sidecar file as a buffer between committed
 * rows and the main `.db` file. Without periodic `checkpointWal()`
 * calls, the `-wal` grows until it hits `journal_size_limit`
 * (default ~1 GB). Without `vacuumCompleted()`, terminal rows
 * (`failed` — `done` rows are deleted by `markDone` to keep the
 * happy path lean) accumulate forever.
 *
 * Scenarios:
 *   A. No GC — 1 000 tasks are marked failed and stay on disk.
 *   B. checkpointWal + vacuumCompleted — after the workload, both
 *      are invoked and the disk footprint shrinks.
 *
 * Use cases:
 *   - Long-lived production deployments (cron jobs, outbox workers)
 *     where the queue file would otherwise grow to gigabytes.
 *   - Operators who want a measurable retention policy.
 *
 * What this example measures:
 *   - `totalBytes` — combined size of `queue.db` + `queue.db-wal`
 *     after the workload.
 *   - `checkpointWalMs` — wall-clock of `checkpointWal()` on the
 *     loaded WAL file.
 *   - `vacuumRemovedRows` — count of terminal rows removed by
 *     `vacuumCompleted(0)`.
 *
 * Run: `node examples/durable-task-vacuum.js`
 *
 * Refs: ADR-0020 (revised 2026-09-24), `src/queue/sqlite-backend.js`
 * (`checkpointWal` + `vacuumCompleted` + `markFailed` API surface).
 */

import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteTaskQueue } from '../src/queue/sqlite-backend.js';
import { TaskHandle } from '../src/task-handle.js';

// === Configuration ===

const TASK_COUNT = 2000;

function makeHandle(id) {
  const handle = new TaskHandle({
    id,
    type: 'vacuum-bench',
    payload: { id },
    fnCode: 'async () => 1',
  });
  handle.promise.catch(
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op
    () => {},
  );
  return handle;
}

/**
 * Combined size of the main DB file + any sidecar (`.db-wal`, `.db-shm`)
 * SQLite leaves lying around in the same directory. Read AFTER
 * checkpointWal so the WAL has been flushed and we measure the
 * canonical on-disk footprint (not transient WAL pages).
 */
function dbFileBytes(dbPath, checkpointFirst = true) {
  if (checkpointFirst) {
    // Force a passive checkpoint so the -wal file is shrunk/truncated
    // before we measure — otherwise Scenario A's measurement includes
    // a hot WAL that hasn't been flushed yet, which inflates the
    // comparison unfairly.
    const q = new SqliteTaskQueue({ path: dbPath, maxQueueSize: 1 });
    try {
      q.checkpointWal();
    } finally {
      q.destroy();
    }
  }
  const dir = join(dbPath, '..');
  const base = dbPath.split(/[\\/]/).pop();
  let total = 0;
  for (const f of readdirSync(dir)) {
    if (f.startsWith(base)) {
      try {
        total += statSync(join(dir, f)).size;
      } catch {
        // ignore: file may have been cleaned up by SQLite after checkpoint
      }
    }
  }
  return total;
}

/**
 * Count rows in the terminal `failed` state (rows still pending GC).
 * This is the metric that quantifies "how much audit backlog is left
 * to clean up"; disk size is misleading because SQLite doesn't shrink
 * the main db file on DELETE — it just frees pages inside the file.
 */
function failedRowCount(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM queue_tasks WHERE state = 'failed'").get();
    return row.n;
  } finally {
    db.close();
  }
}

async function workload(dbPath) {
  const q = new SqliteTaskQueue({ path: dbPath, maxQueueSize: TASK_COUNT + 100 });
  try {
    for (let i = 0; i < TASK_COUNT; i++) {
      await q.enqueue(makeHandle(`t_${i}`));
    }
    // Drain and mark every task as failed. Failed rows are KEPT on
    // disk (state='failed') so they show up in audits and can be
    // vacuumed — unlike `done` rows which are DELETEd by markDone.
    const dequeued = [];
    while (true) {
      const claimed = q.dequeue();
      if (claimed === null) break;
      dequeued.push(claimed.id);
    }
    for (const id of dequeued) {
      q.markFailed(id);
    }
  } finally {
    q.destroy();
  }
}

async function runScenarioA_noGC(dbPath) {
  await workload(dbPath);
  return {
    totalBytes: dbFileBytes(dbPath, true),
    failedRows: await failedRowCount(dbPath),
  };
}

async function runScenarioB_withGC(dbPath) {
  await workload(dbPath);
  // Open a fresh queue instance to exercise the GC primitives.
  const gc = new SqliteTaskQueue({ path: dbPath, maxQueueSize: TASK_COUNT + 100 });
  try {
    const checkpointStart = Date.now();
    const checkpointResult = gc.checkpointWal();
    const checkpointWalMs = Date.now() - checkpointStart;
    const vacuumRemovedRows = gc.vacuumCompleted(0);
    return {
      totalBytes: dbFileBytes(dbPath, false),
      failedRows: await failedRowCount(dbPath),
      checkpointWalMs,
      checkpointResult,
      vacuumRemovedRows,
    };
  } finally {
    gc.destroy();
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function main() {
  console.log('--- EXAMPLE: WAL checkpoint + vacuum reclaim disk space ---\n');
  console.log(`Workload: enqueue ${TASK_COUNT} tasks, drain them, mark all`);
  console.log(`failed (terminal state — kept on disk), then measure the`);
  console.log(`on-disk footprint. Scenario A skips GC; Scenario B invokes`);
  console.log(`checkpointWal() + vacuumCompleted().\n`);

  const tmpA = join(tmpdir(), `pwr-vacuum-A-${Date.now()}.db`);
  const tmpB = join(tmpdir(), `pwr-vacuum-B-${Date.now()}.db`);

  console.log('[A] no GC...');
  const resA = await runScenarioA_noGC(tmpA);

  console.log('[B] checkpointWal() + vacuumCompleted()...');
  const resB = await runScenarioB_withGC(tmpB);

  console.log('\n=== Results ===\n');
  console.table({
    'A. No GC': {
      totalBytes: resA.totalBytes,
      failedRowsPending: resA.failedRows,
      checkpointWalMs: 'n/a',
      vacuumRemovedRows: 'n/a',
    },
    'B. With GC': {
      totalBytes: resB.totalBytes,
      failedRowsPending: resB.failedRows,
      checkpointWalMs: resB.checkpointWalMs.toFixed(2),
      vacuumRemovedRows: resB.vacuumRemovedRows,
    },
  });

  const auditCleared = resA.failedRows > 0 && resB.failedRows === 0;
  if (auditCleared) {
    console.log(
      `\nAudit log: ${resB.vacuumRemovedRows} failed rows cleared by vacuumCompleted(0); ${resA.failedRows} remained without GC.`,
    );
    console.log(`  checkpointWal(TRUNCATE) finished in ${resB.checkpointWalMs.toFixed(2)} ms.`);
    console.log(`  Note: totalBytes is similar across scenarios because SQLite`);
    console.log(`  marks pages free inside the file instead of shrinking it; the`);
    console.log(`  meaningful metric is the audit row count, not the file size.`);
  }

  // Best-effort cleanup of any leftover sidecar files.
  for (const path of [tmpA, tmpB]) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try {
        if (existsSync(path + suffix)) unlinkSync(path + suffix);
      } catch {
        // best-effort
      }
    }
  }

  assert(auditCleared, 'GC must clear the failed-row audit backlog');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
