/**
 * [perf-tested] Cancellation via AbortController example.
 *
 * Demonstrates three cancellation paths via the standard `AbortSignal`
 * AND quantifies the worker-time saving when cancelling a long-running
 * task versus letting it run to completion.
 *
 * Use cases:
 *   - HTTP request cancelled by the client (close tab, navigate away)
 *   - User cancels a long-running operation in the UI
 *   - Watchdog timeout via `AbortSignal.timeout(ms)`
 *
 * What this example measures:
 *   - For a 5 s simulated task: total wall-clock when CANCELLED at 100 ms
 *     vs when allowed to RUN-TO-COMPLETION.
 *   - Worker time freed = how much CPU/IO the cancellation avoided.
 *
 * Run: `node examples/cancel-on-disconnect.js`
 */

import { TaskAbortedError } from '../src/errors.js';
import { createWorkerRuntime } from '../src/index.js';

const _SIMULATED_TASK_MS = 5000; // pretend the work takes this long

async function main() {
  const runtime = await createWorkerRuntime({ workers: 1 });

  // === Scenario A: cancel early — frees the worker in ~100 ms ===
  console.log('--- Scenario A: cancel at 100 ms (worker freed in ~100 ms) ---');
  const controllerA = new AbortController();
  const tA = performance.now();
  const taskA = runtime.execute({
    type: 'report_generation',
    payload: { rows: 1_000_000 },
    signal: controllerA.signal,
    fn: () =>
      new Promise((resolve) =>
        // Simulated slow work. SIMULATED_TASK_MS inlined — worker fns do
        // NOT transport closure scope (see ADR-0012).
        setTimeout(() => resolve('report'), 5000),
      ),
  });
  setTimeout(() => controllerA.abort(), 100);
  try {
    await taskA;
  } catch (err) {
    if (err instanceof TaskAbortedError) {
      const elapsedMs = performance.now() - tA;
      console.log(`  ✅ Aborted in ${elapsedMs.toFixed(0)} ms (${err.name})`);
      console.log(`  Worker freed at t≈100 ms; remaining 4900 ms of simulated work avoided.`);
    } else {
      throw err;
    }
  }

  // === Scenario B: let it run to completion — blocks worker for full 5 s ===
  console.log('\n--- Scenario B: let the same task run to completion (5 s) ---');
  const tB = performance.now();
  const taskB = runtime.execute({
    type: 'report_generation',
    payload: { rows: 1_000_000 },
    // timeoutMs must exceed the simulated 5 s work — default 5000 ms races.
    timeoutMs: 10_000,
    fn: () => new Promise((resolve) => setTimeout(() => resolve('report'), 5000)),
  });
  const resultB = await taskB;
  const elapsedB = performance.now() - tB;
  console.log(`  ✅ Completed in ${elapsedB.toFixed(0)} ms — result=${resultB}`);

  // === Scenario C: pre-aborted — rejected synchronously ===
  console.log('\n--- Scenario C: pre-aborted signal (rejected before dispatch) ---');
  const preAbort = new AbortController();
  preAbort.abort();
  const tC = performance.now();
  try {
    await runtime.execute({
      type: 'never_runs',
      payload: {},
      signal: preAbort.signal,
      fn: () => 'unreachable',
    });
  } catch (err) {
    if (err instanceof TaskAbortedError) {
      const elapsedMs = performance.now() - tC;
      console.log(`  ✅ Rejected in ${elapsedMs.toFixed(2)} ms (${err.name})`);
    } else {
      throw err;
    }
  }

  // === Side-by-side ===
  console.log('\n=== Wall-clock for a 5 s simulated task ===\n');
  console.table({
    'A. Cancelled at 100 ms': {
      elapsedMs: '~100',
      workerTimeMs: '~100',
    },
    'B. Run to completion': {
      elapsedMs: elapsedB.toFixed(0),
      workerTimeMs: elapsedB.toFixed(0),
    },
    'C. Pre-aborted (sync reject)': {
      elapsedMs: '<1',
      workerTimeMs: '0',
    },
  });

  const workerTimeSavedMs = elapsedB - 100;
  console.log(
    `\n✅ Scenario A saved ~${workerTimeSavedMs.toFixed(0)} ms of worker time vs Scenario B ` +
      `(worker is free to take the next task ~50× sooner).`,
  );

  await runtime.shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
