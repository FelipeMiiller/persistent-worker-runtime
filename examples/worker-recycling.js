/**
 * [perf-tested] Example: Worker recycling observable end-to-end.
 *
 * Demonstrates the worker-recycle lifecycle (ADR-0024 HARDEN-04/06/08/11)
 * AND quantifies the per-cycle overhead that recycling costs.
 *
 * Lifecycle:
 * - `maxTasksPerWorker` triggers recycling after N tasks complete.
 * - `recycleBackoffMs` keeps the recycled worker in `getWorkers()` (status
 *   `recycling`) for a configurable grace window before physical termination,
 *   while the replacement is already serving traffic.
 * - Each recycle emits `worker:recycling` (with reason) and `worker:recycled`
 *   events observable via `runtime.addEventListener`.
 *
 * What this example measures:
 * - Per-cycle duration = `worker:recycled.timestamp - worker:recycling.timestamp`.
 *   Expected ≈ `recycleBackoffMs` (the grace window) + small `worker.terminate()`
 *   cost.
 * - Min / max / avg overhead across the recycle cycles in the run.
 * - The "post-executeAll recycle wait" uses an event-driven Promise
 *   (listener resolves when count reaches EXPECTED_RECYCLES) — NOT polling
 *   `runtime.stats.recycledWorkersCount`. The event-driven path costs ~0
 *   wall-clock after the last event; polling would add `pollMs` per tick.
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

  // Track per-cycle overhead: map oldWorkerId → start timestamp (from
  // worker:recycling event). worker:recycled computes delta.
  const cycleStartByWorkerId = new Map();
  const cycleDurationsMs = [];

  // Event-driven wait — resolves the "post-executeAll recycle wait"
  // Promise when the Nth worker:recycled event fires. NO polling.
  let recycleWaitResolve;
  const recycleWait = new Promise((resolve) => {
    recycleWaitResolve = resolve;
  });
  let recycledCount = 0;

  runtime.addEventListener('worker:recycling', (e) => {
    const { workerId, reason } = e.detail;
    cycleStartByWorkerId.set(workerId, performance.now());
    console.log(`  [event] worker:recycling — ${workerId} reason=${reason}`);
  });

  runtime.addEventListener('worker:recycled', (e) => {
    const { oldWorkerId, newWorkerId } = e.detail;
    const start = cycleStartByWorkerId.get(oldWorkerId);
    if (start !== undefined) {
      cycleDurationsMs.push(performance.now() - start);
      cycleStartByWorkerId.delete(oldWorkerId);
    }
    recycledCount++;
    console.log(`  [event] worker:recycled — old=${oldWorkerId} new=${newWorkerId}`);
    if (recycledCount === EXPECTED_RECYCLES && recycleWaitResolve) {
      recycleWaitResolve(e.detail);
      recycleWaitResolve = null;
    }
  });

  console.log(
    `Configuration: workers=1, maxTasksPerWorker=${MAX_TASKS_PER_WORKER}, ` +
      `recycleBackoffMs=${RECYCLE_BACKOFF_MS}\n` +
      `Dispatching ${TASK_COUNT} tasks → expect ${EXPECTED_RECYCLES} recycles\n`,
  );

  // Sample getWorkers() while the worker is mid-recycle to observe status.
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
  // workers that hit their maxTasksPerWorker quota. Wait via the event-
  // driven Promise above (resolved inside the worker:recycled handler).
  // Event-driven = no polling overhead; resolves the moment the last
  // expected worker:recycled event fires.
  await recycleWait;

  // === Per-cycle overhead metric ===
  const minCycle = Math.min(...cycleDurationsMs);
  const maxCycle = Math.max(...cycleDurationsMs);
  const avgCycle = cycleDurationsMs.reduce((a, b) => a + b, 0) / cycleDurationsMs.length;
  // "Termination cost" = cycle duration minus the configured backoff.
  // The grace window is by design; the only variable cost is the
  // worker.terminate() round-trip.
  const avgTerminateCost = avgCycle - RECYCLE_BACKOFF_MS;

  console.log(`\n=== Results ===`);
  console.log(`  worker:recycling events: ${cycleStartByWorkerId.size + cycleDurationsMs.length}`);
  console.log(`  worker:recycled events:  ${recycledCount}`);
  console.log(
    `  recycling snapshot:       ${capturedStatus ? `captured (total=${capturedStatus.total} during backoff)` : 'not captured'}`,
  );
  console.log(`  recycledWorkersCount:     ${runtime.stats.recycledWorkersCount}`);

  console.log(`\n=== Per-cycle overhead ===\n`);
  console.table({
    [`Per cycle (${cycleDurationsMs.length} samples)`]: {
      minMs: minCycle.toFixed(2),
      avgMs: avgCycle.toFixed(2),
      maxMs: maxCycle.toFixed(2),
    },
    'Decomposition (avg)': {
      recycleBackoffMs: RECYCLE_BACKOFF_MS,
      avgTerminateCostMs: avgTerminateCost.toFixed(2),
    },
  });

  console.log(
    `\nTake-away: each recycle costs ~${RECYCLE_BACKOFF_MS} ms of grace + ` +
      `~${avgTerminateCost.toFixed(2)} ms of terminate overhead on average.\n` +
      `Recycling is paid in latency, not throughput — workers stay at capacity the entire time\n` +
      `because the replacement is already serving tasks while the old one drains.`,
  );

  await runtime.shutdown();
  console.log('\n--- Worker recycling example complete ---');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
