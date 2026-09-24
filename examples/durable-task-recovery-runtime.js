/**
 * [perf-tested] Example: end-to-end task recovery after a runtime crash.
 *
 * Demonstrates the full SqliteTaskQueue durability story using
 * createWorkerRuntime (not the lower-level queue API): dispatch tasks
 * via the runtime, simulate a crash WITHOUT graceful shutdown, then
 * open a fresh runtime on the same SQLite file and let its workers
 * finish the recovered pending tasks.
 *
 * Why we use long tasks + few workers:
 *   With short tasks the first runtime's workers would dequeue +
 *   transition rows from `pending` → `processing` before we could
 *   simulate the crash. Long tasks (workers stay busy on the first
 *   batch) keep enough rows in `pending` for the recovery to be
 *   meaningful. Conversely, with too many workers all tasks would
 *   complete before the crash. We size the first runtime's worker
 *   pool below the task count so a backlog of pending rows is
 *   guaranteed at crash time.
 *
 * Why we use a SHORT leaseMs on the first runtime (T13.2):
 *   The recovery sweep `reclaimExpired()` only resets `processing`
 *   rows whose lease has expired. Default lease is 30 000 ms; tasks
 *   that were in `state='processing'` at crash time would stay
 *   orphaned for 30 seconds before being reclaimed. To exercise the
 *   T13.2 path within this example's lifetime, we configure the
 *   first runtime with `leaseMs: 500`. By the time we open the
 *   second runtime, any orphaned lease has expired and
 *   `#recoverOrphans` brings the row back to `pending`.
 *
 * Use cases:
 *   - The user's primary durability story: dispatch work, crash
 *     mid-flight, work continues on the next instance.
 *
 * What this example measures:
 *   - `tasksCompletedByRestart` — number of tasks the second
 *     runtime's workers actually finish (with T13.2: ALL remaining
 *     work, including orphaned `processing` rows reclaimed by the
 *     lease sweep).
 *   - `recoveryTimeMs` — wall-clock between the second runtime's
 *     start and the first task completing.
 *
 * Run: `node examples/durable-task-recovery-runtime.js`
 *
 * Refs: ADR-0020 (revised 2026-09-24, T13.2 lease reclaim), T13.1.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkerRuntime } from '../src/index.js';

// === Configuration ===

const TASK_COUNT = 20;
const TASK_DURATION_MS = 300;
// First runtime has FEWER workers than tasks — guarantees a backlog
// of `pending` rows at crash time.
const FIRST_RUNTIME_WORKERS = 2;
const SECOND_RUNTIME_WORKERS = 4;
// Short lease so orphaned processing rows (workers mid-task when
// the runtime reference is dropped) are reclaimed quickly by the
// recovery sweep on the next instance (T13.2).
const FIRST_RUNTIME_LEASE_MS = 50;

/** Worker fn — `delayMs` is passed via payload (ADR-0012 — no closure). */
const workFn = ({ delayMs }) => new Promise((resolve) => setTimeout(resolve, delayMs));

let tmpRoot;

async function main() {
  console.log('--- EXAMPLE: end-to-end task recovery after a runtime crash ---\n');
  console.log(`Workload: ${TASK_COUNT} tasks × ${TASK_DURATION_MS} ms each, dispatched via`);
  console.log(`createWorkerRuntime on the FIRST instance (${FIRST_RUNTIME_WORKERS} workers).`);
  console.log(`Crash mid-flight (drop runtime reference without shutdown). Open a SECOND`);
  console.log(`runtime on the same SQLite file with ${SECOND_RUNTIME_WORKERS} workers;`);
  console.log(`the recovered queue drains the remaining pending tasks.\n`);

  tmpRoot = mkdtempSync(join(tmpdir(), 'pwr-recovery-runtime-'));
  const dbPath = join(tmpRoot, 'queue.db');

  // === Scenario A: in-memory — second runtime sees nothing ===
  console.log('[A] queueBackend: "memory" — no recovery possible...');
  const firstA_completed = [];
  const secondA_completed = [];
  {
    const first = await createWorkerRuntime({
      workers: FIRST_RUNTIME_WORKERS,
      concurrency: FIRST_RUNTIME_WORKERS,
      queueBackend: 'memory',
    });
    first.addEventListener('task:completed', ({ taskId }) => {
      firstA_completed.push(taskId);
    });
    for (let i = 0; i < TASK_COUNT; i++) {
      first.dispatch({
        id: `mem_${i}`,
        fn: workFn,
        payload: { delayMs: TASK_DURATION_MS },
      });
    }
    void first;
  }
  // Wait long enough for the first runtime's workers to finish their
  // current batch (in flight = FIRST_RUNTIME_WORKERS * delayMs).
  await new Promise((resolve) =>
    setTimeout(resolve, (FIRST_RUNTIME_WORKERS + 1) * TASK_DURATION_MS),
  );

  const restartedA = await createWorkerRuntime({
    workers: SECOND_RUNTIME_WORKERS,
    concurrency: SECOND_RUNTIME_WORKERS,
    queueBackend: 'memory',
  });
  restartedA.addEventListener('task:completed', ({ taskId }) => {
    secondA_completed.push(taskId);
  });
  // Wait long enough for the second runtime to confirm there's nothing
  // to do (the in-memory queue has zero pending rows).
  await new Promise((resolve) => setTimeout(resolve, TASK_DURATION_MS));
  await restartedA.shutdown();

  // === Scenario B: SQLite — second runtime drains the recovered tasks ===
  console.log('[B] queueBackend: "sqlite"  — recovered tasks execute on restart...');
  const firstB_completed = [];
  const secondB_completed = [];
  {
    const first = await createWorkerRuntime({
      workers: FIRST_RUNTIME_WORKERS,
      concurrency: FIRST_RUNTIME_WORKERS,
      queueBackend: 'sqlite',
      sqlite: { path: dbPath, leaseMs: FIRST_RUNTIME_LEASE_MS },
    });
    first.addEventListener('task:completed', ({ taskId }) => {
      firstB_completed.push(taskId);
    });
    for (let i = 0; i < TASK_COUNT; i++) {
      first.dispatch({
        id: `sql_${i}`,
        fn: workFn,
        payload: { delayMs: TASK_DURATION_MS },
      });
    }
    void first;
  }
  // Wait long enough for the first runtime's in-flight workers to
  // finish AND for any orphaned leases (≤ FIRST_RUNTIME_LEASE_MS by
  // T13.2 config) to expire. (FIRST_RUNTIME_WORKERS + 1) ×
  // TASK_DURATION_MS gives every task that was claimed before the
  // crash a chance to either complete (counted in firstB_completed)
  // or expire its lease (reclaimed by #recoverOrphans on restart).
  await new Promise((resolve) =>
    setTimeout(
      resolve,
      (FIRST_RUNTIME_WORKERS + 1) * TASK_DURATION_MS + FIRST_RUNTIME_LEASE_MS + 200,
    ),
  );

  const recoveryStart = Date.now();
  const restartedB = await createWorkerRuntime({
    workers: SECOND_RUNTIME_WORKERS,
    concurrency: SECOND_RUNTIME_WORKERS,
    queueBackend: 'sqlite',
    sqlite: { path: dbPath },
  });
  restartedB.addEventListener('task:completed', ({ taskId }) => {
    secondB_completed.push(taskId);
  });
  // Wait for the first recovered task to complete (recovery success signal).
  await new Promise((resolve) => {
    const onFirst = () => {
      restartedB.removeEventListener('task:completed', onFirst);
      resolve();
    };
    restartedB.addEventListener('task:completed', onFirst);
  });
  const recoveryTimeMs = Date.now() - recoveryStart;

  // Wait for the rest to drain.
  const totalWaitMs = TASK_COUNT * TASK_DURATION_MS + 1000;
  await new Promise((resolve) => setTimeout(resolve, totalWaitMs));
  await restartedB.shutdown();

  // === Results ===
  console.log('\n=== Results ===\n');
  console.table({
    'A. In-memory': {
      tasksSubmitted: TASK_COUNT,
      completedByFirst: firstA_completed.length,
      completedByRestart: secondA_completed.length,
    },
    'B. SQLite': {
      tasksSubmitted: TASK_COUNT,
      completedByFirst: firstB_completed.length,
      completedByRestart: secondB_completed.length,
      recoveryTimeMs: recoveryTimeMs.toFixed(2),
    },
  });

  const passes = secondB_completed.length > 0 && secondA_completed.length === 0;
  if (passes) {
    console.log(
      `\nEnd-to-end: ${secondB_completed.length} tasks survived the runtime crash and were`,
    );
    console.log(
      `executed by the restart runtime's workers. Recovery took ${recoveryTimeMs.toFixed(2)} ms.`,
    );
    console.log(
      `First runtime pre-crash: ${firstB_completed.length} task(s) (cap = FIRST_RUNTIME_WORKERS × delayMs).`,
    );
    console.log(
      `In-memory baseline: 0 tasks completed by the restart runtime — all work was lost.`,
    );
  } else {
    console.log(
      `\nFAIL: B recovered = ${secondB_completed.length} (want > 0); A recovered = ${secondA_completed.length} (want 0).`,
    );
  }

  // Best-effort cleanup. The first runtime's SQLite connection is still
  // open (we never called shutdown()) — defer GC via a brief await before
  // removing the file so SQLite can flush + release the lock.
  await new Promise((resolve) => setTimeout(resolve, 50));
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort — Windows holds the file lock briefly
  }

  process.exit(passes ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
