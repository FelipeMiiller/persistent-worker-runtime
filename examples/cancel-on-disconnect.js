/**
 * Cancellation via AbortController example.
 *
 * Demonstrates how to use the standard AbortSignal to cancel a task
 * cooperatively. Common use cases:
 * - HTTP request cancelled by the client (close tab, navigate away)
 * - User cancels a long-running operation in the UI
 * - Watchdog timeout via AbortSignal.timeout(ms)
 *
 * Run: `node examples/cancel-on-disconnect.js`
 */

import { createWorkerRuntime } from '../src/index.js';
import { TaskAbortedError } from '../src/errors.js';

async function main() {
  const runtime = await createWorkerRuntime({ workers: 2 });

  // === Scenario 1: Manual cancellation ===
  console.log('--- Scenario 1: Manual cancellation ---');
  const controller = new AbortController();

  const longTask = runtime.execute({
    type: 'report_generation',
    payload: { rows: 1_000_000 },
    signal: controller.signal,
    fn: async (p) => {
      // Simulate slow generation. In a real app, you'd check the signal here too:
      //   if (signal.aborted) throw new TaskAbortedError(...)
      await new Promise((r) => setTimeout(r, 5000));
      return `report with ${p.rows} rows`;
    },
  });

  // Cancel after 100ms — the task was set to take 5000ms.
  setTimeout(() => {
    console.log('  > Aborting...');
    controller.abort();
  }, 100);

  try {
    await longTask;
  } catch (err) {
    if (err instanceof TaskAbortedError) {
      console.log(`  ✅ Task aborted cleanly: ${err.name} (${err.taskId})`);
    } else {
      throw err;
    }
  }

  // === Scenario 2: Auto-cancel after a deadline ===
  console.log('\n--- Scenario 2: Auto-cancel with AbortSignal.timeout ---');
  try {
    await runtime.execute({
      type: 'slow_query',
      payload: {},
      signal: AbortSignal.timeout(150), // auto-abort after 150ms
      fn: async () => {
        await new Promise((r) => setTimeout(r, 5000));
        return 'unreachable';
      },
    });
  } catch (err) {
    if (err instanceof TaskAbortedError) {
      console.log(`  ✅ Task auto-aborted at 150ms: ${err.name}`);
    } else {
      throw err;
    }
  }

  // === Scenario 3: Pre-aborted signal ===
  console.log('\n--- Scenario 3: Pre-aborted signal ---');
  const preAbort = new AbortController();
  preAbort.abort();
  try {
    await runtime.execute({
      type: 'never_runs',
      payload: {},
      signal: preAbort.signal,
      fn: () => 'unreachable',
    });
  } catch (err) {
    if (err instanceof TaskAbortedError) {
      console.log(`  ✅ Rejected synchronously: ${err.name}`);
    }
  }

  await runtime.shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
