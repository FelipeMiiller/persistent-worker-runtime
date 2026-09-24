/**
 * Example: Worker recycling observable end-to-end
 *
 * Demonstrates the worker-recycle lifecycle (ADR-0024 HARDEN-04/06/08/11):
 * - `maxTasksPerWorker` triggers recycling after N tasks complete.
 * - `recycleBackoffMs` keeps the recycled worker in `getWorkers()` (status
 *   `recycling`) for a configurable grace window before physical termination,
 *   while the replacement is already serving traffic.
 * - Each recycle emits `worker:recycling` (with reason) and `worker:recycled`
 *   events observable via `runtime.addEventListener`.
 *
 * Key behaviors exercised:
 * - Recycle reason is `'tasks_exceeded'` (HARDEN-08 default).
 * - `recycleBackoffMs: 200` → recycled worker stays in `getWorkers()` for
 *   ~200ms after replacement becomes idle. The polling loop in `main()`
 *   waits for `runtime.stats.recycledWorkersCount` to reach the expected
 *   value before printing, because `executeAll` resolves as soon as the
 *   last task completes — and the backoff timer for that last recycle
 *   fires AFTER the resolve.
 *
 * Run: `node examples/worker-recycling.js`
 */

import { createWorkerRuntime } from '../src/index.js';

// === Configuration ===

const TASK_COUNT = 12; // > workers × maxTasksPerWorker so we see multiple recycles
const PER_TASK_MS = 30;
const MAX_TASKS_PER_WORKER = 3;
const RECYCLE_BACKOFF_MS = 200;
const EXPECTED_RECYCLES = Math.floor(TASK_COUNT / MAX_TASKS_PER_WORKER);

// === Main ===

async function main() {
  console.log('--- EXAMPLE: Worker recycling with backoff grace ---\n');

  const runtime = await createWorkerRuntime({
    workers: 1, // 1 worker pool — every 3rd task triggers a recycle
    maxTasksPerWorker: MAX_TASKS_PER_WORKER,
    recycleBackoffMs: RECYCLE_BACKOFF_MS,
  });

  // Observe recycling lifecycle
  const events = { recycling: [], recycled: [] };
  runtime.addEventListener('worker:recycling', (e) => {
    events.recycling.push({ workerId: e.detail.workerId, reason: e.detail.reason });
    console.log(`  [event] worker:recycling — ${e.detail.workerId} reason=${e.detail.reason}`);
  });
  runtime.addEventListener('worker:recycled', (e) => {
    events.recycled.push({
      oldWorkerId: e.detail.oldWorkerId,
      newWorkerId: e.detail.newWorkerId,
    });
    console.log(
      `  [event] worker:recycled — old=${e.detail.oldWorkerId} new=${e.detail.newWorkerId}`,
    );
  });

  console.log(
    `Configuration: workers=1, maxTasksPerWorker=${MAX_TASKS_PER_WORKER}, ` +
      `recycleBackoffMs=${RECYCLE_BACKOFF_MS}\n` +
      `Dispatching ${TASK_COUNT} tasks → expect ${EXPECTED_RECYCLES} recycles\n`,
  );

  // Sample getWorkers() while the worker is mid-recycle to observe status
  let capturedStatus = null;
  const sampler = setInterval(() => {
    const workers = runtime.getWorkers();
    const recycling = workers.filter((w) => w.status === 'recycling');
    if (recycling.length > 0 && capturedStatus === null) {
      capturedStatus = {
        total: workers.length,
        statuses: workers.map((w) => w.status),
        recyclingIds: recycling.map((w) => w.id),
      };
      console.log(
        `  [snapshot] getWorkers() during backoff — total=${capturedStatus.total}, ` +
          `statuses=[${capturedStatus.statuses.join(',')}], ` +
          `recyclingIds=[${capturedStatus.recyclingIds.join(',')}]`,
      );
    }
  }, 50);

  await runtime.executeAll(
    Array.from({ length: TASK_COUNT }, (_, i) => ({
      type: 'recycle_demo',
      payload: { i, delayMs: PER_TASK_MS },
      fn: ({ i, delayMs }) =>
        new Promise((resolve) => {
          setTimeout(() => resolve(i * 10), delayMs);
        }),
    })),
  );

  clearInterval(sampler);

  // After executeAll resolves, recycle timers are still in-flight for the
  // workers that hit their maxTasksPerWorker quota. Wait for them to
  // complete by polling the supervisor's recycledWorkersCount counter
  // (incremented inside `await worker.terminate()` AFTER the backoff).
  await waitFor(() => runtime.stats.recycledWorkersCount >= EXPECTED_RECYCLES, {
    timeoutMs: (RECYCLE_BACKOFF_MS + 500) * EXPECTED_RECYCLES,
    pollMs: 25,
    description: `recycledWorkersCount >= ${EXPECTED_RECYCLES}`,
  });

  console.log(`\n=== Results ===`);
  console.log(
    `  worker:recycling:   ${events.recycling.length} (reasons: ${events.recycling.map((e) => e.reason).join(', ')})`,
  );
  console.log(`  worker:recycled:    ${events.recycled.length}`);
  console.log(
    `  recycling snapshot: ${capturedStatus ? `captured (total=${capturedStatus.total} during backoff)` : 'not captured'}`,
  );
  console.log(`  recycledWorkersCount (stats): ${runtime.stats.recycledWorkersCount}`);

  await runtime.shutdown();
  console.log('\n--- Worker recycling example complete ---');
}

/**
 * Polls `predicate()` until it returns truthy or `timeoutMs` elapses.
 * Throws an Error if the predicate never satisfies within the budget.
 * Used to bridge async lifecycle gaps where event-loop ordering would
 * otherwise produce a misleading snapshot (see worker-recycling.js).
 */
async function waitFor(predicate, { timeoutMs, pollMs, description }) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout: ${description} did not satisfy within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
