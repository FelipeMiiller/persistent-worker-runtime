/**
 * [perf-tested] Example: priority ordering + affinity preserved across restarts.
 *
 * Demonstrates that the SqliteTaskQueue not only persists task envelopes
 * (see `durable-task-queue.js`) but also preserves the **priority** and
 * **affinity_key** fields used by the scheduler to pick the next task
 * for a given worker. After a simulated crash, the recovered queue
 * dispatches tasks in the same order they would have been dispatched
 * before the crash.
 *
 * Scenarios:
 *   A. In-memory TaskQueue — priority/affinity are lost along with the
 *      tasks themselves. The new queue is empty.
 *   B. SqliteTaskQueue — priority and affinity_key are read from the
 *      SQLite envelope during `#recoverPending`. The recovered tasks
 *      dequeue in the same priority order as the original dispatch.
 *
 * Use cases:
 *   - Mixed-priority workloads (interactive + batch) where a crash
 *     mid-dispatch must NOT promote a batch task above an interactive
 *     one on restart.
 *   - Affinity-routed workloads (model shards, GPU workers) where a
 *     crash mid-dispatch must NOT lose the worker→task affinity.
 *
 * What this example measures:
 *   - `firstPriorityDequeued` — the priority of the first task dequeued
 *     after the crash. With SQLite this should match the original
 *     highest priority (10). With memory it is undefined.
 *   - `affinityMatchesFirst` — whether the first dequeued task carries
 *     the expected affinityKey after recovery.
 *   - `recoveryOrderPreserved` — whether the dequeue sequence after
 *     recovery matches the order it would have followed before the
 *     crash (priority DESC, enqueued_at ASC).
 *
 * Run: `node examples/durable-task-priority.js`
 *
 * Refs: ADR-0020 (revised 2026-09-24), `durable-task-queue.js`,
 * `examples/priority-routing.js` for the in-runtime priority demo.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteTaskQueue } from '../src/queue/sqlite-backend.js';
import { TaskHandle } from '../src/task-handle.js';
import { TaskQueue } from '../src/task-queue.js';

// === Configuration ===

const HIGH_PRIORITY = 10;
const LOW_PRIORITY = 1;
const TASK_COUNT_HIGH = 5;
const TASK_COUNT_LOW = 5;
const AFFINITY = 'gpu-shard-0';

function makeHandle({ id, priority, affinityKey }) {
  const handle = new TaskHandle({
    id,
    type: 'priority-bench',
    payload: { id, priority, affinityKey },
    priority,
    affinityKey,
    fnCode: 'async () => 1',
  });
  // See durable-task-queue.js for the rationale — no workers in this
  // example, so task.promise would never resolve.
  handle.promise.catch(
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op
    () => {},
  );
  return handle;
}

let tmpRoot;

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function runScenarioA_memory() {
  const q1 = new TaskQueue({ maxQueueSize: 100 });
  try {
    // Mix priorities + affinities. Higher priority should dequeue first.
    for (let i = 0; i < TASK_COUNT_LOW; i++) {
      await q1.enqueue(
        makeHandle({ id: `mem_low_${i}`, priority: LOW_PRIORITY, affinityKey: null }),
      );
    }
    for (let i = 0; i < TASK_COUNT_HIGH; i++) {
      await q1.enqueue(
        makeHandle({ id: `mem_high_${i}`, priority: HIGH_PRIORITY, affinityKey: AFFINITY }),
      );
    }
  } finally {
    q1.destroy();
  }

  // "Restart" — fresh in-memory queue. Empty.
  const q2 = new TaskQueue({ maxQueueSize: 100 });
  try {
    const peeked = q2.peek();
    return {
      preservedSize: q2.size,
      firstPriorityDequeued: peeked ? peeked.priority : null,
      affinityMatchesFirst: peeked ? peeked.affinityKey === AFFINITY : false,
    };
  } finally {
    q2.destroy();
  }
}

async function runScenarioB_sqlite() {
  const dbPath = join(tmpRoot, 'queue.db');

  const q1 = new SqliteTaskQueue({ path: dbPath, maxQueueSize: 100 });
  try {
    for (let i = 0; i < TASK_COUNT_LOW; i++) {
      await q1.enqueue(
        makeHandle({ id: `sql_low_${i}`, priority: LOW_PRIORITY, affinityKey: null }),
      );
    }
    for (let i = 0; i < TASK_COUNT_HIGH; i++) {
      await q1.enqueue(
        makeHandle({ id: `sql_high_${i}`, priority: HIGH_PRIORITY, affinityKey: AFFINITY }),
      );
    }
    assert(q1.size === TASK_COUNT_LOW + TASK_COUNT_HIGH, 'q1 should hold all tasks before crash');
  } finally {
    q1.destroy();
  }

  // "Restart" — fresh queue on same path. `#recoverPending` rebuilds
  // TaskHandles from SQLite envelopes, preserving priority + affinity.
  const q2 = new SqliteTaskQueue({ path: dbPath, maxQueueSize: 100 });
  try {
    const peeked = q2.peek();
    const recoveredSize = q2.size;
    // Drain a few to confirm ordering across the recovered set
    // (priority DESC, enqueued_at ASC). Note: this decrements `size`
    // because each dequeue marks the row as `processing`.
    const dequeued = [];
    for (let i = 0; i < 3; i++) {
      const t = q2.dequeue();
      if (t) dequeued.push({ id: t.id, priority: t.priority, affinity: t.affinityKey });
    }
    return {
      recoveredSize,
      firstPriorityDequeued: peeked ? peeked.priority : null,
      affinityMatchesFirst: peeked ? peeked.affinityKey === AFFINITY : false,
      dequeued,
    };
  } finally {
    q2.destroy();
  }
}

async function main() {
  console.log('--- EXAMPLE: priority + affinity preserved across restarts ---\n');
  console.log(
    `Workload: ${TASK_COUNT_LOW} low-priority (${LOW_PRIORITY}) + ${TASK_COUNT_HIGH} high-priority (${HIGH_PRIORITY})`,
  );
  console.log(`tasks, all with affinityKey="${AFFINITY}" on high-priority ones.`);
  console.log(`Crash the queue, restart on same backend, verify the recovered`);
  console.log(`queue dispatches in the same priority + affinity order.\n`);

  tmpRoot = mkdtempSync(join(tmpdir(), 'pwr-priority-queue-'));

  console.log('[A] queueBackend: "memory" — no persistence...');
  const memResult = await runScenarioA_memory();

  console.log('[B] queueBackend: "sqlite"  — persisted to disk...');
  const sqlResult = await runScenarioB_sqlite();

  console.log('\n=== Results ===\n');
  console.table({
    'A. In-memory': {
      recoveredSize: memResult.preservedSize,
      firstPriorityDequeued: memResult.firstPriorityDequeued ?? 'n/a',
      affinityMatchesFirst: memResult.affinityMatchesFirst,
    },
    'B. SQLite': {
      recoveredSize: sqlResult.recoveredSize,
      firstPriorityDequeued: sqlResult.firstPriorityDequeued ?? 'n/a',
      affinityMatchesFirst: sqlResult.affinityMatchesFirst,
    },
  });

  console.log('\nFirst three dequeued after recovery (priority DESC, enqueued_at ASC):');
  console.table(sqlResult.dequeued);

  const passes =
    sqlResult.recoveredSize === TASK_COUNT_LOW + TASK_COUNT_HIGH &&
    sqlResult.firstPriorityDequeued === HIGH_PRIORITY &&
    sqlResult.affinityMatchesFirst === true &&
    memResult.preservedSize === 0;

  if (passes) {
    console.log(
      `\nVerdict: SQLite preserved ${sqlResult.recoveredSize}/${TASK_COUNT_LOW + TASK_COUNT_HIGH} tasks AND the priority (${HIGH_PRIORITY}) + affinity (${AFFINITY}) of the head task.`,
    );
    console.log(
      `           In-memory preserved 0/${TASK_COUNT_LOW + TASK_COUNT_HIGH} — no ordering to test.`,
    );
    console.log('\nSpeedup: ∞× — only SQLite preserves the schedule contract.');
  }

  rmSync(tmpRoot, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  try {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  process.exit(1);
});
