/**
 * [perf-tested] Priority routing example.
 *
 * Demonstrates how `priority` ensures critical work runs first — and
 * quantifies the ordering win against a "no priority" baseline.
 *
 * Common use cases:
 *   - Premium-tier requests before free-tier requests.
 *   - Live chat messages before batch analytics.
 *   - Time-sensitive webhooks before housekeeping jobs.
 *
 * What this example measures:
 *   - "First interactive completion index" — the position in the completion
 *     log where the FIRST interactive (priority=10) task lands.
 *   - Scenario A uses `priority: 10` for interactive tasks.
 *   - Scenario B omits `priority` (defaults to 0) — same as the batch.
 *   - The lower the index, the more the runtime respected the priority cut.
 *   - Throughput is identical; what differs is order.
 *
 * Run: `node examples/priority-routing.js`
 */

import { createWorkerRuntime } from '../src/index.js';

const BATCH_COUNT = 30;
const INTERACTIVE_COUNT = 5;
const WAIT_MS = 2000;

/** Tiny CPU work — keeps the worker busy for a few ms per task. */
const workFn = (p) => ({ id: p.id, priority: p.priority, completedAt: Date.now() });

/**
 * Slow batch task — 50 ms each so 30 batch tasks on 2 workers actually queue
 * up (~15 tasks wait per worker). Without this backlog, priority has nothing
 * to reorder and the metric is identical between scenarios.
 */
const slowBatchFn = (p) =>
  new Promise((resolve) =>
    setTimeout(() => resolve({ id: p.id, priority: p.priority, completedAt: Date.now() }), 50),
  );

async function runScenario({ label, interactivePriority }) {
  const runtime = await createWorkerRuntime({ workers: 2 });
  const completionLog = [];

  // Submit slow batch tasks first (priority=0). 50 ms × 30 tasks on 2 workers
  // creates a real backlog so the subsequent interactive tasks must wait in queue.
  for (let i = 0; i < BATCH_COUNT; i++) {
    const handle = runtime.dispatch({
      type: 'batch_job',
      payload: { id: `batch_${label}_${i}`, priority: 0 },
      priority: 0,
      fn: slowBatchFn,
    });
    handle.onComplete((r) => completionLog.push(r));
  }

  // Submit FAST interactive tasks AFTER. The priority cut only matters when
  // there is queued work to jump past.
  for (let i = 0; i < INTERACTIVE_COUNT; i++) {
    const handle = runtime.dispatch({
      type: 'interactive_request',
      payload: { id: `interactive_${label}_${i}`, priority: interactivePriority },
      priority: interactivePriority,
      fn: workFn,
    });
    handle.onComplete((r) => completionLog.push(r));
  }

  // Wait for all to complete. 30 batch tasks × 50 ms / 2 workers = ~750 ms
  // baseline; the 2 s WAIT_MS leaves margin for scheduling jitter.
  await new Promise((r) => setTimeout(r, WAIT_MS));

  // Match by id prefix (not by priority) — scenario B has both batch and
  // interactive at priority=0, so priority-based matching would return the
  // first BATCH task, not the first interactive one.
  const interactivePrefix = `interactive_${label}_`;
  const firstInteractiveIdx = completionLog.findIndex((r) => r.id.startsWith(interactivePrefix));

  await runtime.shutdown();

  return { label, firstInteractiveIdx, totalCompleted: completionLog.length };
}

async function main() {
  console.log('--- EXAMPLE: Priority routing — measured ordering win ---\n');
  console.log(
    `Workload: ${BATCH_COUNT} batch tasks (priority=0) submitted FIRST, then ${INTERACTIVE_COUNT} interactive tasks.\n`,
  );

  // Scenario A: interactive has priority=10 (the runtime way).
  const withPriority = await runScenario({
    label: 'A_with',
    interactivePriority: 10,
  });

  // Scenario B: interactive has priority=0 (same as batch — no cut-line).
  const withoutPriority = await runScenario({
    label: 'B_without',
    interactivePriority: 0,
  });

  // === Side-by-side ===
  console.log('=== First-interactive completion index (lower = earlier = better) ===\n');
  console.table({
    'A. With priority (interactive=10)': {
      firstInteractiveIdx: withPriority.firstInteractiveIdx,
      totalCompleted: withPriority.totalCompleted,
    },
    'B. Without priority (interactive=0)': {
      firstInteractiveIdx: withoutPriority.firstInteractiveIdx,
      totalCompleted: withoutPriority.totalCompleted,
    },
  });

  const delta = withoutPriority.firstInteractiveIdx - withPriority.firstInteractiveIdx;
  if (delta > 0) {
    console.log(
      `\n✅ Priority routing moved the first interactive task ${delta} slot(s) earlier ` +
        `in the completion log. Throughput is identical; what changes is order.`,
    );
  } else {
    console.log(
      '\n⚠️  Priority routing had no measurable effect on this run — try a larger batch count.',
    );
  }

  console.log(
    '\nTake-away: `priority` does not speed up the worker — it changes which task gets the next slot.\n' +
      'Under load (many queued batch tasks waiting on idle workers), this lets critical work\n' +
      'skip the queue instead of being stuck behind non-critical work.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
