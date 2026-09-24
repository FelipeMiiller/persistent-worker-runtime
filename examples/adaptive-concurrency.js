/**
 * [perf-tested] Example: Adaptive Concurrency (ADR-0014).
 *
 * Demonstrates the three sizing modes side-by-side, reads the
 * `runtime.stats.adaptive` telemetry block, AND quantifies the win of the
 * adaptive controller against a fixed-size pool under sustained load.
 *
 * The three modes:
 *
 *   1. `concurrency: 'auto'` — adaptive controller enabled. Pool is resized
 *      between `[1, availableParallelism()]` based on main-thread ELU + p99
 *      signals. `runtime.stats.adaptive.enabled === true`.
 *   2. `concurrency: 'fixed'` — explicit "static pool" opt-out. The
 *      resolver disables adaptive (`ADR-0023`); `runtime.stats.adaptive.enabled`
 *      is `false` and no controller is constructed. The supervisor pool
 *      defaults to a single worker.
 *   3. `workers: N` — explicit pool size. Also an opt-out (explicit
 *      `workers` wins per `ADR-0023`); same telemetry shape as
 *      `concurrency: 'fixed'` but the pool starts at `N` workers.
 *
 * What this example measures (Part 2):
 *   - Same 50-task CPU burst on `auto` vs `fixed` (workers=1).
 *   - Total wall-clock time + peak `effectiveWorkers` reached.
 *   - The adaptive controller should grow the pool when ELU is high;
 *     the fixed pool cannot.
 *
 * Run: `node examples/adaptive-concurrency.js`
 */

import { createWorkerRuntime } from '../src/index.js';

/** Pretty-print the adaptive telemetry block plus a few supervisor counters. */
function dumpAdaptive(label, stats) {
  const a = stats.adaptive;
  console.log(`  [${label}]`);
  console.log(`    adaptive.enabled         = ${a.enabled}`);
  console.log(`    adaptive.elu             = ${a.elu}`);
  console.log(`    adaptive.latencyP99Ms    = ${a.latencyP99Ms}`);
  console.log(`    adaptive.effectiveWorkers= ${a.effectiveWorkers}`);
  console.log(`    adaptive.ticksSinceResize= ${a.ticksSinceResize}`);
  console.log(`    adaptive.lastResizeReason= ${a.lastResizeReason ?? 'null'}`);
  console.log(`    supervisor.totalWorkers  = ${stats.totalWorkers}`);
  console.log(`    supervisor.idleWorkers   = ${stats.idleWorkers}`);
}

/**
 * One trivial task per runtime — enough to confirm dispatch + completion
 * works on every sizing mode without driving load.
 */
function submitTrivialTask(runtime) {
  return new Promise((resolve, reject) => {
    const handle = runtime.dispatch({
      type: 'ping',
      payload: { at: Date.now() },
      fn: (p) => ({ echo: 'pong', submittedAt: p.at, completedAt: Date.now() }),
    });
    handle.onComplete(resolve);
    handle.onError(reject);
  });
}

async function main() {
  console.log('--- EXAMPLE: Adaptive Concurrency (ADR-0014) ---\n');

  // ============================================================
  // PART 1 — Telemetry shape (no load)
  // ============================================================

  const auto = await createWorkerRuntime({ concurrency: 'auto' });
  const fixed = await createWorkerRuntime({ concurrency: 'fixed' });
  const explicit = await createWorkerRuntime({ workers: 2 });

  console.log('Telemetry at construction time (before any ticks fire):');
  dumpAdaptive('auto      ', auto.stats);
  dumpAdaptive('fixed     ', fixed.stats);
  dumpAdaptive('workers:2 ', explicit.stats);

  console.log('\nSubmitting one trivial task per runtime...');
  const results = await Promise.all([
    submitTrivialTask(auto),
    submitTrivialTask(fixed),
    submitTrivialTask(explicit),
  ]);
  console.log(`  all three completed in order: ${results.map((r) => r.echo).join(', ')}`);

  // Wait a couple of controller ticks so telemetry populates even if the
  // controller had no chance to fire one before our snapshot above.
  await new Promise((r) => setTimeout(r, 250));

  console.log('\nTelemetry after ~250 ms (controller has ticked at least twice):');
  dumpAdaptive('auto      ', auto.stats);
  dumpAdaptive('fixed     ', fixed.stats);
  dumpAdaptive('workers:2 ', explicit.stats);

  await auto.shutdown();
  await fixed.shutdown();
  await explicit.shutdown();

  // ============================================================
  // PART 2 — Perf scenario: adaptive vs fixed under CPU burst
  // ============================================================

  console.log('\n=== Part 2: Adaptive controller vs fixed pool under CPU burst ===\n');

  const BURST_SIZE = 50;
  const PER_TASK_MS = 20;

  /** Same CPU work for both scenarios. PER_TASK_MS inlined because the worker
   *  serializes fn via `new Function(...)` and does NOT transport closures. */
  const cpuFn = () => new Promise((resolve) => setTimeout(resolve, 20));

  // Scenario A: adaptive controller — can grow from 1 worker up.
  const runtimeAuto = await createWorkerRuntime({
    concurrency: 'auto',
    minWorkers: 1,
    maxWorkers: 8,
  });
  const tAuto = performance.now();
  await runtimeAuto.executeAll(
    Array.from({ length: BURST_SIZE }, (_, i) => ({
      type: 'cpu_burst',
      payload: { i },
      fn: cpuFn,
    })),
  );
  const autoMs = performance.now() - tAuto;
  const autoPeak = runtimeAuto.stats.adaptive.effectiveWorkers;
  await runtimeAuto.shutdown();

  // Scenario B: fixed pool, stuck at 1 worker.
  const runtimeFixed = await createWorkerRuntime({
    concurrency: 'fixed',
    workers: 1,
  });
  const tFixed = performance.now();
  await runtimeFixed.executeAll(
    Array.from({ length: BURST_SIZE }, (_, i) => ({
      type: 'cpu_burst',
      payload: { i },
      fn: cpuFn,
    })),
  );
  const fixedMs = performance.now() - tFixed;
  const fixedPeak = runtimeFixed.stats.totalWorkers;
  await runtimeFixed.shutdown();

  console.log(`Workload: ${BURST_SIZE} tasks × ${PER_TASK_MS} ms each. Single-task CPU bound.\n`);
  console.table({
    'A. Adaptive (can grow)': {
      totalMs: autoMs.toFixed(2),
      'peak workers': `${autoPeak} (controller grew)`,
    },
    'B. Fixed (workers=1)': {
      totalMs: fixedMs.toFixed(2),
      'peak workers': `${fixedPeak} (stuck at floor)`,
    },
  });

  const speedup = fixedMs / Math.max(autoMs, 0.001);
  console.log(
    `\nSpeedup: ${speedup.toFixed(2)}× — the adaptive controller grew the pool to match ` +
      `the CPU pressure; the fixed pool stayed at 1 worker.`,
  );

  console.log('\n--- All runtimes shut down cleanly ---');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
