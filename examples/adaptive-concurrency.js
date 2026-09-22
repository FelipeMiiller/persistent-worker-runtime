/**
 * Example: Adaptive Concurrency (ADR-0014).
 *
 * Demonstrates the three sizing modes side-by-side and how to read the
 * `runtime.stats.adaptive` telemetry block. No large burst on purpose:
 * the goal is to show the API surface and the controller's effect on
 * `runtime.stats.adaptive`, not to drive a load test. Stress runs that
 * actually trigger grow/shrink fires live in `benchmarks/`.
 *
 * The three modes:
 *
 *   1. `concurrency: 'auto'` — adaptive controller enabled. Pool is
 *      resized between `[1, availableParallelism()]` based on main-thread
 *      ELU + p99 signals. `runtime.stats.adaptive.enabled === true`.
 *   2. `concurrency: 'fixed'` — explicit "static pool" opt-out. The
 *      resolver disables adaptive (`ADR-0023`); `runtime.stats.adaptive.enabled`
 *      is `false` and no controller is constructed. The supervisor pool
 *      defaults to a single worker.
 *   3. `workers: N` — explicit pool size. Also an opt-out (explicit
 *      `workers` wins per `ADR-0023`); same telemetry shape as
 *      `concurrency: 'fixed'` but the pool starts at `N` workers.
 *
 * Run: `node examples/adaptive-concurrency.js`
 *
 * What you should see in stdout:
 *   - The auto runtime reports `adaptive.enabled === true` and
 *     `effectiveWorkers === 1` (the controller's seed value, decoupled
 *     from the supervisor's actual pool — which is `availableParallelism()`
 *     at startup).
 *   - The fixed and `workers:N` runtimes report `adaptive.enabled === false`.
 *   - All three runtimes process a single short task without issue; the
 *     adaptive runtime's telemetry populates as soon as the controller's
 *     sampling cadence fires (default 100 ms).
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

  // Three runtimes with three different sizing strategies. Constructed
  // back-to-back so the printed state is comparable.
  const auto = await createWorkerRuntime({ concurrency: 'auto' });
  const fixed = await createWorkerRuntime({ concurrency: 'fixed' });
  const explicit = await createWorkerRuntime({ workers: 2 });

  console.log('Telemetry at construction time (before any ticks fire):');
  dumpAdaptive('auto      ', auto.stats);
  dumpAdaptive('fixed     ', fixed.stats);
  dumpAdaptive('workers:2 ', explicit.stats);

  // Submit one trivial task to each runtime. Verifies that every mode
  // is functional; does not attempt to drive the controller's resize
  // decision matrix (that requires sustained ELU / p99 signals, see
  // `benchmarks/adaptive-controller-tick.benchmark.js` for the focused
  // measurement suite).
  console.log('\nSubmitting one trivial task per runtime...');
  const results = await Promise.all([
    submitTrivialTask(auto),
    submitTrivialTask(fixed),
    submitTrivialTask(explicit),
  ]);
  console.log(`  all three completed in order: ${results.map((r) => r.echo).join(', ')}`);

  // Wait a couple of controller ticks so telemetry populates even if
  // the controller had no chance to fire one before our snapshot above.
  await new Promise((r) => setTimeout(r, 250));

  console.log('\nTelemetry after ~250 ms (controller has ticked at least twice):');
  dumpAdaptive('auto      ', auto.stats);
  dumpAdaptive('fixed     ', fixed.stats);
  dumpAdaptive('workers:2 ', explicit.stats);

  console.log('\nHow to read the block:');
  console.log('  - auto runtime: enabled=true means the controller is wired.');
  console.log('    elu + latencyP99Ms reflect EWMA-smoothed main-thread signals.');
  console.log('    effectiveWorkers starts at 1 (the floor); the supervisor pool');
  console.log('    starts at availableParallelism(). The controller grows the');
  console.log('    supervisor pool under sustained grow-direction debounce fires.');
  console.log('  - fixed/workers:N runtimes: enabled=false means the resolver');
  console.log('    detected an opt-out and skipped controller construction.');
  console.log('    No ELU/p99 sampling, no resize decisions, zero controller cost.');

  await auto.shutdown();
  await fixed.shutdown();
  await explicit.shutdown();

  console.log('\n--- All runtimes shut down cleanly ---');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
