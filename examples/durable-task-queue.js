/**
 * [perf-tested] Example: durable task queue across runtime restarts.
 *
 * Demonstrates the SqliteTaskQueue durability guarantee: pending tasks
 * survive a runtime "crash" (process death without graceful shutdown)
 * and are recovered by the next instance that opens the same SQLite
 * file. This is the headline feature behind `queueBackend: 'sqlite'`
 * (ADR-0020) and addresses the RPO=0 requirement in the disaster
 * recovery plan (§5.2.1).
 *
 * Why we exercise the queue directly (not via createWorkerRuntime):
 *   A full runtime would dispatch tasks to workers immediately, and the
 *   workers would transition rows from `pending` → `processing` before
 *   we could simulate the crash. A real crash orphans those `processing`
 *   rows in the DB and the recovery scan (which only restores `pending`
 *   rows) sees them as already-claimed — they would not be re-executed.
 *   To make the comparison fair, both scenarios enqueue tasks directly
 *   to the queue and never start workers. The metric (tasks preserved
 *   vs. tasks lost) is then purely a function of the queue backend.
 *
 *   End-to-end recovery (queue + workers + execute) is covered in
 *   `examples/durable-task-recovery.js` — separate scenario that
 *   controls the timing so no tasks reach the `processing` state.
 *
 * Scenarios:
 *   A. In-memory TaskQueue — every pending task is lost on crash.
 *   B. SqliteTaskQueue — every pending task is recovered from the
 *      SQLite file by the next instance.
 *
 * Use cases:
 *   - Workloads where a restart must NOT drop in-flight work (job
 *     queues, transactional outbox, payment processing).
 *   - Rolling deploys where the old instance is replaced mid-task.
 *
 * What this example measures:
 *   - `tasksPreserved` — number of pending tasks the second queue
 *     instance finds after the simulated crash.
 *   - `recoveryTimeMs` — wall-clock between opening the second instance
 *     and the recovery scan completing (negligible at this scale; the
 *     metric matters at higher task counts).
 *
 * Run: `node examples/durable-task-queue.js`
 *
 * Refs: ADR-0020 (revised 2026-09-24, SQLite-only), DR plan §5.2.1, T13.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteTaskQueue } from '../src/queue/sqlite-backend.js';
import { TaskHandle } from '../src/task-handle.js';
import { TaskQueue } from '../src/task-queue.js';

// === Configuration ===

const TASK_COUNT = 200;

function makeHandle(id) {
  const handle = new TaskHandle({
    id,
    type: 'durable-bench',
    payload: { marker: id },
    fnCode: 'async () => 1',
  });
  // The example never awaits `task.promise` — there are no workers to
  // resolve it. Without this catch, `queue.destroy()` rejecting every
  // pending task would surface as unhandled-rejection warnings and (on
  // Node ≥ 22) a process-level crash. Mirrors the benchmark shim.
  handle.promise.catch(
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op
    () => {},
  );
  return handle;
}

let tmpRoot;

async function runScenarioA_memory() {
  const q1 = new TaskQueue({ maxQueueSize: TASK_COUNT + 100 });
  try {
    for (let i = 0; i < TASK_COUNT; i++) {
      await q1.enqueue(makeHandle(`mem_${i}`));
    }
    assert(q1.size === TASK_COUNT, 'q1 should hold all tasks before crash');
  } finally {
    q1.destroy();
  }
  // Simulate crash: q1 is gone. The JS heap has dropped all task
  // references; the in-memory queue is empty.

  // "Restart" — fresh in-memory queue on the same logic.
  const q2 = new TaskQueue({ maxQueueSize: TASK_COUNT + 100 });
  try {
    return q2.size; // expect 0
  } finally {
    q2.destroy();
  }
}

async function runScenarioB_sqlite() {
  const dbPath = join(tmpRoot, 'queue.db');

  const q1 = new SqliteTaskQueue({
    path: dbPath,
    maxQueueSize: TASK_COUNT + 100,
  });
  try {
    for (let i = 0; i < TASK_COUNT; i++) {
      await q1.enqueue(makeHandle(`sql_${i}`));
    }
    assert(q1.size === TASK_COUNT, 'q1 should hold all tasks before crash');
  } finally {
    q1.destroy(); // leaves pending rows in place for recovery
  }

  // "Restart" — fresh SqliteTaskQueue on the same path. The constructor
  // runs `#recoverPending`, which scans `state='pending'` rows and
  // re-materializes TaskHandles for each one.
  const recoveryStart = Date.now();
  const q2 = new SqliteTaskQueue({
    path: dbPath,
    maxQueueSize: TASK_COUNT + 100,
  });
  const recoveryTimeMs = Date.now() - recoveryStart;
  try {
    return { size: q2.size, recoveryTimeMs };
  } finally {
    q2.destroy();
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function main() {
  console.log('--- EXAMPLE: durable task queue across runtime restarts ---\n');
  console.log(`Workload: enqueue ${TASK_COUNT} tasks, "crash" the queue instance,`);
  console.log(`open a fresh queue instance on the same backend, and count`);
  console.log(`how many pending tasks the new instance finds.\n`);

  tmpRoot = mkdtempSync(join(tmpdir(), 'pwr-durable-queue-'));

  console.log('[A] queueBackend: "memory" — no persistence...');
  const memPreserved = await runScenarioA_memory();

  console.log('[B] queueBackend: "sqlite"  — persisted to disk...');
  const sqlResult = await runScenarioB_sqlite();

  console.log('\n=== Results ===\n');
  console.table({
    'A. In-memory': {
      tasksSubmitted: TASK_COUNT,
      tasksPreserved: memPreserved,
      recoveryTimeMs: 'n/a',
    },
    'B. SQLite': {
      tasksSubmitted: TASK_COUNT,
      tasksPreserved: sqlResult.size,
      recoveryTimeMs: sqlResult.recoveryTimeMs.toFixed(2),
    },
  });

  console.log(
    `\nDurability: SQLite preserved ${sqlResult.size}/${TASK_COUNT} pending tasks across the simulated crash;`,
  );
  console.log(`            in-memory preserved ${memPreserved}/${TASK_COUNT}.`);
  if (sqlResult.size === TASK_COUNT && memPreserved === 0) {
    console.log(
      `\nSpeedup: ∞× — SQLite preserved 100% of pending work; the in-memory queue lost everything.`,
    );
  }

  rmSync(tmpRoot, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  try {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
  process.exit(1);
});
