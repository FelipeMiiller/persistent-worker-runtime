/**
 * [perf-tested] Bounded Concurrency Batch Image/Data Processing.
 *
 * Demonstrates `executeAll()` (Promise.all style) to process multiple items
 * in parallel without overloading CPU cores, AND quantifies the Event Loop
 * responsiveness win over inline main-thread execution.
 *
 * Why responsiveness matters: when the main thread is busy running CPU
 * work, the Node.js Event Loop starves — `setTimeout` callbacks fire late,
 * HTTP request handlers block, file I/O stalls. Offloading to worker
 * threads frees the main thread to keep the loop ticking at its normal
 * cadence even under heavy load.
 *
 * What this example measures:
 *   - `setInterval(5 ms)` ticks fired during a 50-task CPU burst.
 *   - Scenario A: workers via `executeAll` — main thread free, ticks fire
 *     normally (~expected: 200 ticks / second × burst duration).
 *   - Scenario B: same CPU work awaited inline on the main thread — main
 *     thread busy, ticks starve.
 *   - Side-by-side table + responsiveness ratio.
 *
 * Run: `node examples/image-resizer-batch.js`
 */

import { createWorkerRuntime } from '../src/index.js';

const TASK_COUNT = 50;
const PER_TASK_MS = 10; // simulated CPU work per task

/** CPU work — inlined because worker fns do NOT transport closures. */
const resizeFn = (p) => {
  // Simulates a CPU-heavy pixel resize via busy-wait (deterministic, no
  // floating-point variability).
  const start = performance.now();
  while (performance.now() - start < 10) {
    /* busy-wait 10 ms */
  }
  return {
    original: p.name,
    resizedTo: `${Math.round(p.width / 2)}x${Math.round(p.height / 2)}`,
    processedPixels: p.width * p.height,
  };
};

async function runWithWorkers() {
  const runtime = await createWorkerRuntime({ workers: 2 });

  let tickCount = 0;
  const ticker = setInterval(() => {
    tickCount++;
  }, 5);

  const start = performance.now();
  const results = await runtime.executeAll(
    Array.from({ length: TASK_COUNT }, (_, i) => ({
      type: 'resize_image',
      payload: {
        name: `image_${i}.png`,
        width: 1920,
        height: 1080,
      },
      fn: resizeFn,
    })),
  );
  const elapsedMs = performance.now() - start;
  clearInterval(ticker);

  await runtime.shutdown();
  return { elapsedMs, tickCount, results };
}

async function runOnMainThread() {
  let tickCount = 0;
  const ticker = setInterval(() => {
    tickCount++;
  }, 5);

  const start = performance.now();
  // Run the SAME CPU work inline on the main thread — no runtime.
  const results = [];
  for (let i = 0; i < TASK_COUNT; i++) {
    // Each call must be a fresh Promise (can't reuse fn from above — would
    // block the await chain).
    await new Promise((resolve) => {
      const fnStart = performance.now();
      while (performance.now() - fnStart < 10) {
        /* busy-wait 10 ms */
      }
      resolve({
        original: `image_${i}.png`,
        resizedTo: '960x540',
        processedPixels: 1920 * 1080,
      });
    });
  }
  const elapsedMs = performance.now() - start;
  clearInterval(ticker);

  return { elapsedMs, tickCount, results };
}

async function main() {
  console.log('--- EXAMPLE: Worker pool keeps the Event Loop responsive ---\n');
  console.log(
    `Workload: ${TASK_COUNT} tasks × ${PER_TASK_MS} ms CPU each (busy-wait).\n` +
      `Measuring setInterval(5 ms) tick count during the burst.\n`,
  );

  // Run both scenarios back-to-back. Order matters: each scenario starts
  // with a "fresh" setInterval — measurement is per-burst.
  const withWorkers = await runWithWorkers();
  const onMain = await runOnMainThread();

  console.log('=== Results ===\n');
  console.table({
    'A. Workers via executeAll': {
      elapsedMs: withWorkers.elapsedMs.toFixed(2),
      ticksFired: withWorkers.tickCount,
      'main thread': 'free (interval fired normally)',
    },
    'B. Same work on main thread (no runtime)': {
      elapsedMs: onMain.elapsedMs.toFixed(2),
      ticksFired: onMain.tickCount,
      'main thread': 'busy (interval starved)',
    },
  });

  const responsivenessRatio = withWorkers.tickCount / Math.max(onMain.tickCount, 1);
  console.log(
    `\n✅ With workers, setInterval fired ${responsivenessRatio.toFixed(1)}× more often.\n` +
      `Under load, the main thread stays responsive — HTTP handlers, file I/O, and other ` +
      `setTimeout callbacks keep firing while the worker pool crunches.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
